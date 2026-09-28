#!/usr/bin/env bash
# إيقاف التشغيل التلقائي وإزالة الخدمتين.
set -euo pipefail
for label in sa.waqodi.wabot sa.waqodi.wabot-tunnel; do
  plist="$HOME/Library/LaunchAgents/$label.plist"
  [[ -f "$plist" ]] && launchctl unload "$plist" 2>/dev/null; rm -f "$plist"
  echo "  أُزيلت $label"
done
echo "✓ لن يعمل النظام تلقائياً بعد الآن."
