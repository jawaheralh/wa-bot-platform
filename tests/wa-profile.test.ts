/**
 * ملفّ واتساب للأعمال.
 *
 * ما يُختبَر هنا ترتيبُ الخطوات لا نجاحُها: رفع الصورة ثلاث نداءات
 * متسلسلة، وخطأ في الثانية يعني صورةً رُفعت ولم تُثبَّت — وهي حالة
 * تحتاج رسالة تقول ذلك لا «فشل».
 *
 * وMeta لا تُستدعى في الاختبار: نداء حقيقي هنا يغيّر صورة رقم شركة
 * أمام عملائها.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  readProfile,
  updateProfile,
  setPhoto,
  uploadPhoto,
  validateProfile,
  sniffImage,
} from '../src/wa-profile.ts';
import type { MetaCredentials } from '../src/tenant-meta.ts';

const config = loadConfig();
const creds: MetaCredentials = {
  accessToken: 'TOKEN',
  appSecret: 'SECRET',
  appId: '111',
  businessId: '222',
  own: true,
};

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(64)]);

/** نداءات مسجَّلة: الترتيب هو المُختبَر. */
let calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];

function stub(replies: { status: number; body: unknown }[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const reply = replies[Math.min(index, replies.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('القراءة', () => {
  it('تفكّ الملف من داخل مصفوفة data', async () => {
    stub([
      {
        status: 200,
        body: {
          data: [
            {
              about: 'نخدمكم ٢٤ ساعة',
              description: 'محطات وقود',
              profile_picture_url: 'https://example/pic.jpg',
              websites: ['https://waqodi.sa'],
              vertical: 'AUTO',
            },
          ],
        },
      },
    ]);

    const result = await readProfile(config, creds, '999');
    expect(result.ok).toBe(true);
    expect(result.data?.about).toBe('نخدمكم ٢٤ ساعة');
    expect(result.data?.profilePictureUrl).toBe('https://example/pic.jpg');
    expect(result.data?.websites).toEqual(['https://waqodi.sa']);
  });

  it('وبلا معرّف رقم لا تُستدعى Meta أصلاً', async () => {
    stub([{ status: 200, body: {} }]);
    const result = await readProfile(config, creds, '');
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  /** رسالة Meta عن الصلاحية غامضة، والمالك لا يعرف ما «‎#200‎». */
  it('ونقص الصلاحية يُترجَم لا يُنقَل كما هو', async () => {
    stub([{ status: 403, body: { error: { message: '(#200) Permissions error' } } }]);
    const result = await readProfile(config, creds, '999');
    expect(result.message).toContain('whatsapp_business_management');
  });
});

describe('التحقق قبل الإرسال', () => {
  it('الحدود تُفحص هنا لا عند Meta', () => {
    expect(validateProfile({ about: 'ا'.repeat(140) })).toContain('about');
    expect(validateProfile({ email: 'لا بريد' })).toContain('البريد');
    expect(validateProfile({ websites: ['waqodi.sa'] })).toContain('http');
    expect(validateProfile({ websites: ['https://a.sa', 'https://b.sa', 'https://c.sa'] })).toContain('موقعان');
    expect(validateProfile({ vertical: 'NOPE' })).toContain('مجال');
  });

  it('والصحيح يمرّ', () => {
    expect(
      validateProfile({ about: 'نخدمكم', email: 'a@b.sa', websites: ['https://waqodi.sa'], vertical: 'AUTO' }),
    ).toBeNull();
  });

  it('والمرفوض لا يصل Meta', async () => {
    stub([{ status: 200, body: { success: true } }]);
    const result = await updateProfile(config, creds, '999', { email: 'غلط' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('صورة الرقم', () => {
  it('ترفض ما ليس PNG ولا JPG قبل أي نداء', async () => {
    stub([{ status: 200, body: {} }]);
    const result = await uploadPhoto(config, creds, Buffer.from('GIF89a...'));
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('وتقبل PNG وJPG', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPG)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('<svg'))).toBeNull();
  });

  /** الترتيب: جلسة رفع ← بايتات ← تثبيت المقبض على الرقم. */
  it('والرفع ثلاث خطوات بالترتيب', async () => {
    stub([
      { status: 200, body: { id: 'upload:SESSION' } },
      { status: 200, body: { h: 'HANDLE-1' } },
      { status: 200, body: { success: true } },
    ]);

    const result = await setPhoto(config, creds, '999', PNG);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);

    expect(calls[0]!.url).toContain('/111/uploads');
    expect(calls[0]!.url).toContain(`file_length=${PNG.length}`);

    expect(calls[1]!.url).toContain('upload:SESSION');
    expect(calls[1]!.headers.file_offset).toBe('0');

    expect(calls[2]!.url).toContain('/999/whatsapp_business_profile');
    expect(String(calls[2]!.body)).toContain('HANDLE-1');
  });

  /**
   * صورةٌ رُفعت ولم تُثبَّت ليست «فشلاً» فحسب.
   *
   * من يقرأ «تعذّر» يعيد المحاولة ظاناً أن شيئاً لم يحدث، والحقيقة أن
   * الرفع تمّ والخلل في الخطوة الأخيرة — غالباً صلاحية ناقصة، وإعادة
   * الرفع لن تصلحها.
   */
  it('وفشل التثبيت بعد الرفع يُقال كما هو', async () => {
    stub([
      { status: 200, body: { id: 'upload:SESSION' } },
      { status: 200, body: { h: 'HANDLE-1' } },
      { status: 403, body: { error: { message: '(#200) Permissions error' } } },
    ]);

    const result = await setPhoto(config, creds, '999', PNG);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('رُفعت الصورة لكن تعذّر تثبيتها');
    expect(result.message).toContain('whatsapp_business_management');
  });

  it('وفشل فتح الجلسة يوقف السلسلة عند نداء واحد', async () => {
    stub([{ status: 400, body: { error: { message: 'bad app id' } } }]);
    const result = await setPhoto(config, creds, '999', PNG);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('جلسة الرفع');
    expect(calls).toHaveLength(1);
  });
});
