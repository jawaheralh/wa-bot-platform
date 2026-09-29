/**
 * استرجاع كلمة المرور.
 *
 * ## لماذا واتساب لا البريد
 *
 * الطريقة المعتادة في أنظمة SaaS رابطٌ يصل البريد. وهي تحتاج مزوّد
 * بريد، ونطاقاً موثّقاً بسجلات SPF وDKIM، ومتابعةَ وصولٍ مستمرة —
 * وبدونها يقع الرابط في «المهملات» فيتصل العميل رغم الميزة.
 *
 * وهذا النظام يرسل واتساب أصلاً، ولكل مستخدم فيه حقل رقم، وعميله
 * سعودي يقرأ واتساب قبل بريده بساعات. فالرمز يصله حيث هو.
 *
 * ## ما لا يفعله هذا الملف
 *
 * لا يكشف من هو مسجَّل: كل طلب يُجاب بنفس الردّ سواء وُجد الحساب أم
 * لا. نموذجٌ يقول «لا يوجد مستخدم بهذا الاسم» يصير أداةً لجرد أسماء
 * المستخدمين عند من يجرّب.
 */

import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { SQL_NOW, now } from './time.ts';
import type { Db, UserRow } from './db/index.ts';

/** عشر دقائق: تكفي لفتح واتساب، ولا تكفي لتسريب رمز نائم. */
export const TTL_MINUTES = 10;
/** خمس محاولات للرمز الواحد. بعدها يُبطل — لا يُقفل الحساب. */
export const MAX_ATTEMPTS = 5;
const ROUNDS = 10;

export interface ResetRequest {
  /** يُعاد للاختبار وللإرسال — ولا يُخزَّن ولا يُسجَّل. */
  code: string;
  user: UserRow;
}

function sixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * ينشئ رمزاً جديداً ويُبطل ما قبله.
 *
 * الإبطال مقصود: ترك الرموز السابقة صالحة يعني أن من طلب خمس مرات
 * صار عنده خمسة مفاتيح تعمل، وكلٌّ منها رسالة قد تُقرأ من شاشة مقفلة.
 */
export function createReset(db: Db, user: UserRow): ResetRequest {
  const code = sixDigits();

  db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(
    now(),
    user.id,
  );

  db.prepare(
    `INSERT INTO password_resets (user_id, code_hash, expires_at)
     VALUES (?, ?, datetime(${SQL_NOW}, '+${TTL_MINUTES} minutes'))`,
  ).run(user.id, bcrypt.hashSync(code, ROUNDS));

  return { code, user };
}

interface ResetRow {
  id: number;
  user_id: number;
  code_hash: string;
  attempts: number;
}

export interface ResetOutcome {
  ok: boolean;
  message: string;
  userId?: number;
}

/**
 * يتحقق من الرمز ويستهلكه.
 *
 * الرسالة واحدة لكل أسباب الفشل — رمزٌ خاطئ ومنتهٍ ومستهلَك سواء.
 * التفريق بينها يخبر من يجرّب أيَّ نصف أصاب.
 */
export function consumeReset(db: Db, userId: number, code: string): ResetOutcome {
  const bad = { ok: false, message: 'الرمز غير صحيح أو انتهت صلاحيته.' };

  const row = db
    .prepare(
      `SELECT id, user_id, code_hash, attempts FROM password_resets
       WHERE user_id = ? AND used_at IS NULL AND expires_at > ${SQL_NOW}
       ORDER BY id DESC LIMIT 1`,
    )
    .get(userId) as ResetRow | undefined;

  if (!row) return bad;

  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), row.id);
    return { ok: false, message: 'جُرّب الرمز مرات كثيرة. اطلب رمزاً جديداً.' };
  }

  if (!bcrypt.compareSync(code.trim(), row.code_hash)) {
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return bad;
  }

  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), row.id);
  return { ok: true, message: 'تم التحقق.', userId: row.user_id };
}

/** رموز المستخدم كلها تُبطل — تُستدعى بعد أي تغيير ناجح لكلمة المرور. */
export function invalidateAll(db: Db, userId: number): void {
  db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(
    now(),
    userId,
  );
}

/* ---------------------------------------------------------------
   نصّ الرسالة
--------------------------------------------------------------- */

/**
 * الرسالة تقول ما يفعله الرمز وما يفعله من لم يطلبه.
 *
 * «رمزك: ١٢٣٤٥٦» وحدها تُقرأ كرسالة احتيال. وذكر اسم النظام ومدة
 * الصلاحية وسطرِ «إن لم تطلبه فتجاهلها» يجعلها مفهومة لمن يقرؤها على
 * عجل — وهي تُقرأ دائماً على عجل.
 */
export function resetMessage(code: string, brand: string): string {
  return (
    `رمز استرجاع كلمة المرور في «${brand}»: ${code}\n` +
    `صالح ${TTL_MINUTES} دقائق ولمرة واحدة.\n` +
    `إن لم تطلبه فتجاهل هذه الرسالة ولا تشاركه مع أحد.`
  );
}
