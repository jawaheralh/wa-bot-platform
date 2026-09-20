/**
 * شاشة الوحدات.
 *
 * هي واجهة البيع داخل المنتج: أدمن المنشأة يرى ما لا يملكه بوضوح، مع زر
 * يفتح واتساب معي. لا يستطيع التفعيل بنفسه — أدمن النظام فقط.
 */

import { get, post, put, esc, guard, flash, state } from '../core.js';

/**
 * محرّر إعدادات عام: يبني حقلاً لكل مفتاح حسب نوعه.
 * هكذا تحصل أي وحدة جديدة على شاشة إعدادات بلا كتابة واجهة لها —
 * وهو تكملة لوعد «ملف واحد» على جهة الخادم.
 */
function fieldFor(moduleName, key, value) {
  const id = `cfg-${moduleName}-${key}`;
  const label = LABELS[key] ?? key;

  if (typeof value === 'boolean') {
    return `<label for="${id}">${esc(label)}</label>
      <select id="${id}" data-key="${esc(key)}" data-type="boolean">
        <option value="true"${value ? ' selected' : ''}>نعم</option>
        <option value="false"${value ? '' : ' selected'}>لا</option>
      </select>`;
  }
  if (typeof value === 'number') {
    return `<label for="${id}">${esc(label)}</label>
      <input id="${id}" data-key="${esc(key)}" data-type="number" type="number" value="${esc(value)}">`;
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return `<label for="${id}">${esc(label)}</label>
      <textarea id="${id}" data-key="${esc(key)}" data-type="json" dir="ltr">${esc(
        JSON.stringify(value, null, 2),
      )}</textarea>`;
  }
  const long = String(value ?? '').length > 80;
  return `<label for="${id}">${esc(label)}</label>
    ${
      long
        ? `<textarea id="${id}" data-key="${esc(key)}" data-type="string">${esc(value)}</textarea>`
        : `<input id="${id}" data-key="${esc(key)}" data-type="string" value="${esc(value ?? '')}">`
    }`;
}

/** أسماء عربية للمفاتيح المعروفة؛ المفتاح الجديد يظهر باسمه حتى يُضاف هنا. */
const LABELS = {
  freeText: 'النص الحر',
  unknownPolicy: 'ما يُقال عند عدم المعرفة',
  escalateFrom: 'تصعيد الشكوى من خطورة',
  acknowledgement: 'عبارة تأكيد الشكوى',
  message: 'نص التحويل للعميل',
  silenceMinutes: 'دقائق صمت البوت',
  workingHours: 'ساعات العمل',
  services: 'الخدمات ومددها',
  slotMinutes: 'طول الفترة بالدقائق',
  maxConcurrent: 'الحد الأقصى للحجوزات المتزامنة',
  reminderHours: 'التذكير قبل الموعد بساعات',
  maxDaysAhead: 'أقصى مدى للحجز بالأيام',
};

export async function renderModules(main) {
  const { modules, supportWhatsApp } = await get(`/api/tenants/${state.tenantId}/modules`);
  const isSystemAdmin = state.me.role === 'system';

  main.innerHTML = `
    <h2>الوحدات</h2>
    <p class="subtitle">
      ${
        isSystemAdmin
          ? 'أنتِ أدمن النظام: تستطيعين تفعيل وتعطيل الوحدات لهذه المنشأة.'
          : 'الوحدات المفعّلة لمنشأتك وإعداداتها. للتفعيل تواصلي معنا.'
      }
    </p>
    <div class="grid">${modules.map((m) => card(m, isSystemAdmin, supportWhatsApp)).join('')}</div>
  `;

  main.querySelectorAll('[data-toggle]').forEach((button) => {
    button.onclick = guard(async () => {
      const name = button.dataset.toggle;
      await post(`/api/system/tenants/${state.tenantId}/modules/${name}`, {
        enabled: button.dataset.enabled !== 'true',
      });
      flash('حُدّثت حالة الوحدة.');
      await renderModules(main);
    });
  });

  main.querySelectorAll('[data-save-config]').forEach((button) => {
    button.onclick = guard(async () => {
      const name = button.dataset.saveConfig;
      const scope = main.querySelector(`[data-module="${name}"]`);
      const payload = {};
      for (const field of scope.querySelectorAll('[data-key]')) {
        const key = field.dataset.key;
        if (field.dataset.type === 'number') payload[key] = Number(field.value);
        else if (field.dataset.type === 'boolean') payload[key] = field.value === 'true';
        else if (field.dataset.type === 'json') {
          try {
            payload[key] = JSON.parse(field.value);
          } catch {
            throw new Error(`القيمة في «${LABELS[key] ?? key}» ليست JSON صالحاً.`);
          }
        } else payload[key] = field.value;
      }
      await put(`/api/tenants/${state.tenantId}/modules/${name}/config`, payload);
      flash('حُفظت الإعدادات.');
      await renderModules(main);
    });
  });
}

function card(module, isSystemAdmin, supportWhatsApp) {
  if (!module.enabled) {
    const text = encodeURIComponent(`السلام عليكم، أبغى أفعّل وحدة «${module.titleAr}» للمنشأة.`);
    return `<div class="module off" data-module="${esc(module.name)}">
      <h4>${esc(module.titleAr)}</h4>
      <p>${esc(module.descriptionAr)}</p>
      <div class="locked">
        غير مفعّلة، تواصل معنا للتفعيل.
        <div class="actions">
          <a class="btn small" href="https://wa.me/${esc(supportWhatsApp)}?text=${text}" target="_blank" rel="noopener">
            تواصل معنا على واتساب
          </a>
          ${
            isSystemAdmin
              ? `<button class="btn ghost small" data-toggle="${esc(module.name)}" data-enabled="false">تفعيل (أدمن النظام)</button>`
              : ''
          }
        </div>
      </div>
    </div>`;
  }

  const keys = Object.keys(module.config ?? {});
  return `<div class="module" data-module="${esc(module.name)}">
    <h4>${esc(module.titleAr)}
      ${module.core ? '<span class="badge grey">أساسية</span>' : '<span class="badge green">مفعّلة</span>'}</h4>
    <p>${esc(module.descriptionAr)}</p>
    ${keys.map((key) => fieldFor(module.name, key, module.config[key])).join('')}
    <div class="actions">
      ${keys.length ? `<button class="btn small" data-save-config="${esc(module.name)}">حفظ الإعدادات</button>` : ''}
      ${
        isSystemAdmin && !module.core
          ? `<button class="btn ghost small" data-toggle="${esc(module.name)}" data-enabled="true">تعطيل</button>`
          : ''
      }
    </div>
  </div>`;
}
