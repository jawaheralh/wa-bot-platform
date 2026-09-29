/**
 * صلاحيات الموظفين.
 *
 * أخطر ما في إضافة الصلاحيات ليس منع من لا يملك، بل **سلب من كان
 * يملك**: النظام عمل شهوراً بلا عمود صلاحيات، وصفوف الموظفين القائمين
 * فارغة. فلو قُرئ الفراغ منعاً لفقد كل موظف في كل منشأة قدرته على
 * الرد صباح التحديث — وهو عطل يُكتشف من شكوى عميل لا من سجل.
 *
 * ولذلك أول اختبار هنا للفراغ لا للمنع.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { addStaff, updateStaff, listStaff } from '../src/staff.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import { permissionsOf, normalizePermissions, PERMISSION_KEYS } from '../src/permissions.ts';
import { getOrCreateConversation, saveMessage, type Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let tenantId = 0;
let conversationId = 0;
let agentId = 0;
const cookies: Record<string, string> = {};

async function login(username: string, password: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

const asAgent = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  server.inject({ method, url, headers: { cookie: cookies.agent! }, payload: payload as never });

beforeEach(async () => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  createUser(db, { tenantId, username: 'malik', password: 'malik123456', role: 'tenant' });
  agentId = addStaff(db, { tenantId, username: 'sara', password: 'sara12345678', role: 'agent' }).id;

  conversationId = getOrCreateConversation(db, tenantId, '966551112233', 'خالد').id;
  saveMessage(db, conversationId, 'customer', 'السلام عليكم');

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  cookies.agent = await login('sara', 'sara12345678');
  cookies.malik = await login('malik', 'malik123456');
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('الموظف القديم لا يفقد شيئاً', () => {
  /** صفّه أُنشئ بلا عمود صلاحيات — والفراغ يعني الافتراضي لا المنع. */
  it('الفراغ يعطي صلاحيات الموظف المعتادة', () => {
    db.prepare('UPDATE users SET permissions = NULL WHERE id = ?').run(agentId);
    const granted = permissionsOf({ role: 'agent', permissions: null });
    expect(granted).toContain('reply');
    expect(granted).toContain('assign');
    expect(granted).toContain('bot');
    expect(granted).toContain('cases');
    expect(granted).toContain('templates');
    // ما لم يكن يملكه من قبل لا يُمنح له الآن بالغلط.
    expect(granted).not.toContain('knowledge');
  });

  it('ويرد فعلاً على العملاء', async () => {
    const response = await asAgent('POST', `/api/tenants/${tenantId}/conversations/${conversationId}/reply`, {
      text: 'أهلاً',
    });
    expect(response.statusCode).toBe(200);
  });

  /** صفٌّ تالف لا يشلّ موظفاً — يعود للافتراضي. */
  it('والنصّ التالف يعود للافتراضي لا للمنع', () => {
    expect(permissionsOf({ role: 'agent', permissions: '{ليس JSON' })).toContain('reply');
    expect(permissionsOf({ role: 'agent', permissions: '"نص"' })).toContain('reply');
  });
});

describe('المالك فوق الصلاحيات', () => {
  it('يملك الكل ولو كُتب له خلاف ذلك', () => {
    expect(permissionsOf({ role: 'tenant', permissions: '[]' })).toEqual(PERMISSION_KEYS);
    expect(permissionsOf({ role: 'system', permissions: '[]' })).toEqual(PERMISSION_KEYS);
  });
});

describe('المنع', () => {
  beforeEach(() => {
    updateStaff(db, tenantId, agentId, { permissions: [] });
  });

  it('بلا صلاحية رد لا يصل العميل شيء', async () => {
    const response = await asAgent('POST', `/api/tenants/${tenantId}/conversations/${conversationId}/reply`, {
      text: 'أهلاً',
    });
    expect(response.statusCode).toBe(403);
    // الرسالة تسمّي الصلاحية ليطلبها من مالكه بالاسم.
    expect(String(response.json().error)).toContain('الرد على العملاء');
  });

  it('وبلا صلاحية بوت لا يوقفه', async () => {
    const response = await asAgent('POST', `/api/tenants/${tenantId}/conversations/${conversationId}/bot`, {
      enabled: false,
    });
    expect(response.statusCode).toBe(403);
  });

  it('وبلا صلاحية قوالب لا يرسل ما يُحاسَب عليه', async () => {
    const response = await asAgent('POST', `/api/tenants/${tenantId}/templates/send`, { to: '966551112233' });
    expect(response.statusCode).toBe(403);
  });

  it('والمنع من الخادم لا من الشاشة', async () => {
    // لا شيء في الطلب يدلّ على الواجهة — الحارس وحده هو الذي يرفض.
    const response = await asAgent('POST', `/api/tenants/${tenantId}/conversations/${conversationId}/assign`, {
      userId: null,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('المنح', () => {
  it('صلاحية المعرفة ترفع الموظف فوق الافتراضي', async () => {
    const before = await asAgent('POST', `/api/tenants/${tenantId}/kb`, { question: 'س', answer: 'ج' });
    expect(before.statusCode).toBe(403);

    updateStaff(db, tenantId, agentId, { permissions: [...PERMISSION_KEYS] });
    const after = await asAgent('POST', `/api/tenants/${tenantId}/kb`, { question: 'س', answer: 'ج' });
    expect(after.statusCode).toBe(201);
  });

  it('وتُحفظ وتُقرأ في قائمة الموظفين', () => {
    updateStaff(db, tenantId, agentId, { permissions: ['reply', 'knowledge'] });
    const row = listStaff(db, tenantId).find((s) => s.id === agentId)!;
    expect(row.permissions.sort()).toEqual(['knowledge', 'reply']);
  });

  it('والمفتاح المجهول يُسقَط ولا يُحفظ', () => {
    expect(normalizePermissions(['reply', 'drop-database', 'reply'])).toBe('["reply"]');
    expect(normalizePermissions('نص')).toBeNull();
  });

  /** تعديل غير متعلق بالصلاحيات لا يمسّها. */
  it('وتعديل الاسم وحده لا يمحو الصلاحيات', () => {
    updateStaff(db, tenantId, agentId, { permissions: ['reply'] });
    updateStaff(db, tenantId, agentId, { displayName: 'سارة' });
    expect(listStaff(db, tenantId).find((s) => s.id === agentId)!.permissions).toEqual(['reply']);
  });
});
