/** سجل الشكاوى وتغيير حالتها. */

import { get, patch, esc, guard, flash, state } from '../core.js';

const STATUS_AR = { new: 'جديدة', in_progress: 'قيد المعالجة', closed: 'مغلقة' };
const STATUS_CLASS = { new: 'red', in_progress: 'amber', closed: 'green' };
const CATEGORY_AR = { service: 'خدمة', quality: 'جودة', delay: 'تأخير', billing: 'فوترة', other: 'أخرى' };
const SEVERITY_AR = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية' };

export async function renderComplaints(main) {
  const list = await get(`/api/tenants/${state.tenantId}/complaints`);

  main.innerHTML = `
    <h2>الشكاوى</h2>
    <p class="subtitle">${list.length} شكوى · غيّري الحالة مباشرة من الجدول</p>
    <div class="card">
      ${
        list.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>المرجع</th><th>الشكوى</th><th>التصنيف</th><th>الخطورة</th>
                <th>التاريخ</th><th>الحالة</th>
              </tr></thead>
              <tbody>${list
                .map(
                  (c) => `<tr>
                    <td class="num">${esc(c.reference)}<br><span class="num muted">${esc(c.customer_wa)}</span></td>
                    <td>${esc(c.summary)}${c.resolution ? `<br><span class="muted">${esc(c.resolution)}</span>` : ''}</td>
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
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد شكاوى.</div>'
      }
    </div>
  `;

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
