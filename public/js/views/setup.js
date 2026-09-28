/**
 * صفحة الإعداد — كل ما يلزم لربط النظام بواتساب في مكان واحد.
 *
 * كل بند يُفحص من مصدره الحقيقي (Meta نفسها) لا من ملف الإعدادات، لأن
 * وجود قيمة في الملف لا يعني أنها صحيحة.
 */

import { get, put, post, esc, guard, flash } from '../core.js';

const HINTS = {
  WA_PROVIDER: 'cloud = الرسمي · baileys = مسح QR برقم ثانوي · simulator = بلا اتصال',
  READ_ONLY: 'نعم = يستقبل ويعرض ولا يُرسل شيئاً إطلاقاً',
  SILENT_ON_FAILURE: 'نعم = عند تعطّل البوت يصمت ويُنبّه الموظف، بدل إرسال اعتذار للعميل',
  WA_ACCESS_TOKEN: 'business.facebook.com ← مستخدمو النظام ← إنشاء رمز (دائم لا مؤقت)',
  WA_APP_SECRET: 'developers.facebook.com ← إعدادات التطبيق ← أساسي ← إظهار',
  WA_APP_ID: 'يظهر في نفس صفحة المفتاح السري، أو في رابط صفحة التطبيق',
  WA_BUSINESS_ID: 'business.facebook.com ← معلومات النشاط التجاري',
  WA_VERIFY_TOKEN: 'يُولَّد تلقائياً. لا تحتاجين نسخه — زر الضبط يرسله لـMeta وحده.',
  ANTHROPIC_API_KEY: 'console.anthropic.com ← API Keys. بدونه لن يرد البوت.',
  OPENAI_API_KEY: 'اختياري — لتحويل الرسائل الصوتية لنص.',
  SUPPORT_WHATSAPP: 'يظهر لعملائك عند الوحدات المعطّلة.',
  PUBLIC_URL: 'عنوان HTTPS العام. Cloud API لا يستقبل بدونه.',
};

export async function renderSetup(main) {
  main.innerHTML = '<h2>الإعداد</h2><div class="empty">جارٍ فحص الربط مع Meta…</div>';

  const [settings, status] = await Promise.all([
    get('/api/system/settings'),
    get('/api/system/meta/status').catch((e) => ({ error: e.message, checks: [], numbers: [] })),
  ]);

  const done = status.checks.filter((c) => c.ok).length;
  const total = status.checks.length;

  main.innerHTML = `
    <h2>الإعداد</h2>
    <p class="subtitle">${done} من ${total} خطوات مكتملة · الجاري: <strong>${esc(settings.running.provider)}</strong></p>

    <div class="card">
      <h3>قائمة الفحص</h3>
      <p class="muted">كل بند مفحوص من مصدره الحقيقي — وجود القيمة في الملف لا يعني أنها صحيحة.</p>
      <div class="table-wrap"><table>
        <tbody>${status.checks
          .map(
            (c) => `<tr>
              <td style="width:40px">${c.ok ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>'}</td>
              <td style="width:180px"><strong>${esc(c.label)}</strong></td>
              <td class="muted">${esc(c.message)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>

      ${
        status.numbers?.length
          ? `<h3 style="margin-top:16px">الأرقام لدى Meta</h3>
             <div class="table-wrap"><table><tbody>${status.numbers
               .map(
                 (n) => `<tr>
                   <td style="width:40px">${n.ok ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>'}</td>
                   <td style="width:180px">${esc(n.tenant)}</td>
                   <td class="muted">${esc(n.message)}</td>
                 </tr>`,
               )
               .join('')}</tbody></table></div>`
          : ''
      }

      <div class="actions">
        <button class="btn" id="configure">اضبط الـwebhook في Meta تلقائياً</button>
        <button class="btn ghost" id="recheck">إعادة الفحص</button>
      </div>
      <p class="muted" style="margin-top:8px">
        زر الضبط يسجّل عنوانك لدى Meta ويشترك حساب واتساب في تطبيقك —
        نفس ما يتم من واجهة Meta، بلا الدخول إليها.
      </p>
    </div>

    <div class="card">
      <h3>القيم</h3>
      ${settings.fields
        .map(
          (f) => `
        <label for="f-${f.key}">
          ${esc(f.label)}${f.secret && f.isSet ? ' <span class="badge green">مضبوط</span>' : ''}
        </label>
        ${
          f.key === 'WA_PROVIDER'
            ? `<select id="f-${f.key}" data-key="${f.key}">${['cloud', 'baileys', 'simulator']
                .map((v) => `<option value="${v}"${v === f.value ? ' selected' : ''}>${v}</option>`)
                .join('')}</select>`
            : f.key === 'READ_ONLY' || f.key === 'SILENT_ON_FAILURE'
              ? `<select id="f-${f.key}" data-key="${f.key}">
                   <option value="1"${f.value === '1' ? ' selected' : ''}>نعم</option>
                   <option value="0"${f.value !== '1' ? ' selected' : ''}>لا</option>
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
      </div>
    </div>

    <div class="card" id="restartNote" hidden>
      <h3>يلزم إعادة تشغيل</h3>
      <p class="muted">حُفظت القيم، ولا تسري إلا بإعادة تشغيل الخادم.</p>
      <p>في نافذة Terminal: <strong>Control + C</strong> ثم</p>
      <pre class="mono" style="background:#f4f6f8;padding:10px;border-radius:8px;direction:ltr">npm start</pre>
    </div>
  `;

  document.getElementById('configure').onclick = guard(async (event) => {
    const button = event.target;
    button.disabled = true;
    button.textContent = 'جارٍ الضبط…';
    try {
      const result = await post('/api/system/meta/configure-webhook');
      if (result.ok) {
        flash((result.data?.steps ?? ['تم الضبط']).join(' · '));
        await renderSetup(main);
      } else {
        flash(result.message, 'error');
        button.disabled = false;
        button.textContent = 'اضبط الـwebhook في Meta تلقائياً';
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = 'اضبط الـwebhook في Meta تلقائياً';
      throw error;
    }
  });

  document.getElementById('recheck').onclick = guard(() => renderSetup(main));

  document.getElementById('save').onclick = guard(async () => {
    const payload = {};
    for (const field of main.querySelectorAll('[data-key]')) payload[field.dataset.key] = field.value;
    const result = await put('/api/system/settings', payload);
    if (result.saved === 0) {
      flash('لم يتغير شيء.');
      return;
    }
    flash(`حُفظت ${result.saved} قيمة.`);
    document.getElementById('restartNote').hidden = false;
    document.getElementById('restartNote').scrollIntoView({ behavior: 'smooth' });
  });
}
