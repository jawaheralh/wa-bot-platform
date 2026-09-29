/**
 * التحقق بخطوتين (TOTP — RFC 6238).
 *
 * مبنيّ على node:crypto بلا مكتبة خارجية: الخوارزمية أربعون سطراً،
 * وإضافة تبعية في قلب المصادقة تعني أن من يخترق تلك التبعية يوماً
 * يملك مفاتيح كل المنشآت. ما نكتبه هنا نقرؤه ونختبره.
 *
 * يعمل مع Google Authenticator و Microsoft Authenticator وAuthy وغيرها:
 * كلها تتبع نفس المعيار — SHA-1، ستة أرقام، نافذة ثلاثين ثانية.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const PERIOD = 30;
/** قبول الرمز السابق والتالي: ساعة الجوال تتقدّم أو تتأخر ثوانيَ عادةً. */
const DRIFT = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** سرّ جديد — ١٦٠ بتاً كما توصي RFC 4226. */
export function newSecret(): string {
  return toBase32(randomBytes(20));
}

function codeAt(secret: string, counter: number): string {
  const key = fromBase32(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(buffer).digest();
  // الاقتطاع الديناميكي: آخر نصف بايت يحدّد موضع القراءة.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * الرمز الحالي لسرّ معيّن — ما يعرضه تطبيق المصادقة هذه اللحظة.
 *
 * يخدم الاختبارات ولوحة الإعداد. توليده مباشرةً لا تخميناً: تجريب
 * مليون احتمال يستغرق ثوانيَ تعبر فيها نافذة الثلاثين ثانية، فيصير
 * الاختبار متقلّباً ينجح مرة ويسقط مرة بلا تغيّر في الشيفرة.
 */
export function codeFor(secret: string, now = Date.now()): string {
  return codeAt(secret, Math.floor(now / 1000 / PERIOD));
}

/**
 * يتحقق من الرمز ويعيد العدّاد الذي قَبِله.
 *
 * إعادة العدّاد ليست ترفاً: حفظه يمنع إعادة استعمال نفس الرمز خلال
 * ثلاثين ثانية — وهي نافذة كافية لمن يقرأ الرمز من فوق كتف صاحبه.
 */
export function verifyCode(secret: string, code: string, now = Date.now()): number | undefined {
  const clean = String(code).replace(/\D/g, '');
  if (clean.length !== DIGITS) return undefined;

  const counter = Math.floor(now / 1000 / PERIOD);
  for (let step = -DRIFT; step <= DRIFT; step += 1) {
    // عدّاد سالب يرمي استثناءً من writeBigUInt64BE فيسقط الطلب بـ٥٠٠
    // بدل رفضٍ نظيف. لا يقع إلا قرب بداية الحقبة — وفي الاختبارات.
    if (counter + step < 0) continue;
    const expected = codeAt(secret, counter + step);
    // مقارنة ثابتة الزمن: المقارنة العادية تُسرّب الرمز حرفاً حرفاً
    // لمن يقيس زمن الرد.
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return counter + step;
  }
  return undefined;
}

/** رابط التسجيل الذي يقرأه تطبيق المصادقة من رمز QR أو يُدخَل يدوياً. */
export function otpauthUrl(secret: string, username: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ---------------------------------------------------------------
   رموز الاسترجاع
--------------------------------------------------------------- */

/**
 * جوال ضائع بلا رموز استرجاع يعني حساباً ضائعاً إلى الأبد.
 * عشرة رموز، كلٌّ يُستعمل مرة واحدة، تُحفظ مُجزّأة لا نصاً.
 */
export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function normalizeRecovery(code: string): string {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
