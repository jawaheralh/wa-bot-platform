#!/usr/bin/env bash
# انقري عليّ مرّتين لفتح لوحة التحكم.
# أتأكد أن النظام يعمل، وأشغّله إن كان متوقفاً، ثم أفتح المتصفح.

cd "$(dirname "$0")"

if ! curl -s --max-time 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  echo "النظام متوقف — جارٍ تشغيله…"
  nohup node src/index.ts > logs/manual.log 2>&1 &
  for i in $(seq 1 20); do
    sleep 1
    curl -s --max-time 2 http://localhost:4000/api/health >/dev/null 2>&1 && break
  done
fi

if curl -s --max-time 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  open http://localhost:4000
  echo "فُتحت اللوحة. تقدرين تغلقين هذي النافذة."
else
  echo "تعذّر التشغيل. راجعي logs/manual.log"
  read -n 1 -s -r -p "اضغطي أي زر للإغلاق"
fi
