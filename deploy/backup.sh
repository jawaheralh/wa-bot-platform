#!/usr/bin/env bash
#
# نسخة احتياطية من قاعدة البيانات.
# SQLite في وضع WAL لا يُنسخ بنسخ الملف مباشرة أثناء الكتابة — نستعمل
# أمر .backup الذي يأخذ لقطة متّسقة بلا إيقاف الخدمة.
#
#   bash deploy/backup.sh            نسخة الآن
#   0 3 * * * /opt/wa-bot/deploy/backup.sh    نسخة يومية عبر cron

set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/backups"
mkdir -p "$OUT"

STAMP=$(date +%Y-%m-%d_%H%M)
sqlite3 "$APP_DIR/data/app.db" ".backup '$OUT/app-$STAMP.db'"
gzip -f "$OUT/app-$STAMP.db"

# نُبقي آخر ٣٠ نسخة
ls -1t "$OUT"/app-*.db.gz | tail -n +31 | xargs -r rm --

echo "✓ $OUT/app-$STAMP.db.gz"
