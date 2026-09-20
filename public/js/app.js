/**
 * التوجيه وتركيب الصفحة.
 *
 * نفس الشيفرة للدورين؛ الفرق أن أدمن النظام يرى قائمة المنشآت ويستطيع
 * التبديل بينها، وأدمن المنشأة مثبَّت على منشأته.
 */

import { get, post, state, esc, guard } from './core.js';
import { renderOverview } from './views/overview.js';
import { renderConversations } from './views/conversations.js';
import { renderComplaints } from './views/complaints.js';
import { renderKnowledge } from './views/knowledge.js';
import { renderModules } from './views/modules.js';
import { renderTenants } from './views/tenants.js';

const VIEWS = [
  { id: 'overview', label: 'نظرة عامة', render: renderOverview },
  { id: 'conversations', label: 'المحادثات', render: renderConversations },
  { id: 'complaints', label: 'الشكاوى', render: renderComplaints },
  { id: 'bookings', label: 'المواعيد', render: null, module: 'bookings' },
  { id: 'knowledge', label: 'قاعدة المعرفة', render: renderKnowledge },
  { id: 'modules', label: 'الوحدات', render: renderModules },
];

const root = document.getElementById('root');

async function boot() {
  state.me = await get('/api/me');

  if (state.me.role === 'system') {
    state.tenants = await get('/api/system/tenants');
    state.tenantId = state.tenants[0]?.id ?? null;
  } else {
    state.tenantId = state.me.tenantId;
  }

  // شاشة المواعيد تظهر فقط إذا كانت وحدة الحجوزات مفعّلة لهذه المنشأة.
  await loadEnabledModules();
  render();
}

async function loadEnabledModules() {
  state.enabledModules = [];
  if (!state.tenantId) return;
  const { modules } = await get(`/api/tenants/${state.tenantId}/modules`);
  state.enabledModules = modules.filter((m) => m.enabled).map((m) => m.name);
}

function visibleViews() {
  return VIEWS.filter((view) => {
    if (view.module && !state.enabledModules.includes(view.module)) return false;
    if (!view.render && !view.module) return false;
    return true;
  });
}

function render() {
  const views = visibleViews();
  if (!views.some((v) => v.id === state.view)) state.view = views[0]?.id ?? 'overview';

  root.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <h1>بوت واتساب</h1>
        <div class="who">${esc(state.me.displayName)} · ${
          state.me.role === 'system' ? 'أدمن النظام' : 'أدمن المنشأة'
        }</div>

        ${
          state.me.role === 'system'
            ? `<select id="tenantPicker">
                 <option value="">— كل المنشآت —</option>
                 ${state.tenants
                   .map(
                     (t) =>
                       `<option value="${t.id}"${t.id === state.tenantId ? ' selected' : ''}>${esc(t.name)}</option>`,
                   )
                   .join('')}
               </select>`
            : ''
        }

        <nav>
          ${
            state.me.role === 'system'
              ? `<button data-view="tenants" class="${state.view === 'tenants' ? 'active' : ''}">كل المنشآت</button>`
              : ''
          }
          ${
            state.tenantId
              ? views
                  .map(
                    (v) =>
                      `<button data-view="${v.id}" class="${state.view === v.id ? 'active' : ''}">${esc(v.label)}</button>`,
                  )
                  .join('')
              : ''
          }
        </nav>

        <div class="spacer"></div>
        <nav><button id="logout">تسجيل الخروج</button></nav>
      </aside>
      <main><div class="empty">جارٍ التحميل…</div></main>
    </div>
  `;

  const main = root.querySelector('main');

  root.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = () => {
      state.view = button.dataset.view;
      render();
    };
  });

  const picker = document.getElementById('tenantPicker');
  if (picker) {
    picker.onchange = guard(async () => {
      state.tenantId = picker.value ? Number(picker.value) : null;
      state.view = state.tenantId ? 'overview' : 'tenants';
      await loadEnabledModules();
      render();
    });
  }

  document.getElementById('logout').onclick = guard(async () => {
    await post('/api/logout');
    location.href = '/login.html';
  });

  void draw(main);
}

async function draw(main) {
  try {
    if (state.view === 'tenants') {
      await renderTenants(main, async (tenantId) => {
        state.tenantId = tenantId;
        state.view = 'overview';
        await loadEnabledModules();
        render();
      });
      return;
    }

    if (!state.tenantId) {
      main.innerHTML = '<div class="empty">اختاري منشأة من القائمة.</div>';
      return;
    }

    const view = VIEWS.find((v) => v.id === state.view);
    if (view?.render) {
      await view.render(main);
      return;
    }

    // شاشة تُقدَّمها وحدة لم تُبنَ واجهتها بعد.
    const { renderBookings } = await import('./views/bookings.js').catch(() => ({ renderBookings: null }));
    if (state.view === 'bookings' && renderBookings) {
      await renderBookings(main);
      return;
    }
    main.innerHTML = '<div class="empty">هذه الشاشة غير متاحة.</div>';
  } catch (error) {
    main.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

boot().catch((error) => {
  if (String(error.message).includes('الجلسة')) return;
  root.innerHTML = `<div class="error" style="margin:30px">${esc(error.message)}</div>`;
});
