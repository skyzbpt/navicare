/* 領航物理治療所 後端 API — Google Cloud Run + PostgreSQL
 *
 * 取代原 Render + MongoDB 後端，API 契約與前端 index.html 完全對齊：
 *   管理端（需 Google OAuth Bearer token，email 須在 ALLOWED_EMAILS 白名單）：
 *     GET  /me                     目前登入者 {email,role}；role 由伺服器決定，前端據此開放頁面
 *     GET  /clinic-data            全量快照（含 _rev 版本號；治療師看不到抽成設定）
 *     GET  /clinic-rev             {rev} 目前版本號（前端每分鐘檢查是否有其他裝置存檔）
 *     POST /clinic-data            全量快照覆寫。帶 X-Base-Rev 時版本不符回 409（前端合併後重送）；
 *                                  治療師不能改管理員設定；清空病患／預約／病歷／消費需管理員＋X-Allow-Wipe；
 *                                  另存歷史（最近 30 份＋近 30 天每天一份＋管理員最近 10 份，內容沒變不重複存）
 *     GET  /pending-submissions    未匯入的線上預約/初診 → {bookings:[{id,data}],intakes:[{id,data}]}
 *     POST /ack-submissions        {ids:[...]} 標記已匯入
 *     GET  /line-users             已加好友的 LINE 使用者
 *     POST /send-line              {userId,message} 推播文字（對象須為好友或已綁定病患）
 *     POST /push-receipt-image     {lineUserId,imageBase64} 推播收據圖片（管理員）
 *     POST /send-tomorrow-reminders 依快照推播明日預約提醒 → {date,sent,skipped}（管理員）
 *     POST /publish-catalog        發布線上預約目錄
 *   公開端：
 *     GET  /login-logo             {logo} 登入頁 Logo（取自快照）
 *     GET  /proxy-image?url=       LINE 頭像代理（僅允許 LINE CDN，防 SSRF）
 *     GET  /catalog                LIFF 預約頁讀取的目錄
 *     POST /public-booking         LIFF 預約送出 → submissions
 *     POST /public-intake          LIFF 初診問卷送出 → submissions
 *     GET  /r/:id.png              收據圖片（不可猜測的隨機 id）
 *     GET  /book /intake           LIFF 頁面
 *     POST /webhook                LINE Platform webhook（X-Line-Signature HMAC 驗證）
 *     POST /cron/tomorrow-reminders 每日自動提醒（Cloud Scheduler 帶 X-Cron-Secret；同一天只送一次）
 *     GET  /healthz
 *
 * 環境變數：
 *   DATABASE_URL               postgresql://user:pass@/db?host=/cloudsql/PROJECT:REGION:INSTANCE
 *   GOOGLE_CLIENT_ID           前端同一組 OAuth Client ID（驗 aud）
 *   ALLOWED_EMAILS             逗號分隔的白名單 email
 *   ADMIN_EMAILS               逗號分隔的管理員 email（須為 ALLOWED_EMAILS 子集）；未設定＝全部視為管理員（啟動時警告）
 *   CRON_SECRET                每日自動提醒排程的共用密鑰；未設定則不開放 /cron/tomorrow-reminders
 *   LINE_CHANNEL_SECRET        webhook 簽章驗證
 *   LINE_CHANNEL_ACCESS_TOKEN  推播用
 *   PUBLIC_BASE_URL            本服務對外網址（收據圖片連結用）
 *   LIFF_BOOK_ID / LIFF_INTAKE_ID  LIFF App ID（頁面 liff.init 用）
 *   ALLOWED_ORIGINS            逗號分隔 CORS 來源（預設 *）
 *   PGSSL=require              走 TCP 且需 SSL 時設定
 *   TOKENINFO_URL / LINE_API_BASE  測試用覆寫（預設 Google/LINE 正式端點）
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/* 管理員白名單（ALLOWED_EMAILS 的子集）。未設定時所有授權帳號皆視為管理員，維持既有行為。 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const TOKENINFO_URL = process.env.TOKENINFO_URL || 'https://www.googleapis.com/oauth2/v3/tokeninfo';
const LINE_API_BASE = process.env.LINE_API_BASE || 'https://api.line.me';

const CRON_SECRET = process.env.CRON_SECRET || '';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});
/* 閒置連線被資料庫端切斷（Cloud SQL 維護、容錯移轉、重啟）時 pg 會在 Pool 上發 'error'；
   沒有監聽的話 Node 會把它當成未處理事件直接結束整個程序，所有進行中的請求一起失敗。
   池會自動補新連線，這裡只需記錄即可。 */
pool.on('error', (e) => console.warn('pg idle client error:', e.message));

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinic_snapshot(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS snapshot_history(
      id BIGSERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      saved_by TEXT,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS submissions(
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('booking','intake')),
      data JSONB NOT NULL,
      acked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_unacked ON submissions(acked) WHERE NOT acked;
    CREATE TABLE IF NOT EXISTS line_users(
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      followed BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS catalog(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS receipt_images(
      id TEXT PRIMARY KEY,
      png BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reminder_runs(
      date TEXT PRIMARY KEY,
      source TEXT,
      sent INT NOT NULL DEFAULT 0,
      skipped INT NOT NULL DEFAULT 0,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE clinic_snapshot ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 0;
  `);
}

/* ============ Google OAuth token 驗證（快取至逾期） ============ */
const tokenCache = new Map(); // token -> {email, exp}
async function verifyGoogleToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.email;
  const r = await fetch(TOKENINFO_URL + '?access_token=' + encodeURIComponent(token));
  if (!r.ok) return null;
  const info = await r.json();
  if (!info || !info.email) return null;
  if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) return null; // token 必須是本 app 簽發的
  /* email_verified 未通過就不採信該 email：未驗證的 email 可被冒用來對撞白名單 */
  if (info.email_verified !== undefined && String(info.email_verified) !== 'true') return null;
  const email = String(info.email).toLowerCase();
  const ttl = Math.max(30, Number(info.expires_in || 60)) * 1000;
  if (tokenCache.size > 200) tokenCache.clear();
  tokenCache.set(token, { email, exp: Date.now() + ttl });
  return email;
}
async function auth(req, res, next) {
  try {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ message: '缺少授權' });
    const email = await verifyGoogleToken(m[1]);
    if (!email) return res.status(401).json({ message: '授權無效或已逾期' });
    if (!ALLOWED_EMAILS.includes(email)) return res.status(403).json({ message: '此帳號不在授權名單' });
    req.userEmail = email;
    req.userRole = roleOf(email);
    /* 已驗證身分的回應一律不留快取：內容含病患個資與病歷 */
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (e) {
    res.status(401).json({ message: '授權驗證失敗' });
  }
}
/* 角色由伺服器判定，前端的 EMAIL_WHITELIST 僅作離線備援，不能拿來提權 */
function roleOf(email) {
  if (!ADMIN_EMAILS.length) return 'admin';
  return ADMIN_EMAILS.includes(email) ? 'admin' : 'therapist';
}
function adminOnly(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ message: '此操作僅限管理員' });
  next();
}

/* ============ LINE ============ */
function lineSignatureValid(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signature)); } catch (e) { return false; }
}
async function linePush(to, messages) {
  const r = await fetch(LINE_API_BASE + '/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ to, messages }),
  });
  if (!r.ok) {
    let msg = 'LINE HTTP ' + r.status;
    try { const j = await r.json(); if (j && j.message) msg = j.message; } catch (e) {}
    throw new Error(msg);
  }
}
async function lineProfile(userId) {
  const r = await fetch(LINE_API_BASE + '/v2/bot/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
  });
  if (!r.ok) return null;
  return r.json();
}

const app = express();
app.set('x-powered-by', false);
/* 只信任「最靠近本服務的 1 跳」代理（Cloud Run 的 GFE）。
   用 true 會信任整條 X-Forwarded-For，req.ip 取最左側＝呼叫端自己塞的值，
   攻擊者只要每次換一個假 IP 就能完全繞過下方的公開端點節流。
   設為 1 時 req.ip 取 GFE 附加的那一段，才是真實來源位址。
   若日後在 Cloud Run 前面再加一層 LB／CDN，請把數字加到對應的跳數。 */
app.set('trust proxy', 1);

/* 一般性安全標頭：本服務只回 JSON／圖片／少數靜態頁，全部禁止嗅探與內嵌 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  /* LIFF 頁面交由 LINE 用戶端載入，不加 frame 限制以免影響既有流程；其餘一律禁止被內嵌 */
  if (req.path !== '/book' && req.path !== '/intake') res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // 前端與 LIFF 頁需跨源載入頭貼／收據圖
  next();
});

/* CORS：前端與 LIFF 頁面跨域呼叫（Authorization 標頭需要 preflight） */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED_ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Base-Rev, X-Allow-Wipe');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* LINE webhook 需要原始 body 驗簽章，必須排在 json parser 之前 */
app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = req.body || Buffer.alloc(0);
  if (!lineSignatureValid(raw, req.headers['x-line-signature'])) return res.status(403).end();
  res.status(200).end(); // 先回 200，處理放背景（LINE 要求快速回應）
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  const events = (body && body.events) || [];
  for (const ev of events) {
    try {
      const uid = ev.source && ev.source.userId;
      if (!uid) continue;
      if (ev.type === 'unfollow') {
        await pool.query('UPDATE line_users SET followed=false, updated_at=now() WHERE user_id=$1', [uid]);
        continue;
      }
      if (ev.type === 'follow' || ev.type === 'message') {
        const prof = await lineProfile(uid);
        await pool.query(
          `INSERT INTO line_users(user_id, display_name, picture_url, followed, updated_at)
           VALUES($1,$2,$3,true,now())
           ON CONFLICT(user_id) DO UPDATE SET
             display_name=COALESCE(EXCLUDED.display_name, line_users.display_name),
             picture_url=COALESCE(EXCLUDED.picture_url, line_users.picture_url),
             followed=true, updated_at=now()`,
          [uid, prof && prof.displayName || null, prof && prof.pictureUrl || null]
        );
      }
    } catch (e) { console.warn('webhook event error:', e.message); }
  }
});

/* Body 大小分兩級：
   - 已驗證身分的快照／收據圖需要放寬到 30mb（含 base64 Logo、印章、收據 PNG）
   - 公開端點（LIFF 表單、目錄查詢）只需要幾十 KB；若也給 30mb，未驗證的呼叫端就能反覆
     丟大 body 逼伺服器解析，節流是在 handler 內才判斷的，擋不到解析階段的資源消耗。 */
const jsonLarge = express.json({ limit: '30mb' });
const jsonSmall = express.json({ limit: '64kb' });
const LARGE_BODY_PATHS = new Set(['/clinic-data', '/push-receipt-image', '/publish-catalog']);
function wantsLargeBody(req) { return req.method === 'POST' && LARGE_BODY_PATHS.has(req.path); }
/* 放寬上限前先驗身分：auth 不需要 body，提早跑就能讓未授權的大 body 在解析前被 401 擋下。
   token 會命中 tokenCache，路由層再跑一次 auth 不會多打一次 Google。 */
app.use((req, res, next) => (wantsLargeBody(req) ? auth(req, res, next) : next()));
app.use((req, res, next) => (wantsLargeBody(req) ? jsonLarge : jsonSmall)(req, res, next));

/* ============ 健康檢查 ============ */
app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});
/* 根目錄：純 API 服務，提供人可讀的狀態頁（含資料庫連線檢查） */
app.get('/', async (req, res) => {
  let db = false;
  try { await pool.query('SELECT 1'); db = true; } catch (e) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(db ? 200 : 503).end(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center">' +
    '<div style="font-size:52px">' + (db ? '✅' : '⚠️') + '</div>' +
    '<h2 style="color:#1a4d68">領航物理治療所 後端</h2>' +
    '<p style="font-size:16px">服務狀態：<b>運作中</b><br>資料庫連線：<b>' + (db ? '正常' : '異常') + '</b></p>' +
    '<p style="color:#64748b;font-size:13px">這是 API 伺服器，不是管理介面。請由管理系統前端登入使用。</p>' +
    '</div>'
  );
});

/* ============ 身分 ============ */
/* 前端據此決定可用頁面；角色只認伺服器這一份，前端自帶的名單改不動權限 */
app.get('/me', auth, (req, res) => res.json({ email: req.userEmail, role: req.userRole }));

/* ============ 快照 ============ */
/* 只有管理員能改的設定。治療師存檔時這些欄位一律沿用伺服器上的現值（前端角色只是畫面，
   不能靠它擋住直接呼叫 API 的人）：薪資抽成、印花稅、診所資料與 Logo、提醒文字、課程／服務與發布設定 */
const ADMIN_ONLY_KEYS = ['T_SVC_RATES', 'STAMPS', 'STAMP_T', 'CLINIC_INFO', 'CLINIC_LOGO', 'LOGIN_LOGO', 'REMINDER_TEMPLATE',
  'PACKAGES', 'PKG_ID', 'SERVICES', 'SVC_ID', 'PUBLISHED_SVC_IDS', 'PUBLISHED_PKG_IDS'];
/* 治療師看不到的欄位（同事的抽成設定）；回存時由上面的規則補回伺服器現值 */
const ADMIN_READ_KEYS = ['T_SVC_RATES'];
/* 這幾類資料一旦整批消失就是災難（登入時讀取失敗卻把空白狀態存回、竄改、誤操作）。
   原本有資料、這次卻變成空的，必須是管理員且明確帶 X-Allow-Wipe（還原備份／清空重置）才放行 */
const CRITICAL_KEYS = ['PATIENTS', 'BOOKINGS', 'SOAP_NOTES', 'PAYMENTS'];
/* 只影響單一裝置提示狀態、每次存檔都會變動的欄位，比對「內容是否真的變了」時忽略 */
const VOLATILE_KEYS = ['_backupAt', '_lastSeen', '_seenSubIds', 'NOTIFY_LOG'];
const arrLen = (v) => (Array.isArray(v) ? v.length : 0);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

app.get('/clinic-data', auth, async (req, res) => {
  const r = await pool.query('SELECT data, rev FROM clinic_snapshot WHERE id=1');
  const data = r.rows.length && isObj(r.rows[0].data) ? Object.assign({}, r.rows[0].data) : {};
  if (req.userRole !== 'admin') ADMIN_READ_KEYS.forEach((k) => delete data[k]);
  /* _rev 讓前端知道自己讀到的是哪一版，存檔時帶回來做衝突偵測（不寫進資料庫） */
  data._rev = r.rows.length ? Number(r.rows[0].rev) : 0;
  res.json(data);
});
/* 輕量版本查詢：前端每分鐘檢查一次，有其他裝置存過檔才重新下載整份快照 */
app.get('/clinic-rev', auth, async (req, res) => {
  const r = await pool.query('SELECT rev FROM clinic_snapshot WHERE id=1');
  res.json({ rev: r.rows.length ? Number(r.rows[0].rev) : 0 });
});
app.post('/clinic-data', auth, async (req, res) => {
  const snap = isObj(req.body) ? Object.assign({}, req.body) : {};
  delete snap._rev;
  const isAdmin = req.userRole === 'admin';
  const baseHdr = req.get('X-Base-Rev');
  const allowWipe = req.get('X-Allow-Wipe') === '1';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    /* 鎖住這一列：同時兩台裝置存檔時依序處理，版本比對才可靠 */
    const cur = await client.query('SELECT data, rev FROM clinic_snapshot WHERE id=1 FOR UPDATE');
    const curData = cur.rows.length && isObj(cur.rows[0].data) ? cur.rows[0].data : {};
    const curRev = cur.rows.length ? Number(cur.rows[0].rev) : 0;
    /* 衝突偵測：前端帶著「我是根據第幾版改的」。中間有別台裝置存過檔就回 409，
       由前端把兩邊的變更合併後再送，不再整份互相覆蓋。沒帶標頭的呼叫（舊版前端、手動工具）維持原行為。 */
    if (baseHdr != null && baseHdr !== '' && Number(baseHdr) !== curRev) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: '資料已在其他裝置更新', rev: curRev });
    }
    if (!isAdmin) {
      ADMIN_ONLY_KEYS.forEach((k) => { if (k in curData) snap[k] = curData[k]; else delete snap[k]; });
    }
    /* 管理員刪到最後一兩筆（例如剛開始使用、作廢唯一一筆消費）屬正常操作，只有原本 3 筆以上整批變空才擋 */
    const wiped = CRITICAL_KEYS.filter((k) => arrLen(curData[k]) >= (isAdmin ? 3 : 1) && arrLen(snap[k]) === 0);
    if (wiped.length && !(isAdmin && allowWipe)) {
      await client.query('ROLLBACK');
      return res.status(isAdmin ? 409 : 403).json({
        message: isAdmin ? '這次存檔會清空 ' + wiped.join('、') + '，已拒絕（還原備份或清空重置請用管理介面的對應功能）' : '清空伺服器資料僅限管理員',
        code: 'wipe', keys: wiped,
      });
    }
    /* 非管理員一次刪掉大量資料也擋下（正常操作是一筆一筆刪） */
    if (!isAdmin) {
      const shrunk = CRITICAL_KEYS.filter((k) => { const a = arrLen(curData[k]), b = arrLen(snap[k]); return a - b >= 20 && b < a / 2; });
      if (shrunk.length) { await client.query('ROLLBACK'); return res.status(403).json({ message: '一次刪除大量資料僅限管理員', code: 'shrink', keys: shrunk }); }
    }
    const newRev = curRev + 1;
    await client.query(
      `INSERT INTO clinic_snapshot(id, data, rev, updated_at) VALUES(1,$1,$2,now())
       ON CONFLICT(id) DO UPDATE SET data=$1, rev=$2, updated_at=now()`,
      [snap, newRev]
    );
    /* 歷史：內容（忽略只影響提示狀態的欄位）跟上一份相同就不再存，避免單純換頁就把好的備份擠掉 */
    const strip = VOLATILE_KEYS.map((k) => `- '${k}'`).join(' ');
    const last = await client.query(`SELECT (data ${strip}) = ($1::jsonb ${strip}) AS same FROM snapshot_history ORDER BY id DESC LIMIT 1`, [snap]);
    if (!last.rows.length || !last.rows[0].same) {
      await client.query('INSERT INTO snapshot_history(data, saved_by) VALUES($1,$2)', [snap, req.userEmail]);
      /* 保留：最近 30 份＋近 30 天每天最後一份＋管理員最近 10 份。
         只按筆數保留的話，任何人連續存檔 30 次就能把所有可還原的版本擠光。 */
      await client.query(
        `DELETE FROM snapshot_history WHERE
           id NOT IN (SELECT id FROM snapshot_history ORDER BY id DESC LIMIT 30)
           AND id NOT IN (SELECT DISTINCT ON (date_trunc('day', saved_at AT TIME ZONE 'Asia/Taipei')) id FROM snapshot_history
                          WHERE saved_at > now() - interval '30 days'
                          ORDER BY date_trunc('day', saved_at AT TIME ZONE 'Asia/Taipei') DESC, id DESC)
           AND id NOT IN (SELECT id FROM snapshot_history WHERE saved_by = ANY($1::text[]) ORDER BY id DESC LIMIT 10)`,
        [ADMIN_EMAILS]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, rev: newRev });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

/* ============ 線上送出（預約/初診） ============ */
/* 預約與初診分開取、各取最新 300 筆（再依送出順序回傳）。
   全部混在一起只取最舊 500 筆的話，前端暫留未確認的項目（待人工處理清單已滿）或大量洗版的預約
   會永遠佔住前面的名額，之後真正的初診與預約就再也取不到。 */
app.get('/pending-submissions', auth, async (req, res) => {
  const q = (kind) => pool.query(
    `SELECT id, data FROM (SELECT id, data FROM submissions WHERE NOT acked AND kind=$1 ORDER BY id DESC LIMIT 300) t ORDER BY id ASC`, [kind]);
  const [b, i] = await Promise.all([q('booking'), q('intake')]);
  const pick = (rows) => rows.map((row) => ({ id: row.id, data: row.data }));
  res.json({ bookings: pick(b.rows), intakes: pick(i.rows) });
});
app.post('/ack-submissions', auth, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(n => Number.isFinite(n)) : [];
  if (ids.length) await pool.query('UPDATE submissions SET acked=true WHERE id = ANY($1::bigint[])', [ids]);
  res.json({ ok: true });
});

/* 與前端相同的電話規則（只允許半形空白）。先把全形數字、全形空白、不換行空白轉成半形：
   中文輸入法常打出全形字元，不轉換的話這裡收下了、管理介面匯入時卻會因格式不符略過 */
const PHONE_RE = /^[\d()\-+ ]{5,20}$/;
function normPhone(v) {
  return String(typeof v === 'string' ? v : '').replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF08\uFF09\uFF0B]/g, (c) => ({ '\uFF08': '(', '\uFF09': ')', '\uFF0B': '+' }[c]))
    .replace(/[\uFF0D\uFE63\u2212\u2010-\u2015]/g, '-').replace(/[\s\u00a0\u3000]+/g, ' ').trim().slice(0, 20);
}
function cleanStr(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : ''; }
/* 簡易節流：同 IP 每分鐘 20 次公開提交。
   用固定時間窗計數（每個 IP 只存一組數字），不保存每次請求的時間戳——
   後者在被擋的請求持續湧入時會無限變長，每次過濾都更慢，反而成了消耗伺服器的手段。 */
const rl = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = rl.get(ip);
  if (!e || now - e.start >= 60000) { e = { start: now, n: 0 }; rl.set(ip, e); }
  e.n++;
  if (rl.size > 5000) { for (const [k, v] of rl) if (now - v.start >= 60000) rl.delete(k); if (rl.size > 5000) rl.clear(); }
  return e.n > 20;
}
/* 硬上限：即使節流被繞過，也不讓未匯入的公開送出無限增長（防儲存耗盡/洗版） */
async function submissionsFull() {
  const c = await pool.query('SELECT count(*)::int AS n FROM submissions WHERE NOT acked');
  return c.rows[0].n >= 2000;
}
app.post('/public-booking', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ message: '請稍後再試' });
  if (await submissionsFull()) return res.status(429).json({ message: '目前系統繁忙，請稍後再試或改用電話預約' });
  const d = req.body || {};
  const data = {
    name: cleanStr(d.name, 50), phone: normPhone(d.phone),
    date: cleanStr(d.date, 10), time: cleanStr(d.time, 5),
    t: cleanStr(d.t, 30), svc: cleanStr(d.svc, 30), note: cleanStr(d.note, 300),
    lineUserId: cleanStr(d.lineUserId, 50), linePictureUrl: cleanStr(d.linePictureUrl, 500), lineDisplayName: cleanStr(d.lineDisplayName, 50),
  };
  if (!data.name || !PHONE_RE.test(data.phone)) return res.status(400).json({ message: '請填寫姓名與有效電話' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !/^\d{2}:\d{2}$/.test(data.time)) return res.status(400).json({ message: '日期或時間格式錯誤' });
  await pool.query(`INSERT INTO submissions(kind, data) VALUES('booking',$1)`, [data]);
  res.json({ ok: true });
});
app.post('/public-intake', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ message: '請稍後再試' });
  if (await submissionsFull()) return res.status(429).json({ message: '目前系統繁忙，請稍後再試' });
  const d = req.body || {};
  const data = {
    name: cleanStr(d.name, 50), phone: normPhone(d.phone), gender: ['male', 'female'].includes(d.gender) ? d.gender : '',
    dob: cleanStr(d.dob, 10), idNum: cleanStr(d.idNum, 12), address: cleanStr(d.address, 200), occupation: cleanStr(d.occupation, 50),
    emergencyName: cleanStr(d.emergencyName, 50), emergencyPhone: normPhone(d.emergencyPhone),
    referral: Array.isArray(d.referral) ? d.referral.slice(0, 8).map(x => cleanStr(x, 20)) : [],
    complaint: cleanStr(d.complaint, 500), duration: cleanStr(d.duration, 50),
    vas: Number.isFinite(Number(d.vas)) ? Math.max(0, Math.min(10, Number(d.vas))) : null,
    bodyParts: Array.isArray(d.bodyParts) ? d.bodyParts.slice(0, 20).map(x => cleanStr(x, 20)) : [],
    medicalHistory: cleanStr(d.medicalHistory, 1000), injuryHistory: cleanStr(d.injuryHistory, 1000),
    surgeryHistory: cleanStr(d.surgeryHistory, 1000), exerciseHabit: cleanStr(d.exerciseHabit, 1000),
    lineUserId: cleanStr(d.lineUserId, 50), linePictureUrl: cleanStr(d.linePictureUrl, 500), lineDisplayName: cleanStr(d.lineDisplayName, 50),
  };
  if (!data.name || !PHONE_RE.test(data.phone)) return res.status(400).json({ message: '請填寫姓名與有效電話' });
  await pool.query(`INSERT INTO submissions(kind, data) VALUES('intake',$1)`, [data]);
  res.json({ ok: true });
});

/* ============ LINE 使用者 / 推播 ============ */
app.get('/line-users', auth, async (req, res) => {
  const r = await pool.query('SELECT user_id, display_name, picture_url FROM line_users WHERE followed ORDER BY updated_at DESC LIMIT 500');
  res.json(r.rows.map(x => ({ userId: x.user_id, displayName: x.display_name || '', pictureUrl: x.picture_url || '' })));
});
/* 推播對象只限本診所 LINE 官方帳號的好友，或已綁定在病患資料上的 LINE。
   不檢查的話，任何登入者都能拿診所的官方帳號對任意 userId 發訊息。 */
async function isKnownLineUser(uid) {
  const a = await pool.query('SELECT 1 FROM line_users WHERE user_id=$1', [uid]);
  if (a.rows.length) return true;
  const b = await pool.query(
    `SELECT 1 FROM clinic_snapshot, jsonb_array_elements(CASE WHEN jsonb_typeof(data->'PATIENTS')='array' THEN data->'PATIENTS' ELSE '[]'::jsonb END) p
     WHERE id=1 AND p->>'lineId'=$1 LIMIT 1`, [uid]);
  return b.rows.length > 0;
}
app.post('/send-line', auth, async (req, res) => {
  const { userId, message } = req.body || {};
  if (!userId || !message) return res.status(400).json({ message: '缺少 userId 或 message' });
  if (typeof userId !== 'string' || !(await isKnownLineUser(userId))) return res.status(403).json({ message: '此 LINE 帳號不是診所好友或未綁定病患' });
  try {
    await linePush(userId, [{ type: 'text', text: String(message).slice(0, 5000) }]);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ message: e.message }); }
});
app.post('/push-receipt-image', auth, adminOnly, async (req, res) => {
  const { lineUserId, imageBase64 } = req.body || {};
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(imageBase64 || '');
  if (!lineUserId || !m) return res.status(400).json({ message: '缺少 lineUserId 或圖片格式錯誤' });
  const png = Buffer.from(m[1], 'base64');
  if (png.length > 8 * 1024 * 1024) return res.status(400).json({ message: '圖片過大' });
  if (typeof lineUserId !== 'string' || !(await isKnownLineUser(lineUserId))) return res.status(403).json({ message: '此 LINE 帳號不是診所好友或未綁定病患' });
  const id = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO receipt_images(id, png) VALUES($1,$2)', [id, png]);
  const url = PUBLIC_BASE_URL + '/r/' + id + '.png';
  try {
    await linePush(lineUserId, [{ type: 'image', originalContentUrl: url, previewImageUrl: url }]);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ message: e.message }); }
});
app.get('/r/:file', async (req, res) => {
  const id = String(req.params.file || '').replace(/\.png$/, '');
  if (!/^[0-9a-f]{32}$/.test(id)) return res.status(404).end();
  const r = await pool.query('SELECT png FROM receipt_images WHERE id=$1', [id]);
  if (!r.rows.length) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(r.rows[0].png);
});

/* ============ 明日預約提醒 ============ */
/* 與前端「診所管理 → LINE 提醒內容」顯示的預設文字完全相同（含遲到／取消規定），未自訂時兩邊送出的內容才會一致 */
const REMINDER_DEFAULT = '【領航物理治療所】\n親愛的{name} ，提醒您明日的預約即將到來 🔔\n別忘了準時赴約唷：\n📅 {date}\n⏰ {timerange}\n🏥 {service}\n🩺 治療師：{therapist}\n\n⚠️\n因故遲到者恕不延後治療時段\n而費用將以原先預約項目價格進行收費\n為保障其他學員預約需求\n如需取消或更改時間\n請於「前一工作日18:00前」告知\n\n提醒您：如欲一次性預約≥2次以上的課程\n需先預付所有預約的款項\n\n感謝您的配合，謝謝您的體諒，祝您平安順心😇';
function taipeiDateStr(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600e3 + (offsetDays || 0) * 86400e3);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function fmtMin(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
async function sendTomorrowReminders() {
  const r = await pool.query('SELECT data FROM clinic_snapshot WHERE id=1');
  const s = r.rows.length && isObj(r.rows[0].data) ? r.rows[0].data : {};
  const tomorrow = taipeiDateStr(1);
  const bookings = (Array.isArray(s.BOOKINGS) ? s.BOOKINGS : []).filter(b => b && b.date === tomorrow && b.status === 'confirmed');
  const patients = Array.isArray(s.PATIENTS) ? s.PATIENTS : [];
  const services = {}; (Array.isArray(s.SERVICES) ? s.SERVICES : []).forEach(x => { if (x) services[x.id] = x; });
  const tn = isObj(s.TN) ? s.TN : {};
  const tpl = (s.REMINDER_TEMPLATE && String(s.REMINDER_TEMPLATE).trim()) || REMINDER_DEFAULT;
  let sent = 0, skipped = 0;
  for (const b of bookings) {
    const p = patients.find(x => x && ((x.phone && x.phone === b.phone) || (x.pid && x.pid === b.phone)));
    if (!p || !p.lineId) { skipped++; continue; }
    const svc = services[b.svc] || {};
    const dur = Number(svc.dur) || 50;
    const start = Number.isFinite(Number(b.start)) ? Number(b.start) : (function () { const hm = String(b.time || '00:00').split(':'); return Number(hm[0]) * 60 + Number(hm[1] || 0); })();
    const end = start + dur;
    const msg = tpl
      .replace(/{name}/g, b.name || p.name || '')
      .replace(/{date}/g, b.date)
      .replace(/{timerange}/g, fmtMin(start) + '–' + fmtMin(end) + '（共 ' + dur + ' 分鐘）')
      .replace(/{endtime}/g, fmtMin(end))
      .replace(/{duration}/g, String(dur))
      .replace(/{therapist}/g, tn[b.t] || '')
      .replace(/{time}/g, fmtMin(start))
      .replace(/{service}/g, svc.name || '');
    try { await linePush(p.lineId, [{ type: 'text', text: msg }]); sent++; }
    catch (e) { console.warn('reminder push failed:', e.message); skipped++; }
  }
  return { date: tomorrow, sent, skipped };
}
/* 手動「立即推播明日提醒」：僅管理員（提醒文字由管理員設定，治療師不能拿官方帳號對所有病患發訊） */
app.post('/send-tomorrow-reminders', auth, adminOnly, async (req, res) => {
  const out = await sendTomorrowReminders();
  await pool.query(
    `INSERT INTO reminder_runs(date, source, sent, skipped) VALUES($1,$2,$3,$4)
     ON CONFLICT(date) DO UPDATE SET source=$2, sent=reminder_runs.sent+$3, skipped=$4, ran_at=now()`,
    [out.date, 'manual:' + req.userEmail, out.sent, out.skipped]);
  res.json(out);
});
/* 每日自動推播：由 Cloud Scheduler 每天呼叫一次（見 DEPLOY.md）。
   以 X-Cron-Secret 驗證（Secret 只存在 Cloud Run 環境變數與排程設定）；同一天只會送一次，
   排程重試或手動已推播過都不會重複發給病患。未設定 CRON_SECRET 時此端點不存在。 */
app.post('/cron/tomorrow-reminders', async (req, res) => {
  const got = String(req.get('X-Cron-Secret') || '');
  if (!CRON_SECRET || got.length !== CRON_SECRET.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(CRON_SECRET))) return res.status(404).end();
  const date = taipeiDateStr(1);
  const claim = await pool.query(`INSERT INTO reminder_runs(date, source) VALUES($1,'cron') ON CONFLICT(date) DO NOTHING RETURNING date`, [date]);
  if (!claim.rows.length) return res.json({ date, alreadySent: true });
  const out = await sendTomorrowReminders();
  await pool.query('UPDATE reminder_runs SET sent=$2, skipped=$3, ran_at=now() WHERE date=$1', [date, out.sent, out.skipped]);
  res.json(out);
});

/* ============ 目錄（線上預約用） ============ */
app.post('/publish-catalog', auth, adminOnly, async (req, res) => {
  const cat = req.body && typeof req.body === 'object' ? req.body : {};
  await pool.query(
    `INSERT INTO catalog(id, data, updated_at) VALUES(1,$1,now())
     ON CONFLICT(id) DO UPDATE SET data=$1, updated_at=now()`,
    [cat]
  );
  res.json({ ok: true });
});
app.get('/catalog', async (req, res) => {
  const r = await pool.query('SELECT data FROM catalog WHERE id=1');
  res.json(r.rows.length ? r.rows[0].data : {});
});

/* ============ 公開資源 ============ */
app.get('/login-logo', async (req, res) => {
  const r = await pool.query(`SELECT data->>'LOGIN_LOGO' AS logo FROM clinic_snapshot WHERE id=1`);
  res.json({ logo: (r.rows.length && r.rows[0].logo) || null });
});
const PROXY_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*(line-scdn\.net|line-apps\.com)\//i;
app.get('/proxy-image', async (req, res) => {
  let url = String(req.query.url || '');
  if (!PROXY_HOST_RE.test(url)) return res.status(400).json({ message: '不允許的來源' });
  try {
    /* 自己處理轉址，每一跳都重新過一次白名單：
       - redirect:'follow' 會讓白名單網域把我們導去內網（GCP metadata、私有服務）造成 SSRF 繞過
       - 但一律拒絕 3xx 也會擋掉 LINE CDN 自身的正常轉址，頭貼就抓不回來
       折衷成「跟隨轉址，但只跟到仍在白名單內的網址」，最多 3 跳。 */
    let r;
    for (let hop = 0; ; hop++) {
      r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (r.status < 300 || r.status >= 400) break;
      const loc = r.headers.get('location');
      if (!loc || hop >= 3) return res.status(400).end();
      try { url = new URL(loc, url).toString(); } catch (e) { return res.status(400).end(); }
      if (!PROXY_HOST_RE.test(url)) return res.status(400).end();
    }
    if (!r.ok) return res.status(502).end();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(ct)) return res.status(400).end();
    if (Number(r.headers.get('content-length') || 0) > 5 * 1024 * 1024) return res.status(400).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return res.status(400).end();
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch (e) { res.status(502).end(); }
});

/* ============ LIFF 頁面（注入 LIFF ID） ============ */
function servePage(file, liffId) {
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8').replace(/__LIFF_ID__/g, liffId || '');
  return (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); };
}
app.get('/book', servePage('book.html', process.env.LIFF_BOOK_ID));
app.get('/intake', servePage('intake.html', process.env.LIFF_INTAKE_ID));

/* 統一錯誤處理。body-parser 的「格式錯誤／超過大小上限」帶有 4xx status，
   一律轉成 500 會讓呼叫端誤判為伺服器故障而重試，因此 4xx 照原樣回傳。 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ message: status === 413 ? '內容過大' : '請求格式錯誤' });
  }
  console.error('unhandled:', err && err.message);
  res.status(500).json({ message: '伺服器錯誤' });
});

/* 個資保留期限：線上初診／預約匯入後內容已存進診所快照，原始送出（含身分證字號、病史）確認後保留 30 天備查即刪除；
   收據圖片 60 天後刪除。啟動時與每 6 小時各跑一次（Cloud Run 會縮到 0，所以啟動時也要跑）。 */
async function purgeOld() {
  try {
    const a = await pool.query(`DELETE FROM submissions WHERE acked AND created_at < now() - interval '30 days'`);
    const b = await pool.query(`DELETE FROM receipt_images WHERE created_at < now() - interval '60 days'`);
    if (a.rowCount || b.rowCount) console.log('purged submissions:', a.rowCount, 'receipts:', b.rowCount);
  } catch (e) { console.warn('purge failed:', e.message); }
}

initSchema().then(() => {
  if (!ADMIN_EMAILS.length) console.warn('警告：未設定 ADMIN_EMAILS，所有授權帳號都會是管理員');
  purgeOld();
  setInterval(purgeOld, 6 * 3600e3).unref();
  app.listen(PORT, () => console.log('navicare-api listening on :' + PORT));
}).catch(e => { console.error('schema init failed:', e.message); process.exit(1); });
