/**
 * زر حذف بيانات التجربة.
 *
 * الخطر هنا ليس أن يعجز الزر عن الحذف — بل أن يحذف أكثر مما وُسم.
 * محادثة عميل حقيقي تُمحى بضغطة لا تُسترجع، ولا يُكتشف ذلك إلا حين
 * يسأل العميل عن طلب لم يعد له أثر.
 *
 * فكل وصف هنا يتحقق من الطرفين معاً: أن الموسوم يُحذف، وأن ما عداه
 * باقٍ — عدداً وصفاً.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import { getOrCreateConversation, saveMessage, type Db } from '../src/db/index.ts';
import { summarizeTestData, deleteTestData, markConversation } from '../src/test-data.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let tenantId = 0;
let root = '';
let owner = '';
let realId = 0;
let testId = 0;

const REAL_TEXT = 'طلب عميل حقيقي لا يجوز أن يُمَسّ';

async function login(username: string, password: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

function counts(): { conversations: number; messages: number; requests: number } {
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    conversations: n('SELECT COUNT(*) n FROM conversations'),
    messages: n('SELECT COUNT(*) n FROM messages'),
    requests: n('SELECT COUNT(*) n FROM requests'),
  };
}

beforeEach(async () => {
  db = freshDb();
  const tenant = seedTenant(db, { name: 'وقودي', waNumber: '966500000001' });
  tenantId = tenant.id;

  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });
  createUser(db, { tenantId: tenant.id, username: 'owner', password: 'owner12345', role: 'tenant' });

  const real = getOrCreateConversation(db, tenant.id, '966501052903', 'عميل حقيقي');
  realId = real.id;
  saveMessage(db, real.id, 'customer', REAL_TEXT);
  saveMessage(db, real.id, 'bot', 'أبشر');

  const test = getOrCreateConversation(db, tenant.id, '966555000111', 'تجربة');
  testId = test.id;
  saveMessage(db, test.id, 'customer', 'رسالة تجربة');

  db.prepare(
    `INSERT INTO requests (tenant_id, conversation_id, reference, customer_wa, kind, summary)
     VALUES (?,?,?,?,?,?)`,
  ).run(tenant.id, test.id, 'TLB-TEST', '966555000111', 'maintenance', 'طلب تجربة');
  db.prepare(
    `INSERT INTO requests (tenant_id, conversation_id, reference, customer_wa, kind, summary)
     VALUES (?,?,?,?,?,?)`,
  ).run(tenant.id, real.id, 'TLB-REAL', '966501052903', 'maintenance', 'طلب حقيقي');

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  root = await login('root', 'root123456');
  owner = await login('owner', 'owner12345');
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('بلا وسم لا حذف', () => {
  it('الملخص فارغ ما لم تُوسم محادثة', () => {
    const summary = summarizeTestData(db);
    expect(summary.conversations).toBe(0);
    expect(summary.messages).toBe(0);
  });

  /** أهم وصف في الملف. */
  it('الحذف بلا وسم لا يمسّ شيئاً إطلاقاً', () => {
    const before = counts();
    deleteTestData(db);
    expect(counts()).toEqual(before);
  });
});

describe('الموسوم وحده يُحذف', () => {
  beforeEach(() => {
    markConversation(db, tenantId, testId, true);
  });

  it('الملخص يعدّ الموسومة فقط', () => {
    const summary = summarizeTestData(db);
    expect(summary.conversations).toBe(1);
    expect(summary.requests).toBe(1);
    expect(summary.preview[0]?.customerWa).toBe('966555000111');
  });

  it('الحذف يُبقي المحادثة الحقيقية ورسائلها وطلبها', () => {
    deleteTestData(db);

    const after = counts();
    expect(after.conversations).toBe(1);
    expect(after.messages).toBe(2);
    expect(after.requests).toBe(1);

    const left = db.prepare('SELECT customer_wa FROM conversations').get() as { customer_wa: string };
    expect(left.customer_wa).toBe('966501052903');

    const message = db.prepare('SELECT body FROM messages LIMIT 1').get() as { body: string };
    expect(message.body).toBe(REAL_TEXT);

    const request = db.prepare('SELECT reference FROM requests').get() as { reference: string };
    expect(request.reference).toBe('TLB-REAL');
  });

  it('ورفع الوسم يُعيدها محميّة', () => {
    markConversation(db, tenantId, testId, false);
    const before = counts();
    deleteTestData(db);
    expect(counts()).toEqual(before);
  });
});

describe('عبر الـHTTP', () => {
  async function call(method: 'GET' | 'DELETE', cookie: string) {
    const response = await server.inject({ method, url: '/api/system/test-data', headers: { cookie } });
    let body: Record<string, unknown> = {};
    try {
      body = response.json();
    } catch {
      // ردود بلا جسم
    }
    return { status: response.statusCode, body };
  }

  it('أدمن النظام وحده يرى الملخص', async () => {
    expect((await call('GET', root)).status).toBe(200);
    expect((await call('GET', owner)).status).toBe(403);
    expect((await call('GET', '')).status).toBe(401);
  });

  it('ومالك المنشأة لا يحذف', async () => {
    markConversation(db, tenantId, testId, true);
    const before = counts();

    expect((await call('DELETE', owner)).status).toBe(403);
    expect(counts()).toEqual(before);
  });

  it('الوسم من مسار المنشأة ثم الحذف من مسار النظام', async () => {
    const mark = await server.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/conversations/${testId}/test`,
      headers: { cookie: owner },
      payload: { isTest: true },
    });
    expect(mark.statusCode).toBe(200);
    expect(mark.json().is_test).toBe(1);

    const removed = await call('DELETE', root);
    expect(removed.status).toBe(200);
    expect(removed.body.conversations).toBe(1);

    expect(counts().conversations).toBe(1);
  });

  it('مالك منشأة لا يسم محادثة منشأة أخرى', async () => {
    const other = seedTenant(db, { name: 'جيران', waNumber: '966500000002' });
    const foreign = getOrCreateConversation(db, other.id, '966555999999');

    const response = await server.inject({
      method: 'POST',
      url: `/api/tenants/${other.id}/conversations/${foreign.id}/test`,
      headers: { cookie: owner },
      payload: { isTest: true },
    });
    expect(response.statusCode).toBe(403);
  });

  it('ووسم محادثة من منشأة أخرى عبر معرّف منشأتي يُرفض', async () => {
    const other = seedTenant(db, { name: 'جيران', waNumber: '966500000002' });
    const foreign = getOrCreateConversation(db, other.id, '966555999999');

    // المنشأة في المسار منشأتي، لكن المحادثة ليست لها
    const response = await server.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/conversations/${foreign.id}/test`,
      headers: { cookie: owner },
      payload: { isTest: true },
    });
    expect(response.statusCode).toBe(404);
    expect((db.prepare('SELECT is_test FROM conversations WHERE id = ?').get(foreign.id) as { is_test: number }).is_test).toBe(0);
  });
});
