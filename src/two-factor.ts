/**
 * إدارة التحقق بخطوتين لكل مستخدم.
 *
 * الفصل عن totp.ts مقصود: هناك الخوارزمية المجرّدة، وهنا قواعد
 * النظام — متى يُفعَّل، وكيف يُمنع استعمال الرمز مرتين، وما حكم
 * رمز الاسترجاع المستهلَك.
 */

import { hashPassword, verifyPassword } from './tenants.ts';
import { newSecret, verifyCode, newRecoveryCodes, normalizeRecovery, otpauthUrl } from './totp.ts';
import type { Db, UserRow } from './db/index.ts';

export const ISSUER = 'بوت واتساب';

export interface SetupInfo {
  secret: string;
  otpauth: string;
}

function userById(db: Db, userId: number): UserRow {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) throw Object.assign(new Error('لا يوجد هذا المستخدم.'), { statusCode: 404 });
  return user;
}

/**
 * يبدأ الإعداد: سرّ جديد يُحفظ غير مفعَّل.
 *
 * لا يُفعَّل إلا بعد أن يثبت المستخدم أنه أدخله في تطبيقه فعلاً —
 * وإلا قفلنا الحساب على صاحبه بسرّ لا يملكه.
 */
export function startSetup(db: Db, userId: number): SetupInfo {
  const user = userById(db, userId);
  if (user.totp_enabled === 1) {
    throw Object.assign(new Error('التحقق بخطوتين مفعّل أصلاً.'), { statusCode: 400 });
  }

  const secret = newSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, userId);
  return { secret, otpauth: otpauthUrl(secret, user.username, ISSUER) };
}

/** يُفعّل بعد التحقق من رمز حقيقي، ويعيد رموز الاسترجاع مرة واحدة. */
export function confirmSetup(db: Db, userId: number, code: string): string[] {
  const user = userById(db, userId);
  if (!user.totp_secret) {
    throw Object.assign(new Error('لم يبدأ الإعداد بعد.'), { statusCode: 400 });
  }

  const counter = verifyCode(user.totp_secret, code);
  if (counter === undefined) {
    throw Object.assign(new Error('الرمز غير صحيح — يلزم التأكد من وقت الجوال.'), { statusCode: 401 });
  }

  const codes = newRecoveryCodes();
  const hashes = codes.map((c) => hashPassword(normalizeRecovery(c)));

  db.prepare(
    'UPDATE users SET totp_enabled = 1, totp_last_counter = ?, recovery_hashes = ? WHERE id = ?',
  ).run(counter, JSON.stringify(hashes), userId);

  return codes;
}

/**
 * يتحقق عند الدخول — من رمز التطبيق أو من رمز استرجاع.
 *
 * منع إعادة الاستعمال هو جوهر الفائدة: بدونه يكفي أن يُرى الرمز
 * على الشاشة ليُستعمل خلال نصف دقيقة من جهاز آخر.
 */
export function verifyLogin(db: Db, user: UserRow, code: string): void {
  const invalid = Object.assign(new Error('رمز التحقق غير صحيح.'), { statusCode: 401 });
  if (!user.totp_secret || user.totp_enabled !== 1) throw invalid;

  const counter = verifyCode(user.totp_secret, code);
  if (counter !== undefined) {
    if (user.totp_last_counter !== null && counter <= user.totp_last_counter) {
      throw Object.assign(
        new Error('هذا الرمز استُعمل — الرمز التالي بعد قليل.'),
        { statusCode: 401 },
      );
    }
    db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, user.id);
    return;
  }

  // ليس رمز تطبيق — فلعلّه رمز استرجاع لجوال ضائع.
  const hashes: string[] = user.recovery_hashes ? JSON.parse(user.recovery_hashes) : [];
  const entered = normalizeRecovery(code);
  const index = hashes.findIndex((h) => verifyPassword(entered, h));
  if (index < 0) throw invalid;

  // يُستهلك فوراً: رمز استرجاع يُقبل مرتين ليس رمز استرجاع.
  hashes.splice(index, 1);
  db.prepare('UPDATE users SET recovery_hashes = ? WHERE id = ?').run(JSON.stringify(hashes), user.id);
}

/** التعطيل يتطلّب كلمة المرور: جهاز مفتوح لا يكفي لنزع الحماية. */
export function disable(db: Db, userId: number, password: string): void {
  const user = userById(db, userId);
  if (!verifyPassword(password, user.password_hash)) {
    throw Object.assign(new Error('كلمة المرور غير صحيحة.'), { statusCode: 401 });
  }
  db.prepare(
    'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_counter = NULL, recovery_hashes = NULL WHERE id = ?',
  ).run(userId);
}

export function status(db: Db, userId: number): { enabled: boolean; recoveryLeft: number } {
  const user = userById(db, userId);
  const hashes: string[] = user.recovery_hashes ? JSON.parse(user.recovery_hashes) : [];
  return { enabled: user.totp_enabled === 1, recoveryLeft: hashes.length };
}
