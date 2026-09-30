/**
 * الطلبات — تغيير الحالة هنا يُرسل تحديثاً للعميل على واتساب تلقائياً،
 * ونتيجة الإرسال تُعرض صراحةً فلا يُوهَم الموظف أن العميل عَلِم.
 */

import { get, patch, post, esc, ago, guard, flash, state } from '../core.js';
import { renderCaseForm, readCaseForm, extraLine } from '../case-form.js';

const STATUS_CLASS = {
  new: 'red',
  in_progress: 'amber',
  waiting_customer: 'amber',
  done: 'green',
  cancelled: 'grey',
};

export async function renderRequests(main) {
  const [{ requests, statuses, kinds }, { fields }] = await Promise.all([
    get(`/api/tenants/${state.tenantId}/requests`),
    get(`/api/tenants/${state.tenantId}/requests/fields`),
  ]);
  const open = requests.filter((r) => !['done', 'cancelled'].includes(r.status));

  main.innerHTML = `
    <h2>الطلبات</h2>
    <p class="subtitle">
      ${open.length} طلب مفتوح من أصل ${requests.length} ·
      تغيير الحالة يُرسل تحديثاً للعميل على واتساب تلقائياً
    </p>

    <div class="actions" style="margin-bottom:14px">
      <button class="btn" id="newCase">تسجيل طلب</button>
    </div>
    <div class="card" id="caseBox" hidden></div>

    <div class="card">
      ${
        requests.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>رقم الطلب</th><th>العميل</th><th>النوع</th><th>الطلب</th>
                <th>آخر تحديث</th><th>أُبلغ العميل</th><th>الحالة</th><th></th>
              </tr></thead>
              <tbody>${requests
                .map(
                  (r) => `<tr>
                    <td class="num">${esc(r.reference)}
                      ${r.priority === 'urgent' ? '<br><span class="badge red">عاجل</span>' : ''}</td>
                    <td>${esc(r.customer_name || '—')}<br><span class="num muted">${esc(r.customer_wa)}</span></td>
                    <td>${esc(kinds[r.kind] ?? r.kind)}</td>
                    <td>${esc(r.summary)}${extraLine(fields, r.extra)}${
                      r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ''
                    }</td>
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
                    <td><button class="btn ghost small" data-edit="${r.id}">تعديل</button></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد طلبات بعد.</div>'
      }
    </div>
  `;

  const box = main.querySelector('#caseBox');

  const PRIORITY_AR = { normal: 'عادي', urgent: 'عاجل' };
  const CHOICES = {
    a: { label: 'النوع', field: 'kind', options: kinds },
    b: { label: 'الأولوية', field: 'priority', options: PRIORITY_AR },
  };
  const LABELS = { newTitle: 'طلب جديد', summary: 'وصف الطلب', withName: true };

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
        customerName: form.customerName,
        kind: form.a,
        priority: form.b,
        summary: form.summary,
        extra: form.extra,
      };

      if (row) {
        await patch(`/api/tenants/${state.tenantId}/requests/${row.id}/details`, payload);
        flash('حُفظ التعديل.');
      } else {
        await post(`/api/tenants/${state.tenantId}/requests`, payload);
        flash('سُجّل الطلب.');
      }
      await renderRequests(main);
    });
  }

  main.querySelector('#newCase').onclick = () => openForm(null);

  main.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = () => openForm(requests.find((r) => r.id === Number(button.dataset.edit)));
  });

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
