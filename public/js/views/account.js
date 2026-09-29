/**
 * حسابي — تغيير كلمة المرور.
 *
 * الشاشة الوحيدة التي لا تخصّ منشأة: تظهر لكل دور، ومنها يغيّر أدمن
 * النظام كلمته أيضاً وهو ليس موظفاً في أي منشأة.
 */

import { post, esc, guard, flash, state } from '../core.js';

const ROLE_AR = { system: 'أدمن النظام', tenant: 'مالك المنشأة', agent: 'موظف' };

export async function renderAccount(main) {
  const me = state.me ?? {};

  main.innerHTML = `
    <h2>حسابي</h2>
    <p class="subtitle">${esc(me.displayName ?? me.username ?? '')} · ${esc(ROLE_AR[me.role] ?? me.role ?? '')}</p>

    <div class="card">
      <h3>تغيير كلمة المرور</h3>
      <p class="muted">
        عشرة أحرف على الأقل. بعد الحفظ يُغلق الدخول وتعودين لتسجيل
        الدخول بالكلمة الجديدة.
      </p>

      <div>
        <label for="cur">كلمة المرور الحالية</label>
        <input id="cur" type="password" autocomplete="current-password">
      </div>
      <div>
        <label for="nw">الكلمة الجديدة</label>
        <input id="nw" type="password" autocomplete="new-password">
      </div>
      <div>
        <label for="nw2">تأكيد الكلمة الجديدة</label>
        <input id="nw2" type="password" autocomplete="new-password">
      </div>

      <div style="margin-top:14px"><button class="btn" id="save">حفظ</button></div>
    </div>
  `;

  main.querySelector('#save').onclick = guard(async () => {
    const current = main.querySelector('#cur').value;
    const next = main.querySelector('#nw').value;
    const again = main.querySelector('#nw2').value;

    // التأكيد يُفحص هنا لا في الخادم: خطأ مطبعي في كلمة لا تُعرض
    // يقفل الحساب على صاحبه، والخادم لا يملك ما يقارن به.
    if (next !== again) {
      flash('الكلمتان غير متطابقتين.', 'error');
      return;
    }

    await post('/api/me/password', { current, next });
    flash('تم تغيير كلمة المرور. سجّلي الدخول من جديد.');
    setTimeout(() => {
      location.href = '/login.html';
    }, 1500);
  });
}
