/** شاشة أدمن النظام: كل المنشآت وإضافة منشأة. */

import { get, post, patch, esc, guard, flash, state } from '../core.js';

export async function renderTenants(main, onPick) {
  const tenants = await get('/api/system/tenants');

  main.innerHTML = `
    <h2>المنشآت</h2>
    <p class="subtitle">${tenants.length} منشأة</p>

    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>المنشأة</th><th>الرقم</th><th>الاتصال</th><th>الوحدات</th>
          <th>محادثات</th><th>ردود الشهر</th><th>حساب Meta</th><th>مفتاح Claude</th><th></th>
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
              <td class="num">${t.usage?.replies ?? 0}${
                t.usage?.failures ? ` <span class="badge red">${t.usage.failures} فشل</span>` : ''
              }${
                t.cost?.actual
                  ? `<br><span class="muted num">${(t.cost.actual * 3.75).toFixed(2)} ر.س</span>${
                      t.cost.savedPercent > 0
                        ? ` <span class="badge green">وفّر ${t.cost.savedPercent}٪</span>`
                        : ''
                    }`
                  : ''
              }</td>
              <td>${
                t.hasOwnMeta ? '<span class="badge green">خاص</span>' : '<span class="badge grey">حسابك</span>'
              }</td>
              <td>${
                t.hasOwnClaude ? '<span class="badge green">خاص</span>' : '<span class="badge grey">حسابك</span>'
              }</td>
              <td>
                <button class="btn ghost small" data-pick="${t.id}">إدارة</button>
                <button class="btn ghost small" data-meta="${t.id}">بيانات Meta</button>
              </td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </div>

    <div class="card" id="metaCard" hidden>
      <h3>بيانات Meta للمنشأة <span id="metaTenant"></span></h3>
      <p class="muted">
        كل عميل له حساب واتساب أعمال خاص: رقمه وتطبيقه وتوكنه. تُترك الحقول
        فارغة ليستعمل حسابك أنت، أو تُدخَل بياناته ليعمل بحسابه.
      </p>
      <div class="row">
        <div><label for="mToken">توكن Meta الدائم</label><input id="mToken" dir="ltr" placeholder="بلا تغيير"></div>
        <div><label for="mSecret">المفتاح السري للتطبيق</label><input id="mSecret" dir="ltr" placeholder="بلا تغيير"></div>
      </div>
      <div class="row">
        <div><label for="mAppId">معرّف التطبيق</label><input id="mAppId" dir="ltr"></div>
        <div><label for="mBizId">معرّف النشاط التجاري</label><input id="mBizId" dir="ltr"></div>
        <div><label for="mPhoneId">معرّف الرقم (Phone number ID)</label><input id="mPhoneId" dir="ltr"></div>
      </div>
      <label for="mClaude">مفتاح Claude الخاص بالمنشأة</label>
      <input id="mClaude" dir="ltr" placeholder="بلا تغيير">
      <p class="muted" style="margin:4px 0 12px">
        مفتاح خاص يعني أن رصيد هذا العميل ينفد وحده فلا يوقف بقية عملائك،
        وأن تكلفته محسوبة عليه. يُترك فارغاً ليستعمل مفتاحك.
        <br>في console.anthropic.com تُنشأ مساحة عمل لكل عميل بسقف إنفاق
        شهري، ثم يُولَّد مفتاح بنطاقها.
      </p>
      <div class="actions">
        <button class="btn" id="mSave">حفظ</button>
        <button class="btn ghost" id="mClose">إغلاق</button>
      </div>
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

  let editing = null;
  main.querySelectorAll('[data-meta]').forEach((button) => {
    button.onclick = () => {
      editing = tenants.find((t) => t.id === Number(button.dataset.meta));
      document.getElementById('metaTenant').textContent = `«${editing.name}»`;
      document.getElementById('mToken').value = '';
      document.getElementById('mToken').placeholder = editing.waAccessTokenMasked || 'غير مضبوط';
      document.getElementById('mSecret').value = '';
      document.getElementById('mSecret').placeholder = editing.waAppSecretMasked || 'غير مضبوط';
      document.getElementById('mAppId').value = editing.wa_app_id ?? '';
      document.getElementById('mBizId').value = editing.wa_business_id ?? '';
      document.getElementById('mPhoneId').value = editing.wa_phone_number_id ?? '';
      document.getElementById('mClaude').value = '';
      document.getElementById('mClaude').placeholder = editing.anthropicKeyMasked || 'غير مضبوط — يستعمل مفتاحك';
      const card = document.getElementById('metaCard');
      card.hidden = false;
      card.scrollIntoView({ behavior: 'smooth' });
    };
  });

  document.getElementById('mClose').onclick = () => {
    document.getElementById('metaCard').hidden = true;
  };

  document.getElementById('mSave').onclick = guard(async () => {
    const v = (id) => document.getElementById(id).value.trim();
    const payload = {
      waAppId: v('mAppId'),
      waBusinessId: v('mBizId'),
      waPhoneNumberId: v('mPhoneId'),
    };
    // الفارغ يعني «لا تغيّر»، فلا يُرسل ولا يمسح السرّ المحفوظ.
    if (v('mToken')) payload.waAccessToken = v('mToken');
    if (v('mSecret')) payload.waAppSecret = v('mSecret');
    if (v('mClaude')) payload.anthropicApiKey = v('mClaude');

    await patch(`/api/system/tenants/${editing.id}`, payload);
    flash('حُفظت بيانات Meta للمنشأة.');
    await renderTenants(main, onPick);
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
