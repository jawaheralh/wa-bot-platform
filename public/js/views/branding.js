/**
 * هوية المنشأة: لونها وشعارها.
 *
 * المعاينة تسبق الحفظ.
 *
 * اللون قرار بصري لا رقم يُكتب: من يختار «#1a7f5a» لا يعرف كيف يبدو
 * شريطاً جانبياً وزرَّ إرسال حتى يراه. فكل تغيير يُطبَّق على الشاشة
 * فوراً، والحفظ يُثبّت ما رآه لا ما كتبه.
 */

import { get, put, post, del, esc, guard, flash, state, applyBranding, loadBranding } from '../core.js';

/** ألوان جاهزة: أكثر العملاء يريد لوناً قريباً من علامته لا مطابقاً. */
const SWATCHES = [
  ['#c9772b', 'برتقالي'],
  ['#1f7a53', 'أخضر'],
  ['#1d6fa5', 'أزرق'],
  ['#7a2f6d', 'أرجواني'],
  ['#b3322c', 'أحمر'],
  ['#0f766e', 'فيروزي'],
  ['#8a6d1f', 'ذهبي'],
  ['#3f4756', 'رمادي'],
];

export async function renderBranding(main) {
  const branding = await get(`/api/tenants/${state.tenantId}/branding`);

  /** اللون المعروض الآن — يتغيّر بالمعاينة قبل الحفظ. */
  let current = { color: branding.accent, deep: branding.deep, auto: !branding.deepCustom };

  main.innerHTML = `
    <h2>هوية «${esc(branding.name)}»</h2>
    <p class="subtitle">لون المنشأة وشعارها — يظهران لموظفيها في كل شاشة.</p>

    <div class="grid">
      <div class="card">
        <h3>اللون</h3>
        <p class="muted" style="margin-top:0">
          لون واحد يكفي: يُشتق منه الظلّ والتظليل ولون الشريط الجانبي.
        </p>

        <div class="swatches" id="swatches">
          ${SWATCHES.map(
            ([hex, name]) =>
              `<button class="swatch" data-swatch="${hex}" title="${esc(name)}"
                       style="background:${hex}" aria-label="${esc(name)}"></button>`,
          ).join('')}
        </div>

        <div class="row" style="margin-top:14px">
          <div style="max-width:170px">
            <label for="color">اللون الأساسي</label>
            <div class="color-pick">
              <input id="colorDot" type="color" value="${esc(branding.accent)}">
              <input id="color" dir="ltr" value="${esc(branding.accent)}" maxlength="7">
            </div>
          </div>
          <div style="max-width:170px">
            <label for="deep">لون الشريط الجانبي</label>
            <div class="color-pick">
              <input id="deepDot" type="color" value="${esc(branding.deep)}">
              <input id="deep" dir="ltr" value="${esc(branding.deep)}" maxlength="7">
            </div>
          </div>
        </div>

        <label class="inline">
          <input type="checkbox" id="auto"${current.auto ? ' checked' : ''}>
          <span>اشتقاق لون الشريط من اللون الأساسي</span>
        </label>

        <div class="actions">
          <button class="btn" id="save">حفظ الهوية</button>
          <button class="btn ghost" id="reset">العودة لألوان المنصة</button>
        </div>
      </div>

      <div class="card">
        <h3>الشعار</h3>
        <p class="muted" style="margin-top:0">
          PNG أو JPG أو WEBP، حتى ٥١٢ كيلوبايت. يظهر أعلى الشريط الجانبي.
        </p>

        <div class="logo-box" id="logoBox">
          ${
            branding.logoUrl
              ? `<img src="${esc(branding.logoUrl)}?t=${Date.now()}" alt="شعار المنشأة">`
              : '<span class="muted">لا شعار بعد</span>'
          }
        </div>

        <div class="actions">
          <button class="btn ghost" id="pickLogo">${branding.logoUrl ? 'استبدال الشعار' : 'رفع الشعار'}</button>
          ${branding.logoUrl ? '<button class="btn ghost" id="dropLogo">حذف الشعار</button>' : ''}
          <input id="logoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>المعاينة</h3>
      <p class="muted" style="margin-top:0">ما يراه موظفو المنشأة. يتغيّر مع كل اختيار قبل الحفظ.</p>
      <div class="preview">
        <div class="preview-side">
          <div class="preview-brand">
            ${branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="">` : '<span>💬</span>'}
            <strong>${esc(branding.name)}</strong>
          </div>
          <span class="preview-nav on">المحادثات</span>
          <span class="preview-nav">الشكاوى</span>
          <span class="preview-nav">قاعدة المعرفة</span>
        </div>
        <div class="preview-main">
          <div class="bubble customer">متى تفتحون يوم الجمعة؟</div>
          <div class="bubble bot">من ١ ظهراً إلى ١٢ منتصف الليل.</div>
          <div class="actions" style="margin-top:14px">
            <button class="btn" type="button" tabindex="-1">إرسال</button>
            <button class="btn ghost" type="button" tabindex="-1">إيقاف البوت</button>
            <span class="badge amber">صامت</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const color = main.querySelector('#color');
  const colorDot = main.querySelector('#colorDot');
  const deep = main.querySelector('#deep');
  const deepDot = main.querySelector('#deepDot');
  const auto = main.querySelector('#auto');

  /** يسأل الخادم عن اللوحة المشتقّة ويطبّقها على الشاشة كما هي. */
  async function preview() {
    const value = normalize(color.value);
    if (!value) return;
    current.color = value;
    current.auto = auto.checked;
    current.deep = auto.checked ? '' : normalize(deep.value) || '';

    const query = new URLSearchParams({ color: current.color });
    if (current.deep) query.set('deep', current.deep);
    const palette = await get(`/api/tenants/${state.tenantId}/branding/preview?${query}`);

    applyBranding({ ...palette, logoUrl: branding.logoUrl, name: branding.name });
    colorDot.value = palette.accent;
    if (auto.checked) {
      deep.value = palette.deep;
      deepDot.value = palette.deep;
    }
    deep.disabled = auto.checked;
    deepDot.disabled = auto.checked;
  }

  colorDot.oninput = () => {
    color.value = colorDot.value;
    void preview();
  };
  color.onchange = () => void preview();
  deepDot.oninput = () => {
    deep.value = deepDot.value;
    void preview();
  };
  deep.onchange = () => void preview();
  auto.onchange = () => void preview();

  main.querySelectorAll('[data-swatch]').forEach((button) => {
    button.onclick = () => {
      color.value = button.dataset.swatch;
      void preview();
    };
  });

  void preview();

  main.querySelector('#save').onclick = guard(async () => {
    await put(`/api/tenants/${state.tenantId}/branding`, {
      color: current.color,
      deep: current.auto ? '' : current.deep,
    });
    await loadBranding(state.tenantId);
    flash('حُفظت الهوية.');
    await renderBranding(main);
  });

  main.querySelector('#reset').onclick = guard(async () => {
    await put(`/api/tenants/${state.tenantId}/branding`, { color: '', deep: '' });
    await loadBranding(state.tenantId);
    flash('عادت ألوان المنصة.');
    await renderBranding(main);
  });

  /* --- الشعار --- */

  const file = main.querySelector('#logoFile');
  main.querySelector('#pickLogo').onclick = () => file.click();

  file.onchange = guard(async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    if (chosen.size > 512 * 1024) {
      flash('الشعار أكبر من ٥١٢ كيلوبايت.', 'error');
      return;
    }

    const payload = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('تعذّرت قراءة الملف.'));
      reader.readAsDataURL(chosen);
    });

    await post(`/api/tenants/${state.tenantId}/logo`, { file: payload });
    await loadBranding(state.tenantId);
    flash('رُفع الشعار.');
    await renderBranding(main);
  });

  const drop = main.querySelector('#dropLogo');
  if (drop) {
    drop.onclick = guard(async () => {
      await del(`/api/tenants/${state.tenantId}/logo`);
      await loadBranding(state.tenantId);
      flash('حُذف الشعار.');
      await renderBranding(main);
    });
  }
}

function normalize(raw) {
  const value = String(raw || '').trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value);
  return match ? `#${match[1].toLowerCase()}` : null;
}
