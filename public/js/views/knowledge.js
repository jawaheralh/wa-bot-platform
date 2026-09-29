/** قاعدة المعرفة: نص حر + أسئلة وأجوبة. */

import { get, post, patch, put, del, esc, guard, flash, state } from '../core.js';

export async function renderKnowledge(main) {
  const [entries, { modules }] = await Promise.all([
    get(`/api/tenants/${state.tenantId}/kb`),
    get(`/api/tenants/${state.tenantId}/modules`),
  ]);
  const inquiries = modules.find((m) => m.name === 'inquiries');
  const config = inquiries?.config ?? { freeText: '', unknownPolicy: '' };

  main.innerHTML = `
    <h2>قاعدة المعرفة</h2>
    <p class="subtitle">كل ما يكتب هنا يقوله البوت حرفياً. ما ليس هنا يقول عنه «ما أعرف» ويحوّل للموظف.</p>

    <div class="card">
      <h3>تأسيس سريع بملف اكسل</h3>
      <p class="muted" style="margin-top:0">
        يُنزَّل الملف ويُرسل للعميل ليملأه على مهله، ثم يُرفع هنا.
        ثلاث أوراق: <strong>المعرفة</strong> (ما يجيب عنه البوت)،
        <strong>الحدود</strong> (ما لا يجيب عنه أبداً)،
        <strong>الفروع</strong>.
      </p>
      <div class="actions">
        <a class="btn ghost" href="/api/tenants/${state.tenantId}/onboarding/template" download>
          تنزيل ملف التأسيس
        </a>
        <button class="btn" id="pickFile">رفع الملف بعد ملئه</button>
        <input id="xlsxFile" type="file" accept=".xlsx" hidden>
      </div>
      <p class="muted" style="margin-top:8px">
        الرفع يُضيف ولا يحذف، والسؤال الموجود لا يتكرّر — فيمكن رفع
        نسخة محدَّثة بلا خوف.
      </p>
      <div id="importResult"></div>
    </div>

    <div class="card">
      <h3>نص حر عن المنشأة</h3>
      <p class="muted">الخدمات والأسعار والموقع وساعات العمل — بأسلوبك.</p>
      <textarea id="freeText" style="min-height:160px">${esc(config.freeText)}</textarea>
      <label for="unknownPolicy">ما يقوله البوت حين لا يعرف الجواب</label>
      <input id="unknownPolicy" value="${esc(config.unknownPolicy)}">
      <div class="actions"><button class="btn" id="saveConfig">حفظ</button></div>
    </div>

    <div class="card">
      <h3>أسئلة وأجوبة (${entries.length})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:35%">السؤال</th><th>الجواب</th><th style="width:90px"></th></tr></thead>
        <tbody>${entries
          .map(
            (e) => `<tr>
              <td><input data-q="${e.id}" value="${esc(e.question)}"></td>
              <td><input data-a="${e.id}" value="${esc(e.answer)}"></td>
              <td>
                <button class="btn ghost small" data-save="${e.id}">حفظ</button>
                <button class="btn danger small" data-del="${e.id}">حذف</button>
              </td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>

      <div class="row" style="margin-top:14px">
        <div><label for="newQ">سؤال جديد</label><input id="newQ" placeholder="كم سعر الكشف؟"></div>
        <div><label for="newA">الجواب</label><input id="newA" placeholder="الكشف ١٥٠ ريال."></div>
        <div style="flex:0 0 auto"><button class="btn" id="add">إضافة</button></div>
      </div>
    </div>
  `;

  document.getElementById('saveConfig').onclick = guard(async () => {
    await put(`/api/tenants/${state.tenantId}/modules/inquiries/config`, {
      freeText: document.getElementById('freeText').value,
      unknownPolicy: document.getElementById('unknownPolicy').value,
    });
    flash('حُفظت المعرفة.');
  });

  document.getElementById('add').onclick = guard(async () => {
    await post(`/api/tenants/${state.tenantId}/kb`, {
      question: document.getElementById('newQ').value,
      answer: document.getElementById('newA').value,
    });
    await renderKnowledge(main);
  });

  main.querySelectorAll('[data-save]').forEach((button) => {
    button.onclick = guard(async () => {
      const id = button.dataset.save;
      await patch(`/api/tenants/${state.tenantId}/kb/${id}`, {
        question: main.querySelector(`[data-q="${id}"]`).value,
        answer: main.querySelector(`[data-a="${id}"]`).value,
      });
      flash('حُفظ السؤال.');
    });
  });

  main.querySelectorAll('[data-del]').forEach((button) => {
    button.onclick = guard(async () => {
      await del(`/api/tenants/${state.tenantId}/kb/${button.dataset.del}`);
      await renderKnowledge(main);
    });
  });

  wireOnboarding(main, () => renderKnowledge(main));
}


/* ---------------------------------------------------------------
   رفع ملف التأسيس
--------------------------------------------------------------- */

/**
 * يُركَّب بعد رسم الشاشة.
 *
 * يُقرأ الملف في المتصفح ويُرسل base64: الرفع بـmultipart يحتاج
 * ملحقاً في الخادم لمسار واحد، والملف هنا كيلوبايتات — نصوص لا صور.
 */
export function wireOnboarding(main, reload) {
  const picker = main.querySelector('#xlsxFile');
  const button = main.querySelector('#pickFile');
  const box = main.querySelector('#importResult');
  if (!picker || !button) return;

  button.onclick = () => picker.click();

  picker.onchange = guard(async () => {
    const file = picker.files?.[0];
    if (!file) return;

    button.disabled = true;
    button.textContent = 'جارٍ القراءة…';
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('تعذّرت قراءة الملف.'));
        reader.readAsDataURL(file);
      });

      const result = await post(`/api/tenants/${state.tenantId}/onboarding/import`, { file: base64 });

      box.innerHTML = `
        <div class="warn-box" style="background:#e6f3ea;border-color:#c3e2cd">
          ✅ أُضيف <strong>${result.added}</strong> مدخلاً.
          ${result.skipped ? `تُخطّي ${result.skipped} صفاً (فارغ أو مكرر أو مثال).` : ''}
          ${result.notes?.length ? `<p class="muted" style="margin:6px 0 0">${result.notes.map(esc).join('<br>')}</p>` : ''}
        </div>`;

      if (result.added > 0) await reload();
    } finally {
      // يُصفَّر دائماً وإلا تعذّر رفع الملف نفسه مرة أخرى بعد تصحيحه.
      picker.value = '';
      button.disabled = false;
      button.textContent = 'رفع الملف بعد ملئه';
    }
  });
}
