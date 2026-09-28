#!/usr/bin/env bash
#
# تشغيل النظام تلقائياً على macOS بلا طرفية.
#
#   bash deploy/mac/install.sh
#
# يُسجّل خدمتين في launchd تبدآن مع تسجيل دخولك وتعيدان نفسيهما إن تعطّلتا:
#   النظام نفسه، ونفق cloudflared إن كان موجوداً.

set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
AGENTS="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
mkdir -p "$AGENTS" "$ROOT/logs"

echo "▸ المشروع: $ROOT"
echo "▸ Node:    $NODE"

write_agent() {
  local label="$1" program="$2" args="$3"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
$args
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/logs/$label.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$label.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
  launchctl unload "$AGENTS/$label.plist" 2>/dev/null || true
  launchctl load "$AGENTS/$label.plist"
  echo "  ✓ $label"
}

echo "▸ تسجيل خدمة النظام"
write_agent "sa.waqodi.wabot" "$NODE" "    <string>$ROOT/src/index.ts</string>"

if [[ -x "$ROOT/bin/cloudflared" ]]; then
  echo "▸ تسجيل خدمة النفق"
  write_agent "sa.waqodi.wabot-tunnel" "$ROOT/bin/cloudflared" \
    "    <string>tunnel</string>
    <string>--url</string>
    <string>http://localhost:4000</string>"
fi

echo
echo "✓ تم. النظام يبدأ تلقائياً مع كل تشغيل للجهاز."
echo
echo "  الإيقاف:   bash deploy/mac/uninstall.sh"
echo "  السجل:     tail -f $ROOT/logs/sa.waqodi.wabot.log"
echo "  اللوحة:    http://localhost:4000"
