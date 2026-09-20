/**
 * شاشة المواعيد — تظهر فقط إذا كانت وحدة الحجوزات مفعّلة.
 * تستهلك مسارات تُصدّرها الوحدة نفسها في src/modules/bookings.ts.
 */

import { get, post, esc, guard, flash, state } from '../core.js';

const STATUS = {
  booked: ['محجوز', 'green'],
  cancelled: ['ملغى', 'red'],
  done: ['منتهٍ', 'grey'],
};

const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function dayOf(sqlTime) {
  return DAYS[new Date(sqlTime.replace(' ', 'T') + '+03:00').getUTCDay()] ?? '';
}

export async function renderBookings(main) {
  const list = await get(`/api/tenants/${state.tenantId}/bookings`);
  const upcoming = list.filter((b) => b.status === 'booked');

  main.innerHTML = `
    <h2>المواعيد</h2>
    <p class="subtitle">${upcoming.length} موعد قادم من أصل ${list.length}</p>
    <div class="card">
      ${
        list.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>المرجع</th><th>العميل</th><th>الخدمة</th><th>الموعد</th><th>التذكير</th><th>الحالة</th><th></th>
              </tr></thead>
              <tbody>${list
                .map(
                  (b) => `<tr>
                    <td class="num">${esc(b.reference)}</td>
                    <td>${esc(b.customer_name || '—')}<br><span class="num muted">${esc(b.customer_wa)}</span></td>
                    <td>${esc(b.service)}</td>
                    <td>${esc(dayOf(b.starts_at))}
                      <span class="num">${esc(b.starts_at.slice(0, 16))}</span></td>
                    <td class="muted">${b.reminder_sent_at ? 'أُرسل' : '—'}</td>
                    <td><span class="badge ${STATUS[b.status]?.[1] ?? 'grey'}">${esc(
                      STATUS[b.status]?.[0] ?? b.status,
                    )}</span></td>
                    <td>${
                      b.status === 'booked'
                        ? `<button class="btn danger small" data-cancel="${esc(b.reference)}">إلغاء</button>`
                        : ''
                    }</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">لا توجد مواعيد.</div>'
      }
    </div>
  `;

  main.querySelectorAll('[data-cancel]').forEach((button) => {
    button.onclick = guard(async () => {
      await post(`/api/tenants/${state.tenantId}/bookings/${encodeURIComponent(button.dataset.cancel)}/cancel`);
      flash('أُلغي الموعد وأُبلغ العميل.');
      await renderBookings(main);
    });
  });
}
