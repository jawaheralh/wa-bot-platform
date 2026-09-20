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
}
