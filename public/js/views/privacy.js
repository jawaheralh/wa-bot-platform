/**
 * الخصوصية وسجل التدقيق.
 * أدوات تنفيذ حقوق أصحاب البيانات: الاطلاع، والمحو، ومدة الاحتفاظ.
 */

import { get, put, del, esc, guard, flash, state } from '../core.js';

export async function renderPrivacy(main) {
  const [{ tenant }, { entries, actions }] = await Promise.all([
    get(`/api/tenants/${state.tenantId}`),
    get(`/api/tenants/${state.tenantId}/audit`),
  ]);

  main.innerHTML = `
    <h2>الخصوصية وسجل التدقيق</h2>
    <p class="subtitle">أدوات تنفيذ حقوق أصحاب البيانات. ليست استشارة قانونية.</p>

    <div class="card">
      <h3>مدة الاحتفاظ بالرسائل</h3>
      <p class="muted">
        تُحذف نصوص المحادثات الأقدم من هذه المدة تلقائياً كل يوم.
        الشكاوى والطلبات والمواعيد لا تُحذف — هي سجلات عمل.
        <strong>صفر = احتفاظ بلا حد.</strong>
      </p>
      <div class="row">
        <div><label for="days">عدد الأيام</label>
          <input id="days" type="number" min="0" max="3650" value="${Number(tenant.retention_days ?? 0)}"></div>
        <div style="flex:0 0 auto"><button class="btn" id="saveDays">حفظ</button></div>
      </div>
    </div>

    <div class="card">
      <h3>حقوق العميل</h3>
      <p class="muted">أدخلي رقم العميل بصيغة 9665xxxxxxxx.</p>
      <div class="row">
        <div><label for="number">رقم العميل</label><input id="number" dir="ltr" placeholder="966501234567"></div>
        <div style="flex:0 0 auto">
          <button class="btn ghost" id="export">تصدير بياناته</button>
          <button class="btn danger" id="erase">حذف بياناته نهائياً</button>
        </div>
      </div>
      <p class="muted" style="margin-top:8px">
        الحذف فعلي ولا رجعة فيه: المحادثات والرسائل والشكاوى والطلبات والمواعيد
        الخاصة بهذا الرقم <strong>في هذه المنشأة وحدها</strong>.
      </p>
    </div>

    <div class="card">
      <h3>سجل التدقيق</h3>
      ${
        entries.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الهدف</th><th>التفاصيل</th></tr></thead>
              <tbody>${entries
                .map(
                  (e) => `<tr>
                    <td class="num muted">${esc(e.created_at.slice(5, 16))}</td>
                    <td>${esc(e.username || '—')}</td>
                    <td>${esc(actions[e.action] ?? e.action)}</td>
                    <td class="num">${esc(e.target || '')}</td>
                    <td class="muted">${esc(e.detail || '')}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد أحداث بعد.</div>'
      }
    </div>
  `;

  document.getElementById('saveDays').onclick = guard(async () => {
    await put(`/api/tenants/${state.tenantId}/retention`, { days: Number(document.getElementById('days').value) });
    flash('حُفظت مدة الاحتفاظ.');
    await renderPrivacy(main);
  });

  document.getElementById('export').onclick = guard(async () => {
    const number = document.getElementById('number').value.trim();
    if (!number) return;
    const data = await get(`/api/tenants/${state.tenantId}/customers/${encodeURIComponent(number)}/export`);
    // التنزيل من الصفحة نفسها — لا يغادر البيانات الجهاز.
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `بيانات-${number}.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
    flash('نُزّل الملف.');
  });

  document.getElementById('erase').onclick = guard(async () => {
    const number = document.getElementById('number').value.trim();
    if (!number) return;
    if (!confirm(`حذف نهائي لكل بيانات ${number} في هذه المنشأة. لا يمكن التراجع. متأكدة؟`)) return;
    const report = await del(`/api/tenants/${state.tenantId}/customers/${encodeURIComponent(number)}`);
    flash(
      `حُذف: ${report.conversations} محادثة · ${report.messages} رسالة · ${report.complaints} شكوى · ` +
        `${report.requests} طلب · ${report.bookings} موعد`,
    );
    await renderPrivacy(main);
  });
}
