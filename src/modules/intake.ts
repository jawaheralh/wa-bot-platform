/**
 * وحدة الاستقبال — التحية وجمع بيانات العميل قبل الخدمة.
 *
 * أول رسالة من عميل جديد: ترحيب باسم المنشأة، ثم سؤال عن اسمه (وعن رقم
 * تواصل بديل إن طُلب)، ثم قائمة بما تقدّمه المنشأة. بعدها تسير المحادثة
 * طبيعياً وقد صار للعميل اسم يُنادى به ويظهر للموظف في اللوحة.
 *
 * تصميم مقصود: **لا نسأل عن رقم الجوال افتراضياً** — العميل يكاتبنا من
 * رقمه أصلاً والنظام يعرفه. سؤاله عنه يُشعره أننا لا ننتبه، ويزيد خطوة
 * بلا فائدة. الخيار متاح لمن يحتاج رقماً ثانياً (رقم المسؤول في الشركة مثلاً).
 */

import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { readString } from './types.ts';
import { normalizeNumber, type Db } from '../db/index.ts';

interface IntakeConfig extends ModuleConfig {
  /** نص الترحيب. {المنشأة} يُستبدل باسمها. */
  greeting: string;
  /** اسأل عن الاسم قبل الخدمة. */
  askName: boolean;
  /** اسأل عن رقم تواصل بديل — غير الرقم الذي يكاتبنا منه. */
  askAltPhone: boolean;
  /** اسأل عن مدينته أو المحطة التي يقصدها. */
  askLocation: boolean;
  /** المواقع المتاحة — تُعرض للعميل ليختار، وتمنع أسماء مبهمة. */
  locations: string[];
  /** يُعرض بعد الترحيب ليعرف العميل ما يستطيع طلبه. فارغ = بلا قائمة. */
  menu: string[];
  /** امنع الخدمة قبل اكتمال البيانات، أو اسأل واستمر على أي حال. */
  requireBeforeService: boolean;
}

const DEFAULTS: IntakeConfig = {
  greeting: 'حياك الله في {المنشأة}.',
  askName: true,
  askAltPhone: false,
  askLocation: true,
  locations: [],
  menu: ['استفسار عن الخدمات', 'تقديم شكوى', 'طلب خدمة'],
  requireBeforeService: false,
};

export function saveIntake(
  db: Db,
  conversationId: number,
  data: { name?: string; phone?: string; location?: string },
): void {
  db.prepare(
    `UPDATE conversations SET
       customer_name = COALESCE(NULLIF(?, ''), customer_name),
       contact_phone = COALESCE(NULLIF(?, ''), contact_phone),
       customer_city = COALESCE(NULLIF(?, ''), customer_city),
       intake_done   = 1
     WHERE id = ?`,
  ).run(
    data.name?.trim() ?? '',
    data.phone ? normalizeNumber(data.phone) : '',
    data.location?.trim() ?? '',
    conversationId,
  );
}

export const intakeModule: BotModule = {
  name: 'intake',
  titleAr: 'الاستقبال',
  descriptionAr:
    'يرحّب بالعميل الجديد، ويأخذ اسمه، ويعرض عليه ما تقدّمه المنشأة — فيعرف الموظف مع من يتكلم من أول رسالة.',
  core: false,

  tables: [],

  defaultConfig: () => structuredClone(DEFAULTS),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<IntakeConfig>;
    const menu = Array.isArray(raw.menu)
      ? raw.menu.map((m) => String(m).trim()).filter(Boolean).slice(0, 8)
      : [...DEFAULTS.menu];

    const locations = Array.isArray(raw.locations)
      ? raw.locations.map((l) => String(l).trim()).filter(Boolean).slice(0, 30)
      : [];

    return {
      greeting:
        typeof raw.greeting === 'string' && raw.greeting.trim() ? raw.greeting.trim() : DEFAULTS.greeting,
      askName: raw.askName !== false,
      askAltPhone: raw.askAltPhone === true,
      askLocation: raw.askLocation !== false,
      locations,
      menu,
      requireBeforeService: raw.requireBeforeService === true,
    } satisfies IntakeConfig;
  },

  systemPrompt(ctx: ModuleContext): string {
    const config = ctx.config as IntakeConfig;
    const greeting = config.greeting.replace(/\{المنشأة\}/g, ctx.tenant.name);

    // البيانات مكتملة: لا تعليمات استقبال، ولا تحية متكررة.
    const nothingToAsk = !config.askName && !config.askAltPhone && !config.askLocation;
    if (ctx.conversation.intake_done === 1 || nothingToAsk) {
      const known: string[] = [];
      if (ctx.conversation.customer_name) known.push(`اسمه «${ctx.conversation.customer_name}»`);
      if (ctx.conversation.customer_city) known.push(`وموقعه «${ctx.conversation.customer_city}»`);
      return known.length
        ? `## العميل
${known.join(' ')}. استعمل ذلك في إجابتك — خصّص الجواب لموقعه ولا تسأله عنه ثانيةً.
ناده باسمه حين يناسب، بلا تكلّف ولا تكرار في كل رسالة.`
        : '';
    }

    const wanted: string[] = [];
    if (config.askName) wanted.push('اسمه');
    if (config.askLocation) {
      wanted.push(
        config.locations.length
          ? `المدينة أو المحطة التي يقصدها (${config.locations.join('، ')})`
          : 'مدينته أو الموقع الذي يقصده',
      );
    }
    if (config.askAltPhone) wanted.push('رقم تواصل بديل (غير الرقم الذي يكاتبك منه)');

    return `## الاستقبال — أول تعامل مع هذا العميل
رحّب به بهذا النص أو بمعناه: «${greeting}»
${config.menu.length ? `ثم اعرض عليه باختصار ما نقدّمه: ${config.menu.join('، ')}.` : ''}
واسأله عن ${wanted.join(' و')} في نفس الرسالة — رسالة واحدة لا ثلاث.

حين يعطيك ${wanted.join(' و')} استعمل save_customer_details فوراً، ثم أكمل طلبه.

قواعد:
- لا تسأله عن رقم جواله الذي يكاتبك منه؛ عندنا وهو يعرف ذلك.
- إن ذكر موقعه ضمناً في سؤاله («المغسلة في الربيع») فقد أجاب — احفظه ولا تسأل.
- ${
      config.requireBeforeService
        ? 'إن بدأ بطلب أو شكوى قبل أن يعطيك اسمه، اطلب الاسم أولاً بلطف ثم أكمل.'
        : 'إن بدأ بطلب أو شكوى مباشرة، **لا تعطّله**: اخدمه واسأله عن اسمه في نفس الرسالة.'
    }
- لا تكرر السؤال أكثر من مرة؛ إن رفض أو تجاهل، أكمل الخدمة بلا اسم.`;
  },

  tools(): ToolDefinition[] {
    return [
      {
        name: 'save_customer_details',
        description: 'يحفظ اسم العميل ورقم تواصله البديل. استعمله فور أن يذكرها.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'اسم العميل كما ذكره.' },
            phone: { type: 'string', description: 'رقم تواصل بديل إن ذكره. اتركه فارغاً إن لم يذكره.' },
            location: { type: 'string', description: 'مدينته أو المحطة التي يقصدها إن ذكرها.' },
          },
          required: ['name'],
        },
      },
    ];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    if (name !== 'save_customer_details') return { content: `أداة غير معروفة: ${name}`, isError: true };

    const customerName = readString(input, 'name');
    const phone = readString(input, 'phone');
    const location = readString(input, 'location');

    if (!customerName && !phone && !location) {
      return { content: 'لم تصل بيانات. اسأل العميل عن اسمه بلطف مرة واحدة.', isError: true };
    }

    saveIntake(ctx.db, ctx.conversation.id, { name: customerName, phone, location });
    ctx.logger.info('حُفظت بيانات العميل', {
      اسم: customerName || '—',
      موقع: location || '—',
      بديل: phone || '—',
    });

    const saved = [
      customerName && `الاسم: ${customerName}`,
      location && `الموقع: ${location}`,
      phone && `رقم التواصل: ${phone}`,
    ].filter(Boolean);

    return {
      content: `حُفظ ${saved.join(' · ')}. اشكره باختصار وأكمل خدمة طلبه مباشرةً، ولا تسأله عن شيء آخر.`,
    };
  },
};
