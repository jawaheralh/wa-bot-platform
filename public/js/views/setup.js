/**
 * صفحة الإعداد — كل ما يلزم لربط النظام بواتساب في مكان واحد.
 *
 * كل بند يُفحص من مصدره الحقيقي (Meta نفسها) لا من ملف الإعدادات، لأن
 * وجود قيمة في الملف لا يعني أنها صحيحة.
 */

import { get, put, post, del, esc, guard, flash } from '../core.js';

const HINTS = {
  WA_PROVIDER: 'cloud = الرسمي · baileys = مسح QR برقم ثانوي · simulator = بلا اتصال',
  READ_ONLY: 'نعم = يستقبل ويعرض ولا يُرسل شيئاً إطلاقاً',
  SILENT_ON_FAILURE: 'نعم = عند تعطّل البوت يصمت ويُنبّه الموظف، بدل إرسال اعتذار للعميل',
  WA_ACCESS_TOKEN: 'business.facebook.com ← مستخدمو النظام ← إنشاء رمز (دائم لا مؤقت)',
  WA_APP_SECRET: 'developers.facebook.com ← إعدادات التطبيق ← أساسي ← إظهار',
  WA_APP_ID: 'يظهر في نفس صفحة المفتاح السري، أو في رابط صفحة التطبيق',
  WA_BUSINESS_ID: 'business.facebook.com ← معلومات النشاط التجاري',
  WA_VERIFY_TOKEN: 'يُولَّد تلقائياً. لا حاجة لنسخه — زر الضبط يرسله لـMeta وحده.',
  ANTHROPIC_API_KEY: 'console.anthropic.com ← API Keys. بدونه لن يرد البوت.',
  OPENAI_API_KEY: 'اختياري — لتحويل الرسائل الصوتية لنص.',
  SUPPORT_WHATSAPP: 'يظهر لعملائك عند الوحدات المعطّلة.',
  EMAIL_API_KEY: 'resend.com أو brevo.com — قناة استرجاع أرخص من واتساب.',
  EMAIL_FROM: 'البريد المُرسِل، على نطاق موثّق لدى المزوّد.',
  PUBLIC_URL: 'عنوان HTTPS العام. Cloud API لا يستقبل بدونه.',
};

export async function renderSetup(main) {
  main.innerHTML = '<h2>الإعداد</h2><div class="empty">جارٍ فحص الربط مع Meta…</div>';

  const [settings, status, health, testData] = await Promise.all([
    get('/api/system/settings'),
    get('/api/system/meta/status').catch((e) => ({ error: e.message, checks: [], numbers: [] })),
    get('/api/system/health').catch(() => ({ checks: [], severity: 'warn', history: [] })),
    get('/api/system/test-data').catch(() => ({ conversations: 0, messages: 0, requests: 0, complaints: 0, bookings: 0, preview: [] })),
  ]);

  const BADGE = { ok: 'green', warn: 'amber', down: 'red' };
  const LABEL = { ok: 'سليم', warn: 'تحذير', down: 'متعطّل' };

  const done = status.checks.filter((c) => c.ok).length;
  const total = status.checks.length;

  main.innerHTML = `
    <h2>الإعداد</h2>
    <p class="subtitle">${done} من ${total} خطوات مكتملة · الجاري: <strong>${esc(settings.running.provider)}</strong></p>

    <div class="card" style="${
      health.severity === 'down' ? 'border:2px solid var(--danger)' : ''
    }">
      <h3>صحة النظام <span class="badge ${BADGE[health.severity]}">${esc(LABEL[health.severity] ?? '')}</span></h3>
      <p class="muted">يُفحص تلقائياً كل ١٥ دقيقة، وينبّه الموظف على واتساب عند أي تغيّر.</p>
      <div class="table-wrap"><table><tbody>${health.checks
        .map(
          (c) => `<tr>
            <td style="width:40px"><span class="badge ${BADGE[c.severity]}">${
              c.severity === 'ok' ? '✓' : c.severity === 'warn' ? '!' : '✗'
            }</span></td>
            <td style="width:180px"><strong>${esc(c.label)}</strong></td>
            <td class="muted">${esc(c.message)}${
              c.fix ? `<br><span style="color:var(--warn)">الحل: ${esc(c.fix)}</span>` : ''
            }</td>
          </tr>`,
        )
        .join('')}</tbody></table></div>
    </div>

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
          ? `<h3 style="margin-top:16px">كل منشأة وإعدادها</h3>
             <p class="muted" style="margin-top:0">
               «خاصة» = المنشأة تستعمل توكن حسابها هي. «مشتركة» = ترث
               إعدادات النظام العامة — وهذا لا يصلح لعميل يدفع.
             </p>
             <div class="table-wrap"><table><tbody>${status.numbers
               .map(
                 (n) => `<tr>
                   <td style="width:40px">${n.ok ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>'}</td>
                   <td style="width:200px">${esc(n.tenant)}</td>
                   <td style="width:90px">${
                     n.own
                       ? '<span class="badge green">خاصة</span>'
                       : '<span class="badge amber">مشتركة</span>'
                   }</td>
                   <td class="muted">${esc(n.message)}</td>
                 </tr>`,
               )
               .join('')}</tbody></table></div>
             ${
               status.numbers.some((n) => !n.own)
                 ? `<p class="muted" style="margin-top:10px">
                      ⚠️ منشأة على الإعدادات المشتركة تستهلك من توكنك ومن
                      حساب Claude العام، ويظهر رقمها تحت تطبيقك أنت.
                      من «كل المنشآت» يُدخَل لكل منشأة توكن حسابها ومفتاحها.
                    </p>`
                 : ''
             }`
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

    ${testDataCard(testData)}

    <div class="card">
      <h3>الإعدادات المشتركة</h3>
      <p class="muted" style="margin-top:0">
        هذه تخصّ النظام كله لا منشأة بعينها. إعدادات كل منشأة — توكن Meta،
        ورقمها، ومفتاح Claude الخاص بها — في شاشة <strong>كل المنشآت</strong>.
      </p>
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
                        placeholder="${f.secret && f.isSet ? 'بلا تغيير' : ''}">`
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
      <pre class="mono" style="background:var(--bg);padding:10px;border-radius:8px;direction:ltr">npm start</pre>
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

  const purge = document.getElementById('purgeTest');
  if (purge) {
    purge.onclick = guard(async () => {
      const total = testData.conversations;
      // تأكيد يذكر العدد لا «متأكدة؟» مجرّدة: الرقم يجعل الضغطة واعية.
      if (
        !confirm(
          `حذف ${total} محادثة تجريبية و${testData.messages} رسالة و${testData.requests} طلباً.\n` +
            'لا يمكن التراجع. المحادثات غير الموسومة لن تُمَسّ.\n\nأتابع؟',
        )
      ) {
        return;
      }
      const removed = await del('/api/system/test-data');
      flash(`حُذفت ${removed.conversations} محادثة تجريبية.`);
      await renderSetup(main);
    });
  }
}

/* ---------------------------------------------------------------
   بيانات التجربة
--------------------------------------------------------------- */

/**
 * الزر يعرض ما سيحذفه قبل أن يحذفه.
 *
 * زر حذف لا يُظهر ما يمسّه يُضغط يوماً على بيانات لم يقصدها صاحبه —
 * ولا سبيل للتراجع.
 */
function testDataCard(data) {
  if (!data.conversations) {
    return `
      <div class="card">
        <h3>بيانات التجربة</h3>
        <p class="muted" style="margin:0">
          لا توجد محادثات موسومة كتجربة. لوسم محادثة: تُفتح من
          <strong>المحادثات</strong> ثم «وسم كتجربة».
        </p>
      </div>`;
  }

  return `
    <div class="card" style="border-inline-start:3px solid var(--warn)">
      <h3>بيانات التجربة</h3>
      <p class="muted" style="margin-top:0">
        هذه المحادثات وُسمت تجريبية. <strong>الحذف يطالها وحدها</strong> —
        ولا يملك النظام أي مسار لحذف غيرها.
      </p>

      <div class="table-wrap"><table><tbody>
        ${data.preview
          .map(
            (c) => `<tr>
              <td style="width:170px">${esc(c.customerWa)}</td>
              <td style="width:150px">${esc(c.customerName ?? '—')}</td>
              <td style="width:110px" class="muted">${c.messages} رسالة</td>
              <td class="muted">${esc(c.tenant)}</td>
            </tr>`,
          )
          .join('')}
      </tbody></table></div>

      <p class="muted" style="margin-top:10px">
        الإجمالي: <strong>${data.conversations}</strong> محادثة ·
        ${data.messages} رسالة · ${data.requests} طلباً ·
        ${data.complaints} شكوى · ${data.bookings} حجزاً
      </p>

      <div class="actions">
        <button class="btn danger" id="purgeTest">حذف بيانات التجربة</button>
      </div>
    </div>`;
}
