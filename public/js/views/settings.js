/**
 * إعدادات التشغيل — لصق المفاتيح من المتصفح بدل تحرير .env في الطرفية.
 * لأدمن النظام وحده.
 */

import { get, put, post, esc, guard, flash } from '../core.js';

const HINTS = {
  WA_PROVIDER: 'cloud = الرسمي · baileys = مسح QR برقم ثانوي · simulator = بلا اتصال',
  READ_ONLY: '1 = يستقبل ويعرض ولا يُرسل شيئاً · 0 = يعمل كاملاً',
  WA_ACCESS_TOKEN: 'business.facebook.com ← مستخدمو النظام ← إنشاء رمز (دائم، لا المؤقت)',
  WA_APP_SECRET: 'developers.facebook.com ← إعدادات التطبيق ← أساسي ← إظهار',
  WA_VERIFY_TOKEN: 'يُولَّد تلقائياً. انسخيه إلى Meta عند ربط الـwebhook.',
  ANTHROPIC_API_KEY: 'console.anthropic.com ← API Keys. بدونه لن يرد البوت.',
  OPENAI_API_KEY: 'اختياري — لتحويل الرسائل الصوتية لنص.',
  SUPPORT_WHATSAPP: 'يظهر لعملائك عند الوحدات المعطّلة.',
  PUBLIC_URL: 'عنوان HTTPS العام. Cloud API لا يستقبل بدونه.',
};

export async function renderSettings(main) {
  const { fields, running } = await get('/api/system/settings');

  main.innerHTML = `
    <h2>إعدادات التشغيل</h2>
    <p class="subtitle">
      الجاري الآن: <strong>${esc(running.provider)}</strong>
      ${running.readOnly ? ' · <span class="badge amber">عرض فقط</span>' : ''}
    </p>

    <div class="card">
      ${fields
        .map(
          (f) => `
        <label for="f-${f.key}">
          ${esc(f.label)}
          ${f.secret && f.isSet ? '<span class="badge green">مضبوط</span>' : ''}
        </label>
        ${
          f.key === 'WA_PROVIDER'
            ? `<select id="f-${f.key}" data-key="${f.key}">
                 ${['cloud', 'baileys', 'simulator']
                   .map((v) => `<option value="${v}"${v === f.value ? ' selected' : ''}>${v}</option>`)
                   .join('')}
               </select>`
            : f.key === 'READ_ONLY'
              ? `<select id="f-${f.key}" data-key="${f.key}">
                   <option value="1"${f.value === '1' ? ' selected' : ''}>نعم — يستقبل ولا يُرسل</option>
                   <option value="0"${f.value !== '1' ? ' selected' : ''}>لا — يعمل كاملاً</option>
                 </select>`
              : `<input id="f-${f.key}" data-key="${f.key}" data-secret="${f.secret}" dir="ltr"
                        value="${esc(f.value)}"
                        placeholder="${f.secret && f.isSet ? 'اتركيه لعدم التغيير' : ''}">`
        }
        <p class="muted" style="margin:4px 0 12px">${esc(HINTS[f.key] ?? '')}</p>`,
        )
        .join('')}

      <div class="actions">
        <button class="btn" id="save">حفظ</button>
        <button class="btn ghost" id="testMeta">اختبار توكن Meta</button>
      </div>
      <p class="muted" style="margin-top:10px">
        الأسرار تُعرض محجوبة ولا تُرسل للمتصفح كاملة. اتركي الحقل كما هو لعدم تغييره.
      </p>
    </div>

    <div class="card" id="restartNote" hidden>
      <h3>يلزم إعادة تشغيل</h3>
      <p class="muted">حُفظت القيم في الملف، لكنها لا تسري إلا بإعادة تشغيل الخادم.</p>
      <p>في نافذة Terminal اضغطي <strong>Control + C</strong> ثم اكتبي:</p>
      <pre class="mono" style="background:#f4f6f8;padding:10px;border-radius:8px;direction:ltr">npm start</pre>
    </div>
  `;

  document.getElementById('save').onclick = guard(async () => {
    const payload = {};
    for (const field of main.querySelectorAll('[data-key]')) {
      payload[field.dataset.key] = field.value;
    }
    const result = await put('/api/system/settings', payload);
    if (result.saved === 0) {
      flash('لم يتغير شيء.');
      return;
    }
    flash(`حُفظت ${result.saved} قيمة.`);
    document.getElementById('restartNote').hidden = false;
    document.getElementById('restartNote').scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('testMeta').onclick = guard(async () => {
    const result = await post('/api/system/settings/test-meta');
    flash(result.message, result.ok ? 'ok' : 'error');
  });
}
