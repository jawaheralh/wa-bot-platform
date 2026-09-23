/**
 * الطلبات — تغيير الحالة هنا يُرسل تحديثاً للعميل على واتساب تلقائياً،
 * ونتيجة الإرسال تُعرض صراحةً فلا يُوهَم الموظف أن العميل عَلِم.
 */

import { get, patch, post, esc, ago, guard, flash, state } from '../core.js';

const STATUS_CLASS = {
  new: 'red',
  in_progress: 'amber',
  waiting_customer: 'amber',
  done: 'green',
  cancelled: 'grey',
};

export async function renderRequests(main) {
  const { requests, statuses, kinds } = await get(`/api/tenants/${state.tenantId}/requests`);
  const open = requests.filter((r) => !['done', 'cancelled'].includes(r.status));

  main.innerHTML = `
    <h2>الطلبات</h2>
    <p class="subtitle">
      ${open.length} طلب مفتوح من أصل ${requests.length} ·
      تغيير الحالة يُرسل تحديثاً للعميل على واتساب تلقائياً
    </p>
    <div class="card">
      ${
        requests.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>رقم الطلب</th><th>العميل</th><th>النوع</th><th>الطلب</th>
                <th>آخر تحديث</th><th>أُبلغ العميل</th><th>الحالة</th>
              </tr></thead>
              <tbody>${requests
                .map(
                  (r) => `<tr>
                    <td class="num">${esc(r.reference)}
                      ${r.priority === 'urgent' ? '<br><span class="badge red">عاجل</span>' : ''}</td>
                    <td>${esc(r.customer_name || '—')}<br><span class="num muted">${esc(r.customer_wa)}</span></td>
                    <td>${esc(kinds[r.kind] ?? r.kind)}</td>
                    <td>${esc(r.summary)}${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ''}</td>
                    <td class="num muted">${esc(ago(r.updated_at))}</td>
                    <td>${
                      r.notified_status === r.status
                        ? '<span class="badge green">نعم</span>'
                        : `<span class="badge amber">لا</span>
                           <button class="btn ghost small" data-notify="${r.id}">إرسال</button>`
                    }</td>
                    <td>
                      <span class="badge ${STATUS_CLASS[r.status] ?? 'grey'}">${esc(statuses[r.status])}</span>
                      <select data-id="${r.id}" style="margin-top:6px">
                        ${Object.entries(statuses)
                          .map(
                            ([value, label]) =>
                              `<option value="${value}"${value === r.status ? ' selected' : ''}>${esc(label)}</option>`,
                          )
                          .join('')}
                      </select>
                    </td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد طلبات بعد.</div>'
      }
    </div>
  `;

  main.querySelectorAll('select[data-id]').forEach((select) => {
    select.onchange = guard(async () => {
      const note = prompt('ملاحظة تظهر للعميل في رسالة التحديث (اختياري):') ?? undefined;
      const { notice } = await patch(`/api/tenants/${state.tenantId}/requests/${select.dataset.id}`, {
        status: select.value,
        note,
      });
      flash(
        notice.sent ? 'حُدّثت الحالة وأُبلغ العميل على واتساب.' : `حُدّثت الحالة — لم يُبلَّغ العميل: ${notice.reason}`,
        notice.sent ? 'ok' : 'error',
      );
      await renderRequests(main);
    });
  });

  main.querySelectorAll('[data-notify]').forEach((button) => {
    button.onclick = guard(async () => {
      const notice = await post(`/api/tenants/${state.tenantId}/requests/${button.dataset.notify}/notify`);
      flash(notice.sent ? 'أُرسل التحديث للعميل.' : `تعذّر الإرسال: ${notice.reason}`, notice.sent ? 'ok' : 'error');
      await renderRequests(main);
    });
  });
}
