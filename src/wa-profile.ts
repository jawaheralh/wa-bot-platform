/**
 * ملفّ واتساب للأعمال: الصورة والوصف وبيانات التواصل.
 *
 * هذا ما يراه العميل قبل أن يكتب حرفاً — صورة الرقم واسم النشاط ونبذته.
 * ورقمٌ بلا صورة يبدو لعميلٍ سعودي رقماً مجهولاً لا شركةً، فيتردّد قبل
 * أن يرسل.
 *
 * وتغييره من هنا لا من واجهة Meta: الوصول إليه هناك يمرّ بأربع شاشات
 * ويختلف موضعه بين حساب وآخر، والمنشآت عندنا كثيرة.
 *
 * ## رفع الصورة يحتاج ثلاث خطوات لا واحدة
 *
 * Meta لا تقبل صورة مباشرةً في الملف، بل «مقبضاً» (handle) يُنتَج من
 * رفعٍ مستأنَف على التطبيق:
 *   ١. فتح جلسة رفع على `/{app-id}/uploads` ← معرّف الجلسة.
 *   ٢. إرسال البايتات إلى الجلسة بترويسة `file_offset` ← المقبض.
 *   ٣. كتابة المقبض في `profile_picture_handle` على الرقم.
 * وكل خطوة قد تُرفض وحدها، فالرسالة تقول أيّها فشلت.
 */

import type { AppConfig } from './config.ts';
import type { MetaCredentials } from './tenant-meta.ts';

const GRAPH = 'https://graph.facebook.com';

/** ما تقبله Meta صورةً للملف. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface WaProfile {
  about: string;
  description: string;
  address: string;
  email: string;
  vertical: string;
  websites: string[];
  profilePictureUrl: string;
}

export interface ProfileResult<T = undefined> {
  ok: boolean;
  message: string;
  data?: T;
}

/** المجالات التي تقبلها Meta لحقل «النشاط». */
export const VERTICALS: Record<string, string> = {
  UNDEFINED: '—',
  AUTO: 'سيارات',
  BEAUTY: 'تجميل',
  APPAREL: 'ملابس',
  EDU: 'تعليم',
  ENTERTAIN: 'ترفيه',
  EVENT_PLAN: 'تنظيم فعاليات',
  FINANCE: 'مالية',
  GROCERY: 'بقالة',
  GOVT: 'جهة حكومية',
  HOTEL: 'فنادق',
  HEALTH: 'صحة',
  NONPROFIT: 'غير ربحية',
  PROF_SERVICES: 'خدمات مهنية',
  RETAIL: 'تجزئة',
  TRAVEL: 'سفر',
  RESTAURANT: 'مطاعم',
  OTHER: 'أخرى',
};

function errorOf(data: Record<string, unknown>, status: number): string {
  const error = data.error as { message?: string; error_user_msg?: string } | undefined;
  return error?.error_user_msg ?? error?.message ?? `رفضت Meta (${status})`;
}

/**
 * الصلاحية الناقصة أشهر أسباب الرفض هنا.
 *
 * توكن الرسائل وحده لا يكفي لتعديل الملف: يلزم
 * `whatsapp_business_management`. ورسالة Meta عنها غامضة، فتُترجَم.
 */
function explain(data: Record<string, unknown>, status: number): string {
  const raw = errorOf(data, status);
  if (/permission|scope|(#200)/i.test(raw)) {
    return `${raw} — الأرجح أن التوكن بلا صلاحية whatsapp_business_management.`;
  }
  return raw;
}

/* ---------------------------------------------------------------
   القراءة
--------------------------------------------------------------- */

const FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';

export async function readProfile(
  config: AppConfig,
  credentials: MetaCredentials,
  phoneNumberId: string,
): Promise<ProfileResult<WaProfile>> {
  if (!credentials.accessToken) return { ok: false, message: 'لا يوجد توكن Meta لهذه المنشأة.' };
  if (!phoneNumberId) return { ok: false, message: 'لا يوجد معرّف رقم (Phone number ID) لهذه المنشأة.' };

  const url =
    `${GRAPH}/${config.cloud.graphVersion}/${phoneNumberId}/whatsapp_business_profile` +
    `?fields=${FIELDS}&access_token=${encodeURIComponent(credentials.accessToken)}`;

  const response = await fetch(url);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, message: explain(body, response.status) };

  // Meta تعيد الملف داخل مصفوفة data من عنصر واحد.
  const row = (Array.isArray(body.data) ? body.data[0] : body) as Record<string, unknown>;
  return {
    ok: true,
    message: 'قُرئ الملف.',
    data: {
      about: String(row?.about ?? ''),
      description: String(row?.description ?? ''),
      address: String(row?.address ?? ''),
      email: String(row?.email ?? ''),
      vertical: String(row?.vertical ?? 'UNDEFINED'),
      websites: Array.isArray(row?.websites) ? (row.websites as string[]) : [],
      profilePictureUrl: String(row?.profile_picture_url ?? ''),
    },
  };
}

/* ---------------------------------------------------------------
   الكتابة
--------------------------------------------------------------- */

export interface ProfileUpdate {
  about?: string;
  description?: string;
  address?: string;
  email?: string;
  vertical?: string;
  websites?: string[];
  profilePictureHandle?: string;
}

/** حدود Meta. تجاوزها يُرفض من عندها برسالة غامضة، فيُمنع من هنا. */
const LIMITS: Record<string, number> = { about: 139, description: 512, address: 256, email: 128 };

export function validateProfile(update: ProfileUpdate): string | null {
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = (update as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > max) {
      return `«${key}» أطول من ${max} حرفاً.`;
    }
  }
  if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(update.email)) {
    return 'البريد الإلكتروني غير صحيح.';
  }
  for (const site of update.websites ?? []) {
    if (!/^https?:\/\/\S+$/i.test(site)) return 'الموقع يجب أن يبدأ بـhttp أو https.';
  }
  if ((update.websites?.length ?? 0) > 2) return 'موقعان على الأكثر.';
  if (update.vertical && !(update.vertical in VERTICALS)) return 'مجال النشاط غير معروف.';
  return null;
}

export async function updateProfile(
  config: AppConfig,
  credentials: MetaCredentials,
  phoneNumberId: string,
  update: ProfileUpdate,
): Promise<ProfileResult> {
  if (!credentials.accessToken) return { ok: false, message: 'لا يوجد توكن Meta لهذه المنشأة.' };
  if (!phoneNumberId) return { ok: false, message: 'لا يوجد معرّف رقم (Phone number ID) لهذه المنشأة.' };

  const invalid = validateProfile(update);
  if (invalid) return { ok: false, message: invalid };

  const payload: Record<string, unknown> = { messaging_product: 'whatsapp' };
  if (update.about !== undefined) payload.about = update.about;
  if (update.description !== undefined) payload.description = update.description;
  if (update.address !== undefined) payload.address = update.address;
  if (update.email !== undefined) payload.email = update.email;
  if (update.vertical !== undefined) payload.vertical = update.vertical;
  if (update.websites !== undefined) payload.websites = update.websites;
  if (update.profilePictureHandle) payload.profile_picture_handle = update.profilePictureHandle;

  const response = await fetch(
    `${GRAPH}/${config.cloud.graphVersion}/${phoneNumberId}/whatsapp_business_profile`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify(payload),
    },
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) return { ok: false, message: explain(body, response.status) };
  return { ok: true, message: 'حُدّث ملف واتساب.' };
}

/* ---------------------------------------------------------------
   الصورة: رفع مستأنَف ثم مقبض
--------------------------------------------------------------- */

export function sniffImage(buffer: Buffer): string | null {
  if (buffer.length < 8) return null;
  const hex = buffer.subarray(0, 8).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  return null;
}

/**
 * يرفع الصورة إلى Meta ويعيد مقبضها.
 *
 * التطبيق هو من يستضيف جلسة الرفع لا الرقم، فيلزم `appId`. وتوكن
 * التطبيق (`المعرّف|السرّ`) لا يصلح هنا — الجلسة تُفتح بتوكن المستخدم
 * نفسه الذي سيكتب الملف.
 */
export async function uploadPhoto(
  config: AppConfig,
  credentials: MetaCredentials,
  image: Buffer,
): Promise<ProfileResult<{ handle: string }>> {
  if (!credentials.appId) return { ok: false, message: 'لا يوجد معرّف تطبيق (App ID) لهذه المنشأة.' };

  const mime = sniffImage(image);
  if (!mime || !IMAGE_TYPES.has(mime)) return { ok: false, message: 'الصورة يجب أن تكون PNG أو JPG.' };
  if (image.length > MAX_IMAGE_BYTES) return { ok: false, message: 'الصورة أكبر من ٥ ميجابايت.' };

  // ١. فتح الجلسة
  const openUrl =
    `${GRAPH}/${config.cloud.graphVersion}/${credentials.appId}/uploads` +
    `?file_length=${image.length}&file_type=${encodeURIComponent(mime)}` +
    `&access_token=${encodeURIComponent(credentials.accessToken)}`;

  const opened = await fetch(openUrl, { method: 'POST' });
  const openBody = (await opened.json().catch(() => ({}))) as Record<string, unknown>;
  if (!opened.ok || !openBody.id) {
    return { ok: false, message: `تعذّر فتح جلسة الرفع: ${explain(openBody, opened.status)}` };
  }

  // ٢. إرسال البايتات
  const sent = await fetch(`${GRAPH}/${config.cloud.graphVersion}/${String(openBody.id)}`, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${credentials.accessToken}`,
      file_offset: '0',
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(image),
  });

  const sentBody = (await sent.json().catch(() => ({}))) as Record<string, unknown>;
  if (!sent.ok || !sentBody.h) {
    return { ok: false, message: `تعذّر رفع الصورة: ${explain(sentBody, sent.status)}` };
  }

  return { ok: true, message: 'رُفعت الصورة.', data: { handle: String(sentBody.h) } };
}

/** الخطوات الثلاث معاً: رفع الصورة ثم كتابتها في ملف الرقم. */
export async function setPhoto(
  config: AppConfig,
  credentials: MetaCredentials,
  phoneNumberId: string,
  image: Buffer,
): Promise<ProfileResult> {
  const uploaded = await uploadPhoto(config, credentials, image);
  if (!uploaded.ok) return { ok: false, message: uploaded.message };

  const applied = await updateProfile(config, credentials, phoneNumberId, {
    profilePictureHandle: uploaded.data!.handle,
  });
  if (!applied.ok) return { ok: false, message: `رُفعت الصورة لكن تعذّر تثبيتها: ${applied.message}` };

  return { ok: true, message: 'تغيّرت صورة الرقم على واتساب.' };
}
