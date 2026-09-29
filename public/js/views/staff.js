/** الموظفون: من يرد على العملاء، وبأي صلاحية، وعلى أي رقم تصله التنبيهات. */

import { get, post, patch, esc, guard, flash, state } from '../core.js';

export async function renderStaff(main) {
  const { staff, roles, permissions } = await get(`/api/tenants/${state.tenantId}/staff`);
  const isOwner = state.me.role === 'system' || state.me.role === 'tenant';

  main.innerHTML = `
    <h2>الموظفون</h2>
    <p class="subtitle">
      ${staff.length} حساب ·
      ${
        isOwner
          ? 'المالك يملك كل الصلاحيات دائماً. والموظف يُمنح ما تختاره له وحده.'
          : 'هذه قائمة الفريق. الإضافة والتعديل لمالك المنشأة.'
      }
    </p>

    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>الاسم</th><th>المستخدم</th><th>الدور</th><th>الصلاحيات</th><th>رقم التنبيهات</th>
          <th>ردود</th><th>الحالة</th>${isOwner ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${staff
          .map(
            (s) => `<tr>
              <td>${esc(s.displayName)}${s.id === state.me.id ? ' <span class="badge grey">أنت</span>' : ''}</td>
              <td class="mono">${esc(s.username)}</td>
              <td>${
                isOwner && s.id !== state.me.id
                  ? `<select data-role="${s.id}">
                       <option value="agent"${s.role === 'agent' ? ' selected' : ''}>موظف</option>
                       <option value="tenant"${s.role === 'tenant' ? ' selected' : ''}>مالك المنشأة</option>
                     </select>`
                  : esc(roles[s.role] ?? s.role)
              }</td>
              <td>${
                s.role === 'agent'
                  ? `<span class="badge ${s.permissions.length ? 'grey' : 'red'}">${
                      s.permissions.length
                    } من ${permissions.length}</span>${
                      isOwner ? ` <button class="btn ghost small" data-perm="${s.id}">تعديل</button>` : ''
                    }`
                  : '<span class="badge green">الكل</span>'
              }</td>
              <td>${
                isOwner
                  ? `<input class="num" data-wa="${s.id}" dir="ltr" value="${esc(s.waNumber ?? '')}" placeholder="9665…">`
                  : `<span class="num">${esc(s.waNumber ?? '—')}</span>`
              }</td>
              <td class="num">${s.replies}</td>
              <td>${s.active ? '<span class="badge green">نشط</span>' : '<span class="badge grey">معطَّل</span>'}</td>
              ${
                isOwner
                  ? `<td>
                      <button class="btn ghost small" data-save="${s.id}">حفظ</button>
                      ${
                        s.id === state.me.id
                          ? ''
                          : `<button class="btn ${s.active ? 'danger' : 'ghost'} small" data-toggle="${s.id}" data-active="${s.active}">
                               ${s.active ? 'تعطيل' : 'تفعيل'}
                             </button>`
                      }
                      <button class="btn ghost small" data-pw="${s.id}">كلمة مرور</button>
                    </td>`
                  : ''
              }
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="muted" style="margin-top:10px">
        الحساب يُعطَّل ولا يُحذف، حتى تبقى ردوده السابقة منسوبة له في سجل المحادثات.
      </p>
    </div>

    <div class="card" id="permCard" hidden>
      <h3>صلاحيات <span id="permWho"></span></h3>
      <p class="muted" style="margin-top:0">
        ما لا يُؤشَّر هنا يُرفض من الخادم لا من الشاشة فقط.
      </p>
      <div id="permList"></div>
      <div class="actions">
        <button class="btn" id="permSave">حفظ الصلاحيات</button>
        <button class="btn ghost" id="permClose">إغلاق</button>
      </div>
    </div>

    ${
      isOwner
        ? `<div class="card">
            <h3>إضافة موظف</h3>
            <div class="row">
              <div><label for="displayName">الاسم</label><input id="displayName" placeholder="منى"></div>
              <div><label for="username">اسم المستخدم</label><input id="username" dir="ltr" placeholder="mona"></div>
              <div><label for="password">كلمة المرور</label><input id="password" type="password" placeholder="٨ أحرف فأكثر"></div>
            </div>
            <div class="row">
              <div><label for="waNumber">رقم جواله للتنبيهات (اختياري)</label><input id="waNumber" dir="ltr" placeholder="966501234567"></div>
              <div><label for="role">الصلاحية</label>
                <select id="role"><option value="agent">موظف</option><option value="tenant">مالك المنشأة</option></select>
              </div>
            </div>
            <div id="newPerms">
              <label>صلاحياته</label>
              ${permissions
                .map(
                  (p) => `<label class="inline">
                    <input type="checkbox" data-new-perm="${p.key}"${p.byDefault ? ' checked' : ''}>
                    <span>${esc(p.label)} <span class="muted">— ${esc(p.hint)}</span></span>
                  </label>`,
                )
                .join('')}
            </div>
            <div class="actions"><button class="btn" id="add">إضافة</button></div>
          </div>`
        : ''
    }
  `;

  if (!isOwner) return;

  document.getElementById('add').onclick = guard(async () => {
    const value = (id) => document.getElementById(id).value.trim();
    await post(`/api/tenants/${state.tenantId}/staff`, {
      displayName: value('displayName'),
      username: value('username'),
      password: document.getElementById('password').value,
      waNumber: value('waNumber'),
      role: value('role'),
      permissions: [...document.querySelectorAll('[data-new-perm]:checked')].map((box) => box.dataset.newPerm),
    });
    flash('أُضيف الموظف.');
    await renderStaff(main);
  });

  main.querySelectorAll('[data-save]').forEach((button) => {
    button.onclick = guard(async () => {
      const id = button.dataset.save;
      await patch(`/api/tenants/${state.tenantId}/staff/${id}`, {
        waNumber: main.querySelector(`[data-wa="${id}"]`).value.trim(),
        role: main.querySelector(`[data-role="${id}"]`)?.value,
      });
      flash('حُفظ.');
      await renderStaff(main);
    });
  });

  /**
   * الصلاحيات في بطاقة لا في خلية.
   *
   * ست خانات داخل صفّ جدول تُنتج صفاً بارتفاع شاشة، وقراءة شرح كل
   * صلاحية أهم من اختصار نقرة.
   */
  const permCard = document.getElementById('permCard');
  let editing = null;

  main.querySelectorAll('[data-perm]').forEach((button) => {
    button.onclick = () => {
      editing = staff.find((s) => s.id === Number(button.dataset.perm));
      document.getElementById('permWho').textContent = `«${editing.displayName}»`;
      document.getElementById('permList').innerHTML = permissions
        .map(
          (p) => `<label class="inline">
            <input type="checkbox" data-perm-key="${p.key}"${editing.permissions.includes(p.key) ? ' checked' : ''}>
            <span>${esc(p.label)} <span class="muted">— ${esc(p.hint)}</span></span>
          </label>`,
        )
        .join('');
      permCard.hidden = false;
      permCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  });

  document.getElementById('permClose').onclick = () => {
    permCard.hidden = true;
  };

  document.getElementById('permSave').onclick = guard(async () => {
    await patch(`/api/tenants/${state.tenantId}/staff/${editing.id}`, {
      permissions: [...permCard.querySelectorAll('[data-perm-key]:checked')].map((box) => box.dataset.permKey),
    });
    flash('حُفظت الصلاحيات.');
    await renderStaff(main);
  });

  main.querySelectorAll('[data-toggle]').forEach((button) => {
    button.onclick = guard(async () => {
      await patch(`/api/tenants/${state.tenantId}/staff/${button.dataset.toggle}`, {
        active: button.dataset.active !== 'true',
      });
      await renderStaff(main);
    });
  });

  main.querySelectorAll('[data-pw]').forEach((button) => {
    button.onclick = guard(async () => {
      const password = prompt('كلمة المرور الجديدة (٨ أحرف فأكثر):');
      if (!password) return;
      await patch(`/api/tenants/${state.tenantId}/staff/${button.dataset.pw}`, { password });
      flash('غُيّرت كلمة المرور.');
    });
  });
}
