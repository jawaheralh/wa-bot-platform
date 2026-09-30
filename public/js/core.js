/**
 * النواة: الحالة المشتركة ونداءات الـAPI وأدوات الرسم.
 * بلا framework — الصفحة أداة عمل بسيطة، وإضافة أداة بناء تعني تبعية
 * وخطوة ترجمة مقابل مكسب لا يظهر في هذا الحجم.
 */

export const state = {
  me: null,
  tenantId: null,
  tenants: [],
  /**
   * الدخول يفتح على المحادثات.
   *
   * هي عمل الموظف كله، ومالكُ المنشأة يفتح اللوحة ليرى ما وصل عملاءه
   * لا ليقرأ «النبرة ودّية». والنظرة العامة تبقى بضغطة.
   */
  view: 'conversations',
  /** المحادثة المفتوحة — تُعاد بعد كل تحديث مباشر فلا تُغلق تحت يد الموظف. */
  openConversation: null,
  /** هوية المنشأة المفتوحة: ألوانها وشعارها. */
  branding: null,
};

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401) {
    location.href = '/login.html';
    throw new Error('انتهت الجلسة.');
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || `فشل الطلب (${response.status})`);
  return data;
}

export const get = (path) => request('GET', path);
export const post = (path, body) => request('POST', path, body ?? {});
export const patch = (path, body) => request('PATCH', path, body ?? {});
export const put = (path, body) => request('PUT', path, body ?? {});
export const del = (path) => request('DELETE', path);

/* ---------------------------------------------------------------
   الرسم
--------------------------------------------------------------- */

/** يهرب النص قبل حقنه في HTML — المحتوى يأتي من العملاء. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/** «قبل ٣ دقائق» — الطوابع مخزَّنة بتوقيت الرياض أصلاً. */
export function ago(sqlTime) {
  if (!sqlTime) return '—';
  const then = new Date(sqlTime.replace(' ', 'T') + '+03:00');
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return 'الآن';
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  if (minutes < 60 * 24) return `قبل ${Math.round(minutes / 60)} ساعة`;
  return sqlTime.slice(0, 16);
}

export function flash(message, kind = 'ok') {
  const box = el(`<div class="${kind}">${esc(message)}</div>`);
  const main = document.querySelector('main');
  if (!main) return;
  main.prepend(box);
  setTimeout(() => box.remove(), 4000);
}

/** يلفّ معالجاً غير متزامن فيُظهر الخطأ بدل ابتلاعه بصمت. */
export function guard(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      flash(error.message, 'error');
    }
  };
}

/* ---------------------------------------------------------------
   البث المباشر
--------------------------------------------------------------- */

let live = null;

/**
 * يشترك في بث تغيّرات المنشأة.
 *
 * EventSource يعيد الاتصال وحده إن انقطع، فلا نكتب منطق إعادة اتصال.
 * لكنه يُبقي الاتصال مفتوحاً، فيلزم إغلاق السابق عند تبديل المنشأة —
 * وإلا تراكمت اتصالات لمنشآت لم تعد معروضة.
 */
export function watchLive(tenantId, onChange) {
  stopLive();
  if (!tenantId) return;

  const source = new EventSource(`/api/tenants/${tenantId}/stream`);
  source.addEventListener('change', () => onChange());
  live = source;
}

export function stopLive() {
  if (live) {
    live.close();
    live = null;
  }
}

/**
 * هل المستخدمة في منتصف كتابة؟
 *
 * إعادة الرسم تمسح ما في الحقول. ورسالة نصف مكتوبة تختفي لأن عميلاً
 * آخر أرسل شيئاً في تلك اللحظة عطلٌ يُفقد الثقة بالنظام كله — فنؤجّل
 * التحديث بدل أن نتلف عملها.
 */
export function isTyping() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  return String(active.value ?? '').trim().length > 0;
}

/* ---------------------------------------------------------------
   هوية المنشأة
--------------------------------------------------------------- */

/**
 * يُلبس اللوحةَ ألوانَ المنشأة.
 *
 * بمتغيّرات CSS على الجذر لا بورقة أنماط ثانية: كل لون في اللوحة يشير
 * إلى متغيّر أصلاً، فتغييره هنا يسري على كل شاشة — بما فيها ما يُكتب
 * مستقبلاً — بلا أن يعرف أحدها بالهوية شيئاً.
 */
export function applyBranding(branding) {
  state.branding = branding;
  const root = document.documentElement.style;

  if (!branding) {
    for (const name of ['--accent', '--accent-dark', '--accent-soft', '--deep', '--accent-ink', '--bg', '--line']) {
      root.removeProperty(name);
    }
    root.removeProperty('--brand-watermark');
    return;
  }

  root.setProperty('--accent', branding.accent);
  root.setProperty('--accent-dark', branding.accentDark);
  root.setProperty('--accent-soft', branding.accentSoft);
  root.setProperty('--deep', branding.deep);
  root.setProperty('--accent-ink', branding.accentInk);
  root.setProperty('--bg', branding.bg);
  root.setProperty('--line', branding.line);

  /**
   * الشعار خلف المحادثة كما تفعل خلفية واتساب.
   *
   * متغيّر لا وسم <img>: الخلفية لا تُنتقى ولا تُسحب ولا تدخل ترتيب
   * القراءة لقارئ الشاشة، ووسمٌ حقيقي خلف الفقاعات يفعل الثلاثة.
   */
  if (branding.logoUrl) {
    root.setProperty('--brand-watermark', `url("${branding.logoUrl}")`);
  } else {
    root.removeProperty('--brand-watermark');
  }
}

/** يقرأ الهوية ويطبّقها. الفشل لا يمنع فتح اللوحة — تُعرض بألوان المنصة. */
export async function loadBranding(tenantId) {
  if (!tenantId) return applyBranding(null);
  try {
    applyBranding(await get(`/api/tenants/${tenantId}/branding`));
  } catch {
    applyBranding(null);
  }
}
