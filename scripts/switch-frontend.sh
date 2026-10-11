#!/usr/bin/env bash
# 一鍵切換前端 index.html 到新後端網址（改 RENDER_URL 常數 + CSP connect-src 兩處）
# 用法：bash scripts/switch-frontend.sh https://navicare-api-xxxx-de.a.run.app
set -euo pipefail
NEW="${1:-}"
OLD="https://line-webhook-x1ux.onrender.com"
[ -n "$NEW" ] || { echo "用法：bash scripts/switch-frontend.sh <Cloud Run 網址>"; exit 1; }
NEW="${NEW%/}"
[[ "$NEW" =~ ^https://[a-zA-Z0-9.-]+$ ]] || { echo "網址格式怪怪的：$NEW"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/index.html"
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }

n=$(grep -c "$OLD" "$F" || true)
if [ "$n" -eq 0 ]; then
  if grep -q "$NEW" "$F"; then echo "index.html 已經指向 $NEW，無需變更"; exit 0; fi
  echo "在 index.html 找不到舊網址 $OLD，請確認是否已被改過"; exit 1
fi
echo "找到 $n 處舊網址，替換為新網址…"

# 以 Python 做精確字串替換（避免 sed 對 / 的跳脫問題）
python3 - "$F" "$OLD" "$NEW" <<'PY'
import sys
f,old,new=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(f,encoding='utf-8').read()
open(f,'w',encoding='utf-8').write(s.replace(old,new))
PY

# 驗證：兩處都改到、且 JS 語法無誤
left=$(grep -c "$OLD" "$F" || true)
[ "$left" -eq 0 ] || { echo "仍有 $left 處未替換"; exit 1; }
echo "  RENDER_URL 與 CSP connect-src 皆已更新："
grep -n "$NEW" "$F" | sed 's/^/    /' | cut -c1-100

python3 - "$F" <<'PY'
import sys
s=open(sys.argv[1],encoding='utf-8').read()
a=s.index('<script>')+8; b=s.rindex('</script>')
open('/tmp/_fe_check.js','w',encoding='utf-8').write(s[a:b])
PY
node --check /tmp/_fe_check.js && echo "  JS 語法檢查通過 ✓"
echo
echo "完成。接著把更新後的 index.html 部署到你的前端託管位置，再登入還原加密備份（DEPLOY.md 步驟 7）。"
