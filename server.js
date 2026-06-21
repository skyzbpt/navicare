/**
 * 領航物理治療所 — LINE Webhook + 後台資料伺服器（MongoDB 版）
 * 部署平台：Render（Node.js Web Service）
 *
 * ★ 本版更新：
 *   1. 明日提醒範本變數：{therapist} {timerange} {endtime} {duration}
 *   2. 新增公開端點 GET /login-logo — 登入前即可取得登入畫面 Logo
 *      （只回傳 Logo 一個欄位，不洩漏其他資料）
 *
 * 安裝：
 *   npm install express mongodb   ⚠ 需要 Node 18 以上（內建 fetch）。
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
  console.error('✗ 此 Node 版本沒有內建 fetch（需要 Node 18+）。');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// ── 設定 ──
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_API = 'https://api.line.me/v2/bot';
if (!LINE_TOKEN) console.warn('⚠ 未設定 LINE_CHANNEL_ACCESS_TOKEN，推播會失敗。');
if (!LINE_SECRET) console.warn('⚠ 未設定 LINE_CHANNEL_SECRET，webhook 不會驗章（請盡快設定）。');

const STAFF_EMAILS = (process.env.STAFF_EMAILS ||
  'nycuptc@gmail.com,skyzbpt@gmail.com,yewfir@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ════════════════════════════════════════════════
//  儲存層：MongoDB 優先，否則退回 JSON 檔
// ════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'clinic';
const USE_MONGO = !!MONGODB_URI;

const K_USERS = 'line-users';
const K_PENDING = 'pending';
const K_CATALOG = 'catalog';
const K_CLINIC = 'clinic-data';

const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const FILES = {
  [K_USERS]: path.join(DATA_DIR, 'line-users.json'),
  [K_PENDING]: path.join(DATA_DIR, 'pending.json'),
  [K_CATALOG]: path.join(DATA_DIR, 'catalog.json'),
  [K_CLINIC]: path.join(DATA_DIR, 'clinic-data.json')
};

let mongoColl = null;
async function initStore() {
  if (!USE_MONGO) { console.log('🗄  儲存模式：JSON 檔（未設 MONGODB_URI）'); return; }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  mongoColl = client.db(MONGODB_DB).collection('store');
  await mongoColl.findOne({ _id: '__ping' }).catch(() => {});
  console.log(`🗄  儲存模式：MongoDB（資料庫 ${MONGODB_DB}）`);
}

async function storeGet(key, fallback) {
  try {
    if (USE_MONGO && mongoColl) {
      const doc = await mongoColl.findOne({ _id: key });
      return doc && 'data' in doc ? doc.data : fallback;
    }
    const file = FILES[key];
    if (!fs.existsSync(file)) return fallback;
    const txt = fs.readFileSync(file, 'utf8');
    return txt ? JSON.parse(txt) : fallback;
  } catch (e) {
    console.error('storeGet 失敗', key, e.message);
    return fallback;
  }
}
const _locks = {};
async function storeSet(key, data) {
  const run = async () => {
    if (USE_MONGO && mongoColl) {
      await mongoColl.updateOne({ _id: key }, { $set: { data, at: new Date() } }, { upsert: true });
      return;
    }
    const file = FILES[key];
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  const prev = _locks[key] || Promise.resolve();
  const next = prev.then(run, run);
  _locks[key] = next.catch(() => {});
  return next;
}

// ════════════════════════════════════════════════
//  速率限制（內建）
// ════════════════════════════════════════════════
function rateLimit(opts) {
  const windowMs = opts.windowMs || 60000;
  const max = opts.max || 30;
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const kept = arr.filter(t => now - t < windowMs);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref();
  return function (req, res, next) {
    const ip = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ ok: false, error: '請求過於頻繁，請稍後再試' });
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}
const submitLimiter = rateLimit({ windowMs: 60000, max: 10 });
const imageLimiter = rateLimit({ windowMs: 60000, max: 60 });
const lineLimiter = rateLimit({ windowMs: 60000, max: 30 });

// ── CORS + 安全性 HTTP 標頭 ──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Line-Signature');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'no-referrer');
  res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.header('X-Permitted-Cross-Domain-Policies', 'none');
  res.header('Cross-Origin-Resource-Policy', 'same-site');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 身分驗證 ──
const _tokenCache = new Map();
async function verifyStaff(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const cached = _tokenCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.email;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const info = await r.json();
    const email = (info.email || '').toLowerCase();
    if (!email || !STAFF_EMAILS.includes(email)) return null;
    _tokenCache.set(token, { email, exp: Date.now() + 5 * 60 * 1000 });
    return email;
  } catch (e) { return null; }
}
function requireStaff(req, res, next) {
  verifyStaff(req).then(email => {
    if (!email) return res.status(401).json({ ok: false, error: '未授權，請重新登入' });
    req.staffEmail = email;
    next();
  }).catch(() => res.status(401).json({ ok: false, error: '身分驗證失敗' }));
}

// ── LINE webhook（原始 bytes 驗章）──
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);
  try {
    const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!bodyStr) return;
    if (LINE_SECRET) {
      const sig = req.headers['x-line-signature'];
      const expected = crypto.createHmac('sha256', LINE_SECRET).update(bodyStr).digest('base64');
      const a = Buffer.from(sig || '', 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { console.warn('webhook 簽章不符，略過'); return; }
    }
    const body = JSON.parse(bodyStr);
    const events = body.events || [];
    for (const ev of events) {
      const userId = ev.source && ev.source.userId;
      if (!userId) continue;
      await upsertLineUser(userId);
      if (ev.type === 'follow' && ev.replyToken) {
        await replyMessage(ev.replyToken, '感謝您加入領航物理治療所 👋\n如需預約或諮詢，請直接留言，我們會盡快回覆您！');
      } else if (ev.type === 'message' && ev.message && ev.message.type === 'text' && ev.replyToken) {
        await replyMessage(ev.replyToken, '已收到您的訊息，我們會盡快回覆 🙏\n緊急事項請來電 (02)2826-1698');
      }
    }
  } catch (e) { console.error('webhook 處理錯誤', e.message); }
});

app.use(express.json({ limit: '25mb' }));

// 提供靜態 HTML 檔案（liff-book.html、liff-intake.html 等）
app.use(express.static(__dirname, { index: false }));

// 明確路由：LIFF 頁面
app.get('/liff-book.html', (req, res) => {
  const f = path.join(__dirname, 'liff-book.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).send('liff-book.html 尚未部署到此伺服器，請將檔案加入 repo 並重新部署。');
});
app.get('/liff-intake.html', (req, res) => {
  const f = path.join(__dirname, 'liff-intake.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).send('liff-intake.html 尚未部署到此伺服器，請將檔案加入 repo 並重新部署。');
});

async function upsertLineUser(userId) {
  try {
    const r = await fetch(`${LINE_API}/profile/${userId}`, { headers: { Authorization: `Bearer ${LINE_TOKEN}` } });
    if (!r.ok) return;
    const p = await r.json();
    const users = await storeGet(K_USERS, []);
    const idx = users.findIndex(u => u.userId === userId);
    const rec = { userId, displayName: p.displayName || '', pictureUrl: p.pictureUrl || '', updatedAt: new Date().toISOString() };
    if (idx > -1) users[idx] = { ...users[idx], ...rec }; else users.push(rec);
    await storeSet(K_USERS, users);
  } catch (e) { console.error('upsertLineUser 失敗', e.message); }
}
function replyMessage(replyToken, text) {
  return fetch(`${LINE_API}/message/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  }).catch(e => console.error('reply 失敗', e.message));
}

// ════════════════════════════════════════════════
//  公開端點
// ════════════════════════════════════════════════
app.get('/proxy-image', imageLimiter, async (req, res) => {
  try {
    const url = req.query.url;
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { return res.status(400).send('invalid url'); }
    if (!/(^|\.)line-scdn\.net$|(^|\.)line-apps\.com$|(^|\.)line\.me$/.test(host)) {
      return res.status(400).send('domain not allowed');
    }
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).send('fetch failed');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) { res.status(500).send(e.message); }
});

function clampStr(v, n) { return typeof v === 'string' ? v.slice(0, n) : v; }
function sanitizeSubmit(d) {
  d = d && typeof d === 'object' ? d : {};
  const out = {};
  ['name', 'phone', 'dob', 'idNum', 'gender', 'svc', 'svcName', 't', 'tName', 'date', 'time', 'note', 'complaint', 'duration', 'sigName', 'sigRel', 'sigDate', 'lineUserId', 'lineDisplayName', 'linePictureUrl'].forEach(k => {
    if (d[k] != null) out[k] = clampStr(d[k], (k === 'note' || k === 'complaint' || k === 'linePictureUrl') ? 500 : 100);
  });
  if (Array.isArray(d.bodyParts)) out.bodyParts = d.bodyParts.slice(0, 30).map(x => clampStr(x, 20));
  if (d.vas != null) out.vas = Number(d.vas) || 0;
  return out;
}
async function pushPending(kind, data) {
  const p = await storeGet(K_PENDING, { bookings: [], intakes: [] });
  if (!Array.isArray(p.bookings)) p.bookings = [];
  if (!Array.isArray(p.intakes)) p.intakes = [];
  const rec = { id: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, data, at: new Date().toISOString() };
  if (kind === 'booking') p.bookings.push(rec); else p.intakes.push(rec);
  if (p.bookings.length > 500) p.bookings = p.bookings.slice(-500);
  if (p.intakes.length > 500) p.intakes = p.intakes.slice(-500);
  await storeSet(K_PENDING, p);
  return rec.id;
}
app.post('/submit-booking', submitLimiter, async (req, res) => {
  try { const id = await pushPending('booking', sanitizeSubmit(req.body)); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/submit-intake', submitLimiter, async (req, res) => {
  try { const id = await pushPending('intake', sanitizeSubmit(req.body)); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.get('/catalog', async (req, res) => res.json(await storeGet(K_CATALOG, { services: [], therapists: [] })));

// 初診表單預填：依電話或姓名查詢病患基本資料
app.get('/patient-prefill', async (req, res) => {
  try {
    const key = (req.query.k || '').trim();
    if (!key) return res.json(null);
    const data = await storeGet(K_CLINIC, null);
    if (!data) return res.json(null);
    const patients = data.PATIENTS || [];
    const intakes  = data.INTAKE_DATA || {};
    const p = patients.find(x => x.phone === key || x.pid === key);
    if (!p) return res.json(null);
    const it = intakes[p.phone] || {};
    res.json({
      name:   p.name   || it.name   || '',
      phone:  p.phone  || '',
      dob:    p.dob    || it.dob    || '',
      idNum:  p.idNum  || it.idNum  || '',
      gender: p.gender || it.gender || ''
    });
  } catch (e) { res.status(500).json(null); }
});

// ★ 公開：只回傳登入畫面 Logo（登入前即可取得，不洩漏其他資料）
app.get('/login-logo', async (req, res) => {
  try {
    const data = await storeGet(K_CLINIC, null);
    res.json({ logo: (data && data.LOGIN_LOGO) || '' });
  } catch (e) { res.json({ logo: '' }); }
});

app.get('/', (req, res) => res.send('領航物理治療所 webhook 伺服器運作中 ✓（儲存：' + (USE_MONGO ? 'MongoDB' : 'JSON 檔') + '）'));

// ════════════════════════════════════════════════
//  受保護端點（需 Google 身分驗證）
// ════════════════════════════════════════════════
app.post('/send-line', lineLimiter, requireStaff, async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    if (!userId || !message) return res.status(400).json({ message: '缺少 userId 或 message' });
    const r = await fetch(`${LINE_API}/message/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: String(message).slice(0, 4500) }] })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return res.json(data);
    return res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});
app.get('/line-users', requireStaff, async (req, res) => res.json(await storeGet(K_USERS, [])));
app.get('/pending-submissions', requireStaff, async (req, res) => res.json(await storeGet(K_PENDING, { bookings: [], intakes: [] })));
app.post('/ack-submissions', requireStaff, async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    const p = await storeGet(K_PENDING, { bookings: [], intakes: [] });
    p.bookings = (p.bookings || []).filter(b => !ids.includes(b.id));
    p.intakes = (p.intakes || []).filter(i => !ids.includes(i.id));
    await storeSet(K_PENDING, p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/publish-catalog', requireStaff, async (req, res) => {
  try { await storeSet(K_CATALOG, req.body || { services: [], therapists: [] }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/clinic-data', requireStaff, async (req, res) => res.json(await storeGet(K_CLINIC, null)));
app.post('/clinic-data', requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, message: '資料格式錯誤' });
    }
    await storeSet(K_CLINIC, body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ════════════════════════════════════════════════
//  明日提醒（手動觸發，需驗證）
//  ★ 範本變數：{name} {date} {time} {endtime} {timerange}
//              {duration} {therapist} {service}
// ════════════════════════════════════════════════
function tomorrowStrTaipei() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  now.setDate(now.getDate() + 1);
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}
function reminderSvc(data, svcId) { return (data.SERVICES || []).find(x => x.id === svcId) || null; }
function reminderSvcName(data, svcId) { const s = reminderSvc(data, svcId); return s ? s.name : '療程'; }
function reminderTherapistName(data, tid) {
  if (data.TN && data.TN[tid]) return data.TN[tid];
  const t = (data.THERAPISTS || []).find(x => x.id === tid);
  return t ? t.name : (tid || '');
}
function fmtMin(min) {
  min = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function reminderStartMin(b) {
  if (b.start != null && !isNaN(b.start)) return Number(b.start);
  const hm = String(b.time || '00:00').split(':');
  return Number(hm[0]) * 60 + (Number(hm[1]) || 0);
}

// 預設範本（與前端「看診提醒」一致，含條款）
const REMINDER_DEFAULT =
  '【領航物理治療所】\n親愛的貴賓，提醒您明日的預約即將到來 🔔\n別忘了準時赴約唷：\n' +
  '📅 {date}\n⏰ {timerange}\n🏥 {service}\n🩺 治療師：{therapist}\n' +
  '如有異動請於前一工作日來電 (02)2826-1698\n\n' +
  '⚠️\n因故遲到者恕不延後治療時段，而費用將以原先預約項目價格進行收費。\n' +
  '為保障其他學員預約需求，如需取消或更改時間，請於「前一工作日18:00前」告知。\n\n' +
  '提醒您：如欲一次性預約≥2次以上的課程，需先預付所有預約的款項。\n\n' +
  '感謝您的配合，謝謝您的體諒，祝您平安順心😇';

function buildReminderMessage(data, booking, patient) {
  const tpl = (data.REMINDER_TEMPLATE && String(data.REMINDER_TEMPLATE).trim()) ? data.REMINDER_TEMPLATE : REMINDER_DEFAULT;
  const sv = reminderSvc(data, booking.svc);
  const dur = sv ? (Number(sv.dur) || 0) : 0;
  const startMin = reminderStartMin(booking);
  const startStr = fmtMin(startMin);
  const endStr = fmtMin(startMin + dur);
  const timeRange = startStr + '–' + endStr + '（共 ' + dur + ' 分鐘）';
  return tpl
    .replace(/{name}/g, (patient && patient.name) || '')
    .replace(/{date}/g, booking.date || '')
    .replace(/{time}/g, booking.time || startStr)
    .replace(/{endtime}/g, endStr)
    .replace(/{timerange}/g, timeRange)
    .replace(/{duration}/g, String(dur))
    .replace(/{therapist}/g, reminderTherapistName(data, booking.t))
    .replace(/{service}/g, reminderSvcName(data, booking.svc));
}

async function pushLineText(userId, text) {
  const r = await fetch(`${LINE_API}/message/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('LINE ' + r.status + ' ' + t); }
  return true;
}
async function sendTomorrowReminders() {
  const data = await storeGet(K_CLINIC, null);
  if (!data) return { sent: 0, skipped: 0, reason: 'no-data' };
  const date = tomorrowStrTaipei();
  const patients = data.PATIENTS || [];
  const bookings = (data.BOOKINGS || []).filter(b => b.date === date && b.status === 'confirmed');
  let sent = 0, skipped = 0;
  for (const b of bookings) {
    const p = patients.find(x => x.phone && x.phone === b.phone);
    if (!p || !p.lineId) { skipped++; continue; }
    try { await pushLineText(p.lineId, buildReminderMessage(data, b, p)); sent++; }
    catch (e) { console.error('[reminder] 推播失敗', e.message); }
  }
  console.log(`[reminder] ${date} 成功 ${sent} 筆，略過 ${skipped} 筆`);
  return { sent, skipped, date };
}
app.post('/send-tomorrow-reminders', requireStaff, async (req, res) => {
  try { const r = await sendTomorrowReminders(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.use((err, req, res, next) => { console.error('未處理錯誤', err.message); res.status(400).json({ ok: false, message: err.message }); });

const PORT = process.env.PORT || 3000;
initStore()
  .catch(e => { console.error('✗ MongoDB 連線失敗，將退回 JSON 檔模式：', e.message); mongoColl = null; })
  .finally(() => {
    app.listen(PORT, () => {
      const usingMongo = USE_MONGO && mongoColl;
      console.log('────────────────────────────────────────');
      console.log('  領航物理治療所 伺服器已啟動 ✓');
      console.log('  • 埠號         ：' + PORT);
      console.log('  • 儲存模式     ：' + (usingMongo ? '🗄  MongoDB（資料持久化）' : '📄 JSON 檔（暫存，重新部署會清空）'));
      if (usingMongo) console.log('  • 資料庫       ：' + MONGODB_DB);
      else if (USE_MONGO) console.log('  ⚠ 有設 MONGODB_URI 但連線失敗，請檢查 Atlas 白名單 / 叢集狀態');
      else console.log('  ⚠ 未設 MONGODB_URI，建議設定以啟用持久化儲存');
      console.log('  • LINE 推播    ：' + (LINE_TOKEN ? '已設定' : '⚠ 未設定 token'));
      console.log('  • Webhook 驗章 ：' + (LINE_SECRET ? '已啟用' : '⚠ 未設定 secret'));
      console.log('  • CORS 限定    ：' + (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '⚠ 未設定（目前放行全部 *）'));
      console.log('  • 後台白名單   ：' + STAFF_EMAILS.length + ' 個帳號');
      console.log('────────────────────────────────────────');
    });
  });

process.on('unhandledRejection', e => console.error('unhandledRejection', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException', e && e.message));
