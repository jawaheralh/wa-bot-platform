/**
 * إعداد كل منشأة على حدة.
 *
 * العطل الذي يمسكه هذا الملف ظهر فعلاً: يُفتح «مطعم الركن» فتُعرض
 * إعدادات «وقودي». لا رسالة خطأ ولا شيء مكسور — فيُظنّ المطعم مضبوطاً
 * وهو لم يُربط، ولا يُكتشف ذلك إلا حين لا يرد بوته على عميل.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import type { Db } from '../src/db/index.ts';

const WAQODI = { token: 'WAQODI_TOKEN_SECRET', secret: 'a'.repeat(32), app: 'APP_WAQODI' };

let app: App;
let server: FastifyInstance;
let db: Db;
let waqodi = 0;
let matam = 0;
let root = '';

async function call(url: string, cookie = root) {
  const response = await server.inject({ method: 'GET', url, headers: { cookie } });
  let body: Record<string, unknown> = {};
  try {
    body = response.json();
  } catch {
    // ردود بلا جسم
  }
  return { status: response.statusCode, body };
}

beforeAll(async () => {
  db = freshDb();

  const a = seedTenant(db, { name: 'وقودي', waNumber: '966920014643', waPhoneNumberId: 'PN_WAQODI' });
  const b = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' });
  waqodi = a.id;
  matam = b.id;

  // وقودي وحدها لها حساب Meta ومفتاح Claude
  db.prepare(
    'UPDATE tenants SET wa_access_token=?, wa_app_secret=?, wa_app_id=?, anthropic_api_key=? WHERE id=?',
  ).run(WAQODI.token, WAQODI.secret, WAQODI.app, 'sk-ant-waqodi-key', a.id);

  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });

  // لا شبكة: أي فحص لدى Meta يُردّ عليه محلياً.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'لا شبكة' } }), { status: 400 }));

  app = await buildApp({
    config: {
      ...loadConfig(),
      provider: 'simulator',
      sessionSecret: 'test-secret-for-cookies',
      sharedMetaFallback: false,
      anthropicApiKey: 'sk-ant-global',
    },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  const login = await server.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'root', password: 'root123456' },
  });
  root = String(login.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await server.close();
  db.close();
});

describe('كل منشأة ترى إعدادها هي', () => {
  it('إعداد وقودي يحمل اسمها ورقمها', async () => {
    const { status, body } = await call(`/api/system/tenants/${waqodi}/setup`);
    expect(status).toBe(200);
    expect((body.tenant as { name: string }).name).toBe('وقودي');
    expect((body.tenant as { waNumber: string }).waNumber).toBe('966920014643');
    expect(body.own).toBe(true);
  });

  it('إعداد المطعم يحمل اسمه هو — لا اسم وقودي', async () => {
    const { body } = await call(`/api/system/tenants/${matam}/setup`);
    expect((body.tenant as { name: string }).name).toBe('مطعم الركن');
    expect((body.tenant as { waNumber: string }).waNumber).toBe('966500000002');
  });

  /** جوهر العطل: بيانات وقودي لا تظهر في شاشة المطعم بأي صورة. */
  it('ولا يتسرّب توكن وقودي إلى شاشة المطعم', async () => {
    const { body } = await call(`/api/system/tenants/${matam}/setup`);
    const asText = JSON.stringify(body);

    expect(body.own).toBe(false);
    expect(asText).not.toContain(WAQODI.token);
    expect(asText).not.toContain(WAQODI.app);
    expect((body.secrets as { waAccessToken: string }).waAccessToken).toBe('');
  });

  it('والمطعم يُعلَن صراحةً أنه لم يُربط بعد', async () => {
    const { body } = await call(`/api/system/tenants/${matam}/setup`);
    const checks = body.checks as { key: string; ok: boolean; message: string }[];
    const credentials = checks.find((c) => c.key === 'credentials')!;

    expect(credentials.ok).toBe(false);
    expect(credentials.message).toContain('لم تُدخَل');
  });
});

describe('الأسرار محجوبة', () => {
  it('التوكن يُعرض مقطوعاً لا كاملاً', async () => {
    const { body } = await call(`/api/system/tenants/${waqodi}/setup`);
    const shown = (body.secrets as { waAccessToken: string }).waAccessToken;

    expect(shown).toContain('…');
    expect(shown).not.toBe(WAQODI.token);
    expect(shown.length).toBeLessThan(WAQODI.token.length);
  });
});

describe('مفتاح Claude', () => {
  it('وقودي بمفتاح خاص — مصروفها منفصل', async () => {
    const { body } = await call(`/api/system/tenants/${waqodi}/setup`);
    expect(body.ownClaude).toBe(true);
    const claude = (body.checks as { key: string; message: string }[]).find((c) => c.key === 'claude')!;
    expect(claude.message).toContain('منفصل');
  });

  it('والمطعم على المفتاح العام — يُقال له ذلك صراحةً', async () => {
    const { body } = await call(`/api/system/tenants/${matam}/setup`);
    expect(body.ownClaude).toBe(false);
    const claude = (body.checks as { key: string; message: string }[]).find((c) => c.key === 'claude')!;
    expect(claude.message).toContain('حسابك');
  });
});

describe('الصلاحية', () => {
  it('لا يصلها إلا أدمن النظام', async () => {
    const { status } = await call(`/api/system/tenants/${waqodi}/setup`, '');
    expect(status).toBe(401);
  });

  it('منشأة غير موجودة تُرفض بـ٤٠٤', async () => {
    const { status } = await call('/api/system/tenants/9999/setup');
    expect(status).toBe(404);
  });
});

describe('ربط webhook لمنشأة بعينها', () => {
  it('يُرفض قبل إدخال بياناتها', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/system/tenants/${matam}/configure-webhook`,
      headers: { cookie: root },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('أدخلي توكن المنشأة');
  });
});
