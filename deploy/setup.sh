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

if [[ $EUID -ne 0 ]]; then echo "يلزم تشغيله بـsudo" >&2; exit 1; fi

echo "▸ تحصين الخادم"

# صور Ubuntu على Oracle تأتي بقواعد iptables تحجب كل شيء عدا 22 —
# فتح المنفذين في Security List وحده لا يكفي، والموقع يبدو معطّلاً بلا سبب.
# القاعدة الأخيرة في السلسلة هي REJECT تحجب كل ما تبقى، فالإضافة بعدها
# لا أثر لها إطلاقاً. نُدرج قبلها دائماً، لا في موضع رقمي ثابت.
if command -v netfilter-persistent >/dev/null 2>&1 || [[ -f /etc/iptables/rules.v4 ]]; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null && continue
    reject_at=$(iptables -L INPUT -n --line-numbers \
      | awk '$2=="REJECT" || $2=="DROP" {print $1; exit}')
    iptables -I INPUT "${reject_at:-1}" -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  done
  apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  netfilter-persistent save >/dev/null 2>&1 || true
  echo "  ✓ فُتح المنفذان 80 و443 في جدار الخادم"
fi

# منع تخمين كلمات مرور SSH: الحظر بعد محاولات فاشلة
apt-get install -y fail2ban >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# الدخول بالمفتاح وحده — لا كلمة مرور تُخمَّن
if [[ -d /etc/ssh/sshd_config.d ]]; then
  cat > /etc/ssh/sshd_config.d/99-wa-bot.conf <<'SSHCONF'
PasswordAuthentication no
PermitRootLogin no
SSHCONF
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

# تحديثات الأمان تلقائياً — ثغرة تُرقَّع قبل أن تُستغل
apt-get install -y unattended-upgrades >/dev/null 2>&1 || true
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
echo "  ✓ fail2ban · دخول بالمفتاح فقط · تحديثات أمنية تلقائية"

# better-sqlite3 لا يوفّر نسخة جاهزة لمعالجات ARM، فيُبنى محلياً ويحتاج مترجماً.
echo "▸ تثبيت أدوات البناء"
apt-get install -y build-essential python3 >/dev/null 2>&1 || true
echo "  ✓ make · g++ · python3"

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
chown -R wabot:wabot "$APP_DIR"
sudo -u wabot npm ci --omit=dev 2>&1 | tail -3

echo "▸ الأسرار"
if [[ -f "$APP_DIR/.env" ]]; then
  # .env منقول من الجهاز: نضمن سرّ جلسة قوياً فقط
  SECRET=$(grep -E '^SESSION_SECRET=' "$APP_DIR/.env" | cut -d= -f2-)
  if [[ ${#SECRET} -lt 32 || "$SECRET" == *change-me* ]]; then
    sudo -u wabot sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" "$APP_DIR/.env"
    echo "  وُلّد سرّ جلسة قوي (السابق كان ضعيفاً)"
  else
    echo "  المفاتيح المنقولة سليمة"
  fi
elif [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u wabot cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  sudo -u wabot sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  sudo -u wabot sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env
  echo "  أُنشئ .env بسرّ جلسة عشوائي — تبقى المفاتيح فيه قبل التشغيل."
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
echo "   ٢. إن كانت قاعدة جديدة:  cd $APP_DIR && sudo -u wabot node src/seed.ts"
echo "   ٣. إعادة التشغيل:   sudo systemctl restart wa-bot"
echo "   ٤. متابعة السجل:    sudo journalctl -u wa-bot -f"
echo
echo "   ملاحظة: النظام يستمع على 127.0.0.1 فقط، ولا يصله أحد إلا عبر Caddy"
echo "           على 443 بشهادة HTTPS. المنفذ 4000 غير مكشوف للإنترنت."
echo
echo "   لوحة التحكم:  https://$DOMAIN"
echo "   الـwebhook:   https://$DOMAIN/webhook/whatsapp"
