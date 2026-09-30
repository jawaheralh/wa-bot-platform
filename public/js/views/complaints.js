/** سجل الشكاوى وتغيير حالتها. */

import { get, post, patch, esc, guard, flash, state } from '../core.js';
import { renderCaseForm, readCaseForm, extraLine } from '../case-form.js';

const STATUS_AR = { new: 'جديدة', in_progress: 'قيد المعالجة', closed: 'مغلقة' };
const STATUS_CLASS = { new: 'red', in_progress: 'amber', closed: 'green' };
const CATEGORY_AR = { service: 'خدمة', quality: 'جودة', delay: 'تأخير', billing: 'فوترة', other: 'أخرى' };
const SEVERITY_AR = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية' };

export async function renderComplaints(main) {
  const [list, { fields }] = await Promise.all([
    get(`/api/tenants/${state.tenantId}/complaints`),
    get(`/api/tenants/${state.tenantId}/complaints/fields`),
  ]);

  main.innerHTML = `
    <h2>الشكاوى</h2>
    <p class="subtitle">${list.length} شكوى · الحالة تُغيَّر مباشرة من الجدول</p>

    <div class="actions" style="margin-bottom:14px">
      <button class="btn" id="newCase">تسجيل شكوى</button>
    </div>
    <div class="card" id="caseBox" hidden></div>

    <div class="card">
      ${
        list.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>المرجع</th><th>الشكوى</th><th>التصنيف</th><th>الخطورة</th>
                <th>التاريخ</th><th>الحالة</th><th></th>
              </tr></thead>
              <tbody>${list
                .map(
                  (c) => `<tr>
                    <td class="num">${esc(c.reference)}<br><span class="num muted">${esc(c.customer_wa)}</span></td>
                    <td>${esc(c.summary)}${extraLine(fields, c.extra)}${
                      c.resolution ? `<br><span class="muted">${esc(c.resolution)}</span>` : ''
                    }</td>
                    <td>${esc(CATEGORY_AR[c.category] || c.category)}</td>
                    <td>${
                      c.severity === 'high'
                        ? '<span class="badge red">عالية</span>'
                        : esc(SEVERITY_AR[c.severity] || c.severity)
                    }</td>
                    <td class="num muted">${esc(c.created_at.slice(0, 16))}</td>
                    <td>
                      <span class="badge ${STATUS_CLASS[c.status]}">${esc(STATUS_AR[c.status])}</span>
                      <select data-id="${c.id}" style="margin-top:6px">
                        ${Object.entries(STATUS_AR)
                          .map(
                            ([value, label]) =>
                              `<option value="${value}"${value === c.status ? ' selected' : ''}>${label}</option>`,
                          )
                          .join('')}
                      </select>
                    </td>
                    <td><button class="btn ghost small" data-edit="${c.id}">تعديل</button></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد شكاوى.</div>'
      }
    </div>
  `;

  const box = main.querySelector('#caseBox');

  const CHOICES = {
    a: { label: 'التصنيف', field: 'category', options: CATEGORY_AR },
    b: { label: 'الخطورة', field: 'severity', options: SEVERITY_AR },
  };
  const LABELS = { newTitle: 'شكوى جديدة', summary: 'وصف الشكوى', withName: false };

  function openForm(row) {
    renderCaseForm(box, { fields, row, choices: CHOICES, labels: LABELS });
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    box.querySelector('#cf-cancel').onclick = () => {
      box.hidden = true;
    };

    box.querySelector('#cf-save').onclick = guard(async () => {
      const form = readCaseForm(box);
      const payload = {
        customerWa: form.customerWa,
        category: form.a,
        severity: form.b,
        summary: form.summary,
        extra: form.extra,
      };

      if (row) {
        await patch(`/api/tenants/${state.tenantId}/complaints/${row.id}/details`, payload);
        flash('حُفظ التعديل.');
      } else {
        await post(`/api/tenants/${state.tenantId}/complaints`, payload);
        flash('سُجّلت الشكوى.');
      }
      await renderComplaints(main);
    });
  }

  main.querySelector('#newCase').onclick = () => openForm(null);

  main.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => openForm(list.find((c) => c.id === Number(button.dataset.edit)));
  });

  main.querySelectorAll('select[data-id]').forEach((select) => {
    select.onchange = guard(async () => {
      let resolution;
      if (select.value === 'closed') {
        resolution = prompt('ملاحظة الإغلاق (اختياري):') ?? undefined;
      }
      await patch(`/api/tenants/${state.tenantId}/complaints/${select.dataset.id}`, {
        status: select.value,
        resolution,
      });
      flash('حُدّثت حالة الشكوى.');
      await renderComplaints(main);
    });
  });
}
