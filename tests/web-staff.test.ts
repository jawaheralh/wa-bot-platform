/**
 * صلاحيات الفريق عبر الـHTTP — المسار الحقيقي بكوكي جلسة.
 * الاختبار بالصلاحيات لا يصح إلا من هنا: الحارس يعمل في طبقة الويب.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { addStaff } from '../src/staff.ts';
import { getOrCreateConversation, saveMessage, type Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let conversationId: number;
const cookies: Record<string, string> = {};

/** ينفّذ طلباً باسم مستخدم معيّن عبر inject — بلا منفذ ولا شبكة. */
async function as(
  who: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await server.inject({
    method,
    url,
    headers: { cookie: cookies[who] ?? '' },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = response.json();
  } catch {
    // ردود بلا جسم
  }
  return { status: response.statusCode, body };
}

async function login(username: string, password: string): Promise<void> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(response.statusCode, `فشل دخول ${username}`).toBe(200);
  const raw = response.headers['set-cookie'];
  cookies[username] = (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}

beforeAll(async () => {
  db = freshDb();
  const tenant = seedTenant(db, { name: 'عيادة', waNumber: '966500000001', staffWaNumber: '966500000099' });
  seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });

  createUser(db, { tenantId: null, username: 'root', password: 'root12345', role: 'system' });
  createUser(db, { tenantId: tenant.id, username: 'owner', password: 'owner12345', displayName: 'المالك', role: 'tenant' });
  addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', displayName: 'منى', waNumber: '966500000011' });
  addStaff(db, { tenantId: tenant.id, username: 'fahad', password: 'fahad12345', displayName: 'فهد' });

  const conversation = getOrCreateConversation(db, tenant.id, '966555123456', 'خالد');
  conversationId = conversation.id;
  saveMessage(db, conversationId, 'customer', 'متى تفتحون؟');

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();

  for (const [u, p] of [['root', 'root12345'], ['owner', 'owner12345'], ['mona', 'mona12345'], ['fahad', 'fahad12345']]) {
    await login(u!, p!);
  }
});

afterAll(async () => {
  await server.close();
  db.close();
});

describe('ما يستطيعه الموظف', () => {
  it('يقرأ المحادثات والشكاوى وقائمة الفريق', async () => {
    for (const url of ['/api/tenants/1/conversations', '/api/tenants/1/complaints', '/api/tenants/1/staff']) {
      expect((await as('mona', 'GET', url)).status, url).toBe(200);
    }
  });

  it('يرد على العميل، ويُنسب الرد لاسمه، وتُسند له المحادثة تلقائياً', async () => {
    const reply = await as('mona', 'POST', `/api/tenants/1/conversations/${conversationId}/reply`, {
      text: 'نفتح من ٩ إلى ٩',
    });
    expect(reply.status).toBe(200);

    const thread = await as('mona', 'GET', `/api/tenants/1/conversations/${conversationId}`);
    expect(thread.body.assigneeName).toBe('منى');
    const messages = thread.body.messages as { role: string; author_name: string | null }[];
    expect(messages.find((m) => m.role === 'staff')?.author_name).toBe('منى');
  });

  it('يستطيع الإسناد لزميله', async () => {
    const staff = (await as('mona', 'GET', '/api/tenants/1/staff')).body.staff as { id: number; username: string }[];
    const fahad = staff.find((s) => s.username === 'fahad')!;

    expect((await as('mona', 'POST', `/api/tenants/1/conversations/${conversationId}/assign`, { userId: fahad.id })).status).toBe(200);
    expect((await as('mona', 'GET', `/api/tenants/1/conversations/${conversationId}`)).body.assigneeName).toBe('فهد');

    await as('mona', 'POST', `/api/tenants/1/conversations/${conversationId}/assign`, { userId: null });
  });

  it('الإسناد لموظف من منشأة أخرى يُرفض', async () => {
    const result = await as('owner', 'POST', `/api/tenants/1/conversations/${conversationId}/assign`, { userId: 1 });
    expect(result.status).toBe(400);
  });
});

describe('ما لا يستطيعه الموظف', () => {
  it('لا يعدّل قاعدة المعرفة', async () => {
    const result = await as('mona', 'POST', '/api/tenants/1/kb', { question: 'س', answer: 'ج' });
    expect(result.status).toBe(403);
    expect(String(result.body.error)).toContain('مالك المنشأة');
  });

  it('لا يغيّر إعدادات وحدة', async () => {
    expect((await as('mona', 'PUT', '/api/tenants/1/modules/handoff/config', {})).status).toBe(403);
  });

  it('لا يضيف موظفاً ولا يعدّل زميله', async () => {
    expect((await as('mona', 'POST', '/api/tenants/1/staff', { username: 'x1', password: 'password123' })).status).toBe(403);
    expect((await as('mona', 'PATCH', '/api/tenants/1/staff/4', { active: false })).status).toBe(403);
  });

  it('لا يرى منشأة أخرى', async () => {
    expect((await as('mona', 'GET', '/api/tenants/2')).status).toBe(403);
    expect((await as('mona', 'GET', '/api/system/tenants')).status).toBe(403);
  });
});

describe('ما يستطيعه المالك', () => {
  it('يضيف موظفاً ويعدّله', async () => {
    const added = await as('owner', 'POST', '/api/tenants/1/staff', {
      username: 'sara',
      password: 'sara12345',
      displayName: 'سارة',
    });
    expect(added.status).toBe(201);
    expect(added.body.role).toBe('agent');

    const updated = await as('owner', 'PATCH', `/api/tenants/1/staff/${added.body.id}`, { waNumber: '966500000033' });
    expect(updated.body.waNumber).toBe('966500000033');
  });

  it('يعدّل المعرفة وإعدادات الوحدات', async () => {
    expect((await as('owner', 'POST', '/api/tenants/1/kb', { question: 'س', answer: 'ج' })).status).toBe(201);
    expect((await as('owner', 'PUT', '/api/tenants/1/modules/handoff/config', { silenceMinutes: 60 })).status).toBe(200);
  });

  it('لا يعطّل حساب نفسه', async () => {
    const me = (await as('owner', 'GET', '/api/me')).body as { id: number };
    const result = await as('owner', 'PATCH', `/api/tenants/1/staff/${me.id}`, { active: false });
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toContain('حسابك أنت');
  });

  it('لا يفعّل وحدة — هذا لأدمن النظام وحده', async () => {
    expect((await as('owner', 'POST', '/api/system/tenants/1/modules/bookings', { enabled: true })).status).toBe(403);
    expect((await as('root', 'POST', '/api/system/tenants/1/modules/bookings', { enabled: true })).status).toBe(200);
  });
});

describe('تحذير الحضور', () => {
  it('الموظف لا يرى نفسه في التحذير مهما فتح المحادثة', async () => {
    await as('mona', 'GET', `/api/tenants/1/conversations/${conversationId}`);
    const again = await as('mona', 'GET', `/api/tenants/1/conversations/${conversationId}`);
    expect(again.body.viewer).toBeNull();
  });

  it('الزميل الذي فتحها قبلي يظهر باسمه', async () => {
    await as('mona', 'GET', `/api/tenants/1/conversations/${conversationId}`);
    const fahadView = await as('fahad', 'GET', `/api/tenants/1/conversations/${conversationId}`);
    expect((fahadView.body.viewer as { display_name: string }).display_name).toBe('منى');
  });
});

describe('الحساب المعطَّل', () => {
  it('لا يدخل، وجلسته المفتوحة تسقط فوراً', async () => {
    const sara = (await as('owner', 'GET', '/api/tenants/1/staff')).body.staff as { id: number; username: string }[];
    const target = sara.find((s) => s.username === 'fahad')!;

    // جلسة فهد تعمل الآن
    expect((await as('fahad', 'GET', '/api/tenants/1/conversations')).status).toBe(200);

    await as('owner', 'PATCH', `/api/tenants/1/staff/${target.id}`, { active: false });

    // الجلسة نفسها لم تعد صالحة بلا انتظار انتهاء الكوكي
    expect((await as('fahad', 'GET', '/api/tenants/1/conversations')).status).toBe(401);

    const attempt = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'fahad', password: 'fahad12345' },
    });
    expect(attempt.statusCode).toBe(403);
    expect(String(attempt.json().error)).toContain('معطَّل');
  });
});

describe('رموز حالة الدخول', () => {
  it('كلمة مرور خاطئة ترجع 401 لا 500 — فشل الدخول حدث متوقع لا عطل خادم', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'غلط' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('مستخدم غير موجود يعطي نفس الرسالة فلا تُكشف الأسماء الموجودة', async () => {
    const missing = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'لا-أحد', password: 'غلط' },
    });
    const wrongPassword = await server.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: 'غلط' },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe(wrongPassword.json().error);
  });
});

describe('تحديد معدّل الدخول', () => {
  it('المحاولات الفاشلة المتكررة تُحظر مؤقتاً بـ429', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'owner', password: `غلط-${i}` },
      });
      last = response.statusCode;
    }
    expect(last).toBe(429);
  });
});
