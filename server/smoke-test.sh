#!/usr/bin/env bash
# 部署後自動驗收（公開端點，不需登入 token）
# 用法：bash smoke-test.sh https://navicare-api-xxxx-de.a.run.app
set -uo pipefail
B="${1:-}"
[ -n "$B" ] || { echo "用法：bash smoke-test.sh <Cloud Run 網址>"; exit 1; }
B="${B%/}"
pass=0; fail=0
chk() { # chk 名稱 期望 實得
  if [ "$2" = "$3" ]; then printf '  \033[32m✓\033[0m %-34s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  \033[31m✗\033[0m %-34s 得 %s（期望 %s）\n' "$1" "$3" "$2"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "驗收目標：$B"
echo
echo "── 基本 ──"
chk "healthz 回 200"          200 "$(code "$B/healthz")"
chk "healthz body"            '{"ok":true}' "$(curl -s "$B/healthz")"
echo "── 公開資源 ──"
chk "/login-logo 200"         200 "$(code "$B/login-logo")"
chk "/catalog 200"            200 "$(code "$B/catalog")"
chk "/book LIFF 頁 200"       200 "$(code "$B/book")"
chk "/intake LIFF 頁 200"     200 "$(code "$B/intake")"
echo "── 認證防線（應被擋）──"
chk "無 token 存快照 401"     401 "$(code "$B/clinic-data")"
chk "壞 token 存快照 401"     401 "$(code -H 'Authorization: Bearer xxx' "$B/clinic-data")"
echo "── SSRF 防護（應被擋）──"
chk "proxy 非 LINE 網域 400"  400 "$(code "$B/proxy-image?url=https://evil.com/x.jpg")"
chk "proxy 內網 IP 400"       400 "$(code "$B/proxy-image?url=http://169.254.169.254/")"
chk "proxy 偽子網域 400"      400 "$(code "$B/proxy-image?url=https://line-scdn.net.evil.com/x")"
echo "── LINE webhook（無簽章應 403）──"
chk "webhook 無簽章 403"      403 "$(code -X POST -d '{}' "$B/webhook")"
echo "── 公開提交驗證（壞電話應 400）──"
chk "壞電話預約 400"          400 "$(code -X POST -H 'Content-Type: application/json' -d '{"name":"x","phone":"__proto__","date":"2026-07-10","time":"10:00"}' "$B/public-booking")"
echo
if [ "$fail" -eq 0 ]; then printf '\033[32m全部 %d 項通過 ✓\033[0m\n' "$pass";
else printf '\033[31m%d 項失敗 / %d 項通過\033[0m — 檢查 Cloud Run 日誌：gcloud run services logs read navicare-api --region asia-east1\n' "$fail" "$pass"; exit 1; fi
echo
echo "註：需登入 token 的端點（快照存取、推播、提醒）請於前端切換後，用第 8 步驗收清單手動確認。"
