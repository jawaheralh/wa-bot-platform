/**
 * نموذج طلب التجربة — مفتوح للإنترنت بلا تسجيل دخول.
 *
 * أي نموذج مفتوح سيُملأ آلياً. والخطر ليس امتلاء الجدول فحسب، بل أن
 * يغرق الطلبُ الحقيقيُّ وسط آلاف الزائفة فلا يُرى — ويضيع عميل كان
 * سيدفع.
 *
 * ولذلك يُفحص هنا الرفض أكثر من القبول.
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
import { listDemoRequests } from '../src/demo-requests.ts';
import type { Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let root = '';

const VALID = {
  firstName: 'جواهر',
  lastName: 'الحربي',
  email: 'j@example.sa',
  company: 'وقودي',
  phone: '+966551234567',
  country: 'السعودية',
  role: 'المالك',
  teamSize: '٦–٢٠',
  marketingOk: true,
  lang: 'ar',
};

async function send(payload: Record<string, unknown>) {
  const response = await server.inject({ method: 'POST', url: '/api/demo-request', payload });
  let body: Record<string, unknown> = {};
  try {
    body = response.json();
  } catch {
    // ردود بلا جسم
  }
  return { status: response.statusCode, body };
}

beforeEach(async () => {
  db = freshDb();
  seedTenant(db, { name: 'وقودي', waNumber: '966500000001' });
  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
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

afterEach(async () => {
  await server.close();
  db.close();
});

describe('الإرسال بلا تسجيل دخول', () => {
  it('الطلب الصحيح يُحفظ', async () => {
    const { status } = await send(VALID);
    expect(status).toBe(200);

    const rows = listDemoRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company).toBe('وقودي');
    expect(rows[0]!.status).toBe('new');
  });

  it('والبريد يُخزَّن بحروف صغيرة فلا يتكرر بحالتين', async () => {
    await send({ ...VALID, email: 'Jawaher@Example.SA' });
    expect(listDemoRequests(db)[0]!.email).toBe('jawaher@example.sa');
  });
});

describe('ما يُرفض', () => {
  it('بلا اسم أو منشأة', async () => {
    expect((await send({ ...VALID, firstName: '' })).status).toBe(400);
    expect((await send({ ...VALID, company: '' })).status).toBe(400);
  });

  it('وبريد غير صحيح', async () => {
    for (const email of ['لا بريد', 'a@b', 'a b@c.com', '']) {
      expect((await send({ ...VALID, email })).status).toBe(400);
    }
  });

  it('وجوال قصير', async () => {
    expect((await send({ ...VALID, phone: '123' })).status).toBe(400);
  });

  it('ولا يُحفظ شيء من المرفوض', async () => {
    await send({ ...VALID, email: 'غلط' });
    expect(listDemoRequests(db)).toHaveLength(0);
  });
});

describe('الحماية من الآلات', () => {
  /**
   * الفخّ يُعامَل كالنجاح.
   *
   * إخبار الآلة بأنها كُشفت يجعلها تعدّل وتعيد حتى تنجح. والصمت يجعلها
   * تظنّ أنها نجحت فتمضي.
   */
  it('الحقل الخفي المملوء يبدو ناجحاً ولا يُحفظ', async () => {
    const { status } = await send({ ...VALID, website: 'http://spam.example' });

    expect(status).toBe(200);
    expect(listDemoRequests(db)).toHaveLength(0);
  });

  it('وحدّ لكل عنوان خلال يوم', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { status } = await send({ ...VALID, email: `a${i}@example.sa` });
      expect(status).toBe(200);
    }
    expect((await send({ ...VALID, email: 'a9@example.sa' })).status).toBe(429);
  });

  /** البريد المكرر غالباً ضغطتان لا هجوم — فالرسالة مطمئِنة لا زاجرة. */
  it('وحدّ لكل بريد — برسالة لا تُشعِر بأنه خطأ', async () => {
    await send(VALID);
    await send(VALID);
    const third = await send(VALID);

    expect(third.status).toBe(429);
    expect(String(third.body.error)).toContain('وصلنا طلبك');
  });
});

describe('لوحة الأدمن', () => {
  it('أدمن النظام وحده يرى الطلبات', async () => {
    await send(VALID);

    const mine = await server.inject({
      method: 'GET',
      url: '/api/system/demo-requests',
      headers: { cookie: root },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().requests).toHaveLength(1);

    const anonymous = await server.inject({ method: 'GET', url: '/api/system/demo-requests' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('وتحديث الحالة يعمل', async () => {
    await send(VALID);
    const id = listDemoRequests(db)[0]!.id;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/system/demo-requests/${id}`,
      headers: { cookie: root },
      payload: { status: 'contacted' },
    });

    expect(response.statusCode).toBe(200);
    expect(listDemoRequests(db)[0]!.status).toBe('contacted');
  });

  it('وحالة غير معروفة تُرفض', async () => {
    await send(VALID);
    const id = listDemoRequests(db)[0]!.id;

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/system/demo-requests/${id}`,
      headers: { cookie: root },
      payload: { status: 'whatever' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('صفحة الهبوط عامة', () => {
  it('اسم المنصة يُقرأ بلا جلسة', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/brand' });
    expect(response.statusCode).toBe(200);
    expect(String(response.json().name).length).toBeGreaterThan(0);
  });

  it('واللوحة على /app لا على /', async () => {
    const panel = await server.inject({ method: 'GET', url: '/app' });
    expect(panel.statusCode).toBe(200);
    expect(panel.body).toContain('/js/app.js');

    const landing = await server.inject({ method: 'GET', url: '/' });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('/js/landing.js');
  });
});
