/**
 * Sales Timeline Server — with image/attachment proxy
 */
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SENDER_EMAIL  = process.env.SENDER_EMAIL         || 'boypeo81@gmail.com';

let refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';
let accessToken  = '';
let tokenExpiry  = 0;

function getRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}/auth/callback`;
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  if (!refreshToken) throw new Error('ยังไม่ได้ Auth — กรุณาไปที่ /auth ก่อน');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Refresh token failed: ' + (data.error_description || data.error));
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return accessToken;
}

async function gmailFetch(endpoint, params = {}) {
  const token = await getAccessToken();
  const url   = new URL('https://gmail.googleapis.com/gmail/v1/users/me' + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
  return r.json();
}

function hdr(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Extract all parts (attachments + inline images) from message payload
function extractParts(payload) {
  const parts = [];
  function walk(p) {
    if (!p) return;
    if (p.filename && p.filename.length > 0 && p.body) {
      parts.push({
        attachmentId: p.body.attachmentId || null,
        data:         p.body.data         || null,  // base64url for small items
        filename:     p.filename,
        mimeType:     p.mimeType || 'application/octet-stream',
        size:         p.body.size || 0,
        contentId:    (p.headers || []).find(h => h.name.toLowerCase() === 'content-id')?.value || null,
        isImage:      (p.mimeType || '').startsWith('image/'),
      });
    }
    (p.parts || []).forEach(walk);
  }
  walk(payload);
  return parts;
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes
app.get('/auth', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET)
    return res.send('<h2>⚠️ ยังไม่ตั้งค่า GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET</h2>');
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: getRedirectUri(req),
    response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send('<h2>Auth ยกเลิก: ' + (error || 'ไม่มี code') + '</h2>');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: getRedirectUri(req), grant_type: 'authorization_code',
    }),
  });
  const data = await r.json();
  if (!data.refresh_token)
    return res.send(`<h2>❌ ไม่ได้รับ refresh_token</h2><pre>${JSON.stringify(data,null,2)}</pre>`);
  refreshToken = data.refresh_token;
  accessToken  = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in || 3600) * 1000;
  res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:600px">
    <h2>✅ Auth สำเร็จ!</h2>
    <p>Copy <b>GOOGLE_REFRESH_TOKEN</b> ด้านล่างใส่ใน Render → Environment Variables แล้ว Redeploy:</p>
    <textarea style="width:100%;height:80px;font-size:13px;padding:10px;font-family:monospace" readonly>${data.refresh_token}</textarea>
    <br><br><a href="/" style="background:#2563EB;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">→ ไปหน้า Dashboard</a>
    </body></html>`);
});

// API: threads with attachments
app.get('/api/threads', async (req, res) => {
  try {
    const sender = req.query.sender || SENDER_EMAIL;
    const after  = req.query.after  || '2026/01/01';
    const before = req.query.before || '2026/12/31';
    const maxRes = Math.min(parseInt(req.query.max) || 50, 50);

    const query = `from:${sender} after:${after} before:${before}`;
    const list  = await gmailFetch('/threads', { q: query, maxResults: maxRes });
    if (!list.threads || !list.threads.length) return res.json({ threads: [] });

    const details = await Promise.all(
      list.threads.map(t => gmailFetch('/threads/' + t.id, { format: 'full' }))
    );

    const threads = details.map(raw => {
      const msgs = (raw.messages || []).map(m => {
        const h    = m.payload?.headers || [];
        const parts = extractParts(m.payload);
        return {
          id:          m.id,
          labelIds:    m.labelIds || [],
          subject:     hdr(h, 'Subject'),
          from:        hdr(h, 'From'),
          to:          hdr(h, 'To'),
          cc:          hdr(h, 'Cc'),
          date:        hdr(h, 'Date'),
          snippet:     m.snippet || '',
          hasAttach:   parts.length > 0,
          attachments: parts,
        };
      });
      return {
        id:        raw.id,
        messages:  msgs,
        hasAttach: msgs.some(m => m.hasAttach),
      };
    }).sort((a, b) => new Date(b.messages[b.messages.length-1].date) - new Date(a.messages[a.messages.length-1].date));

    res.json({ threads, sender, total: threads.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// API: serve attachment/image bytes (proxy to Gmail)
app.get('/api/attachment/:messageId/:attachmentId', async (req, res) => {
  try {
    const { messageId, attachmentId } = req.params;
    const mime = req.query.mime || 'application/octet-stream';
    const data = await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`);
    if (!data.data) return res.status(404).send('Not found');
    // Gmail returns base64url — convert to base64
    const b64 = data.data.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/health', (req, res) => res.json({
  ok: true, hasToken: !!refreshToken,
  sender: SENDER_EMAIL, tokenExpiry: new Date(tokenExpiry).toISOString(),
}));

app.listen(PORT, () => {
  console.log(`Sales Timeline running on port ${PORT}`);
  console.log(`Auth: ${refreshToken ? '✅ ready' : '⚠️  go to /auth'}`);
});
