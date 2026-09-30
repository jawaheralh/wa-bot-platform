/**
 * نموذج الشكوى والطلب: إنشاءً وتعديلاً.
 *
 * مشترك بين الشاشتين لأن ما يختلف بينهما حقلان (تصنيف وخطورة مقابل
 * نوع وأولوية) وما يتفق عشرة. ونسختان من نموذجٍ واحد تفترقان عند أول
 * تعديل — فتُضاف الحقول الإضافية لإحداهما وتُنسى الأخرى.
 */

import { esc } from './core.js';

/** يبني حقلاً من تعريفه — النوع هو ما يحدّد عنصر الإدخال. */
function fieldInput(field, value) {
  const id = `x-${field.key}`;
  const required = field.required ? ' <span style="color:var(--danger)">*</span>' : '';
  const common = `id="${id}" data-field="${esc(field.key)}"`;

  if (field.type === 'اختيار') {
    return `
      <div>
        <label for="${id}">${esc(field.label)}${required}</label>
        <select ${common}>
          <option value="">—</option>
          ${field.options
            .map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`)
            .join('')}
        </select>
      </div>`;
  }

  const type = { رقم: 'number', تاريخ: 'date', وقت: 'time' }[field.type] ?? 'text';
  return `
    <div>
      <label for="${id}">${esc(field.label)}${required}</label>
      <input ${common} type="${type}" value="${esc(value ?? '')}">
    </div>`;
}

/**
 * يرسم النموذج داخل عنصر.
 *
 * `row` موجودة = تعديل، غائبة = إنشاء. والفرق في العنوان وفي أن رقم
 * العميل لا يُعدَّل بعد التسجيل: تغييره ينقل السجل لشخص آخر بلا أثر.
 */
export function renderCaseForm(box, options) {
  const { fields, row, choices, labels } = options;
  const values = row?.extra ? JSON.parse(row.extra || '{}') : {};

  box.innerHTML = `
    <h3>${row ? `تعديل ${esc(row.reference)}` : labels.newTitle}</h3>

    <div class="row">
      <div>
        <label for="cf-wa">رقم العميل ${row ? '' : '<span style="color:var(--danger)">*</span>'}</label>
        <input id="cf-wa" dir="ltr" value="${esc(row?.customer_wa ?? '')}"
               placeholder="0551234567"${row ? ' readonly' : ''}>
      </div>
      ${
        labels.withName
          ? `<div>
              <label for="cf-name">اسم العميل</label>
              <input id="cf-name" value="${esc(row?.customer_name ?? '')}">
            </div>`
          : ''
      }
      <div>
        <label for="cf-a">${esc(choices.a.label)}</label>
        <select id="cf-a">
          ${Object.entries(choices.a.options)
            .map(([k, v]) => `<option value="${k}"${row?.[choices.a.field] === k ? ' selected' : ''}>${esc(v)}</option>`)
            .join('')}
        </select>
      </div>
      <div>
        <label for="cf-b">${esc(choices.b.label)}</label>
        <select id="cf-b">
          ${Object.entries(choices.b.options)
            .map(([k, v]) => `<option value="${k}"${row?.[choices.b.field] === k ? ' selected' : ''}>${esc(v)}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <label for="cf-summary">${esc(labels.summary)} <span style="color:var(--danger)">*</span></label>
    <textarea id="cf-summary">${esc(row?.summary ?? '')}</textarea>

    ${
      fields.length
        ? `<div class="row">${fields.map((f) => fieldInput(f, values[f.key])).join('')}</div>`
        : `<p class="muted" style="margin-top:10px">
             لا حقول إضافية لهذه المنشأة. تُعرَّف من <strong>الوحدات</strong> — سطرٌ لكل حقل.
           </p>`
    }

    <div class="actions">
      <button class="btn" id="cf-save">${row ? 'حفظ التعديل' : 'تسجيل'}</button>
      <button class="btn ghost" id="cf-cancel">إلغاء</button>
    </div>
  `;
}

/** يجمع ما كُتب في النموذج. */
export function readCaseForm(box) {
  const value = (id) => box.querySelector(id)?.value.trim() ?? '';
  const extra = {};
  box.querySelectorAll('[data-field]').forEach((input) => {
    const raw = input.value.trim();
    if (raw) extra[input.dataset.field] = raw;
  });

  return {
    customerWa: value('#cf-wa'),
    customerName: value('#cf-name'),
    a: value('#cf-a'),
    b: value('#cf-b'),
    summary: value('#cf-summary'),
    extra,
  };
}

/** سطر يعرض الحقول الإضافية في الجدول — يُخفى إن كانت فارغة. */
export function extraLine(fields, stored) {
  if (!stored) return '';
  let values;
  try {
    values = JSON.parse(stored || '{}');
  } catch {
    return '';
  }

  const labels = new Map(fields.map((f) => [f.key, f.label]));
  const parts = Object.entries(values)
    .filter(([, v]) => String(v).trim())
    .map(([k, v]) => `${esc(labels.get(k) ?? k)}: <strong>${esc(v)}</strong>`);

  return parts.length ? `<br><span class="muted">${parts.join(' · ')}</span>` : '';
}
