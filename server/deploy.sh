#!/usr/bin/env bash
# 一鍵部署：Cloud SQL PostgreSQL + Cloud Run（步驟 1–3）
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

CONN="${PROJECT}:${REGION}:${INSTANCE}"

say "步驟 1／3：建立專案並開通 API"
gcloud projects describe "$PROJECT" >/dev/null 2>&1 || gcloud projects create "$PROJECT" --name="NaviCare"
gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com

say "步驟 2／3：建立 Cloud SQL PostgreSQL（首次約需 8–10 分鐘）"
if gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo "實例 $INSTANCE 已存在，略過建立"
else
  gcloud sql instances create "$INSTANCE" \
    --database-version=POSTGRES_16 --tier=db-f1-micro \
    --region="$REGION" --storage-size=10GB
fi
gcloud sql databases describe "$DB" --instance="$INSTANCE" >/dev/null 2>&1 \
  || gcloud sql databases create "$DB" --instance="$INSTANCE"
if gcloud sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DBUSER"; then
  gcloud sql users set-password "$DBUSER" --instance="$INSTANCE" --password="$DBPASS"
  echo "使用者 $DBUSER 已存在，已更新密碼"
else
  gcloud sql users create "$DBUSER" --instance="$INSTANCE" --password="$DBPASS"
fi

say "步驟 3／3：部署 Cloud Run"
DBURL="postgresql://${DBUSER}:${DBPASS}@/${DB}?host=/cloudsql/${CONN}"
ENVS="^##^DATABASE_URL=${DBURL}##GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}##ALLOWED_EMAILS=${ALLOWED_EMAILS}##LINE_CHANNEL_SECRET=${LINE_SECRET}##LINE_CHANNEL_ACCESS_TOKEN=${LINE_TOKEN}##PUBLIC_BASE_URL=https://placeholder##LIFF_BOOK_ID=${LIFF_BOOK_ID}##LIFF_INTAKE_ID=${LIFF_INTAKE_ID}"
gcloud run deploy navicare-api \
  --source . --region "$REGION" --allow-unauthenticated --max-instances 2 \
  --add-cloudsql-instances "$CONN" \
  --set-env-vars "$ENVS"

URL=$(gcloud run services describe navicare-api --region "$REGION" --format='value(status.url)')
say "回填 PUBLIC_BASE_URL=$URL"
gcloud run services update navicare-api --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=${URL}" >/dev/null

say "完成！後端網址："
echo "  $URL"
echo
echo "驗證："
echo "  curl $URL/healthz    # 應回 {\"ok\":true}"
echo
echo "下一步："
echo "  1. bash smoke-test.sh $URL           # 自動驗收公開端點"
echo "  2. LINE Console 三個網址改指向 $URL   （webhook / 兩個 LIFF，見 DEPLOY.md 步驟 5）"
echo "  3. 前端切換：bash ../scripts/switch-frontend.sh $URL"
