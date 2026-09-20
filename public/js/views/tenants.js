/** شاشة أدمن النظام: كل المنشآت وإضافة منشأة. */

import { get, post, esc, guard, flash, state } from '../core.js';

export async function renderTenants(main, onPick) {
  const tenants = await get('/api/system/tenants');

  main.innerHTML = `
    <h2>المنشآت</h2>
    <p class="subtitle">${tenants.length} منشأة</p>

    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>المنشأة</th><th>الرقم</th><th>الاتصال</th><th>الوحدات</th>
          <th>محادثات</th><th>شكاوى مفتوحة</th><th></th>
        </tr></thead>
        <tbody>${tenants
          .map(
            (t) => `<tr>
              <td>${esc(t.name)} ${
                t.status === 'active' ? '' : '<span class="badge red">موقوفة</span>'
              }</td>
              <td class="num">${esc(t.wa_number)}</td>
              <td>${
                t.connection.connected
                  ? '<span class="badge green">متصل</span>'
                  : `<span class="badge amber">${esc(t.connection.detail || 'غير متصل')}</span>`
              }</td>
              <td class="muted">${t.modules
                .filter((m) => m.enabled)
                .map((m) => esc(m.titleAr))
                .join('، ')}</td>
              <td class="num">${t.conversations}</td>
              <td class="num">${t.openComplaints}</td>
              <td><button class="btn ghost small" data-pick="${t.id}">إدارة</button></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h3>إضافة منشأة</h3>
      <div class="row">
        <div><label for="name">اسم المنشأة</label><input id="name" placeholder="عيادة النور"></div>
        <div><label for="waNumber">رقم واتساب</label><input id="waNumber" dir="ltr" placeholder="966500000001"></div>
        <div><label for="tone">النبرة</label>
          <select id="tone"><option value="friendly">ودّية</option><option value="formal">رسمية</option></select>
        </div>
      </div>
      <div class="row">
        <div><label for="staffWaNumber">رقم الموظف للتنبيهات</label><input id="staffWaNumber" dir="ltr" placeholder="966500000099"></div>
        <div><label for="waPhoneNumberId">معرّف الرقم في Cloud API (اختياري)</label><input id="waPhoneNumberId" dir="ltr"></div>
      </div>
      <div class="row">
        <div><label for="adminUsername">مستخدم أدمن المنشأة</label><input id="adminUsername" dir="ltr" placeholder="noor"></div>
        <div><label for="adminPassword">كلمة المرور (٨ أحرف فأكثر)</label><input id="adminPassword" type="password"></div>
      </div>
      <div class="actions"><button class="btn" id="create">إنشاء</button></div>
    </div>
  `;

  main.querySelectorAll('[data-pick]').forEach((button) => {
    button.onclick = () => onPick(Number(button.dataset.pick));
  });

  document.getElementById('create').onclick = guard(async () => {
    const value = (id) => document.getElementById(id).value.trim();
    const tenant = await post('/api/system/tenants', {
      name: value('name'),
      waNumber: value('waNumber'),
      tone: value('tone'),
      staffWaNumber: value('staffWaNumber'),
      waPhoneNumberId: value('waPhoneNumberId'),
      adminUsername: value('adminUsername'),
      adminPassword: document.getElementById('adminPassword').value,
    });
    flash(`أُنشئت «${tenant.name}».`);
    await renderTenants(main, onPick);
  });
}
