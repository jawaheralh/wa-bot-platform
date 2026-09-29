/**
 * حارس العنوان العام.
 *
 * للوحة وضعان، وكلاهما يجب أن يبقى مضموناً:
 *   مغلقة (الافتراضي) — العنوان العام لا يقبل إلا /webhook، والباقي ٤٠٤.
 *   مفتوحة (PUBLIC_PANEL=1) — يصلها الموظفون من أي مكان، وتحرسها كلمة المرور.
 *
 * الخطر الذي يمسكه هذا الملف: أن ينقلب الوضع الافتراضي يوماً فتُكشَف
 * محادثات العملاء كلها للإنترنت بلا أن يطلب ذلك أحد.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import type { Db } from '../src/db/index.ts';

const PUBLIC_URL = 'https://bot.example.sa';
const PUBLIC_HOST = 'bot.example.sa';

async function serverWith(publicPanel: boolean): Promise<{ app: App; server: FastifyInstance; db: Db }> {
  const db = freshDb();
  seedTenant(db, { name: 'عيادة', waNumber: '966500000001' });
  createUser(db, { tenantId: null, username: 'root', password: 'root12345', role: 'system' });

  const app = await buildApp({
    config: {
      ...loadConfig(),
      provider: 'simulator',
      sessionSecret: 'test-secret-for-cookies',
      publicUrl: PUBLIC_URL,
      publicPanel,
    },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  const server = await createServer(app);
  await server.ready();
  // عدّاد المحاولات مشترك بين ملفات الاختبار في العملية الواحدة.
  resetLoginRate();
  return { app, server, db };
}

describe('اللوحة مغلقة على العنوان العام (الافتراضي)', () => {
  let server: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    ({ server, db } = await serverWith(false));
  });
  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('صفحة الدخول تُحجب بـ٤٠٤ من العنوان العام', async () => {
    const response = await server.inject({ method: 'GET', url: '/login.html', headers: { host: PUBLIC_HOST } });
    expect(response.statusCode).toBe(404);
  });

  it('مسار الدخول نفسه محجوب — لا تخمين لكلمة المرور من الخارج', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: PUBLIC_HOST },
      payload: { username: 'root', password: 'root12345' },
    });
    expect(response.statusCode).toBe(404);
  });

  /**
   * المحاكي لا يسجّل مسار webhook، فـ٤٠٤ هنا قد تكون «لا مسار» لا «حجبه
   * الحارس». التمييز بجسم الرد: الحارس وحده يكتب رسالته العربية.
   */
  it('الحارس لا يعترض /webhook وإلا انقطع واتساب', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=غلط&hub.challenge=x',
      headers: { host: PUBLIC_HOST },
    });
    expect(response.body).not.toContain('غير موجود.');
  });

  it('والحارس هو من يحجب اللوحة فعلاً', async () => {
    const response = await server.inject({ method: 'GET', url: '/login.html', headers: { host: PUBLIC_HOST } });
    expect(response.body).toContain('غير موجود.');
  });

  it('الدخول من الجهاز نفسه (مضيف آخر) يعمل', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: '127.0.0.1:4000' },
      payload: { username: 'root', password: 'root12345' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('اللوحة مفتوحة (PUBLIC_PANEL=1)', () => {
  let server: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    ({ server, db } = await serverWith(true));
  });
  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('الموظف يدخل من العنوان العام', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: PUBLIC_HOST },
      payload: { username: 'root', password: 'root12345' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('الفتح لا يعني الدخول بلا كلمة مرور', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: PUBLIC_HOST },
      payload: { username: 'root', password: 'غلط' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('بيانات المحادثات لا تُقرأ بلا جلسة', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/tenants',
      headers: { host: PUBLIC_HOST },
    });
    expect(response.statusCode).toBe(401);
  });
});
