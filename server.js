/**
 * Sales Feed Server
 * ─────────────────
 * Owner auth ครั้งเดียว → server เก็บ refresh token
 * ผู้ใช้คนอื่นเปิด URL ได้เลย ไม่ต้อง login
 *
 * ENV ที่ต้องตั้งบน Render.com:
 *   GOOGLE_CLIENT_ID       - จาก Google Cloud Console
 *   GOOGLE_CLIENT_SECRET   - จาก Google Cloud Console
 *   GOOGLE_REFRESH_TOKEN   - ได้หลัง owner auth ครั้งแรก (ดู /auth)
 *   SENDER_EMAIL           - boypeo81@gmail.com
 *   PORT                   - (Render ตั้งให้อัตโนมัติ)
 */

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SENDER_EMAIL  = process.env.SENDER_EMAIL         || 'boypeo81@gmail.com';

// Refresh token: ตั้งไว้ใน ENV หลัง owner auth ครั้งแรก
let refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';
let accessToken  = '';
let tokenExpiry  = 0;

// ── Redirect URI ──────────────────────────────────────────────
function getRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}/auth/callback`;
}

// ── Get / refresh access token ─────────────────────────────────
async function getAccessToken(req) {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  if (!refreshToken) throw new Error('ยังไม่ได้ Auth — กรุณาไปที่ /auth ก่อน');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) {
    console.error('Token refresh error:', data);
    throw new Error('ไม่สามารถ refresh token ได้: ' + (data.error_description || data.error));
  }
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return accessToken;
}

// ── Gmail API helper ────────────────────────────────────────────
async function gmailFetch(path, params = {}, req) {
  const token = await getAccessToken(req);
  const url   = new URL('https://gmail.googleapis.com/gmail/v1/users/me' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token },
  });
  return r.json();
}

function hdr(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
function hasAttach(msg) {
  return (msg.payload?.parts || []).some(p => p.filename && p.filename.length > 0);
}

// ── Routes ─────────────────────────────────────────────────────

// เสิร์ฟ index.html
app.use(express.static(path.join(__dirname, 'public')));

// ── STEP 1: Owner ไปที่ /auth เพื่อขอ permission ───────────────
app.get('/auth', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.send(`
      <h2>⚠️ ยังไม่ได้ตั้งค่า ENV</h2>
      <p>กรุณาตั้งค่า <code>GOOGLE_CLIENT_ID</code> และ <code>GOOGLE_CLIENT_SECRET</code> ใน Render Environment Variables ก่อน</p>
    `);
  }
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  getRedirectUri(req),
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/gmail.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// ── STEP 2: Google redirect กลับมาที่นี่ ─────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send('<h2>Auth ยกเลิก: ' + (error||'ไม่มี code') + '</h2>');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  getRedirectUri(req),
      grant_type:    'authorization_code',
    }),
  });
  const data = await r.json();

  if (!data.refresh_token) {
    return res.send(`<h2>❌ ไม่ได้รับ refresh_token</h2><pre>${JSON.stringify(data,null,2)}</pre>`);
  }

  refreshToken = data.refresh_token;
  accessToken  = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in || 3600) * 1000;

  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
    <h2>✅ Auth สำเร็จ!</h2>
    <p>Copy <b>GOOGLE_REFRESH_TOKEN</b> ด้านล่างไปใส่ใน Render → Environment Variables แล้ว Redeploy:</p>
    <textarea style="width:100%;height:80px;font-family:monospace;font-size:13px;padding:10px" readonly>${data.refresh_token}</textarea>
    <br><br>
    <a href="/" style="background:#1B6FD8;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">→ ไปหน้า Dashboard</a>
    </body></html>
  `);
});

// ── API: ดึง email threads ────────────────────────────────────
app.get('/api/threads', async (req, res) => {
  try {
    const sender   = req.query.sender   || SENDER_EMAIL;
    const after    = req.query.after    || '2026/01/01';
    const before   = req.query.before   || '2026/12/31';
    const maxRes   = Math.min(parseInt(req.query.max)||50, 50);

    const query = `from:${sender} after:${after} before:${before}`;
    const list  = await gmailFetch('/threads', { q: query, maxResults: maxRes }, req);

    if (!list.threads || !list.threads.length) return res.json({ threads: [] });

    const details = await Promise.all(
      list.threads.map(t => gmailFetch('/threads/' + t.id, { format: 'full' }, req))
    );

    const threads = details.map(raw => {
      const msgs = (raw.messages || []).map(m => {
        const h = m.payload?.headers || [];
        return {
          id:        m.id,
          labelIds:  m.labelIds || [],
          subject:   hdr(h, 'Subject'),
          from:      hdr(h, 'From'),
          to:        hdr(h, 'To'),
          cc:        hdr(h, 'Cc'),
          date:      hdr(h, 'Date'),
          snippet:   m.snippet || '',
          hasAttach: hasAttach(m),
        };
      });
      return {
        id:        raw.id,
        messages:  msgs,
        hasAttach: msgs.some(m => m.hasAttach),
      };
    }).sort((a, b) => new Date(b.messages[0].date) - new Date(a.messages[0].date));

    res.json({ threads, sender, total: threads.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:           true,
    hasToken:     !!refreshToken,
    sender:       SENDER_EMAIL,
    tokenExpiry:  new Date(tokenExpiry).toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Sales Feed running on port ${PORT}`);
  console.log(`Auth status: ${refreshToken ? '✅ Token ready' : '⚠️  No token — go to /auth'}`);
});
