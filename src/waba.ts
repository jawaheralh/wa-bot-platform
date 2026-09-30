/**
 * إيجاد حساب واتساب للأعمال (WABA) من معرّف النشاط التجاري.
 *
 * Meta تسمّي شيئين متقاربين باسمٍ واحد تقريباً:
 *
 * - **معرّف النشاط التجاري** (Business Portfolio) — الحساب الأمّ الذي
 *   يضمّ التطبيقات والصفحات وحسابات واتساب.
 * - **حساب واتساب للأعمال** (WABA) — وتحته الأرقام والقوالب.
 *
 * والذي يُنسخ من واجهة Meta غالباً هو الأول، لأنه الظاهر في العنوان.
 * أما القوالب فهي حافّة على الثاني، فتُرفض بـ«(#100) Tried accessing
 * nonexisting field» — رسالةٌ لا تدلّ على السبب إطلاقاً.
 *
 * ولذلك يُشتقّ الثاني من الأول هنا بدل أن يُطلب من المالك أن يميّز
 * بينهما في واجهةٍ لا تميّزهما.
 */

import type { AppConfig } from './config.ts';
import type { MetaCredentials } from './tenant-meta.ts';

const GRAPH = 'https://graph.facebook.com';

export interface WabaResult {
  ok: boolean;
  message: string;
  id?: string;
  /** أكثر من حساب تحت النشاط الواحد — يُذكر ليعرف المالك أيّها استُعمل. */
  all?: { id: string; name: string }[];
}

/**
 * ذاكرة داخل التشغيل الواحد.
 *
 * الاشتقاق نداءُ شبكةٍ إضافي، وقائمة القوالب تُفتح مراراً في الجلسة.
 * والمفتاح هو التوكن مع المعرّف لا المعرّف وحده: توكنٌ جديد قد يرى
 * حسابات غير التي رآها سابقه.
 */
const cache = new Map<string, string>();

export function forgetWaba(): void {
  cache.clear();
}

export async function resolveWaba(config: AppConfig, credentials: MetaCredentials): Promise<WabaResult> {
  if (!credentials.accessToken) return { ok: false, message: 'لا يوجد توكن Meta لهذه المنشأة.' };
  if (!credentials.businessId) {
    return { ok: false, message: 'لا يوجد معرّف نشاط تجاري لهذه المنشأة — يُضبط من الإعداد.' };
  }

  const key = `${credentials.businessId}:${credentials.accessToken.slice(-12)}`;
  const known = cache.get(key);
  if (known) return { ok: true, message: 'من الذاكرة.', id: known };

  const url =
    `${GRAPH}/${config.cloud.graphVersion}/${credentials.businessId}/owned_whatsapp_business_accounts` +
    `?fields=id,name&access_token=${encodeURIComponent(credentials.accessToken)}`;

  const response = await fetch(url);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.ok) {
    const rows = (body.data ?? []) as { id?: string; name?: string }[];
    const all = rows.map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') })).filter((r) => r.id);

    if (all.length) {
      cache.set(key, all[0]!.id);
      return { ok: true, message: 'وُجد حساب واتساب للأعمال.', id: all[0]!.id, all };
    }
    return {
      ok: false,
      message: 'لا يوجد حساب واتساب للأعمال تحت هذا النشاط التجاري.',
      all: [],
    };
  }

  /**
   * الفشل هنا لا يعني الخطأ دائماً.
   *
   * من أدخل معرّف الـWABA مباشرة — وهو الصحيح تقنياً — لا يملك حافّة
   * `owned_whatsapp_business_accounts`. فيُجرَّب المعرّف كما هو بدل
   * أن يُرفض إعدادٌ سليم.
   */
  const probe = await fetch(
    `${GRAPH}/${config.cloud.graphVersion}/${credentials.businessId}/message_templates` +
      `?limit=1&access_token=${encodeURIComponent(credentials.accessToken)}`,
  );
  if (probe.ok) {
    cache.set(key, credentials.businessId);
    return { ok: true, message: 'المعرّف نفسه حساب واتساب للأعمال.', id: credentials.businessId };
  }

  const error = body.error as { message?: string } | undefined;
  return { ok: false, message: error?.message ?? `رفضت Meta (${response.status})` };
}
