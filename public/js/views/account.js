/**
 * حسابي — تغيير كلمة المرور.
 *
 * الشاشة الوحيدة التي لا تخصّ منشأة: تظهر لكل دور، ومنها يغيّر أدمن
 * النظام كلمته أيضاً وهو ليس موظفاً في أي منشأة.
 */

import { get, post, esc, guard, flash, state } from '../core.js';

const ROLE_AR = { system: 'أدمن النظام', tenant: 'مالك المنشأة', agent: 'موظف' };

export async function renderAccount(main) {
  const me = state.me ?? {};
  const tfa = await get('/api/me/2fa');

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

    <div class="card">
      <h3>التحقق بخطوتين</h3>
      <p class="muted">
        كلمة مرور مسرّبة وحدها لا تكفي للدخول: يُطلب معها رمز يتغيّر كل
        ثلاثين ثانية من تطبيق على جوالك.
      </p>
      <div id="tfaBox"></div>
    </div>
  `;

  drawTwoFactor(main.querySelector('#tfaBox'), tfa);

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
    flash('تم تغيير كلمة المرور — يلزم تسجيل الدخول من جديد.');
    setTimeout(() => {
      location.href = '/login.html';
    }, 1500);
  });
}


/* ---------------------------------------------------------------
   التحقق بخطوتين
--------------------------------------------------------------- */

function drawTwoFactor(box, tfa) {
  if (tfa.enabled) {
    box.innerHTML = `
      <p><strong style="color:var(--ok,#0a7)">مفعّل ✓</strong></p>
      <p class="muted">رموز الاسترجاع المتبقية: <strong>${tfa.recoveryLeft}</strong></p>
      <div style="margin-top:12px">
        <label for="offPw">كلمة المرور لتعطيله</label>
        <input id="offPw" type="password" autocomplete="current-password">
      </div>
      <div style="margin-top:10px"><button class="btn danger" id="off">تعطيل</button></div>
    `;
    box.querySelector('#off').onclick = guard(async () => {
      await post('/api/me/2fa/disable', { password: box.querySelector('#offPw').value });
      flash('عُطّل التحقق بخطوتين.');
      const fresh = await get('/api/me/2fa');
      drawTwoFactor(box, fresh);
    });
    return;
  }

  box.innerHTML = `<button class="btn" id="startTfa">تفعيل</button>`;
  box.querySelector('#startTfa').onclick = guard(async () => {
    const setup = await post('/api/me/2fa/start');
    drawSetup(box, setup);
  });
}

function drawSetup(box, setup) {
  // السرّ مقسّم أرباعاً: إدخاله يدوياً في التطبيق أسهل وأقل خطأً.
  const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim();

  box.innerHTML = `
    <ol class="steps">
      <li>
        تنزيل تطبيق مصادقة على الجوال —
        <strong>Google Authenticator</strong> أو <strong>Microsoft Authenticator</strong>.
      </li>
      <li>
        اختيار «إضافة حساب» فيه ثم «إدخال مفتاح الإعداد»، وإدخال:
        <div class="secret" dir="ltr">${esc(grouped)}</div>
      </li>
      <li>كتابة الرمز المعروض في التطبيق للتأكيد:</li>
    </ol>

    <div style="max-width:220px">
      <label for="tfaCode">الرمز (٦ أرقام)</label>
      <input id="tfaCode" dir="ltr" inputmode="numeric" maxlength="6" placeholder="123456">
    </div>
    <div style="margin-top:12px">
      <button class="btn" id="confirmTfa">تأكيد وتفعيل</button>
      <button class="btn ghost" id="cancelTfa">إلغاء</button>
    </div>
  `;

  box.querySelector('#cancelTfa').onclick = guard(async () => {
    drawTwoFactor(box, await get('/api/me/2fa'));
  });

  box.querySelector('#confirmTfa').onclick = guard(async () => {
    const result = await post('/api/me/2fa/confirm', { code: box.querySelector('#tfaCode').value });
    drawRecovery(box, result.recoveryCodes);
  });
}

function drawRecovery(box, codes) {
  // تُعرض مرة واحدة: عندنا مُجزّأة لا نصاً، فلا سبيل لعرضها ثانية.
  box.innerHTML = `
    <p><strong style="color:var(--ok,#0a7)">فُعّل التحقق بخطوتين ✓</strong></p>
    <p class="muted">
      تُحفظ هذه الرموز في مكان آمن. كلٌّ يُستعمل مرة واحدة، وهي الطريق
      الوحيد للدخول لو ضاع الجوال.
      <strong>لن تُعرض مرة أخرى.</strong>
    </p>
    <div class="secret" dir="ltr">${codes.map(esc).join('<br>')}</div>
    <div style="margin-top:12px"><button class="btn" id="doneTfa">حفظتها</button></div>
  `;
  box.querySelector('#doneTfa').onclick = guard(async () => {
    drawTwoFactor(box, await get('/api/me/2fa'));
  });
}
