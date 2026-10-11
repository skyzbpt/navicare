# 部署指南：Google Cloud Run + PostgreSQL（取代 Render + MongoDB）

後端 API 契約與 `index.html` 前端**完全對齊**，切換時前端只需改兩行（見步驟 6）。

## ⚡ 快速部署（腳本版，推薦）

在 [Google Cloud Shell](https://shell.cloud.google.com) 執行：

```bash
git clone https://github.com/skyzbpt/navicare.git
cd navicare && git checkout claude/index-html-review-r42g2e && cd server
bash deploy.sh          # 互動式：只需輸入 3 個密碼，其餘全自動（步驟 1–3）
bash smoke-test.sh <部署完成印出的網址>   # 自動驗收 13 項
```

之後照下方**步驟 4（備份舊資料）→ 步驟 5（LINE Console）→ 步驟 6（前端切換，
可用 `bash ../scripts/switch-frontend.sh <網址>`）→ 步驟 7（還原資料）** 完成切換。
以下手動步驟說明保留作為腳本的對照與故障排除參考。

## 架構

```
前端 index.html（靜態託管，不變）
   │  Bearer <Google OAuth token>
   ▼
Cloud Run（server/ 本目錄，Node 22 + Express 5）
   │
   ├── Cloud SQL for PostgreSQL 16（unix socket 連線）
   ├── LINE Messaging API（webhook 接收 / 推播）
   └── LIFF 頁面：/book 線上預約、/intake 初診問卷
```

PostgreSQL 資料表（啟動時自動建立，無需手動跑 migration）：

| 資料表 | 用途 |
|---|---|
| `clinic_snapshot` | 全量快照（單列 JSONB，對應原 Mongo 文件模型）|
| `snapshot_history` | 每次儲存留存（最近 30 份，含操作者 email，誤刪可救）|
| `submissions` | 線上預約/初診送出（`acked` 標記是否已匯入）|
| `line_users` | LINE 好友（webhook 自動維護）|
| `catalog` | 已發布的線上預約目錄 |
| `receipt_images` | 收據圖片（推播用，60 天自動清除）|

## 步驟 1：建立 GCP 專案與 API

```bash
gcloud auth login
gcloud projects create navicare-clinic --name="NaviCare"   # 或用既有專案
gcloud config set project navicare-clinic
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com
```

## 步驟 2：建立 Cloud SQL PostgreSQL

```bash
gcloud sql instances create navicare-pg \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=asia-east1 \
  --storage-size=10GB

gcloud sql databases create navicare --instance=navicare-pg
gcloud sql users create navicare --instance=navicare-pg --password='<設一組強密碼>'
```

> 💰 `db-f1-micro` 每月約 US$8–10，診所單店規模綽綽有餘。
> 想更省可改用 [Neon](https://neon.tech)/[Supabase](https://supabase.com) 免費層 Postgres，
> 把 `DATABASE_URL` 換成他們給的連線字串並設 `PGSSL=require`，可跳過本步驟。

## 步驟 3：部署 Cloud Run

在 `server/` 目錄執行（env 含逗號，故用 `^##^` 分隔符）：

```bash
gcloud run deploy navicare-api \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --max-instances 2 \
  --add-cloudsql-instances navicare-clinic:asia-east1:navicare-pg \
  --set-env-vars '^##^DATABASE_URL=postgresql://navicare:<密碼>@/navicare?host=/cloudsql/navicare-clinic:asia-east1:navicare-pg##GOOGLE_CLIENT_ID=488516957607-6pt8ofca357qrj5fgpjk8n67i6krvr4d.apps.googleusercontent.com##ALLOWED_EMAILS=nycuptc@gmail.com,yewfir@gmail.com,skyzbpt@gmail.com##LINE_CHANNEL_SECRET=<LINE channel secret>##LINE_CHANNEL_ACCESS_TOKEN=<LINE channel access token>##PUBLIC_BASE_URL=https://<部署後的網址>##LIFF_BOOK_ID=2010433876-ySl8EsUh##LIFF_INTAKE_ID=2010433876-2HSNBpkC'
```

部署完成會得到網址如 `https://navicare-api-xxxx-de.a.run.app`。
**第一次部署後**，把 `PUBLIC_BASE_URL` 更新成這個實際網址再部署一次
（收據圖片推播的連結需要它）：

```bash
gcloud run services update navicare-api --region asia-east1 \
  --update-env-vars PUBLIC_BASE_URL=https://navicare-api-xxxx-de.a.run.app
```

驗證：`curl https://navicare-api-xxxx-de.a.run.app/healthz` → `{"ok":true}`

## 步驟 4：遷移資料（不碰 MongoDB，用 App 內建備份/還原）

1. 舊系統仍在線時：登入前端 → 儀表板 → 資料備份 → **加密備份（.ncek）**下載
2. 前端切到新後端（步驟 6）後：登入 → 資料備份 → **還原加密備份** → 選剛才的檔案
3. 完成。所有病患、預約、病歷、消費、設定全部進入 PostgreSQL

> 為什麼不用 mongoexport？App 的資料模型就是「單一全量快照」，
> 前端內建的備份檔即完整資料，還原功能已在生產環境驗證過，
> 比手寫 Mongo→PG 欄位對應可靠得多。
>
> LINE 好友清單（`line_users`）不在快照內，會在好友下次傳訊/加好友時
> 由 webhook 自動重建；已綁定病患的 lineId 都存在快照裡，不受影響。
> 尚未匯入的線上預約請在切換前先按「匯入全部」。

## 步驟 5：LINE Developers Console 切換

<https://developers.line.biz/console/> → 你的 Channel：

1. **Messaging API → Webhook URL**：改為 `https://<cloud-run網址>/webhook` → Verify
2. **LIFF → 線上預約 App（2010433876-ySl8EsUh）**：Endpoint URL 改為 `https://<cloud-run網址>/book`
3. **LIFF → 初診問卷 App（2010433876-2HSNBpkC）**：Endpoint URL 改為 `https://<cloud-run網址>/intake`

LIFF 網址（`https://liff.line.me/2010433876-...`）不變，前端無需改 LIFF 常數。

## 步驟 6：前端切換（index.html 改兩處）

```js
// 1. RENDER_URL 常數（約 line 318）
var RENDER_URL='https://navicare-api-xxxx-de.a.run.app';
```

```html
<!-- 2. CSP meta 的 connect-src（line 6）：把 onrender.com 換成 Cloud Run 網址 -->
connect-src 'self' https://navicare-api-xxxx-de.a.run.app https://www.googleapis.com https://accounts.google.com;
```

部署新版前端 → 登入 → 執行步驟 4 的還原 → 驗證各頁面資料。
確認正常運作一週後再關閉 Render 服務與 MongoDB。

## 環境變數一覽

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres 連線字串（Cloud SQL 用 `?host=/cloudsql/...` socket）|
| `GOOGLE_CLIENT_ID` | ✅ | 與前端相同的 OAuth Client ID（驗證 token `aud`）|
| `ALLOWED_EMAILS` | ✅ | 逗號分隔的登入白名單（與前端 EMAIL_WHITELIST 對齊）|
| `ADMIN_EMAILS` | 選 | 逗號分隔的管理員（須為 `ALLOWED_EMAILS` 子集）。**未設定時所有授權帳號都是管理員**。設定後，不在名單內的帳號登入即為「治療師」角色：只開放預約／病歷／衛教／排班頁，且伺服器會擋下清空資料、發布線上預約目錄、推播收據圖片等操作。角色由伺服器 `GET /me` 決定，改前端沒有用。|
| `LINE_CHANNEL_SECRET` | ✅ | webhook 簽章驗證 |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | 推播訊息 |
| `PUBLIC_BASE_URL` | ✅ | 本服務對外網址（收據圖片連結）|
| `LIFF_BOOK_ID` / `LIFF_INTAKE_ID` | 建議 | LIFF App ID（頁面取得 LINE 身分用）|
| `ALLOWED_ORIGINS` | 選 | CORS 白名單，預設 `*`；建議設為前端網址 |
| `PGSSL=require` | 選 | 走 TCP 且需 SSL 的 Postgres（如 Neon）|

## 本機開發

```bash
cd server && npm install
DATABASE_URL=postgresql://localhost/navicare GOOGLE_CLIENT_ID=... ALLOWED_EMAILS=you@gmail.com \
LINE_CHANNEL_SECRET=x LINE_CHANNEL_ACCESS_TOKEN=x PUBLIC_BASE_URL=http://localhost:8080 \
node server.js
```

## 安全設計

- 所有管理端點驗 Google OAuth token：呼叫 tokeninfo、**驗 `aud` 防止他站 token 重放**、比對 email 白名單
- LINE webhook 以 HMAC-SHA256 + `timingSafeEqual` 驗簽章
- `/proxy-image` 僅允許 LINE CDN 網域（防 SSRF / 內網探測）
- 公開提交端點：電話格式驗證（同時阻擋 `__proto__` 鍵注入）、欄位長度上限、每 IP 每分鐘 20 次節流
- 收據圖片使用 128-bit 隨機 id，無法枚舉，60 天自動清除
- 快照每次儲存留歷史（30 份、含操作者），誤操作可回復
