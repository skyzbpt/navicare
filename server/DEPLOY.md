# 部署指南：Google Cloud Run + PostgreSQL（取代 Render + MongoDB）

後端 API 契約與 `index.html` 前端**完全對齊**；main 分支的前端已指向 Cloud Run（見步驟 6）。

## ⚠️ 切換順序（務必先讀）

**合併 PR／部署新版 `index.html` 的那一刻，櫃台前端就會改連 Cloud Run**，舊系統的前端從此打不開。
所以一定要依下面順序，在一個不營業的時段完成：

1. **合併前**：照「快速部署」把後端架好（步驟 1–3），跑 `smoke-test.sh` 全部通過
2. **合併前**：在**目前的**前端完成步驟 4（匯入全部線上送出 → 下載加密備份），並請所有人暫停輸入資料
3. 步驟 5：LINE Webhook 與兩個 LIFF 改指向 Cloud Run
4. 合併 PR（或部署新版 `index.html`）→ 步驟 7：以管理員登入還原備份、重新發布線上預約目錄、跑驗收清單
5. 驗收通過再恢復營業；Render 保留至少一週再關閉

**回復（rollback）**：在新系統下載一份加密備份 → `bash scripts/switch-frontend.sh https://line-webhook-x1ux.onrender.com`
並部署該前端 → LINE Webhook／LIFF 改回 Render → 在舊系統還原剛才的備份。

## ⚡ 快速部署（腳本版，推薦）

在 [Google Cloud Shell](https://shell.cloud.google.com) 執行：

```bash
git clone https://github.com/skyzbpt/navicare.git
cd navicare/server
bash deploy.sh          # 互動式：輸入 3 個密碼、管理員帳號、每日提醒時間，其餘全自動（步驟 1–3、8）
bash smoke-test.sh <部署完成印出的網址>   # 自動驗收公開端點 16 項
```

之後照下方**步驟 4（備份舊資料）→ 步驟 5（LINE Console）→ 步驟 6（前端切換）→
步驟 7（還原資料並驗收）** 完成切換；步驟 8 的每日提醒排程 `deploy.sh` 已自動建立。
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
| `snapshot_history` | 儲存歷史（最近 30 份＋近 30 天每天最後一份＋管理員最近 10 份；內容沒變不重複存；含操作者 email，誤刪可救，見「從歷史版本救回資料」）|
| `submissions` | 線上預約/初診送出（`acked` 標記是否已匯入；匯入後 30 天自動刪除原始資料）|
| `line_users` | LINE 好友（webhook 自動維護）|
| `catalog` | 已發布的線上預約目錄 |
| `receipt_images` | 收據圖片（推播用，60 天自動清除）|
| `reminder_runs` | 每日提醒推播紀錄（同一天排程只送一次）|

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
  --edition=ENTERPRISE \
  --tier=db-f1-micro \
  --region=asia-east1 \
  --storage-size=10GB

gcloud sql databases create navicare --instance=navicare-pg
gcloud sql users create navicare --instance=navicare-pg --password='<設一組強密碼>'
```

> 💰 `db-f1-micro` 每月約 US$8–10，診所單店規模綽綽有餘。PostgreSQL 16 預設是 Enterprise Plus 版（不支援 `db-f1-micro`、每月上百美元），
> 所以一定要加 `--edition=ENTERPRISE`。專案需先連結帳單帳戶。
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
  --memory 1Gi \
  --add-cloudsql-instances navicare-clinic:asia-east1:navicare-pg \
  --set-env-vars '^##^DATABASE_URL=postgresql://navicare:<密碼>@/navicare?host=/cloudsql/navicare-clinic:asia-east1:navicare-pg##GOOGLE_CLIENT_ID=488516957607-6pt8ofca357qrj5fgpjk8n67i6krvr4d.apps.googleusercontent.com##ALLOWED_EMAILS=nycuptc@gmail.com,yewfir@gmail.com,skyzbpt@gmail.com##ADMIN_EMAILS=nycuptc@gmail.com,yewfir@gmail.com,skyzbpt@gmail.com##CRON_SECRET=<openssl rand -hex 24 產生>##LINE_CHANNEL_SECRET=<LINE channel secret>##LINE_CHANNEL_ACCESS_TOKEN=<LINE channel access token>##PUBLIC_BASE_URL=https://<部署後的網址>##LIFF_BOOK_ID=2010433876-ySl8EsUh##LIFF_INTAKE_ID=2010433876-2HSNBpkC'
```

部署完成會得到網址如 `https://navicare-api-xxxx-de.a.run.app`。
**第一次部署後**，把 `PUBLIC_BASE_URL` 更新成這個實際網址再部署一次
（收據圖片推播的連結需要它）：

```bash
gcloud run services update navicare-api --region asia-east1 \
  --update-env-vars PUBLIC_BASE_URL=https://navicare-api-xxxx-de.a.run.app
```

驗證：`curl https://navicare-api-xxxx-de.a.run.app/healthz` → `{"ok":true}`

## 步驟 4：備份舊資料（不碰 MongoDB，用 App 內建備份）

1. 舊系統仍在線時，先在「通知」按 **匯入全部**，把尚未匯入的線上預約／初診表收進來
2. 登入前端 → 診所管理 → 資料備份 → **加密備份（.ncek）**下載
3. 從這一刻起到步驟 7 還原完成前，請櫃台暫停在舊系統輸入資料（之後的變更不在備份裡）

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

> main 分支的 `index.html` 已指向 `https://navicare-api-56o6ce6uoq-de.a.run.app`（RENDER_URL、CSP 的 connect-src 與 img-src）。
> 若實際部署的 Cloud Run 網址相同，此步驟可略過；不同時再執行 `bash scripts/switch-frontend.sh <網址>`。

```js
// 1. RENDER_URL 常數（約 line 318）
var RENDER_URL='https://navicare-api-xxxx-de.a.run.app';
```

```html
<!-- 2. CSP meta 的 connect-src（line 6）：把 onrender.com 換成 Cloud Run 網址 -->
connect-src 'self' https://navicare-api-xxxx-de.a.run.app https://www.googleapis.com https://accounts.google.com;
```

## 步驟 7：還原資料並驗收

1. 以**管理員**帳號登入新版前端 → 診所管理 → 資料備份 → **還原加密備份** → 選步驟 4 下載的檔案
2. **服務與課程 → 發布到線上預約**：線上預約目錄存在新資料庫，沒有重新發布的話病患會看到「目前無可預約項目」
3. 依下方清單驗收（其他裝置可同時保持登入：新版會自動取回最新資料，不會把舊資料蓋回去）

驗收清單：
- [ ] 管理員登入：看得到全部頁面；治療師帳號登入：只看到預約／SOAP 病歷／衛教／排班
- [ ] 病患、預約、病歷、消費筆數與舊系統一致；新增一筆預約後重新整理仍在
- [ ] 兩台裝置同時登入，各改一筆不同的資料，兩邊重新整理後都看得到
- [ ] LINE 好友：病患管理 → 綁定 LINE 清單有出現好友（好友傳訊或加好友後才會出現）
- [ ] 用手機打開線上預約、初診問卷各送出一筆 → 通知鈴鐺出現 → 匯入成功
- [ ] 推播：對一位已綁定的病患發 LINE 訊息、推播一張收據
- [ ] 每日提醒：`gcloud scheduler jobs run navicare-tomorrow-reminders --location asia-east1` 後，明天有預約且已綁定 LINE 的病患收到提醒
- [ ] 服務與課程 → 發布到線上預約 → 線上預約頁看得到

確認正常運作一週後再關閉 Render 服務與 MongoDB。

## 步驟 8：每日自動提醒（Cloud Scheduler）

`deploy.sh` 會建立排程 `navicare-tomorrow-reminders`：每天指定時間（預設 20:00 台北時間）呼叫
`POST /cron/tomorrow-reminders`，推播明日預約提醒給已綁定 LINE 的病患。以 `X-Cron-Secret` 標頭驗證
（密鑰只存在 Cloud Run 環境變數 `CRON_SECRET` 與排程設定），同一天只會送一次——排程重試或當天已按過
「立即推播明日提醒」都不會重複發送。

手動建立／修改（例如改成每天 19:30）：

```bash
gcloud scheduler jobs create http navicare-tomorrow-reminders --location asia-east1 \
  --schedule "30 19 * * *" --time-zone "Asia/Taipei" \
  --uri "https://<cloud-run網址>/cron/tomorrow-reminders" --http-method POST \
  --headers "X-Cron-Secret=<與 Cloud Run 的 CRON_SECRET 相同>"
# 已存在則把 create 換成 update，--headers 換成 --update-headers
```

## 環境變數一覽

| 變數 | 必填 | 說明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres 連線字串（Cloud SQL 用 `?host=/cloudsql/...` socket）|
| `GOOGLE_CLIENT_ID` | ✅ | 與前端相同的 OAuth Client ID（驗證 token `aud`）|
| `ALLOWED_EMAILS` | ✅ | 逗號分隔的登入白名單（與前端 EMAIL_WHITELIST 對齊）|
| `ADMIN_EMAILS` | ✅ | 逗號分隔的管理員（須為 `ALLOWED_EMAILS` 子集）。**未設定時所有授權帳號都是管理員（啟動時會警告）**。不在名單內的帳號登入即為「治療師」角色：只開放預約／病歷／衛教／排班頁，伺服器也會擋下清空資料、修改管理員設定（薪資抽成、提醒文字、服務與課程等）、發布線上預約目錄、推播收據與明日提醒。角色由伺服器 `GET /me` 決定，改前端沒有用。|
| `CRON_SECRET` | 建議 | 每日自動提醒排程的共用密鑰（`deploy.sh` 自動產生）；未設定時不開放 `/cron/tomorrow-reminders` |
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
- 收據圖片使用 128-bit 隨機 id，無法枚舉，60 天自動清除；線上送出的原始資料匯入後 30 天刪除
- 快照存檔：
  - **版本檢查**：前端存檔帶著「根據第幾版修改」，其他裝置在這之間存過檔就回 409，前端把兩邊的變更合併後重送，
    不再整份互相覆蓋；只有兩台同時改到同一筆資料才請使用者選擇
  - **清空保護**：原本有資料的病患／預約／病歷／消費變成空的，必須是管理員且由「還原備份／清空重置」功能送出才接受
    （例如登入時讀取失敗、卻把空白畫面存回去，會被擋下）；治療師一次刪除大量資料也會被擋
  - **治療師權限**：伺服器端保留管理員設定（薪資抽成、印花稅、診所資料與 Logo、提醒文字、服務與課程），
    治療師存檔改不動、也讀不到抽成設定；「立即推播明日提醒」與收據推播限管理員
  - **歷史保留**：見上方資料表說明，任何人連續存檔也擠不掉前幾天與管理員的版本
- LINE 推播對象限本診所官方帳號的好友或已綁定病患
- 資料庫密碼、LINE 金鑰以 Cloud Run 環境變數保存（可在主控台看到）。若要更嚴格，可改存 Secret Manager 再以
  `--set-secrets` 掛載；部署時請勿在共用電腦執行，避免殘留在終端機紀錄
- 資料庫閒置連線被切斷（維護、重啟）時服務不會中斷

## 從歷史版本救回資料

```sql
-- 在 Cloud SQL Studio 或 gcloud sql connect 執行
SELECT id, saved_by, saved_at,
       jsonb_array_length(data->'PATIENTS') AS patients, jsonb_array_length(data->'BOOKINGS') AS bookings
FROM snapshot_history ORDER BY id DESC LIMIT 40;
-- 確認要回復的 id 後（請先在管理介面下載一份目前的備份）：
UPDATE clinic_snapshot SET data=(SELECT data FROM snapshot_history WHERE id=<id>), rev=rev+1, updated_at=now() WHERE id=1;
```

回復後各裝置會在一分鐘內自動取回該版本（或重新整理頁面）。

## 已知限制

- **線上表單的 LINE 身分未經驗證**：LIFF 頁面送出的 LINE userId 由手機端提供，伺服器無法確認。
  匯入時「既有病患」的姓名、生日、身分證字號只會補空白、不會被覆蓋；但匯入時仍會把 LINE 綁定到
  電話相符、且尚未綁定 LINE 的既有病患。若有人冒用他人電話送出，提醒與收據可能推播到錯誤的 LINE。
  匯入後請留意病患管理中新綁定的 LINE 名稱是否與本人相符。
