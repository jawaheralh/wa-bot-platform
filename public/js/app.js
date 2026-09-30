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
import { renderBilling } from './views/billing.js';

/**
 * شاشتان لا قائمة واحدة.
 *
 * `daily` ما يُفتح كل يوم، و`setup` ما يُضبط مرة عند التأسيس ثم يُنسى.
 * وخلطهما في قائمة من أربع عشرة شاشة يجعل الموظف يمرّ على «استهلاك
 * ميتا» ليصل إلى «المحادثات» — وهي عمله كله.
 *
 * فاليومي في الشريط الجانبي، والإعداد خلف زرٍّ واحد أعلى الصفحة.
 */
const VIEWS = [
  { id: 'conversations', label: 'المحادثات', render: renderConversations, group: 'daily' },
  { id: 'complaints', label: 'الشكاوى', render: renderComplaints, group: 'daily' },
  { id: 'requests', label: 'الطلبات', render: renderRequests, module: 'requests', group: 'daily' },
  { id: 'bookings', label: 'المواعيد', render: renderBookings, module: 'bookings', group: 'daily' },
  { id: 'overview', label: 'نظرة عامة', render: renderOverview, group: 'daily' },
  { id: 'satisfaction', label: 'رضا العملاء', render: renderSatisfaction, group: 'daily' },

  { id: 'knowledge', label: 'قاعدة المعرفة', render: renderKnowledge, group: 'setup' },
  { id: 'training', label: 'تدريب البوت', render: renderTraining, group: 'setup' },
  { id: 'staff', label: 'الموظفون', render: renderStaff, group: 'setup' },
  { id: 'branding', label: 'الهوية', render: renderBranding, group: 'setup' },
  { id: 'templates', label: 'القوالب', render: renderTemplates, group: 'setup' },
  { id: 'billing', label: 'استهلاك ميتا', render: renderBilling, group: 'setup' },
  { id: 'modules', label: 'الوحدات', render: renderModules, group: 'setup' },
  { id: 'privacy', label: 'الخصوصية', render: renderPrivacy, group: 'setup' },
];

/** شاشات المنصة لأدمن النظام — ليست إعداد منشأة ولا عملاً يومياً فيها. */
const PLATFORM_VIEWS = [
  { id: 'tenants', label: 'كل المنشآت' },
  { id: 'leads', label: 'طلبات التجربة' },
  { id: 'setup', label: 'إعداد المنشأة' },
];

/**
 * ما يراه الموظف — قائمة سماح لا قائمة منع.
 *
 * قائمة المنع تنمو مع كل شاشة جديدة، ومن ينسى إضافة شاشته إليها
 * يكشفها للموظفين بلا أن ينتبه. وقائمة السماح تفعل العكس: الشاشة
 * الجديدة محجوبة حتى تُذكر صراحةً.
 */
const AGENT_VIEWS = new Set(['conversations', 'complaints', 'requests', 'bookings']);

const root = document.getElementById('root');

async function boot() {
  state.me = await get('/api/me');

  if (state.me.role === 'system') {
    state.tenants = await get('/api/system/tenants');
    state.tenantId = state.tenants[0]?.id ?? null;
    /**
     * صاحب المنصة يفتح على منصّته لا على منشأة أولى بالترتيب.
     *
     * فتحُها على «محادثات عيادة النور» يجعله يظنّ للحظة أنه في لوحة
     * عميل، ويُخفي عنه ما يخصّه: طلبات التجربة الجديدة وحال المنشآت.
     */
    state.view = 'tenants';
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

/** اسم الشاشة المفتوحة — يقول للموظف أين هو قبل أن يقرأ المحتوى. */
function whereLabel(views) {
  const known = [...views, ...PLATFORM_VIEWS, { id: 'account', label: 'حسابي' }];
  return known.find((v) => v.id === state.view)?.label ?? '';
}

/**
 * زرّ الإعدادات: قائمة تُفتح بالضغط.
 *
 * ولا يُعرض أصلاً لمن لا إعداد له — الموظف يرى زراً فارغاً فيضغطه
 * مرة بعد مرة يظنّ أن فيه عطلاً.
 */
function settingsButton(views) {
  const items = views.filter((v) => v.group === 'setup');
  if (!items.length || !state.tenantId) return '';

  return `
    <div class="menu-wrap">
      <button class="btn ghost small" id="settingsToggle" aria-haspopup="true" aria-expanded="false">
        ⚙ الإعدادات
      </button>
      <div class="menu" id="settingsMenu" hidden>
        ${items
          .map(
            (v) =>
              `<button data-view="${v.id}" class="${state.view === v.id ? 'on' : ''}">${esc(v.label)}</button>`,
          )
          .join('')}
      </div>
    </div>`;
}

function visibleViews() {
  return VIEWS.filter((view) => {
    if (view.module && !state.enabledModules.includes(view.module)) return false;
    if (!view.render) return false;
    // الموظف يرد على العملاء ويتابع حالاتهم، ولا شأن له بالإعداد.
    if (state.me.role === 'agent' && !AGENT_VIEWS.has(view.id)) return false;
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
  void draw(document.querySelector('.page'));
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
              ? PLATFORM_VIEWS.map(
                  (v) =>
                    `<button data-view="${v.id}" class="${state.view === v.id ? 'active' : ''}">${esc(v.label)}</button>`,
                ).join('') + '<div class="nav-split"></div>'
              : ''
          }
          ${
            state.tenantId
              ? views
                  .filter((v) => v.group === 'daily')
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
          <button id="logout">تسجيل الخروج</button>
        </nav>
      </aside>

      <main>
        <header class="topbar">
          <span class="topbar-where">${esc(whereLabel(views))}</span>
          <div class="topbar-actions">
            ${settingsButton(views)}
            <button class="btn ghost small" data-view="account">حسابي</button>
          </div>
        </header>
        <div class="page"><div class="empty">جارٍ التحميل…</div></div>
      </main>
    </div>
  `;

  const main = root.querySelector('.page');

  root.querySelectorAll('[data-view]').forEach((button) => {
    button.onclick = guard(async () => {
      const leavingBranding = state.view === 'branding' && button.dataset.view !== 'branding';
      state.view = button.dataset.view;
      // معاينة الهوية تغيّر ألوان اللوحة قبل الحفظ؛ الخروج بلا حفظ يعيدها.
      if (leavingBranding) await loadBranding(state.tenantId);
      render();
    });
  });

  /**
   * القائمة تُغلق بالضغط خارجها.
   *
   * وبلا ذلك تبقى مفتوحة فوق المحتوى، فيضغط الموظف ما تحتها ولا يحدث
   * شيء — ويظنّ الشاشة متجمّدة.
   */
  const toggle = document.getElementById('settingsToggle');
  const menu = document.getElementById('settingsMenu');
  if (toggle && menu) {
    toggle.onclick = (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      toggle.setAttribute('aria-expanded', String(!menu.hidden));
    };
    document.addEventListener('click', () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    });
    menu.onclick = (event) => event.stopPropagation();
  }

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
    void draw(document.querySelector('.page'));
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
