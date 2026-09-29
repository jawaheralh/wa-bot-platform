/**
 * التحقق بخطوتين.
 *
 * تُقاس الخوارزمية بمتجهات RFC 6238 الرسمية لا بنفسها: تطبيق يوافق
 * نفسه ويخالف المعيار يعطي رموزاً لا يقبلها أي تطبيق مصادقة، ولا
 * يظهر ذلك إلا بعد أن يُقفَل الحساب على صاحبه.
 */

import { describe, it, expect } from 'vitest';
import {
  newSecret,
  verifyCode,
  codeFor,
  toBase32,
  fromBase32,
  otpauthUrl,
  newRecoveryCodes,
  normalizeRecovery,
} from '../src/totp.ts';

/** سرّ RFC 6238 المرجعي: "12345678901234567890" بترميز base32. */
const RFC_SECRET = toBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('مطابقة معيار RFC 6238', () => {
  it('السرّ المرجعي يُرمَّز كما في المعيار', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  /**
   * متجهات المعيار الرسمية لـSHA-1. لو خالفها التطبيق فلن يوافق
   * Google Authenticator ولا غيره.
   */
  const vectors: [seconds: number, code: string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  for (const [seconds, code] of vectors) {
    it(`الثانية ${seconds} ← ${code}`, () => {
      expect(verifyCode(RFC_SECRET, code, seconds * 1000)).toBeDefined();
    });
  }
});

describe('التحقق من الرموز', () => {
  it('الرمز الخاطئ يُرفض', () => {
    expect(verifyCode(RFC_SECRET, '000000', 59_000)).toBeUndefined();
  });

  it('رمز سرّ آخر يُرفض', () => {
    const other = newSecret();
    expect(verifyCode(other, '287082', 59_000)).toBeUndefined();
  });

  it('الرمز القصير أو غير الرقمي يُرفض بلا انهيار', () => {
    expect(verifyCode(RFC_SECRET, '123', 59_000)).toBeUndefined();
    expect(verifyCode(RFC_SECRET, 'abcdef', 59_000)).toBeUndefined();
    expect(verifyCode(RFC_SECRET, '', 59_000)).toBeUndefined();
  });

  it('يقبل انحراف ساعة الجوال ثلاثين ثانية في الاتجاهين', () => {
    // 287082 رمز الثانية ٥٩ — يُقبل أيضاً قبلها وبعدها بفترة.
    expect(verifyCode(RFC_SECRET, '287082', 89_000)).toBeDefined();
    expect(verifyCode(RFC_SECRET, '287082', 29_000)).toBeDefined();
  });

  it('ولا يقبل انحرافاً أوسع — وإلا طالت صلاحية الرمز المسروق', () => {
    expect(verifyCode(RFC_SECRET, '287082', 200_000)).toBeUndefined();
  });

  it('يعيد العدّاد ليُحفَظ فيُمنع استعمال الرمز مرتين', () => {
    const counter = verifyCode(RFC_SECRET, '287082', 59_000);
    expect(counter).toBe(Math.floor(59 / 30));
  });
});

describe('توليد الرمز', () => {
  it('يطابق متجهات المعيار مباشرةً لا بالتخمين', () => {
    expect(codeFor(RFC_SECRET, 59_000)).toBe('287082');
    expect(codeFor(RFC_SECRET, 1111111109_000)).toBe('081804');
    expect(codeFor(RFC_SECRET, 2000000000_000)).toBe('279037');
  });

  it('ما يولّده يقبله التحقق', () => {
    const secret = newSecret();
    expect(verifyCode(secret, codeFor(secret))).toBeDefined();
  });
});

describe('الترميز', () => {
  it('base32 يعود كما كان', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'مرحبا']) {
      const buffer = Buffer.from(text, 'utf8');
      expect(fromBase32(toBase32(buffer))).toEqual(buffer);
    }
  });

  it('يتجاهل المسافات والحروف الصغيرة عند الإدخال اليدوي', () => {
    const spaced = RFC_SECRET.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(fromBase32(spaced)).toEqual(fromBase32(RFC_SECRET));
  });
});

describe('رابط التسجيل', () => {
  it('يحمل السرّ والمصدر بصيغة يقرأها تطبيق المصادقة', () => {
    const url = otpauthUrl(RFC_SECRET, 'noor', 'بوت واتساب');
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain(`secret=${RFC_SECRET}`);
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});

describe('رموز الاسترجاع', () => {
  it('عشرة رموز مختلفة', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('التطبيع يتجاهل الشرطة وحالة الأحرف', () => {
    expect(normalizeRecovery('ab12c-de34f')).toBe(normalizeRecovery('AB12C DE34F'));
  });
});
