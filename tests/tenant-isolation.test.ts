/**
 * عزل المنشآت — على كل مسار، لا على المسارات التي تذكّرنا أن نختبرها.
 *
 * الوعد أن `requireTenantAccess` قرار مركزي لا يُنسى في مسار جديد.
 * لكن الوعد بلا اختبار يبقى وعداً: يكفي مسار واحد يقرأ `:tenantId`
 * ولا يمرّ على الحارس ليصير بابَ تسريب — ولن يظهر في الاستعمال، لأن
 * لا أحد يفتح منشأة غيره بالخطأ.
 *
 * فهذا الملف لا يعدّد المسارات يدوياً: يستخرجها من جدول توجيه الخادم
 * نفسه، ويطرقها كلها باسم مالك منشأة أخرى. مسار جديد يُضاف غداً
 * يدخل الاختبار تلقائياً — وهذا هو المقصود.
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
import { resetLoginRate } from '../src/web/auth.ts';
import { getOrCreateConversation, saveMessage, type Db } from '../src/db/index.ts';
import { setEnabled } from '../src/modules/registry.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let mine = 0;
let theirs = 0;
const cookies: Record<string, string> = {};

async function login(username: string, password: string): Promise<void> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(response.statusCode, `فشل دخول ${username}`).toBe(200);
  const raw = response.headers['set-cookie'];
  cookies[username] = (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}

/**
 * مسارات المنشآت من جدول التوجيه.
 *
 * `printRoutes` يطبع شجرة، فنستخرج منها ما يحمل `:tenantId`. الاعتماد
 * على الخادم لا على قائمة مكتوبة هو ما يجعل المسار الجديد مشمولاً بلا
 * أن يتذكّره أحد.
 */
/**
 * كل مسارات الخادم بمساراتها الكاملة.
 *
 * `printRoutes` يطبع شجرة لا قائمة: «‎/totp» يظهر سطراً مستقلاً تحت
 * «‎/api/login». فتُبنى المسارات من عمق التفريع — وقراءة السطر وحده
 * تعطي مساراً ناقصاً فيمرّ الاختبار على فراغ ويبدو ناجحاً.
 */
function allRoutes(): { method: string; url: string }[] {
  const printed = server.printRoutes({ commonPrefix: false });
  const out: { method: string; url: string }[] = [];
  const stack: string[] = [];

  for (const line of printed.split('\n')) {
    const connector = Math.max(line.indexOf('├──'), line.indexOf('└──'));
    if (connector < 0) continue;

    const depth = Math.floor(connector / 4);
    const rest = line.slice(connector + 3).trim();
    const match = rest.match(/^(\S*)\s*\(([^)]+)\)\s*$/);

    const segment = match ? match[1]! : rest;
    stack.length = depth;
    stack[depth] = segment;

    if (!match) continue;
    const url = stack.slice(0, depth + 1).join('');

    for (const method of match[2]!.split(',').map((m) => m.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      out.push({ method, url });
    }
  }
  return out;
}

function tenantRoutes(): { method: string; url: string }[] {
  return allRoutes().filter((r) => r.url.includes(':tenantId'));
}

function systemRoutes(): { method: string; url: string }[] {
  return allRoutes().filter((r) => r.url.startsWith('/api/system'));
}

/** يملأ الوسائط الأخرى بقيم موجودة فعلاً لدى المنشأة الأخرى. */
function fill(url: string, tenantId: number): string {
  return url
    .replace(':tenantId', String(tenantId))
    .replace(/:[A-Za-z]+/g, '1')
    .replace(/\*$/, 'x');
}

beforeAll(async () => {
  db = freshDb();
  const a = seedTenant(db, { name: 'منشأتي', waNumber: '966500000001' });
  const b = seedTenant(db, { name: 'منشأة الجيران', waNumber: '966500000002' });
  mine = a.id;
  theirs = b.id;

  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });
  createUser(db, { tenantId: a.id, username: 'owner', password: 'owner12345', role: 'tenant' });
  addStaff(db, { tenantId: a.id, username: 'agent', password: 'agent12345', displayName: 'موظف' });
  createUser(db, { tenantId: b.id, username: 'neighbour', password: 'neigh12345', role: 'tenant' });

  // بيانات لدى الجيران: لو تسرّب شيء فهذا ما سيظهر.
  const conversation = getOrCreateConversation(db, b.id, '966555000001', 'عميل الجيران');
  saveMessage(db, conversation.id, 'customer', 'سرٌّ لا يخرج من منشأة الجيران');

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  // كل الوحدات مفعّلة للطرفين: مسار وحدة معطّلة لا يُختبر أصلاً.
  for (const id of [a.id, b.id]) for (const m of ['bookings', 'requests']) setEnabled(db, id, m, true);

  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  for (const [u, p] of [
    ['root', 'root123456'],
    ['owner', 'owner12345'],
    ['agent', 'agent12345'],
    ['neighbour', 'neigh12345'],
  ]) {
    await login(u!, p!);
  }
});

afterAll(async () => {
  await server.close();
  db.close();
});

describe('جدول التوجيه', () => {
  it('فيه مسارات منشآت فعلاً — وإلا كان الاختبار يمرّ على فراغ', () => {
    expect(tenantRoutes().length).toBeGreaterThan(5);
  });
});

describe('مالك منشأة لا يصل منشأة أخرى — على كل مسار', () => {
  it('كل مسار يحمل :tenantId يُرفض', async () => {
    const leaks: string[] = [];

    for (const route of tenantRoutes()) {
      const response = await server.inject({
        method: route.method as 'GET',
        url: fill(route.url, theirs),
        headers: { cookie: cookies.owner! },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });

      // ٤٠٣ هو المتوقع. نقبل ٤٠٤ أيضاً (مورد غير موجود لدى الجيران)
      // لكن لا نقبل ٢٠٠ ولا ٥٠٠ — الأول تسريب والثاني حارس انهار.
      if (response.statusCode < 400 || response.statusCode >= 500) {
        leaks.push(`${route.method} ${route.url} → ${response.statusCode}`);
      }
    }

    expect(leaks, `مسارات تسرّب بيانات منشأة أخرى:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('وموظف كذلك', async () => {
    const leaks: string[] = [];
    for (const route of tenantRoutes()) {
      const response = await server.inject({
        method: route.method as 'GET',
        url: fill(route.url, theirs),
        headers: { cookie: cookies.agent! },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      if (response.statusCode < 400 || response.statusCode >= 500) {
        leaks.push(`${route.method} ${route.url} → ${response.statusCode}`);
      }
    }
    expect(leaks, `موظف وصل منشأة أخرى:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('ولا يصل محتوى محادثات الجيران بأي مسار', async () => {
    const بحث = await server.inject({
      method: 'GET',
      url: `/api/tenants/${theirs}/conversations`,
      headers: { cookie: cookies.owner! },
    });
    expect(بحث.statusCode).toBe(403);
    expect(بحث.body).not.toContain('سرٌّ لا يخرج');
  });
});

describe('مسارات النظام لا يمسّها إلا أدمن النظام', () => {
  it('مالك المنشأة يُرفض من /api/system/*', async () => {
    const leaks: string[] = [];
    for (const route of systemRoutes()) {
      const response = await server.inject({
        method: route.method as 'GET',
        url: fill(route.url, theirs),
        headers: { cookie: cookies.owner! },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      if (response.statusCode < 400 || response.statusCode >= 500) {
        leaks.push(`${route.method} ${route.url} → ${response.statusCode}`);
      }
    }
    expect(leaks, `مالك منشأة وصل مسار نظام:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('وفيها مسارات فعلاً', () => {
    expect(systemRoutes().length).toBeGreaterThan(3);
  });
});

describe('المنشأة الخاصة بي تعمل — العزل ليس شللاً', () => {
  it('المالك يقرأ محادثات منشأته', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${mine}/conversations`,
      headers: { cookie: cookies.owner! },
    });
    expect(response.statusCode).toBe(200);
  });

  it('وأدمن النظام يصل الاثنتين', async () => {
    for (const id of [mine, theirs]) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/tenants/${id}/conversations`,
        headers: { cookie: cookies.root! },
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
