import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const IMG_DIR = '/var/www/sats4ads/img';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

const db = new Database(`${__dirname}/sats4ads.db`);
const SHARED_SECRET = process.env.S4A_SECRET || 'sats4ads_shared_secret_2026';
const BOT_TOKEN     = process.env.BOT_TOKEN   || '8581698217:AAHDiVMg3DIBxYMV0IcQqNG3Ye7370fqxJE';
const BOT_NAME      = process.env.BOT_NAME    || 'LightningEasyBot';
const PORT          = process.env.PORT        || 3900;

db.exec(`
  CREATE TABLE IF NOT EXISTS ads (
    code TEXT PRIMARY KEY, title TEXT,
    content_type TEXT NOT NULL, content_text TEXT, content_caption TEXT,
    per_claim_msat INTEGER NOT NULL, max_claims INTEGER NOT NULL,
    claims_made INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

// ── HMAC token generation (bot verifies locally) ──────────────────────────
function makeClaimToken(adCode) {
  const ts    = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const hmac  = crypto.createHmac('sha256', SHARED_SECRET)
                      .update(`${adCode}:${ts}:${nonce}`).digest('hex').slice(0, 32);
  // start param: webgadclaim_{adCode}_{ts}_{nonce}_{hmac}  — no underscores in any segment
  return `https://t.me/${BOT_NAME}?start=webgadclaim_${adCode}_${ts}_${nonce}_${hmac}`;
}

// ── Telegram initData validation ──────────────────────────────────────────
function validateInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckStr = [...params.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey    = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest('hex');
    if (expectedHash !== hash) return null;
    const userRaw = params.get('user');
    return userRaw ? JSON.parse(userRaw) : null;
  } catch { return null; }
}

// ── BOT sync endpoints (protected by shared secret) ───────────────────────
app.post('/api/ads', (req, res) => {
  if (req.headers['x-secret'] !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { code, title, content_type, content_text, content_caption, per_claim_msat, max_claims, media_base64, media_ext } = req.body;
  if (!code || !content_type || !per_claim_msat) return res.status(400).json({ error: 'missing fields' });

  // Save media if provided
  let mediaUrl = null;
  if (media_base64 && media_ext) {
    try {
      const buf = Buffer.from(media_base64, 'base64');
      const filename = `${code}.${media_ext}`;
      fs.writeFileSync(`${IMG_DIR}/${filename}`, buf);
      mediaUrl = `/img/${filename}`;
    } catch (e) { console.error('[MEDIA] save failed:', e.message); }
  }

  db.prepare(`INSERT OR REPLACE INTO ads
    (code,title,content_type,content_text,content_caption,per_claim_msat,max_claims,image_url)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, title||code, content_type, content_text||null, content_caption||null, per_claim_msat, max_claims, mediaUrl);
  res.json({ ok: true });
});
app.post('/api/ads/:code/claim', (req, res) => {
  if (req.headers['x-secret'] !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  db.prepare('UPDATE ads SET claims_made = claims_made + 1 WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});
app.post('/api/ads/:code/close', (req, res) => {
  if (req.headers['x-secret'] !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  db.prepare('UPDATE ads SET active = 0 WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ── Token for browser iframe (no Telegram context) ────────────────────────
app.post('/api/token/:code', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE code = ? AND active = 1').get(req.params.code);
  if (!ad)                           return res.status(404).json({ error: 'Ad not found or inactive' });
  if (ad.claims_made >= ad.max_claims) return res.status(410).json({ error: 'Ad exhausted' });
  res.json({ deepLink: makeClaimToken(req.params.code) });
});

// ── Opción B: Mini App claim (Telegram WebApp context) ───────────────────
app.post('/api/claim-webapp', (req, res) => {
  const { initData, code } = req.body;
  if (!initData || !code) return res.status(400).json({ error: 'missing fields' });

  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });

  const ad = db.prepare('SELECT * FROM ads WHERE code = ? AND active = 1').get(code);
  if (!ad)                            return res.status(404).json({ error: 'Ad not found' });
  if (ad.claims_made >= ad.max_claims) return res.status(410).json({ error: 'Ad exhausted' });

  // Return signed deep link — bot will do the actual payment + DB write
  const deepLink = makeClaimToken(code);
  res.json({ deepLink, userId: user.id, username: user.username });
});

// ── Iframe ad page ─────────────────────────────────────────────────────────
app.get('/ad/:code', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE code = ?').get(req.params.code);
  if (!ad) return res.status(404).send('<p style="font:1rem sans-serif;color:#fff;background:#111;padding:2rem">Anuncio no encontrado.</p>');

  const perClaimSats = (ad.per_claim_msat / 1000).toLocaleString('es-ES', { maximumFractionDigits: 3 });
  const exhausted    = !ad.active || ad.claims_made >= ad.max_claims;
  const content      = ad.content_caption || ad.content_text || '';
  const remaining    = ad.max_claims - ad.claims_made;
  const code         = req.params.code;
  // Build media HTML based on content type and file extension
  let mediaHtml = '';
  if (ad.image_url) {
    const ext = ad.image_url.split('.').pop().toLowerCase();
    const isVideo = ['mp4','webm','mov','avi'].includes(ext);
    const isAudio = ['mp3','ogg','wav','m4a','opus'].includes(ext);
    const isGif = ext === 'gif';

    if (isVideo) {
      mediaHtml = `<video src="${ad.image_url}" controls playsinline style="width:100%;border-radius:8px;margin-bottom:.75rem;max-height:300px;background:#000"></video>`;
    } else if (isAudio) {
      mediaHtml = `<audio src="${ad.image_url}" controls style="width:100%;margin-bottom:.75rem"></audio>`;
    } else if (isGif) {
      mediaHtml = `<img src="${ad.image_url}" style="width:100%;border-radius:8px;margin-bottom:.75rem;max-height:300px;object-fit:cover" alt="">`;
    } else {
      // photo / document with image extension
      mediaHtml = `<img src="${ad.image_url}" style="width:100%;border-radius:8px;margin-bottom:.75rem;max-height:300px;object-fit:cover" alt="">`;
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sats4ads</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--tg-theme-bg-color,#0f0f0f);color:var(--tg-theme-text-color,#fff);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:var(--tg-theme-secondary-bg-color,#1a1a1a);border:1px solid #2a2a2a;border-radius:12px;padding:1.5rem;max-width:480px;width:100%;text-align:center}
.badge{display:inline-block;background:#1c2e1c;color:#4caf50;font-size:.7rem;padding:2px 8px;border-radius:20px;margin-bottom:1rem;letter-spacing:1px;text-transform:uppercase}
.content{font-size:1rem;color:var(--tg-theme-hint-color,#ccc);margin:1rem 0;line-height:1.5;min-height:2rem}
.reward{font-size:1.5rem;font-weight:bold;color:#f7931a;margin:.5rem 0}
.counter{font-size:.8rem;color:#555;margin-bottom:1rem}
.btn{display:block;background:#f7931a;color:#000;font-weight:bold;padding:.85rem 2rem;border-radius:8px;font-size:1rem;cursor:pointer;border:none;width:100%;transition:opacity .2s}
.btn:hover{opacity:.85}.btn:disabled{background:#333;color:#666;cursor:default}
.powered{margin-top:1rem;font-size:.7rem;color:#333}
.powered a{color:#555;text-decoration:none}
#msg{font-size:.85rem;color:#888;margin-top:.75rem;min-height:1.2rem}
</style></head><body>
<div class="card">
  <div class="badge">⚡ Anuncio patrocinado</div>
  ${mediaHtml}
  <div class="content">${content}</div>
  <div class="reward">⚡ ${perClaimSats} sats</div>
  <div class="counter" id="counter">${exhausted ? '✅ Completado' : `${remaining} claims disponibles`}</div>
  ${exhausted
    ? `<button class="btn" disabled>Anuncio finalizado</button>`
    : `<button class="btn" id="btn" onclick="doClaim()">📢 Reclamar ${perClaimSats} sats</button>`
  }
  <div id="msg"></div>
  <div class="powered">Publicado con <a href="https://sats4ads.com" target="_blank">sats4ads.com</a> ⚡</div>
</div>
<script>
const CODE = '${code}';
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

async function doClaim() {
  const btn = document.getElementById('btn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  btn.textContent = '⏳ Procesando...';

  try {
    let deepLink;

    if (tg && tg.initData) {
      // ── Opción B: Mini App — validate initData server-side ──
      const r = await fetch('/api/claim-webapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, code: CODE })
      });
      const d = await r.json();
      if (!r.ok) {
        const errs = { 'Ad exhausted': '💸 Anuncio agotado', 'invalid initData': '❌ Error de autenticación' };
        msg.textContent = errs[d.error] || '❌ ' + (d.error || 'Error');
        btn.textContent = '❌'; return;
      }
      deepLink = d.deepLink;
      msg.textContent = '✅ Abriendo Telegram...';
      btn.textContent = '✅ Completado';
      // Open bot deep link within Telegram (stays inside the app)
      tg.openTelegramLink(deepLink);
      setTimeout(() => tg.close(), 1500);

    } else {
      // ── Opción web: browser iframe — use anonymous token ──
      const r = await fetch('/api/token/' + CODE, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) {
        const errs = { 'Ad exhausted': '💸 Anuncio agotado' };
        msg.textContent = errs[d.error] || '❌ ' + (d.error || 'Error');
        btn.textContent = '❌'; return;
      }
      deepLink = d.deepLink;
      btn.textContent = '✅ Abre Telegram';
      msg.innerHTML = '👆 Se abrirá Telegram para completar el claim';
      window.open(deepLink, '_blank');
    }

  } catch(e) {
    msg.textContent = '❌ Error de conexión';
    btn.disabled = false;
    btn.textContent = '📢 Reclamar ${perClaimSats} sats';
  }
}
</script></body></html>`);
});

// ── Preview + Landing ──────────────────────────────────────────────────────
app.get('/preview', (_, res) => res.sendFile('/var/www/sats4ads/preview/index.html'));
app.get('/manual', (_, res) => res.sendFile('/var/www/sats4ads/manual/index.html'));
app.get('/health',  (_, res) => res.json({ ok: true, version: '4.0' }));

app.listen(PORT, () => console.log(`[sats4ads-api] v4 running on :${PORT}`));
