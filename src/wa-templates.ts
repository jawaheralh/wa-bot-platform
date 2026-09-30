/**
 * إنشاء قوالب واتساب من اللوحة.
 *
 * القالب هو الإذن الوحيد لمراسلة عميلٍ خارج نافذة الأربع والعشرين
 * ساعة: رقم الطلب، وتغيّر الحالة، وسؤال التقييم بعد الإغلاق — كلها
 * تحتاج قالباً معتمداً من Meta.
 *
 * وإنشاؤه في واجهة Meta يمرّ بأربع شاشات، ويختلف موضعه بين حساب
 * وآخر، ويُعاد لكل عميل من عملائك على حدة. فهو هنا بنموذج واحد.
 *
 * ## ما لا يستطيعه هذا الملف
 *
 * لا يعتمد القالب — Meta هي التي تراجعه. يُنشأ بحالة PENDING ثم
 * يُقبل أو يُرفض خلال دقائق إلى يوم. ولهذا لا يَعِد النظامُ أحداً
 * بأن القالب «جاهز» بمجرد إنشائه.
 */

import type { AppConfig } from './config.ts';
import type { MetaCredentials } from './tenant-meta.ts';
import { resolveWaba } from './waba.ts';

const GRAPH = 'https://graph.facebook.com';

/**
 * التصنيف يحدّد السعر والسياسة.
 *
 * MARKETING أغلى وأشدّ مراجعة، وUTILITY لما يتبع معاملةً قائمة
 * (رقم طلب، تحديث حالة). واختيار التصنيف الخطأ أشهر سبب للرفض:
 * رسالة تقييمٍ مصنَّفة تسويقاً تُرفض، ومصنَّفة UTILITY تُقبل.
 */
export const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof CATEGORIES)[number];

export const CATEGORY_AR: Record<TemplateCategory, string> = {
  UTILITY: 'خدمي — يتبع معاملة قائمة (رقم طلب، تحديث حالة)',
  MARKETING: 'تسويقي — عرض أو إعلان. أغلى وأشدّ مراجعة',
  AUTHENTICATION: 'تحقق — رمز دخول أو استرجاع',
};

export interface NewTemplate {
  name: string;
  language: string;
  category: TemplateCategory;
  body: string;
  /** سطر أعلى الرسالة — نصّ ثابت بلا متغيّرات. */
  header?: string;
  footer?: string;
  /** أمثلة المتغيّرات — Meta ترفض القالب بلا أمثلة حين يحمل متغيّرات. */
  examples?: string[];
}

export interface TemplateResult {
  ok: boolean;
  message: string;
  data?: { id?: string; status?: string };
}

/* ---------------------------------------------------------------
   التحقق قبل الإرسال
--------------------------------------------------------------- */

/**
 * اسم القالب عند Meta: حروف إنجليزية صغيرة وأرقام وشرطة سفلية.
 *
 * والشرطات تُقلَّم من الطرفين وتُدمج في الوسط، وإلا خرج اسمٌ عربي
 * بالكامل على صورة «_» — فيمرّ فحصَ «الاسم مطلوب» لأنه ليس فارغاً،
 * ثم ترفضه Meta برسالة لا يفهمها المالك.
 */
export function normalizeName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

/** أرقام المتغيّرات في النصّ، مرتّبة بلا تكرار. */
export function variablesIn(body: string): number[] {
  const found = new Set<number>();
  for (const match of String(body ?? '').matchAll(/\{\{(\d+)\}\}/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function validateTemplate(input: NewTemplate): string | null {
  if (!normalizeName(input.name)) return 'اسم القالب مطلوب — حروف إنجليزية وأرقام.';
  if (!input.body?.trim()) return 'نصّ القالب مطلوب.';
  if (input.body.length > 1024) return 'نصّ القالب أطول من ١٠٢٤ حرفاً.';
  if (input.header && input.header.length > 60) return 'الترويسة أطول من ٦٠ حرفاً.';
  if (input.footer && input.footer.length > 60) return 'التذييل أطول من ٦٠ حرفاً.';
  if (!CATEGORIES.includes(input.category)) return 'تصنيف القالب غير معروف.';

  /**
   * المتغيّرات تبدأ من ١ وتتسلسل.
   *
   * Meta ترفض `{{1}} ... {{3}}` بلا `{{2}}` برسالة غامضة، وهذا أشهر
   * سبب للرفض بعد التصنيف. فيُفحص هنا حيث تُفهم الرسالة.
   */
  const variables = variablesIn(input.body);
  for (let i = 0; i < variables.length; i += 1) {
    if (variables[i] !== i + 1) {
      return `ترقيم المتغيّرات يجب أن يبدأ بـ{{1}} ويتسلسل بلا فجوة — وجدتُ {{${variables[i]}}}.`;
    }
  }

  if (variables.length && (input.examples ?? []).filter(Boolean).length < variables.length) {
    return 'Meta تطلب مثالاً لكل متغيّر — اكتب قيمة واقعية لكلٍّ منها.';
  }

  return null;
}

/* ---------------------------------------------------------------
   الإنشاء والحذف
--------------------------------------------------------------- */

function errorOf(body: Record<string, unknown>, status: number): string {
  const error = body.error as { message?: string; error_user_msg?: string } | undefined;
  return error?.error_user_msg ?? error?.message ?? `رفضت Meta (${status})`;
}

export async function createTemplate(
  config: AppConfig,
  credentials: MetaCredentials,
  input: NewTemplate,
): Promise<TemplateResult> {
  const invalid = validateTemplate(input);
  if (invalid) return { ok: false, message: invalid };

  const waba = await resolveWaba(config, credentials);
  if (!waba.ok) return { ok: false, message: waba.message };

  const variables = variablesIn(input.body);
  const components: Record<string, unknown>[] = [];

  if (input.header?.trim()) {
    components.push({ type: 'HEADER', format: 'TEXT', text: input.header.trim() });
  }

  components.push({
    type: 'BODY',
    text: input.body.trim(),
    // الأمثلة مصفوفة داخل مصفوفة — هكذا تطلبها Meta لنصّ الجسم.
    ...(variables.length
      ? { example: { body_text: [variables.map((_, i) => (input.examples ?? [])[i] ?? '')] } }
      : {}),
  });

  if (input.footer?.trim()) components.push({ type: 'FOOTER', text: input.footer.trim() });

  const response = await fetch(
    `${GRAPH}/${config.cloud.graphVersion}/${waba.id}/message_templates`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: normalizeName(input.name),
        language: input.language || 'ar',
        category: input.category,
        components,
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, message: errorOf(body, response.status) };

  return {
    ok: true,
    message: 'أُرسل القالب لمراجعة Meta. يصير جاهزاً للإرسال حين يُعتمد.',
    data: { id: String(body.id ?? ''), status: String(body.status ?? 'PENDING') },
  };
}

export async function deleteTemplate(
  config: AppConfig,
  credentials: MetaCredentials,
  name: string,
): Promise<TemplateResult> {
  const waba = await resolveWaba(config, credentials);
  if (!waba.ok) return { ok: false, message: waba.message };

  const url =
    `${GRAPH}/${config.cloud.graphVersion}/${waba.id}/message_templates` +
    `?name=${encodeURIComponent(normalizeName(name))}&access_token=${encodeURIComponent(credentials.accessToken)}`;

  const response = await fetch(url, { method: 'DELETE' });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, message: errorOf(body, response.status) };
  return { ok: true, message: 'حُذف القالب.' };
}

/**
 * كل القوالب بحالاتها — لا المعتمدة وحدها.
 *
 * شاشة الإدارة تحتاج المعلّق والمرفوض: المعلّق يُنتظر، والمرفوض
 * يُصحَّح — وإخفاؤهما يجعل المالك يُنشئ القالب مرة بعد مرة ويظنّ أن
 * النظام لا يحفظه.
 */
export async function listAllTemplates(
  config: AppConfig,
  credentials: MetaCredentials,
): Promise<{ ok: boolean; message: string; templates: TemplateInfo[] }> {
  const waba = await resolveWaba(config, credentials);
  if (!waba.ok) return { ok: false, message: waba.message, templates: [] };

  const url =
    `${GRAPH}/${config.cloud.graphVersion}/${waba.id}/message_templates` +
    `?limit=100&access_token=${encodeURIComponent(credentials.accessToken)}`;

  const response = await fetch(url);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, message: errorOf(body, response.status), templates: [] };

  const rows = (body.data ?? []) as {
    name?: string;
    language?: string;
    status?: string;
    category?: string;
    components?: { type?: string; text?: string }[];
  }[];

  return {
    ok: true,
    message: 'قُرئت القوالب.',
    templates: rows.map((t) => {
      const text = t.components?.find((c) => (c.type ?? '').toUpperCase() === 'BODY')?.text ?? '';
      return {
        name: t.name ?? '',
        language: t.language ?? '',
        status: (t.status ?? '').toUpperCase(),
        category: (t.category ?? '').toUpperCase(),
        body: text,
        variables: variablesIn(text).length,
      };
    }),
  };
}

export interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  variables: number;
}

/* ---------------------------------------------------------------
   قوالب جاهزة
--------------------------------------------------------------- */

/**
 * ما يحتاجه كل عميل فعلاً.
 *
 * أكثر ما يُرفض من القوالب يُرفض لصياغته لا لفكرته: نصٌّ يبدو إعلاناً،
 * أو متغيّر بلا مثال، أو تصنيف خاطئ. فهذه مكتوبة بصيغة تمرّ، ويكفي
 * المالكَ أن يضغط «أنشئ».
 */
export const SUGGESTED: (NewTemplate & { title: string; why: string })[] = [
  {
    title: 'رقم الطلب للتتبّع',
    why: 'يُرسل للعميل فور تسجيل طلبه ليعرف رقمه ويتابع به.',
    name: 'request_reference',
    language: 'ar',
    category: 'UTILITY',
    body: 'مرحباً {{1}}، سجّلنا طلبك برقم {{2}}. تقدر ترسل لنا الرقم في أي وقت لمعرفة حالته.',
    footer: 'شكراً لك',
    examples: ['خالد', 'TLB-2026-000042'],
  },
  {
    title: 'تحديث حالة الطلب',
    why: 'يُرسل عند تغيّر حالة الطلب أو الشكوى.',
    name: 'request_update',
    language: 'ar',
    category: 'UTILITY',
    body: 'تحديث على طلبك رقم {{1}}: {{2}}.',
    footer: 'للاستفسار ردّ على هذه الرسالة',
    examples: ['TLB-2026-000042', 'قيد التنفيذ'],
  },
  {
    title: 'تقييم الخدمة بعد الإغلاق',
    why: 'يُرسل بعد إغلاق الطلب لقياس رضا العميل.',
    name: 'service_rating',
    language: 'ar',
    category: 'UTILITY',
    body: 'أغلقنا طلبك رقم {{1}}. كيف كانت خدمتنا؟ ردّ برقم من ١ إلى ٥، و١ أقل تقدير و٥ أعلاه.',
    footer: 'رأيك يساعدنا نتحسن',
    examples: ['TLB-2026-000042'],
  },
];
