#!/usr/bin/env bash
#
# نسخة احتياطية تغادر الخادم.
#
# النسخة على قرص الخادم نفسه لا تحمي من شيء: عطل القرص يأخذها معه،
# ومن يخترق الخادم يمحوها مع الأصل. فترفع هذه النسخة إلى تخزين أوراكل
# في جدة — خارج الخادم، وداخل السعودية.
#
# تشفَّر قبل الرفع. رابط الرفع سرّ على القرص، ولو تسرّب لم يعطِ حامله
# إلا رفع ملفات: الرابط صلاحيته «كتابة فقط»، لا قراءة ولا حذف. ومع
# التشفير لا تُقرأ النسخ ولو تسرّب الرابط والوصول معاً.
#
#   bash deploy/backup-remote.sh
#
# يقرأ من .env:
#   BACKUP_PAR_URL   رابط الرفع (ينتهي بـ /o/)
#   BACKUP_PASSPHRASE عبارة التشفير — بلا نسخة منها لا تُفكّ النسخ أبداً

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wa-bot}"
DB="$APP_DIR/data/app.db"
KEEP_LOCAL=7

# shellcheck disable=SC1090
set -a; . "$APP_DIR/.env"; set +a

fail() { echo "✗ $*" >&2; exit 1; }

[[ -f "$DB" ]] || fail "لا توجد قاعدة بيانات في $DB"
[[ -n "${BACKUP_PAR_URL:-}" ]] || fail "BACKUP_PAR_URL غير معرّف في .env"
[[ -n "${BACKUP_PASSPHRASE:-}" ]] || fail "BACKUP_PASSPHRASE غير معرّف في .env"

STAMP=$(TZ=Asia/Riyadh date +%Y-%m-%d_%H%M)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# SQLite في وضع WAL لا يُنسخ بنسخ الملف أثناء الكتابة — .backup يأخذ
# لقطة متّسقة بلا إيقاف الخدمة.
echo "▸ لقطة من قاعدة البيانات"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$WORK/app.db'"
else
  # الخادم بلا sqlite3: better-sqlite3 يؤدي نفس الأمر.
  node -e "
    const Database = require('$APP_DIR/node_modules/better-sqlite3');
    const db = new Database('$DB', { readonly: true });
    db.exec(\"VACUUM INTO '$WORK/app.db'\");
    db.close();
  "
fi
[[ -s "$WORK/app.db" ]] || fail "اللقطة فارغة"

echo "▸ ضغط وتشفير"
gzip -c "$WORK/app.db" > "$WORK/app.db.gz"
# -pbkdf2 لازم: بدونه يشتقّ openssl المفتاح باشتقاق قديم ضعيف.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass env:BACKUP_PASSPHRASE \
  -in "$WORK/app.db.gz" -out "$WORK/app-$STAMP.db.gz.enc"

SIZE=$(du -h "$WORK/app-$STAMP.db.gz.enc" | cut -f1)

echo "▸ الرفع إلى تخزين أوراكل (جدة)"
CODE=$(curl -sS --max-time 120 -o /dev/null -w '%{http_code}' \
  -X PUT --data-binary "@$WORK/app-$STAMP.db.gz.enc" \
  "${BACKUP_PAR_URL%/}/app-$STAMP.db.gz.enc")

[[ "$CODE" == "200" ]] || fail "رفض الرفع (HTTP $CODE)"
echo "  ✓ app-$STAMP.db.gz.enc ($SIZE)"

# نسخة محلية أيضاً: الاستعادة منها فورية بلا انتظار تنزيل.
mkdir -p "$APP_DIR/backups"
cp "$WORK/app-$STAMP.db.gz.enc" "$APP_DIR/backups/"
ls -1t "$APP_DIR/backups"/app-*.db.gz.enc 2>/dev/null \
  | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm --

echo "✓ تمت النسخة الاحتياطية"
