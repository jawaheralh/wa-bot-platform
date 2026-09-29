#!/usr/bin/env bash
#
# نقل النظام من جهازك إلى الخادم — بكل بياناته ومفاتيحه.
#
#   bash deploy/migrate.sh ubuntu@1.2.3.4 bot.example.com
#
# ينقل: قاعدة البيانات، وملفات العملاء، و.env، والكود. ثم يُعدّ الخادم
# ويُشغّل الخدمة ويُعيد ربط الـwebhook بالعنوان الجديد.

set -euo pipefail
cd "$(dirname "$0")/.."

SSH_TARGET="${1:-}"
DOMAIN="${2:-}"
APP_DIR=/opt/wa-bot

if [[ -z "$SSH_TARGET" || -z "$DOMAIN" ]]; then
  cat >&2 <<USAGE
الاستعمال: bash deploy/migrate.sh <مستخدم@عنوان-الخادم> <النطاق>

مثال:  bash deploy/migrate.sh ubuntu@129.159.20.11 bot.4uwaqodi.sa

قبل التشغيل يلزم التأكد من:
  ١. الخادم يعمل والدخول إليه ممكن:  ssh ubuntu@عنوانه
  ٢. النطاق يشير لعنوان الخادم (سجل A)
USAGE
  exit 1
fi

echo "▸ فحص الاتصال بالخادم"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_TARGET" 'echo "  ✓ متصل: $(lsb_release -ds 2>/dev/null || uname -s)"'

echo "▸ فحص أن النطاق يشير للخادم"
SERVER_IP=$(ssh "$SSH_TARGET" 'curl -s --max-time 10 ifconfig.me || true')
DOMAIN_IP=$(dig +short "$DOMAIN" A | tail -1)
if [[ -n "$SERVER_IP" && "$SERVER_IP" != "$DOMAIN_IP" ]]; then
  echo "  ⚠️  $DOMAIN يشير إلى ${DOMAIN_IP:-(لا شيء)} والخادم $SERVER_IP" >&2
  echo "     يُصحَّح سجل A ثم تُعاد المحاولة — بدونه لن تُصدَر شهادة HTTPS." >&2
  read -rp "  أتابع رغم ذلك؟ (y/N) " go
  [[ "$go" == "y" ]] || exit 1
else
  echo "  ✓ النطاق يشير للخادم"
fi

echo "▸ تجهيز حزمة النقل"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# الكود من git — نظيف بلا node_modules ولا ملفات مؤقتة
git archive HEAD --prefix=app/ | tar -x -C "$STAGE"

# البيانات: قاعدة متّسقة عبر VACUUM INTO لا نسخ ملف
mkdir -p "$STAGE/app/data"
if [[ -f data/app.db ]]; then
  sqlite3 data/app.db ".backup '$STAGE/app/data/app.db'"
  echo "  ✓ قاعدة البيانات ($(du -h "$STAGE/app/data/app.db" | cut -f1))"
fi
if [[ -d data/media ]]; then
  cp -R data/media "$STAGE/app/data/media"
  echo "  ✓ ملفات العملاء ($(du -sh data/media | cut -f1))"
fi

# المفاتيح، وPUBLIC_URL يصير النطاق الجديد
if [[ -f .env ]]; then
  sed -E "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env > "$STAGE/app/.env"
  echo "  ✓ المفاتيح (PUBLIC_URL ← https://$DOMAIN)"
fi

echo "▸ الرفع إلى الخادم"
tar -czf "$STAGE/bundle.tgz" -C "$STAGE" app
scp -q "$STAGE/bundle.tgz" "$SSH_TARGET:/tmp/wa-bot.tgz"

echo "▸ التثبيت على الخادم (قد يأخذ دقائق)"
ssh "$SSH_TARGET" "sudo bash -s -- '$DOMAIN' '$APP_DIR'" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"; APP_DIR="$2"

systemctl stop wa-bot 2>/dev/null || true

mkdir -p "$APP_DIR"
tar -xzf /tmp/wa-bot.tgz -C /tmp
cp -R /tmp/app/. "$APP_DIR/"
rm -rf /tmp/app /tmp/wa-bot.tgz

cd "$APP_DIR"
bash deploy/setup.sh "$DOMAIN"
REMOTE

echo
echo "✓ اكتمل النقل."
echo "  اللوحة:   https://$DOMAIN"
echo "  الـwebhook: https://$DOMAIN/webhook/whatsapp"
echo
echo "  يبقى: تسجيل الـwebhook بالعنوان الجديد من صفحة الإعداد،"
echo "        أو:  ssh $SSH_TARGET 'cd $APP_DIR && sudo -u wabot node src/wa-check.ts'"
