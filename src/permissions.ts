/**
 * صلاحيات الموظفين.
 *
 * الدور وحده لا يكفي حين يكبر الفريق: مطعم فيه ستة موظفين لا يريد
 * كلَّ من يرد على العملاء قادراً على إيقاف البوت، ولا على إرسال قوالب
 * تُحسب عليه بالرسالة، ولا على تعديل ما يقوله البوت لكل عميل.
 *
 * ولذلك المفاتيح قليلة ومختارة: كل مفتاح هنا هو فعلٌ **يندم عليه**
 * المالك إن فعله من لا يملكه — لا كل زر في اللوحة. الصلاحية التي لا
 * يُتصوَّر منعها تزيد شاشة الإعداد ولا تزيد أماناً.
 *
 * والمالك يملك الكل دائماً ولا تُعرض له خانات: مالكٌ يمنع نفسه من
 * قاعدة المعرفة ثم يتصل يسأل لماذا اختفت.
 */

import type { Role } from './staff.ts';

export interface PermissionInfo {
  key: string;
  label: string;
  hint: string;
  /** هل تُمنح للموظف الجديد افتراضياً؟ */
  byDefault: boolean;
}

/**
 * الافتراضات هي سلوك النظام قبل وجود الصلاحيات بالضبط.
 *
 * موظفٌ قائم اليوم يستطيع الرد والإسناد وإيقاف البوت وتغيير حالة
 * الشكوى والإرسال بقالب. فلو بدأت الافتراضات بأقل من ذلك لفقد كل
 * موظف في كل منشأة قدرةً كان يملكها صباح أمس.
 */
export const PERMISSIONS: PermissionInfo[] = [
  {
    key: 'reply',
    label: 'الرد على العملاء',
    hint: 'كتابة رد يدوي في المحادثة. بدونها يقرأ ولا يكتب.',
    byDefault: true,
  },
  {
    key: 'assign',
    label: 'إسناد المحادثات',
    hint: 'تحويل محادثة إلى موظف آخر أو رفع الإسناد.',
    byDefault: true,
  },
  {
    key: 'bot',
    label: 'إيقاف البوت وتشغيله',
    hint: 'إيقافه في محادثة بعينها. الموقوف لا يرد على العميل حتى يُعاد.',
    byDefault: true,
  },
  {
    key: 'cases',
    label: 'تغيير حالة الشكاوى والطلبات',
    hint: 'إغلاق الشكوى أو نقلها بين الحالات — ويصل العميل إشعار بكل تغيير.',
    byDefault: true,
  },
  {
    key: 'templates',
    label: 'الإرسال بقالب معتمد',
    hint: 'مراسلة من لم يراسلنا أو من انقضت نافذته. كل رسالة بتكلفة على المنشأة.',
    byDefault: true,
  },
  {
    key: 'knowledge',
    label: 'تعديل قاعدة المعرفة وتدريب البوت',
    hint: 'ما يُكتب هنا يقوله البوت لكل عميل. تُمنح لمن يُوثق بصياغته.',
    byDefault: false,
  },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const DEFAULT_AGENT = PERMISSIONS.filter((p) => p.byDefault).map((p) => p.key);

export interface PermissionHolder {
  role: Role;
  permissions?: string | null;
}

/**
 * صلاحيات مستخدم بعينه.
 *
 * `null` تعني «لم تُخصَّص بعد» لا «بلا صلاحيات»: الموظفون المسجَّلون
 * قبل هذه الميزة عمودهم فارغ، ولو قُرئ الفراغ منعاً لتوقّف عملهم كله
 * لحظة التحديث.
 */
export function permissionsOf(user: PermissionHolder): string[] {
  if (user.role === 'system' || user.role === 'tenant') return [...PERMISSION_KEYS];
  if (user.permissions === null || user.permissions === undefined) return [...DEFAULT_AGENT];

  try {
    const parsed = JSON.parse(user.permissions) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_AGENT];
    return parsed.filter((key): key is string => typeof key === 'string' && PERMISSION_KEYS.includes(key));
  } catch {
    // صفٌّ تالف لا يمنح صلاحيات ولا يُسقطها كلها — يعود للافتراضي.
    return [...DEFAULT_AGENT];
  }
}

export function can(user: PermissionHolder, key: string): boolean {
  return permissionsOf(user).includes(key);
}

/** يحوّل ما يصل من الواجهة إلى نصّ يُحفظ. الفارغ يعني «بلا صلاحيات». */
export function normalizePermissions(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) return null;
  const clean = [...new Set(input.filter((k): k is string => typeof k === 'string'))].filter((k) =>
    PERMISSION_KEYS.includes(k),
  );
  return JSON.stringify(clean);
}
