#!/usr/bin/env bash
#
# إعداد خادم Ubuntu من الصفر. يُشغَّل مرة واحدة على الخادم الجديد:
#   sudo bash deploy/setup.sh نطاقك.com
#
# يثبّت Node و Caddy، ينشئ مستخدماً محدود الصلاحيات، ويشغّل الخدمة.

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/wa-bot

if [[ -z "$DOMAIN" ]]; then
  echo "الاستعمال: sudo bash deploy/setup.sh نطاقك.com" >&2
  echo "  (وللتجربة بلا نطاق مرّري عنوان IP، وسيعمل على http فقط)" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then echo "شغّليه بـsudo" >&2; exit 1; fi

echo "▸ تثبيت Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "▸ تثبيت Caddy (شهادة HTTPS تلقائية)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "▸ إنشاء مستخدم الخدمة"
id -u wabot >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin wabot

echo "▸ تجهيز مجلد التطبيق"
mkdir -p "$APP_DIR/data"
chown -R wabot:wabot "$APP_DIR"

echo "▸ تثبيت الاعتماديات"
cd "$APP_DIR"
sudo -u wabot npm ci --omit=dev

echo "▸ توليد أسرار الإنتاج"
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u wabot cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  sudo -u wabot sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  sudo -u wabot sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env
  echo "  أُنشئ .env بسرّ جلسة عشوائي — أكملي المفاتيح فيه قبل التشغيل."
fi
chmod 600 "$APP_DIR/.env"

echo "▸ تركيب الخدمة"
cp deploy/wa-bot.service /etc/systemd/system/
sed "s/DOMAIN_HERE/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy

systemctl daemon-reload
systemctl enable --now wa-bot
systemctl reload caddy || systemctl restart caddy

echo
echo "✓ تم. الخطوات المتبقية:"
echo "   ١. املئي المفاتيح:  sudo -u wabot nano $APP_DIR/.env"
echo "   ٢. أنشئي الأدمن:    cd $APP_DIR && sudo -u wabot node src/seed.ts"
echo "   ٣. أعيدي التشغيل:   sudo systemctl restart wa-bot"
echo "   ٤. تابعي السجل:     sudo journalctl -u wa-bot -f"
echo
echo "   لوحة التحكم:  https://$DOMAIN"
echo "   الـwebhook:   https://$DOMAIN/webhook/whatsapp"
