/**
 * تغيير المستخدم كلمة مروره بنفسه.
 *
 * قبل هذا المسار كان من سُلّم كلمة مؤقتة محكوماً بها: شاشة الفريق
 * تغيّر كلمة الموظف لا كلمة صاحبها، وأدمن النظام ليس موظفاً في أي
 * منشأة فلا تطاله الشاشة أصلاً.
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

let app: App;
let server: FastifyInstance;
let db: Db;

async function loginAs(username: string, password: string): Promise<string | undefined> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  if (response.statusCode !== 200) return undefined;
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0];
}

async function changePassword(
  cookie: string,
  current: string,
  next: string,
): Promise<{ status: number; error?: string }> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/me/password',
    headers: { cookie },
    payload: { current, next },
  });
  let error: string | undefined;
  try {
    error = response.json().error;
  } catch {
    // ردود بلا جسم
  }
  return { status: response.statusCode, error };
}

beforeAll(async () => {
  db = freshDb();
  const tenant = seedTenant(db, { name: 'عيادة', waNumber: '966500000001' });
  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });
  createUser(db, { tenantId: tenant.id, username: 'owner', password: 'owner12345', role: 'tenant' });

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();
});

afterAll(async () => {
  await server.close();
  db.close();
});

describe('تغيير كلمة المرور', () => {
  it('أدمن النظام يغيّر كلمته — وهو ليس موظفاً في أي منشأة', async () => {
    const cookie = await loginAs('root', 'root123456');
    expect(cookie).toBeDefined();

    const result = await changePassword(cookie!, 'root123456', 'سرّ-جديد-طويل-١٢٣');
    expect(result.status).toBe(200);

    expect(await loginAs('root', 'root123456')).toBeUndefined();
    expect(await loginAs('root', 'سرّ-جديد-طويل-١٢٣')).toBeDefined();
  });

  it('الكلمة الحالية الخاطئة تُرفض — جهاز مفتوح لا يكفي لاختطاف الحساب', async () => {
    resetLoginRate();
    const cookie = await loginAs('owner', 'owner12345');
    const result = await changePassword(cookie!, 'غلط-تماماً', 'كلمة-جديدة-طويلة');

    expect(result.status).toBe(401);
    // والكلمة لم تتغيّر
    expect(await loginAs('owner', 'owner12345')).toBeDefined();
  });

  it('الكلمة القصيرة تُرفض', async () => {
    resetLoginRate();
    const cookie = await loginAs('owner', 'owner12345');
    const result = await changePassword(cookie!, 'owner12345', 'قصيرة');

    expect(result.status).toBe(400);
    expect(result.error).toContain('١٠');
  });

  it('بلا جلسة لا تغيير', async () => {
    const result = await changePassword('', 'owner12345', 'كلمة-جديدة-طويلة');
    expect(result.status).toBe(401);
  });

  it('المحاولات المتكررة بكلمة حالية خاطئة تُحدّ', async () => {
    resetLoginRate();
    const cookie = await loginAs('owner', 'owner12345');

    let blocked = false;
    for (let i = 0; i < 12; i += 1) {
      const result = await changePassword(cookie!, 'غلط', 'كلمة-جديدة-طويلة');
      if (result.status === 429) {
        blocked = true;
        break;
      }
    }
    expect(blocked, 'مسار تغيير الكلمة صار باباً خلفياً للتخمين بلا حدّ').toBe(true);
  });
});
