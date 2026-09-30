/**
 * التوجيه وتركيب الصفحة.
 *
 * نفس الشيفرة للدورين؛ الفرق أن أدمن النظام يرى قائمة المنشآت ويستطيع
 * التبديل بينها، وأدمن المنشأة مثبَّت على منشأته.
 */

import { get, post, state, esc, guard, watchLive, stopLive, isTyping, loadBranding } from './core.js';
import { renderOverview } from './views/overview.js';
import { renderConversations } from './views/conversations.js';
import { renderComplaints } from './views/complaints.js';
import { renderKnowledge } from './views/knowledge.js';
import { renderModules } from './views/modules.js';
import { renderTenants } from './views/tenants.js';
import { renderSetup } from './views/setup.js';
import { renderTraining } from './views/training.js';
import { renderStaff } from './views/staff.js';
import { renderRequests } from './views/requests.js';
import { renderPrivacy } from './views/privacy.js';
import { renderBookings } from './views/bookings.js';
import { renderAccount } from './views/account.js';
import { renderTenantSetup } from './views/tenant-setup.js';
import { renderLeads } from './views/leads.js';
import { renderBranding } from './views/branding.js';
import { renderTemplates } from './views/templates.js';
import { renderSatisfaction } from './views/satisfaction.js';

const VIEWS = [
  { id: 'overview', label: 'نظرة عامة', render: renderOverview },
  { id: 'conversations', label: 'المحادثات', render: renderConversations },
  { id: 'complaints', label: 'الشكاوى', render: renderComplaints },
  { id: 'requests', label: 'الطلبات', render: renderRequests, module: 'requests' },
  { id: 'bookings', label: 'المواعيد', render: renderBookings, module: 'bookings' },
  { id: 'knowledge', label: 'قاعدة المعرفة', render: renderKnowledge },
  { id: 'training', label: 'تدريب البوت', render: renderTraining },
  { id: 'satisfaction', label: 'رضا العملاء', render: renderSatisfaction },
  { id: 'staff', label: 'الموظفون', render: renderStaff },
  { id: 'privacy', label: 'الخصوصية', render: renderPrivacy },
  { id: 'branding', label: 'الهوية', render: renderBranding },
  { id: 'templates', label: 'القوالب', render: renderTemplates },
  { id: 'modules', label: 'الوحدات', render: renderModules },
];

/** شاشات يراها مالك المنشأة وأدمن النظام دون الموظف. */
const OWNER_ONLY = new Set(['knowledge', 'modules', 'privacy', 'branding', 'templates']);

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
  // الهوية قبل أول رسم: تحميلها بعده يجعل اللوحة تومض بلون ثم بلون.
  await loadBranding(state.tenantId);
  render();
}

async function loadEnabledModules() {
  state.enabledModules = [];
  if (!state.tenantId) return;
  const { modules } = await get(`/api/tenants/${state.tenantId}/modules`);
  state.enabledModules = modules.filter((m) => m.enabled).map((m) => m.name);
}

/**
 * علامة الشريط الجانبي: شعار المنشأة واسمها إن كانا، وإلا اسم المنصة.
 *
 * الموظف يفتح هذه الشاشة كل صباح، ورؤيته شعار منشأته لا شعارنا هي
 * الفرق بين «نظام اشتروه» و«نظامهم».
 */
function brandMark() {
  const tenant = state.tenants.find((t) => t.id === state.tenantId);
  const name = state.branding?.name || tenant?.name || (state.me.role === 'system' ? 'لوحة التحكم' : 'بوت واتساب');
  const logo = state.branding?.logoUrl;

  return logo
    ? `<h1 class="has-logo"><img class="brand-logo" src="${esc(logo)}" alt=""> ${esc(name)}</h1>`
    : `<h1>${esc(name)}</h1>`;
}

function visibleViews() {
  return VIEWS.filter((view) => {
    if (view.module && !state.enabledModules.includes(view.module)) return false;
    if (!view.render) return false;
    // الموظف يرد على العملاء ولا يعدّل المعرفة ولا الوحدات.
    if (state.me.role === 'agent' && OWNER_ONLY.has(view.id)) return false;
    return true;
  });
}

/**
 * شاشات أدمن النظام: ليست في VIEWS لأنها لا تخص منشأة بعينها.
 * إغفالها هنا جعل الحارس أدناه يُعيدها إلى «نظرة عامة» عند كل ضغطة.
 */
const SYSTEM_VIEWS = new Set(['setup', 'tenants', 'account', 'leads']);

/** تغيّر وصل أثناء الكتابة فأُجّل حتى تفرغ. */
let pendingLive = false;

/**
 * ما إن تُغادر الحقلَ حتى يُطبَّق ما تأجّل.
 *
 * بلا هذا يبقى التحديث معلّقاً إلى أن يصل تغيّر جديد — فتبدو اللوحة
 * متجمّدة بعد أن أُلغي ما كُتب.
 */
document.addEventListener('focusout', () => {
  if (!pendingLive || isTyping()) return;
  pendingLive = false;
  void draw(document.querySelector('main'));
});

function render() {
  const views = visibleViews();
  // شاشة غير متاحة (وحدة عُطّلت مثلاً) تُبدَّل بأول متاحة — عدا شاشات النظام.
  if (!SYSTEM_VIEWS.has(state.view) && !views.some((v) => v.id === state.view)) {
    state.view = views[0]?.id ?? 'overview';
  }

  root.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        ${brandMark()}
        <div class="who">${esc(state.me.displayName)} · ${esc(
          { system: 'أدمن النظام', tenant: 'مالك المنشأة', agent: 'موظف' }[state.me.role] ?? state.me.role,
        )}</div>

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
              ? `<button data-view="tenants" class="${state.view === 'tenants' ? 'active' : ''}">كل المنشآت</button>
                 <button data-view="leads" class="${state.view === 'leads' ? 'active' : ''}">طلبات التجربة</button>
                 <button data-view="setup" class="${state.view === 'setup' ? 'active' : ''}">الإعداد</button>`
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
        <nav>
          <button data-view="account" class="${state.view === 'account' ? 'active' : ''}">حسابي</button>
          <button id="logout">تسجيل الخروج</button>
        </nav>
      </aside>
      <main><div class="empty">جارٍ التحميل…</div></main>
    </div>
  `;

  const main = root.querySelector('main');

  root.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = guard(async () => {
      const leavingBranding = state.view === 'branding' && button.dataset.view !== 'branding';
      state.view = button.dataset.view;
      // معاينة الهوية تغيّر ألوان اللوحة قبل الحفظ؛ الخروج بلا حفظ يعيدها.
      if (leavingBranding) await loadBranding(state.tenantId);
      render();
    });
  });

  const picker = document.getElementById('tenantPicker');
  if (picker) {
    picker.onchange = guard(async () => {
      state.tenantId = picker.value ? Number(picker.value) : null;
      state.view = state.tenantId ? 'overview' : 'tenants';
      await loadEnabledModules();
      await loadBranding(state.tenantId);
      render();
    });
  }

  document.getElementById('logout').onclick = guard(async () => {
    stopLive();
    await post('/api/logout');
    location.href = '/login.html';
  });

  void draw(main);

  /**
   * البث المباشر: يُعاد ربطه مع كل رسم لأن المنشأة قد تتغيّر.
   *
   * والتحديث مؤجَّل أثناء الكتابة: إعادة الرسم تمسح الحقول، ورسالة
   * نصف مكتوبة تختفي لأن عميلاً آخر أرسل شيئاً عطلٌ يُفقد الثقة
   * بالنظام كله.
   */
  watchLive(state.tenantId, () => {
    if (isTyping()) {
      pendingLive = true;
      return;
    }
    void draw(document.querySelector('main'));
  });
}

async function draw(main) {
  try {
    // قبل حارس «اختيار منشأة»: حسابي لا يخصّ منشأة، وأدمن النظام
    // يدخلها وهو لم يختر أي منشأة بعد.
    if (state.view === 'account') {
      await renderAccount(main);
      return;
    }

    // قبل حارس «اختيار منشأة»: الطلب ليس لمنشأة بعد.
    if (state.view === 'leads') {
      await renderLeads(main);
      return;
    }

    /**
     * «الإعداد» يتبع المنشأة المفتوحة.
     *
     * كان يعرض إعدادات النظام العام دائماً، فتُفتح منشأة ويُرى توكن
     * منشأة أخرى. مع اختيار منشأة يعرض إعدادها هي، وبلا اختيار يعرض
     * المشترك — وهذا ما يتوقّعه من فتح شركة ليضبطها.
     */
    if (state.view === 'setup') {
      if (state.tenantId) await renderTenantSetup(main);
      else await renderSetup(main);
      return;
    }

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
      main.innerHTML = '<div class="empty">لم تُحدَّد منشأة بعد — الاختيار من القائمة في الأعلى.</div>';
      return;
    }

    const view = VIEWS.find((v) => v.id === state.view);
    if (view?.render) {
      await view.render(main);
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
