/**
 * النواة: الحالة المشتركة ونداءات الـAPI وأدوات الرسم.
 * بلا framework — الصفحة أداة عمل بسيطة، وإضافة أداة بناء تعني تبعية
 * وخطوة ترجمة مقابل مكسب لا يظهر في هذا الحجم.
 */

export const state = {
  me: null,
  tenantId: null,
  tenants: [],
  view: 'overview',
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
