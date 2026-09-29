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
    <p class="subtitle">
      لون المنشأة وشعارها — يظهران لموظفيها في كل شاشة.
      <span class="badge grey">صلاحية المالك</span>
    </p>

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

        <div class="logo-box" id="logoBox" tabindex="0" role="button"
             aria-label="${branding.logoUrl ? 'استبدال الشعار' : 'رفع الشعار'}">
          ${
            branding.logoUrl
              ? `<img src="${esc(branding.logoUrl)}?t=${Date.now()}" alt="شعار المنشأة">`
              : '<span class="muted">اسحب الملف هنا أو اضغط للاختيار</span>'
          }
          <span class="drop-hint">أفلِت الملف هنا</span>
        </div>

        <div class="actions">
          <button class="btn ghost" id="pickLogo">${branding.logoUrl ? 'استبدال الشعار' : 'رفع الشعار'}</button>
          ${branding.logoUrl ? '<button class="btn ghost" id="dropLogo">حذف الشعار</button>' : ''}
          <input id="logoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        </div>

        <div id="logoColors" hidden>
          <p class="muted" style="margin:14px 0 6px">ألوان من شعارك — اضغط أيّها لتجربته:</p>
          <div class="swatches" id="logoSwatches"></div>
        </div>
      </div>
    </div>

    <div class="card" id="waCard">
      <h3>ملف واتساب للأعمال</h3>
      <p class="muted" style="margin-top:0">
        هذا ما يراه عميلك قبل أن يكتب حرفاً: صورة الرقم ونبذته.
        يُقرأ من Meta ويُكتب إليها مباشرة.
      </p>
      <div id="waBody"><div class="empty">جارٍ القراءة من Meta…</div></div>
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
  const box = main.querySelector('#logoBox');

  main.querySelector('#pickLogo').onclick = () => file.click();
  box.onclick = () => file.click();
  box.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      file.click();
    }
  };

  file.onchange = guard(() => upload(file.files?.[0]));

  /**
   * السحب والإفلات.
   *
   * dragover يُمنع افتراضه وإلا فتح المتصفح الصورةَ في التبويب وضاعت
   * الصفحة بما فيها. و«مغادرة» الإفلات تُحسب بعدّاد لا براية: مرور
   * المؤشر فوق الصورة داخل المربّع يُطلق dragleave وإن لم يغادره.
   */
  let depth = 0;
  box.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    box.classList.add('over');
  });
  box.addEventListener('dragover', (event) => event.preventDefault());
  box.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) box.classList.remove('over');
  });
  box.addEventListener(
    'drop',
    guard(async (event) => {
      event.preventDefault();
      depth = 0;
      box.classList.remove('over');
      await upload(event.dataTransfer?.files?.[0]);
    }),
  );

  async function upload(chosen) {
    if (!chosen) return;
    if (!chosen.type.startsWith('image/')) {
      flash('الملف ليس صورة.', 'error');
      return;
    }
    if (chosen.size > 512 * 1024) {
      flash('الشعار أكبر من ٥١٢ كيلوبايت.', 'error');
      return;
    }

    const payload = await readAsDataUrl(chosen);
    await post(`/api/tenants/${state.tenantId}/logo`, { file: payload });
    await loadBranding(state.tenantId);
    flash('رُفع الشعار.');
    await renderBranding(main);
  }

  /* --- ألوان مأخوذة من الشعار --- */

  if (branding.logoUrl) void suggestFromLogo(branding.logoUrl, main, color, preview);

  // ملف واتساب يُقرأ من Meta، وقد يبطئ أو يُرفض — فلا يُؤخّر رسم الشاشة.
  void renderWaProfile(main, Boolean(branding.logoUrl));

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

/* ---------------------------------------------------------------
   ملفّ واتساب
--------------------------------------------------------------- */

async function renderWaProfile(main, hasLogo) {
  const box = main.querySelector('#waBody');
  let result;
  try {
    result = await get(`/api/tenants/${state.tenantId}/wa-profile`);
  } catch (error) {
    box.innerHTML = `<div class="error">${esc(error.message)}</div>`;
    return;
  }

  if (!result.ok) {
    box.innerHTML = `<div class="warn-box">${esc(result.message)}</div>`;
    return;
  }

  const p = result.data;
  box.innerHTML = `
    <div class="row" style="align-items:flex-start">
      <div style="flex:0 0 auto;max-width:190px">
        <label>صورة الرقم</label>
        <div class="logo-box wa-photo" id="waPhoto" tabindex="0" role="button" aria-label="تغيير صورة الرقم">
          ${
            p.profilePictureUrl
              ? `<img src="${esc(p.profilePictureUrl)}" alt="صورة رقم واتساب">`
              : '<span class="muted">اسحب صورة هنا أو اضغط</span>'
          }
          <span class="drop-hint">أفلِت الصورة هنا</span>
        </div>
        <input id="waPhotoFile" type="file" accept="image/png,image/jpeg" hidden>
        ${
          hasLogo
            ? '<div class="actions"><button class="btn ghost small" id="useLogo">استعمال شعار المنشأة</button></div>'
            : ''
        }
        <p class="muted" style="margin:6px 0 0">
          مربّعة، PNG أو JPG، ٦٤٠×٦٤٠ فأكثر.
          والشفافية قد تظهر سوداء عند العميل — الأفضل خلفية مصمتة.
        </p>
      </div>

      <div style="min-width:260px">
        <label for="waAbout">النبذة (تظهر تحت الاسم)</label>
        <input id="waAbout" maxlength="139" value="${esc(p.about)}">
        <label for="waDesc">الوصف</label>
        <textarea id="waDesc" maxlength="512" style="min-height:70px">${esc(p.description)}</textarea>
      </div>

      <div style="min-width:240px">
        <label for="waEmail">البريد الإلكتروني</label>
        <input id="waEmail" dir="ltr" value="${esc(p.email)}">
        <label for="waSite">الموقع</label>
        <input id="waSite" dir="ltr" placeholder="https://" value="${esc(p.websites[0] ?? '')}">
        <label for="waVertical">مجال النشاط</label>
        <select id="waVertical">
          ${Object.entries(result.verticals)
            .map(([key, label]) => `<option value="${key}"${key === p.vertical ? ' selected' : ''}>${esc(label)}</option>`)
            .join('')}
        </select>
      </div>
    </div>

    <label for="waAddress">العنوان</label>
    <input id="waAddress" value="${esc(p.address)}">

    <div class="actions"><button class="btn" id="waSave">حفظ على واتساب</button></div>
  `;

  box.querySelector('#waSave').onclick = guard(async () => {
    const site = box.querySelector('#waSite').value.trim();
    await put(`/api/tenants/${state.tenantId}/wa-profile`, {
      about: box.querySelector('#waAbout').value.trim(),
      description: box.querySelector('#waDesc').value.trim(),
      email: box.querySelector('#waEmail').value.trim(),
      address: box.querySelector('#waAddress').value.trim(),
      vertical: box.querySelector('#waVertical').value,
      websites: site ? [site] : [],
    });
    flash('حُدّث ملف واتساب.');
  });

  /* --- الصورة --- */

  const photoBox = box.querySelector('#waPhoto');
  const photoFile = box.querySelector('#waPhotoFile');

  async function sendPhoto(payload) {
    const result = await post(`/api/tenants/${state.tenantId}/wa-profile/photo`, payload);
    flash(result.message);
    await renderWaProfile(main, hasLogo);
  }

  photoBox.onclick = () => photoFile.click();
  photoBox.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      photoFile.click();
    }
  };
  photoFile.onchange = guard(async () => {
    const chosen = photoFile.files?.[0];
    if (!chosen) return;
    await sendPhoto({ file: await readAsDataUrl(chosen) });
  });

  let depth = 0;
  photoBox.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    photoBox.classList.add('over');
  });
  photoBox.addEventListener('dragover', (event) => event.preventDefault());
  photoBox.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) photoBox.classList.remove('over');
  });
  photoBox.addEventListener(
    'drop',
    guard(async (event) => {
      event.preventDefault();
      depth = 0;
      photoBox.classList.remove('over');
      const chosen = event.dataTransfer?.files?.[0];
      if (chosen) await sendPhoto({ file: await readAsDataUrl(chosen) });
    }),
  );

  const useLogo = box.querySelector('#useLogo');
  if (useLogo) useLogo.onclick = guard(() => sendPhoto({ useLogo: true }));
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('تعذّرت قراءة الملف.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * ألوان الشعار تُستخرج في المتصفح لا في الخادم.
 *
 * المتصفح يفكّ PNG وJPG وWEBP أصلاً، فاستخراجها هنا يوفّر مكتبة صور
 * كاملة على الخادم لأجل خمسة ألوان. والصورة من نفس الأصل فلا يتلوّث
 * الـcanvas ولا يُمنع قراءة بكسلاته.
 */
async function suggestFromLogo(url, main, colorInput, preview) {
  let colors = [];
  try {
    colors = await paletteFromImage(`${url}?t=${Date.now()}`);
  } catch {
    return;
  }
  if (colors.length === 0) return;

  const box = main.querySelector('#logoColors');
  main.querySelector('#logoSwatches').innerHTML = colors
    .map((hex) => `<button class="swatch" data-from-logo="${hex}" style="background:${hex}" aria-label="${hex}"></button>`)
    .join('');
  box.hidden = false;

  main.querySelectorAll('[data-from-logo]').forEach((button) => {
    button.onclick = () => {
      colorInput.value = button.dataset.fromLogo;
      void preview();
    };
  });
}

function paletteFromImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('تعذّر تحميل الشعار.'));
    image.onload = () => {
      // ٦٤×٦٤ تكفي: الغرض ألوان سائدة لا تفاصيل، والأصغر أسرع بكثير.
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      /**
       * تصغير بلا تنعيم.
       *
       * التنعيم يمزج البكسلات المتجاورة، فيولّد عند كل حدّ بين لونين
       * لوناً ثالثاً لا وجود له في الشعار — ثم يُعرض على المالك كأنه
       * أحد ألوان علامته. وأخذ أقرب بكسل يُبقي الألوان كما هي.
       */
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, size, size);
      resolve(dominant(ctx.getImageData(0, 0, size, size).data));
    };
    image.src = src;
  });
}

/**
 * الألوان السائدة.
 *
 * يُستبعد الشفاف والأبيض والأسود والرمادي: أكثر الشعارات على خلفية
 * شفافة أو بيضاء، ولو حُسبت لعاد البياض أول لون في كل شعار — وهو
 * آخر ما يصلح لوناً لزرّ.
 */
function dominant(pixels) {
  const buckets = new Map();

  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    if (a < 200) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2 / 255;
    const sat = max === min ? 0 : (max - min) / (light > 0.5 ? 510 - max - min : max + min);
    if (light > 0.92 || light < 0.08 || sat < 0.12) continue;

    // تجميع بخطوة ٢٤: درجتان متجاورتان من نفس اللون صفّان لا صفّ.
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  /**
   * اللون النادر ليس لوناً للعلامة.
   *
   * حواف الشعار المنعّمة تولّد ألواناً مخلوطة بين كل لونين متجاورين،
   * فتظهر في القائمة درجةٌ لا وجود لها في الشعار أصلاً. وحدّ اثنين
   * في المئة يُسقطها ويُبقي ألوان العلامة.
   */
  const counted = [...buckets.values()].reduce((sum, x) => sum + x.n, 0);
  const ordered = [...buckets.values()]
    .filter((x) => x.n >= counted * 0.02)
    .sort((a, b) => b.n - a.n)
    .map((x) => [Math.round(x.r / x.n), Math.round(x.g / x.n), Math.round(x.b / x.n)]);

  // الألوان المتقاربة لا تُعرض مرتين: خمس درجات من أخضر واحد ليست خياراً.
  const picked = [];
  for (const rgb of ordered) {
    if (picked.some((p) => Math.abs(p[0] - rgb[0]) + Math.abs(p[1] - rgb[1]) + Math.abs(p[2] - rgb[2]) < 90)) {
      continue;
    }
    picked.push(rgb);
    if (picked.length === 5) break;
  }

  return picked.map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
}

function normalize(raw) {
  const value = String(raw || '').trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value);
  return match ? `#${match[1].toLowerCase()}` : null;
}
