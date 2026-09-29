#!/usr/bin/env bash
#
# استعادة قاعدة البيانات من نسخة مشفّرة.
#
# نسخة احتياطية لم تُجرَّب استعادتها ليست نسخة احتياطية — هي رجاء.
# لذلك هذا السكربت موجود من اليوم الأول لا يوم الكارثة.
#
#   bash deploy/restore.sh /opt/wa-bot/backups/app-2026-09-29_0630.db.gz.enc
#
# يوقف الخدمة، ويحتفظ بالقاعدة الحالية جانباً قبل الاستبدال، ثم يشغّلها.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wa-bot}"
SRC="${1:-}"

if [[ -z "$SRC" ]]; then
  echo "الاستعمال: bash deploy/restore.sh <ملف-النسخة.db.gz.enc>" >&2
  echo >&2
  echo "النسخ المتاحة محلياً:" >&2
  ls -1t "$APP_DIR/backups"/app-*.db.gz.enc 2>/dev/null | head -10 >&2 || echo "  لا شيء" >&2
  exit 1
fi

[[ -f "$SRC" ]] || { echo "✗ لا يوجد ملف: $SRC" >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "$APP_DIR/.env"; set +a
[[ -n "${BACKUP_PASSPHRASE:-}" ]] || { echo "✗ BACKUP_PASSPHRASE غير معرّف" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "▸ فكّ التشفير"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_PASSPHRASE -in "$SRC" -out "$WORK/app.db.gz" \
  || { echo "✗ فشل فكّ التشفير — عبارة خاطئة أو ملف تالف" >&2; exit 1; }

gunzip -c "$WORK/app.db.gz" > "$WORK/app.db"

echo "▸ فحص سلامة القاعدة قبل الاستبدال"
# استبدال قاعدة سليمة بأخرى تالفة كارثة أسوأ من التي نعالجها.
OK=$(node -e "
  const Database = require('$APP_DIR/node_modules/better-sqlite3');
  const db = new Database('$WORK/app.db', { readonly: true });
  const r = db.pragma('integrity_check', { simple: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  console.log(r === 'ok' ? 'ok:' + n : 'bad');
  db.close();
")
[[ "$OK" == ok:* ]] || { echo "✗ النسخة تالفة — لم يُمَسّ شيء" >&2; exit 1; }
echo "  ✓ سليمة · ${OK#ok:} رسالة"

echo "▸ إيقاف الخدمة"
systemctl stop wa-bot 2>/dev/null || true

ASIDE="$APP_DIR/data/app.db.before-restore-$(TZ=Asia/Riyadh date +%Y-%m-%d_%H%M)"
if [[ -f "$APP_DIR/data/app.db" ]]; then
  mv "$APP_DIR/data/app.db" "$ASIDE"
  rm -f "$APP_DIR/data/app.db-wal" "$APP_DIR/data/app.db-shm"
  echo "  ✓ القاعدة الحالية محفوظة في $ASIDE"
fi

install -o wabot -g wabot -m 600 "$WORK/app.db" "$APP_DIR/data/app.db"

echo "▸ تشغيل الخدمة"
systemctl start wa-bot
sleep 5
systemctl is-active --quiet wa-bot && echo "✓ تمت الاستعادة والخدمة تعمل" || {
  echo "✗ الخدمة لم تعمل — القاعدة السابقة في $ASIDE" >&2
  exit 1
}
