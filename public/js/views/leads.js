/**
 * طلبات التجربة الواردة من صفحة الهبوط.
 *
 * بلا هذه الشاشة يصل الطلب إلى قاعدة البيانات ولا يراه أحد — فيملأ
 * عميل محتمل النموذج وينتظر رداً لا يأتي، وهو أسوأ من ألّا تكون
 * الصفحة موجودة أصلاً.
 */

import { get, patch, esc, guard, flash } from '../core.js';

const STATUS_AR = {
  new: 'جديد',
  contacted: 'تواصلنا',
  done: 'مكتمل',
  spam: 'مزعج',
};

export async function renderLeads(main) {
  const { requests } = await get('/api/system/demo-requests');
  const fresh = requests.filter((r) => r.status === 'new').length;

  main.innerHTML = `
    <h2>طلبات التجربة</h2>
    <p class="subtitle">
      ${requests.length} طلباً · <strong>${fresh}</strong> لم يُتواصل معه بعد
    </p>

    ${
      requests.length === 0
        ? `<div class="card"><p class="muted" style="margin:0">
             لا طلبات بعد. صفحة الهبوط على العنوان العام، والطلب يصل هنا فور إرساله.
           </p></div>`
        : `<div class="card"><div class="table-wrap"><table>
            <thead><tr>
              <th>المنشأة</th><th>مقدّم الطلب</th><th>التواصل</th>
              <th>الفريق</th><th>وصل</th><th>الحالة</th>
            </tr></thead>
            <tbody>
              ${requests.map(row).join('')}
            </tbody>
          </table></div></div>`
    }
  `;

  main.querySelectorAll('[data-status]').forEach((select) => {
    select.onchange = guard(async () => {
      await patch(`/api/system/demo-requests/${select.dataset.status}`, { status: select.value });
      flash('حُدّثت الحالة.');
      await renderLeads(main);
    });
  });
}

function row(r) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
  // البريد والجوال قابلان للضغط: الموظف يتواصل من هنا لا بالنسخ واللصق.
  return `
    <tr${r.status === 'spam' ? ' style="opacity:.5"' : ''}>
      <td><strong>${esc(r.company)}</strong>${r.country ? `<br><span class="muted">${esc(r.country)}</span>` : ''}</td>
      <td>${esc(name)}${r.role ? `<br><span class="muted">${esc(r.role)}</span>` : ''}</td>
      <td dir="ltr" style="text-align:start">
        <a href="mailto:${esc(r.email)}">${esc(r.email)}</a><br>
        <a href="https://wa.me/${esc(r.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(r.phone)}</a>
      </td>
      <td class="muted">${esc(r.team_size ?? '—')}</td>
      <td class="muted">${esc(r.created_at.slice(0, 16))}</td>
      <td>
        <select data-status="${r.id}">
          ${Object.entries(STATUS_AR)
            .map(([k, v]) => `<option value="${k}"${r.status === k ? ' selected' : ''}>${v}</option>`)
            .join('')}
        </select>
      </td>
    </tr>`;
}
