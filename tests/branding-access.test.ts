/**
 * من يملك تغيير هوية المنشأة.
 *
 * الهوية قرار المالك وحده: لونُ العلامة وشعارها ليسا إعداداً تشغيلياً
 * يعدّله من يرد على العملاء. وموظف يبدّل شعار المنشأة — ولو بحسن نيّة —
 * يغيّر ما يراه زملاؤه كلهم بلا علم من يملك القرار.
 *
 * والقراءة مفتوحة لكل من في المنشأة عمداً: اللوحة تلبس الألوان عند كل
 * إقلاع، فلو كانت للمالك وحده لرآها وحده ورأى الموظفون ألوان المنصة —
 * وهم من يفتح الشاشة طول اليوم.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { addStaff } from '../src/staff.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import type { Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let mine = 0;
let other = 0;

const cookies: Record<string, string> = {};

async function login(username: string, password: string): Promise<string> {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

beforeEach(async () => {
  db = freshDb();
  mine = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  other = seedTenant(db, { name: 'عيادة النور', waNumber: '966500000003' }).id;

  createUser(db, { tenantId: null, username: 'root', password: 'root123456', role: 'system' });
  createUser(db, { tenantId: mine, username: 'malik', password: 'malik123456', role: 'tenant' });
  // الموظف يُضاف بأداته: createUser للمالك وأدمن النظام لا للموظفين.
  addStaff(db, { tenantId: mine, username: 'muwazaf', password: 'muwazaf12345', role: 'agent' });
  createUser(db, { tenantId: other, username: 'noor', password: 'noor12345678', role: 'tenant' });

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  cookies.root = await login('root', 'root123456');
  cookies.malik = await login('malik', 'malik123456');
  cookies.muwazaf = await login('muwazaf', 'muwazaf12345');
  cookies.noor = await login('noor', 'noor12345678');
});

afterEach(async () => {
  await server.close();
  db.close();
});

const put = (who: string, tenantId: number, payload: Record<string, string>) =>
  server.inject({
    method: 'PUT',
    url: `/api/tenants/${tenantId}/branding`,
    headers: { cookie: cookies[who]! },
    payload,
  });

describe('تغيير الهوية', () => {
  it('المالك يغيّر هوية منشأته', async () => {
    const response = await put('malik', mine, { color: '#1f7a53' });
    expect(response.statusCode).toBe(200);
    expect(response.json().accent).toBe('#1f7a53');
  });

  it('وأدمن النظام يغيّرها نيابةً عنه', async () => {
    expect((await put('root', mine, { color: '#1d6fa5' })).statusCode).toBe(200);
  });

  it('والموظف لا يغيّرها', async () => {
    const response = await put('muwazaf', mine, { color: '#1f7a53' });
    expect(response.statusCode).toBe(403);
    expect(String(response.json().error)).toContain('لمالك المنشأة');
  });

  it('ومالك منشأة أخرى لا يقترب منها', async () => {
    expect((await put('noor', mine, { color: '#1f7a53' })).statusCode).toBe(403);
  });

  it('وبلا جلسة لا شيء', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/tenants/${mine}/branding`,
      payload: { color: '#1f7a53' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('الشعار', () => {
  const PNG = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('0000000d49484452', 'hex'),
    Buffer.alloc(32),
  ]).toString('base64');

  it('الموظف لا يرفع شعاراً ولا يحذفه', async () => {
    const upload = await server.inject({
      method: 'POST',
      url: `/api/tenants/${mine}/logo`,
      headers: { cookie: cookies.muwazaf! },
      payload: { file: PNG },
    });
    expect(upload.statusCode).toBe(403);

    const remove = await server.inject({
      method: 'DELETE',
      url: `/api/tenants/${mine}/logo`,
      headers: { cookie: cookies.muwazaf! },
    });
    expect(remove.statusCode).toBe(403);
  });
});

describe('القراءة', () => {
  /** الموظف يرى الألوان وإلا فتح لوحة بهوية غير هوية منشأته. */
  it('الموظف يقرأ هوية منشأته', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${mine}/branding`,
      headers: { cookie: cookies.muwazaf! },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('مطعم الركن');
  });

  it('ولا يقرأ هوية منشأة أخرى', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${other}/branding`,
      headers: { cookie: cookies.muwazaf! },
    });
    expect(response.statusCode).toBe(403);
  });
});
