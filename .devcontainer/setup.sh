#!/usr/bin/env bash
#
# يُنفَّذ مرة واحدة عند إنشاء الـCodespace.
# يهيّئ كل شيء فلا يبقى على المستخدم إلا npm start.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ تثبيت الاعتماديات"
npm install --no-audit --no-fund

if [[ ! -f .env ]]; then
  echo "▸ تجهيز .env"
  cp .env.example .env
  # سرّ جلسة عشوائي لكل Codespace — لا يُشارك ولا يُودَع
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  # المحاكي افتراضياً: لا اتصال بواتساب حتى تختاري ذلك صراحةً
  sed -i "s|^WA_PROVIDER=.*|WA_PROVIDER=simulator|" .env
  chmod 600 .env
fi

if [[ ! -f data/app.db ]]; then
  echo "▸ إنشاء قاعدة البيانات وأول حساب"
  npm run seed
fi

cat <<'MSG'

  ✓ جاهز.

    npm run setup     لإضافة مفتاح Claude (اختياري الآن)
    npm start         لتشغيل لوحة التحكم

  المنفذ 4000 يُفتح تلقائياً في المتصفح، وهو **خاص بك وحدك** —
  لا يصله أحد إلا بتسجيل دخول حسابك على GitHub.

MSG
