/**
 * إعداد منشأة بعينها.
 *
 * كانت شاشة «الإعداد» تعرض إعدادات النظام العام أياً كانت المنشأة
 * المفتوحة: تفتحين «مطعم الركن» فترين توكن «وقودي» — فتظنّين المطعم
 * مضبوطاً وهو لم يُربط بعد، ولا يظهر الخطأ إلا حين لا يرد بوته.
 *
 * هنا كل شيء لهذه المنشأة وحدها: رقمها، وتوكنها، وتطبيقها، ومفتاح
 * Claude الخاص بها — ومفتاحها هو ما يفصل مصروفها عن مصروف غيرها.
 */

import { get, post, patch, esc, guard, flash, state } from '../core.js';

const HINTS = {
  waNumber: 'رقم واتساب الظاهر لعملاء هذه المنشأة',
  waPhoneNumberId: 'Meta ← WhatsApp ← API Setup ← Phone number ID',
  waAccessToken: 'business.facebook.com ← مستخدمو النظام ← إنشاء رمز (دائم لا مؤقت)',
  waAppSecret: 'developers.facebook.com ← إعدادات التطبيق ← أساسي ← إظهار',
  waAppId: 'يظهر في نفس صفحة المفتاح السري',
  waBusinessId: 'business.facebook.com ← معلومات النشاط التجاري',
  anthropicApiKey: 'console.anthropic.com ← API Keys. مفتاح خاص = مصروف منفصل لهذه المنشأة.',
  staffWaNumber: 'يصله تنبيه حين يحوّل البوت محادثة لموظف',
};

export async function renderTenantSetup(main) {
  main.innerHTML = '<h2>الإعداد</h2><div class="empty">جارٍ فحص هذه المنشأة…</div>';

  const data = await get(`/api/system/tenants/${state.tenantId}/setup`);
  const t = data.tenant;

  const badge = (ok) =>
    ok ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>';

  main.innerHTML = `
    <h2>إعداد «${esc(t.name)}»</h2>
    <p class="subtitle">
      هذه الإعدادات لهذه المنشأة وحدها.
      ${
        data.own
          ? '<span class="badge green">بحساب Meta خاص بها</span>'
          : '<span class="badge amber">لم تُربط بعد</span>'
      }
      ${
        data.ownClaude
          ? '<span class="badge green">مفتاح Claude خاص</span>'
          : '<span class="badge amber">Claude مشترك</span>'
      }
    </p>

    <div class="card">
      <h3>حالة هذه المنشأة</h3>
      <div class="table-wrap"><table><tbody>
        ${data.checks
          .map(
            (c) => `<tr>
              <td style="width:40px">${badge(c.ok)}</td>
              <td style="width:170px"><strong>${esc(c.label)}</strong></td>
              <td class="muted">${esc(c.message)}</td>
            </tr>`,
          )
          .join('')}
      </tbody></table></div>

      <div class="actions" style="margin-top:12px">
        <button class="btn" id="hook">اربط الـwebhook لهذه المنشأة</button>
        <button class="btn ghost" id="recheck">إعادة الفحص</button>
      </div>
      <p class="muted" style="margin-top:8px">
        يسجّل عنوانك لدى تطبيق <strong>هذه المنشأة</strong> ويشترك حساب
        واتسابها فيه — لا يمسّ المنشآت الأخرى.
      </p>
    </div>

    <div class="card">
      <h3>الرقم والهوية</h3>
      ${field('waNumber', 'رقم واتساب', t.waNumber, false)}
      ${field('waPhoneNumberId', 'معرّف الرقم (Phone number ID)', t.waPhoneNumberId, false)}
      ${field('staffWaNumber', 'رقم الموظف للتنبيهات', t.staffWaNumber, false)}
      <label for="f-tone">نبرة الرد</label>
      <select id="f-tone">
        <option value="friendly"${t.tone === 'friendly' ? ' selected' : ''}>ودّية</option>
        <option value="formal"${t.tone === 'formal' ? ' selected' : ''}>رسمية</option>
      </select>
    </div>

    <div class="card">
      <h3>حساب Meta الخاص بهذه المنشأة</h3>
      <p class="muted" style="margin-top:0">
        لكل شركة حساب أعمال وتطبيق خاص بها. لا يجوز أن ترسل شركة بتوكن
        شركة أخرى — رقمها يظهر تحت تطبيق غيرها وفاتورتها تُحمّل عليه.
      </p>
      ${field('waAccessToken', 'توكن الوصول', data.secrets.waAccessToken, true)}
      ${field('waAppSecret', 'المفتاح السري للتطبيق', data.secrets.waAppSecret, true)}
      ${field('waAppId', 'معرّف التطبيق', t.waAppId, false)}
      ${field('waBusinessId', 'معرّف النشاط التجاري', t.waBusinessId, false)}
    </div>

    <div class="card">
      <h3>مفتاح Claude</h3>
      ${field('anthropicApiKey', 'مفتاح هذه المنشأة', data.secrets.anthropicApiKey, true)}
    </div>

    <div class="actions">
      <button class="btn" id="save">حفظ إعدادات هذه المنشأة</button>
    </div>
  `;

  main.querySelector('#save').onclick = guard(async () => {
    const value = (key) => main.querySelector(`#f-${key}`).value.trim();
    const body = { tone: main.querySelector('#f-tone').value };

    for (const key of Object.keys(HINTS)) {
      const input = main.querySelector(`#f-${key}`);
      if (!input) continue;
      // السرّ المحجوب المُعاد كما هو لا يُرسل — الخادم يتجاهله، لكن
      // عدم إرساله أصلاً أوضح وأقل عرضاً للخطأ.
      if (input.dataset.secret === '1' && input.value.includes('…')) continue;
      body[key] = value(key);
    }

    await patch(`/api/system/tenants/${state.tenantId}`, body);
    flash('حُفظت إعدادات هذه المنشأة.');
    await renderTenantSetup(main);
  });

  main.querySelector('#recheck').onclick = guard(async () => {
    await renderTenantSetup(main);
  });

  main.querySelector('#hook').onclick = guard(async () => {
    const result = await post(`/api/system/tenants/${state.tenantId}/configure-webhook`);
    flash(result.message || 'تم الضبط.');
    await renderTenantSetup(main);
  });
}

function field(key, label, value, secret) {
  return `
    <label for="f-${key}">${esc(label)}${
      secret && value ? ' <span class="badge green">مضبوط</span>' : ''
    }</label>
    <input id="f-${key}" dir="ltr" data-secret="${secret ? '1' : '0'}"
           value="${esc(value ?? '')}"
           placeholder="${secret && value ? 'بلا تغيير' : ''}">
    <p class="muted" style="margin:4px 0 12px">${esc(HINTS[key] ?? '')}</p>
  `;
}
