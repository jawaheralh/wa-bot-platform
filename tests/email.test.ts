/**
 * قناة البريد.
 *
 * البريد أرخص من واتساب لرسالة الرمز — عشرات الرسائل شهرياً داخل
 * الطبقة المجانية، مقابل محادثةٍ تُحاسِب عليها Meta في كل مرة. فهو
 * المقدَّم حين يكون مضبوطاً.
 *
 * وما يُختبَر هنا الاختيارُ بين القناتين والسقوط من إحداهما إلى
 * الأخرى: مزوّد بريد يرفض الرسالة لا يجوز أن يُسقط الاسترجاع كله —
 * والموظف ينتظر رمزاً لن يصل.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { addStaff } from '../src/staff.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import { sendEmail, emailEnabled, isEmail } from '../src/email.ts';
import type { Db } from '../src/db/index.ts';

const WITH_EMAIL = {
  provider: 'resend',
  apiKey: 'KEY',
  from: 'noreply@example.sa',
  fromName: 'رُدود',
};

let calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];

function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify(body), {
      status,
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

describe('الضبط', () => {
  it('البريد معطّل ما لم يوجد مفتاح ومُرسِل', () => {
    const base = loadConfig();
    expect(emailEnabled(base)).toBe(false);
    expect(emailEnabled({ ...base, email: { ...WITH_EMAIL, apiKey: '' } } as AppConfig)).toBe(false);
    expect(emailEnabled({ ...base, email: { ...WITH_EMAIL, from: '' } } as AppConfig)).toBe(false);
    expect(emailEnabled({ ...base, email: WITH_EMAIL } as AppConfig)).toBe(true);
  });

  it('وفحص العنوان يرفض ما ليس بريداً', () => {
    expect(isEmail('a@b.sa')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isEmail('لا بريد')).toBe(false);
    expect(isEmail('')).toBe(false);
  });
});

describe('المزوّدون', () => {
  const config = { ...loadConfig(), email: WITH_EMAIL } as AppConfig;

  it('Resend ينادى بمفتاحه وصيغته', async () => {
    stubFetch(200, { id: 'x' });
    const result = await sendEmail(config, { to: 'a@b.sa', subject: 'رمز', text: 'الرمز 123456' });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toContain('api.resend.com');
    expect(calls[0]!.headers.authorization).toBe('Bearer KEY');
    expect((calls[0]!.body as { from: string }).from).toContain('noreply@example.sa');
    // نصّ صِرف لا HTML: رسالة سطرين، والـHTML يزيد فرص حجبها.
    expect(calls[0]!.body).not.toHaveProperty('html');
  });

  it('وBrevo بمفتاحه وصيغته هو', async () => {
    stubFetch(201, {});
    const result = await sendEmail({ ...config, email: { ...WITH_EMAIL, provider: 'brevo' } }, {
      to: 'a@b.sa',
      subject: 'رمز',
      text: 'الرمز 123456',
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toContain('api.brevo.com');
    expect(calls[0]!.headers['api-key']).toBe('KEY');
  });

  it('ومزوّد مجهول يُرفض قبل أي نداء', async () => {
    const result = await sendEmail({ ...config, email: { ...WITH_EMAIL, provider: 'لا-أحد' } }, {
      to: 'a@b.sa',
      subject: 'x',
      text: 'y',
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  /** «تعذّر الإرسال» تُبقي من يُعدّ النظام يخمّن؛ وسبب Meta يُصلَح في دقيقة. */
  it('وسبب الرفض يُنقل كما هو', async () => {
    stubFetch(403, { message: 'The domain is not verified' });
    const result = await sendEmail(config, { to: 'a@b.sa', subject: 'x', text: 'y' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not verified');
  });
});

describe('اختيار القناة في الاسترجاع', () => {
  let app: App;
  let server: FastifyInstance;
  let db: Db;
  let provider: SimulatorProvider;

  async function boot(email: AppConfig['email']): Promise<void> {
    db = freshDb();
    const tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;

    addStaff(db, {
      tenantId,
      username: 'kilahuma',
      password: 'kila12345678',
      waNumber: '966551234567',
      email: 'sara@rukn.sa',
      role: 'agent',
    });
    addStaff(db, { tenantId, username: 'bareed', password: 'bareed12345', email: 'b@rukn.sa', role: 'agent' });
    addStaff(db, { tenantId, username: 'jawwal', password: 'jawwal12345', waNumber: '966559990000', role: 'agent' });

    provider = new SimulatorProvider();
    app = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies', email },
      db,
      provider,
      logger: silentLogger(),
    });
    server = await createServer(app);
    await server.ready();
    resetLoginRate();
  }

  const forgot = (username: string) =>
    server.inject({ method: 'POST', url: '/api/forgot', payload: { username } });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('من له الاثنان يصله البريد — فهو الأرخص', async () => {
    stubFetch(200, {});
    await boot(WITH_EMAIL);

    await forgot('kilahuma');
    expect(calls).toHaveLength(1);
    expect(provider.outbox).toHaveLength(0);
  });

  /** مزوّد يرفض لا يجوز أن يُسقط الاسترجاع — الموظف ينتظر رمزاً. */
  it('وفشل البريد يسقط إلى واتساب لا إلى لا شيء', async () => {
    stubFetch(403, { message: 'domain not verified' });
    await boot(WITH_EMAIL);

    await forgot('kilahuma');
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]!.to).toBe('966551234567');
  });

  it('ومن لا رقم له يصله البريد وحده', async () => {
    stubFetch(200, {});
    await boot(WITH_EMAIL);

    await forgot('bareed');
    expect(calls).toHaveLength(1);
    expect(provider.outbox).toHaveLength(0);
  });

  /** البريد قناةٌ إضافية لا بديلة: أكثر الموظفين بلا بريد عمل. */
  it('ومن لا بريد له يصله واتساب', async () => {
    stubFetch(200, {});
    await boot(WITH_EMAIL);

    await forgot('jawwal');
    expect(calls).toHaveLength(0);
    expect(provider.outbox).toHaveLength(1);
  });

  it('وبلا ضبط بريد يبقى واتساب وحده', async () => {
    stubFetch(200, {});
    await boot({ provider: 'resend', apiKey: '', from: '', fromName: '' });

    await forgot('kilahuma');
    expect(calls).toHaveLength(0);
    expect(provider.outbox).toHaveLength(1);
  });

  /** من لا بريد له ولا رقم لا يُنشأ له رمز أصلاً. */
  it('ومن لا سبيل إليه لا يُرسل له شيء', async () => {
    stubFetch(200, {});
    await boot(WITH_EMAIL);
    addStaff(db, { tenantId: 1, username: 'wahid', password: 'wahid1234567', role: 'agent' });

    const response = await forgot('wahid');
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    expect(provider.outbox).toHaveLength(0);
  });
});
