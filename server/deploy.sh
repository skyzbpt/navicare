#!/usr/bin/env bash
# 一鍵部署：Cloud SQL PostgreSQL + Cloud Run（步驟 1–3）＋每日提醒排程（步驟 8）
# 在 Google Cloud Shell 或已裝 gcloud 的環境執行：  bash deploy.sh
# 可重複執行：已建立的資源會自動略過，只補未完成的部分。
set -euo pipefail

# ── 可調參數（有預設值，直接 Enter 即可）──
DEFAULT_PROJECT="navicare-clinic-2026"
DEFAULT_REGION="asia-east1"
DEFAULT_INSTANCE="navicare-pg"
DEFAULT_DB="navicare"
DEFAULT_DBUSER="navicare"

# ── 這些是你系統既有的值，已預填 ──
GOOGLE_CLIENT_ID="488516957607-6pt8ofca357qrj5fgpjk8n67i6krvr4d.apps.googleusercontent.com"
ALLOWED_EMAILS="nycuptc@gmail.com,yewfir@gmail.com,skyzbpt@gmail.com"
LIFF_BOOK_ID="2010433876-ySl8EsUh"
LIFF_INTAKE_ID="2010433876-2HSNBpkC"

ask() { local p="$1" d="${2:-}" v; if [ -n "$d" ]; then read -rp "$p [$d]: " v; echo "${v:-$d}"; else read -rp "$p: " v; echo "$v"; fi; }
asksecret() { local p="$1" v; read -rsp "$p: " v; echo >&2; echo "$v"; }
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

command -v gcloud >/dev/null || { echo "找不到 gcloud，請在 Google Cloud Shell 執行，或先安裝 gcloud CLI"; exit 1; }
[ -f server.js ] || { echo "請在 server/ 目錄執行此腳本"; exit 1; }

say "設定（可直接 Enter 用預設值）"
PROJECT=$(ask "GCP 專案 ID" "$DEFAULT_PROJECT")
REGION=$(ask "區域" "$DEFAULT_REGION")
INSTANCE=$(ask "Cloud SQL 實例名稱" "$DEFAULT_INSTANCE")
DB=$(ask "資料庫名稱" "$DEFAULT_DB")
DBUSER=$(ask "資料庫使用者" "$DEFAULT_DBUSER")
DBPASS=$(asksecret "設定資料庫密碼（自訂一組強密碼）")
[ -n "$DBPASS" ] || { echo "密碼不可為空"; exit 1; }
LINE_SECRET=$(asksecret "LINE Channel Secret")
LINE_TOKEN=$(asksecret "LINE Channel Access Token")
# 管理員：不在名單內的授權帳號登入後是「治療師」角色（只開放預約／病歷／衛教／排班，不能改診所設定與提醒文字）。
# 前端會以伺服器回覆的角色為準，所以這裡一定要明確設定。
ADMIN_EMAILS=$(ask "管理員帳號（逗號分隔）" "$ALLOWED_EMAILS")
[ -n "$ADMIN_EMAILS" ] || { echo "管理員帳號不可為空"; exit 1; }
REMINDER_TIME=$(ask "每日自動推播明日預約提醒的時間（台北時間 HH:MM）" "20:00")
[[ "$REMINDER_TIME" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]] || { echo "時間格式需為 HH:MM"; exit 1; }
REMINDER_CRON="${BASH_REMATCH[2]#0} ${BASH_REMATCH[1]#0} * * *"
# 排程呼叫用的共用密鑰（每次部署重新產生，並同步更新排程設定）
CRON_SECRET=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')

CONN="${PROJECT}:${REGION}:${INSTANCE}"

say "步驟 1／3：建立專案並開通 API"
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || gcloud projects create "$PROJECT" --name="NaviCare"
gcloud config set project "$PROJECT"
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  echo "⚠ 無法確認專案 $PROJECT 已連結帳單帳戶（Cloud SQL 與 Cloud Run 需要）。"
  echo "  若後續建立資源失敗，請到 https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT 連結後再執行一次。"
fi
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com cloudscheduler.googleapis.com

say "步驟 2／3：建立 Cloud SQL PostgreSQL（首次約需 8–10 分鐘）"
if gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo "實例 $INSTANCE 已存在，略過建立"
else
  # PostgreSQL 16 預設是 Enterprise Plus 版，不支援 db-f1-micro 這類共享核心規格（而且每月貴上百美元），必須指定 ENTERPRISE
  gcloud sql instances create "$INSTANCE" \
    --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro \
    --region="$REGION" --storage-size=10GB --deletion-protection
fi
gcloud sql databases describe "$DB" --instance="$INSTANCE" >/dev/null 2>&1 \
  || gcloud sql databases create "$DB" --instance="$INSTANCE"
if gcloud sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DBUSER"; then
  # 重新執行時預設「沿用」現有密碼：先改密碼的話，線上正在跑的服務會在新版本部署完成前全部連不上資料庫。
  # 輸入的密碼若跟現有的不同，新版本啟動時連不上資料庫，Cloud Run 會保留舊版本繼續服務，不會中斷。
  if [ "$(ask "使用者 $DBUSER 已存在，要把資料庫密碼改成剛輸入的嗎？(y/N)" "N")" = "y" ]; then
    gcloud sql users set-password "$DBUSER" --instance="$INSTANCE" --password="$DBPASS"
    echo "已更新密碼（部署完成前服務可能短暫無法連線）"
  else
    echo "沿用現有密碼（請確認剛才輸入的就是現有密碼）"
  fi
else
  gcloud sql users create "$DBUSER" --instance="$INSTANCE" --password="$DBPASS"
fi

say "步驟 3／3：部署 Cloud Run"
# 密碼放進連線網址前先做網址編碼：含 # / ? @ : 等字元的強密碼才不會讓服務啟動失敗
DBPASS_ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$DBPASS")
DBURL="postgresql://${DBUSER}:${DBPASS_ENC}@/${DB}?host=/cloudsql/${CONN}"
# 重新部署時沿用既有網址，避免 PUBLIC_BASE_URL 被暫時改成佔位字串（期間推播的收據圖片連結會壞掉）
PREV_URL=$(gcloud run services describe navicare-api --region "$REGION" --format='value(status.url)' 2>/dev/null || true)
ENVS="^##^DATABASE_URL=${DBURL}##GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}##ALLOWED_EMAILS=${ALLOWED_EMAILS}##ADMIN_EMAILS=${ADMIN_EMAILS}##CRON_SECRET=${CRON_SECRET}##LINE_CHANNEL_SECRET=${LINE_SECRET}##LINE_CHANNEL_ACCESS_TOKEN=${LINE_TOKEN}##PUBLIC_BASE_URL=${PREV_URL:-https://placeholder}##LIFF_BOOK_ID=${LIFF_BOOK_ID}##LIFF_INTAKE_ID=${LIFF_INTAKE_ID}"
gcloud run deploy navicare-api \
  --source . --region "$REGION" --allow-unauthenticated --max-instances 2 --memory 1Gi \
  --add-cloudsql-instances "$CONN" \
  --update-env-vars "$ENVS"
# --update-env-vars：只更新上面列出的變數，手動加過的設定（例如 ALLOWED_ORIGINS）重新部署時不會被清掉

URL=$(gcloud run services describe navicare-api --region "$REGION" --format='value(status.url)')
say "回填 PUBLIC_BASE_URL=$URL"
gcloud run services update navicare-api --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=${URL}" >/dev/null

say "設定每日自動提醒（Cloud Scheduler：每天 ${REMINDER_TIME} 台北時間推播明日預約）"
JOB=navicare-tomorrow-reminders
if gcloud scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" --location "$REGION" --schedule "$REMINDER_CRON" --time-zone "Asia/Taipei" \
    --uri "$URL/cron/tomorrow-reminders" --http-method POST --update-headers "X-Cron-Secret=${CRON_SECRET}" >/dev/null
else
  gcloud scheduler jobs create http "$JOB" --location "$REGION" --schedule "$REMINDER_CRON" --time-zone "Asia/Taipei" \
    --uri "$URL/cron/tomorrow-reminders" --http-method POST --headers "X-Cron-Secret=${CRON_SECRET}" >/dev/null
  # 第一次建立時先暫停：切換前仍由舊系統（Render）每天推播，兩邊同時跑病患會收到兩次。切換當天再 resume（DEPLOY.md 切換順序）
  gcloud scheduler jobs pause "$JOB" --location "$REGION" >/dev/null
  echo "每日提醒排程已建立，先維持「暫停」；切換當天再恢復：gcloud scheduler jobs resume $JOB --location $REGION"
fi

say "完成！後端網址："
echo "  $URL"
echo
echo "驗證："
echo "  curl $URL/healthz    # 應回 {\"ok\":true}"
echo
echo "下一步："
echo "  1. bash smoke-test.sh $URL           # 自動驗收公開端點"
echo "  2. LINE Console 三個網址改指向 $URL   （webhook / 兩個 LIFF，見 DEPLOY.md 步驟 5）"
echo "  3. 前端切換（網址不同時）：bash ../scripts/switch-frontend.sh $URL"
echo "  4. 合併 PR 後：暫停 Render 舊服務、恢復每日提醒排程，登入還原資料並驗收（DEPLOY.md 切換順序、步驟 7）"
echo "     gcloud scheduler jobs resume $JOB --location $REGION"
