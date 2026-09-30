/**
 * الإرسال بقالب — والتنبيه حين يتعذّر الإبلاغ.
 *
 * القالب هو السبيل الوحيد لمراسلة رقم لم يراسلنا. وخطره أن يُرسل
 * بمتغيّرات ناقصة: Meta ترفضه، أو — أسوأ — يصل العميل نص فيه
 * {{1}} باسم المنشأة.
 *
 * والتنبيه يمسك عطلاً أصمت: طلب أُنجز وتعذّر إبلاغ صاحبه، فيبقى
 * منتظراً وتظنّ المنشأة أنه أُبلغ.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import { getOrCreateConversation, recentMessages, type Db } from '../src/db/index.ts';
import { CloudApiProvider } from '../src/whatsapp/cloud-api.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let tenantId = 0;
let owner = '';

const APP_SECRET = 'a'.repeat(32);

function cloudConfig() {
  return {
    ...loadConfig(),
    provider: 'cloud' as const,
    sessionSecret: 'test-secret-for-cookies',
    cloud: {
      verifyToken: 'v',
      appSecret: APP_SECRET,
      accessToken: 'token',
      graphVersion: 'v23.0',
      appId: 'APP',
      businessId: 'BIZ',
    },
  };
}

beforeEach(async () => {
  db = freshDb();
  const tenant = seedTenant(db, { name: 'وقودي', waNumber: '966500000001', waPhoneNumberId: 'PN1' });
  tenantId = tenant.id;
  db.prepare('UPDATE tenants SET wa_access_token=?, wa_app_secret=?, wa_business_id=? WHERE id=?').run(
    'token',
    APP_SECRET,
    'BIZ',
    tenant.id,
  );
  createUser(db, { tenantId: tenant.id, username: 'owner', password: 'owner12345', role: 'tenant' });

  const provider = new CloudApiProvider(db, cloudConfig(), silentLogger());
  app = await buildApp({ config: cloudConfig(), db, provider, logger: silentLogger() });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  const login = await server.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: 'owner12345' },
  });
  owner = String(login.headers['set-cookie']).split(';')[0]!;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  db.close();
});

function metaTemplates(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          name: 'request_done',
          language: 'ar',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'مرحباً {{1}}، طلبك {{2}} أُنجز.' }],
        },
        {
          name: 'not_ready',
          language: 'ar',
          status: 'PENDING',
          category: 'MARKETING',
          components: [{ type: 'BODY', text: 'عرض' }],
        },
      ],
    }),
    { status: 200 },
  );
}

/**
 * القوالب حافّة على حساب واتساب للأعمال لا على النشاط التجاري، فكل
 * قراءة تسبقها استعلامة اشتقاق. وردٌّ واحد لكل النداءات يجعل الاشتقاق
 * يقرأ قائمة القوالب فلا يجد فيها معرّفاً.
 */
function metaWithWaba() {
  return async (url: string | URL | Request) =>
    String(url).includes('owned_whatsapp_business_accounts')
      ? new Response(JSON.stringify({ data: [{ id: 'WABA-1', name: 'منشأة' }] }), { status: 200 })
      : metaTemplates();
}

describe('قائمة القوالب', () => {
  it('المعتمد وحده يُعرض — والمعلّق يُخفى', async () => {
    vi.stubGlobal('fetch', metaWithWaba());

    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${tenantId}/templates`,
      headers: { cookie: owner },
    });

    expect(response.statusCode).toBe(200);
    const templates = response.json().templates as { name: string; variables: number }[];
    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBe('request_done');
  });

  it('وعدد المتغيّرات يُستخرج من المتن', async () => {
    vi.stubGlobal('fetch', metaWithWaba());
    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${tenantId}/templates`,
      headers: { cookie: owner },
    });
    expect(response.json().templates[0].variables).toBe(2);
  });
});

describe('الإرسال بقالب', () => {
  it('يُرسل لرقم لم يراسلنا وتُنشأ له محادثة', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 });
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/templates/send`,
      headers: { cookie: owner },
      payload: { to: '0551234567', name: 'request_done', language: 'ar', variables: ['محمد', 'TLB-1'] },
    });

    expect(response.statusCode).toBe(200);

    const sent = calls[0] as { type: string; template: { name: string; components: unknown[] } };
    expect(sent.type).toBe('template');
    expect(sent.template.name).toBe('request_done');

    // الرقم المحلي صار دولياً قبل أن يغادر — وإلا لم يصل أو وصل غيره
    expect((sent as unknown as { to: string }).to).toBe('966551234567');

    // وحُفظت في محادثة العميل باسم الموظفة
    const conversation = getOrCreateConversation(db, tenantId, '966551234567');
    const messages = recentMessages(db, conversation.id, 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('staff');
    expect(messages[0]!.body).toContain('request_done');
  });

  /** متغيّر ناقص يعني نصاً فيه {{1}} يصل العميل باسم المنشأة. */
  it('متغيّر فارغ يُرفض قبل أن يغادر النظام', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/templates/send`,
      headers: { cookie: owner },
      payload: { to: '0551234567', name: 'request_done', variables: ['محمد', ''] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('متغيّرات');
    expect(called).toBe(false);
  });

  it('وبلا رقم أو بلا قالب يُرفض', async () => {
    for (const payload of [{ name: 'x' }, { to: '0551234567' }]) {
      const response = await server.inject({
        method: 'POST',
        url: `/api/tenants/${tenantId}/templates/send`,
        headers: { cookie: owner },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('الصلاحية', () => {
  it('بلا جلسة يُرفض', async () => {
    const response = await server.inject({ method: 'GET', url: `/api/tenants/${tenantId}/templates` });
    expect(response.statusCode).toBe(401);
  });

  it('ومنشأة أخرى تُرفض', async () => {
    const other = seedTenant(db, { name: 'جيران', waNumber: '966500000002' });
    const response = await server.inject({
      method: 'POST',
      url: `/api/tenants/${other.id}/templates/send`,
      headers: { cookie: owner },
      payload: { to: '0551234567', name: 'x' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('المزوّد الذي لا يدعم القوالب', () => {
  it('يقول ذلك صراحةً بدل أن يصمت', async () => {
    const plain = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', sessionSecret: 's' },
      db,
      provider: new SimulatorProvider(),
      logger: silentLogger(),
    });
    const plainServer = await createServer(plain);
    await plainServer.ready();
    resetLoginRate();

    const login = await plainServer.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'owner12345' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const response = await plainServer.inject({
      method: 'GET',
      url: `/api/tenants/${tenantId}/templates`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('لا يدعم القوالب');
    await plainServer.close();
  });
});

describe('صيغة الرقم', () => {
  it('المحلي يصير دولياً، والدولي يبقى كما هو', async () => {
    const { toInternational } = await import('../src/db/index.ts');

    expect(toInternational('0551234567')).toBe('966551234567');
    expect(toInternational('٠٥٥١٢٣٤٥٦٧'.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))).toBe('966551234567');
    expect(toInternational('551234567')).toBe('966551234567');
    expect(toInternational('966551234567')).toBe('966551234567');
    expect(toInternational('+966 55 123 4567')).toBe('966551234567');
    expect(toInternational('00966551234567')).toBe('966551234567');
    expect(toInternational('')).toBe('');
  });
});
