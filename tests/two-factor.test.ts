/**
 * التحقق بخطوتين عبر الـHTTP — المسار الحقيقي بكوكي.
 *
 * ما يمسكه هذا الملف: أن تفتح كلمة المرور وحدها الجلسة رغم التفعيل.
 * لو انكسر ذلك يوماً فالحماية كلها زينة بلا أثر، ولا يظهر العطل في
 * الاستعمال اليومي لأن الدخول ينجح — وهذا بالضبط هو الخطر.
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
import { codeFor } from '../src/totp.ts';
import type { Db, UserRow } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookies: string[];
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { cookie?: string; payload?: unknown } = {},
): Promise<Res> {
  const response = await server.inject({
    method,
    url,
    headers: options.cookie ? { cookie: options.cookie } : {},
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = response.json();
  } catch {
    // ردود بلا جسم
  }
  const raw = response.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
  return { status: response.statusCode, body, cookies };
}

/**
 * ينقل الساعة إلى النافذة التالية.
 *
 * منع إعادة الاستعمال يرفض رمز النافذة نفسها مرتين — وهو المقصود.
 * فاختبار دخولين متتاليين يجب أن يعبر نافذتين كما يفعل المستخدم
 * الحقيقي حين ينتظر الرمز التالي.
 */
function nextWindow(): void {
  vi.setSystemTime(new Date(Date.now() + 31_000));
}

/** الرمز الصحيح الآن من السرّ المحفوظ — كما يولّده تطبيق المصادقة. */
function currentCode(secret: string): string {
  return codeFor(secret);
}

function row(username: string): UserRow {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow;
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
  // الساعة تحت سيطرتنا: بلا ذلك يصير اجتياز الاختبار رهن لحظة تشغيله
  // داخل نافذة الثلاثين ثانية.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterAll(async () => {
  vi.useRealTimers();
  await server.close();
  db.close();
});

describe('الإعداد', () => {
  let session = '';
  let secret = '';
  let recovery: string[] = [];

  it('الدخول العادي يعمل قبل التفعيل', async () => {
    const res = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });
    expect(res.status).toBe(200);
    expect(res.body.needTotp).toBeUndefined();
    session = res.cookies[0]!;
  });

  it('بدء الإعداد يعطي سرّاً ورابط تسجيل', async () => {
    const res = await call('POST', '/api/me/2fa/start', { cookie: session });
    expect(res.status).toBe(200);
    secret = String(res.body.secret);
    expect(secret.length).toBeGreaterThan(20);
    expect(String(res.body.otpauth)).toContain('otpauth://totp/');
  });

  it('لا يُفعَّل قبل إثبات أن السرّ وصل التطبيق', () => {
    expect(row('root').totp_enabled).toBe(0);
  });

  it('رمز خاطئ يرفض التفعيل', async () => {
    const res = await call('POST', '/api/me/2fa/confirm', { cookie: session, payload: { code: '000000' } });
    expect(res.status).toBe(401);
    expect(row('root').totp_enabled).toBe(0);
  });

  it('الرمز الصحيح يفعّل ويعطي رموز استرجاع مرة واحدة', async () => {
    const res = await call('POST', '/api/me/2fa/confirm', {
      cookie: session,
      payload: { code: currentCode(secret) },
    });
    expect(res.status).toBe(200);
    recovery = res.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    expect(row('root').totp_enabled).toBe(1);
  });

  it('رموز الاسترجاع لا تُحفظ نصاً', () => {
    const stored = String(row('root').recovery_hashes);
    for (const code of recovery) expect(stored).not.toContain(code);
  });
});

describe('الدخول بعد التفعيل', () => {
  it('كلمة المرور وحدها لا تفتح الجلسة', async () => {
    resetLoginRate();
    const res = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });

    expect(res.status).toBe(200);
    expect(res.body.needTotp).toBe(true);
    expect(res.body.role).toBeUndefined();

    // وكوكي الانتظار لا تمنح أي صلاحية
    const pending = res.cookies.find((c) => c.startsWith('wabot_pending='))!;
    expect(pending).toBeDefined();
    const me = await call('GET', '/api/me', { cookie: pending });
    expect(me.status).toBe(401);
  });

  it('الرمز الصحيح يكمل الدخول', async () => {
    resetLoginRate();
    nextWindow();
    const first = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });
    const pending = first.cookies.find((c) => c.startsWith('wabot_pending='))!;

    const res = await call('POST', '/api/login/totp', {
      cookie: pending,
      payload: { code: currentCode(row('root').totp_secret!) },
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('system');

    const session = res.cookies.find((c) => c.startsWith('wabot_session='))!;
    const me = await call('GET', '/api/me', { cookie: session });
    expect(me.status).toBe(200);
  });

  it('الرمز نفسه لا يُقبل مرتين', async () => {
    resetLoginRate();
    nextWindow();
    const code = currentCode(row('root').totp_secret!);

    const a = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });
    const r1 = await call('POST', '/api/login/totp', {
      cookie: a.cookies.find((c) => c.startsWith('wabot_pending='))!,
      payload: { code },
    });
    expect(r1.status).toBe(200);

    const b = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });
    const r2 = await call('POST', '/api/login/totp', {
      cookie: b.cookies.find((c) => c.startsWith('wabot_pending='))!,
      payload: { code },
    });
    expect(r2.status).toBe(401);
  });

  it('بلا كوكي انتظار لا يمرّ رمز صحيح', async () => {
    resetLoginRate();
    nextWindow();
    const res = await call('POST', '/api/login/totp', {
      payload: { code: currentCode(row('root').totp_secret!) },
    });
    expect(res.status).toBe(401);
  });

  it('رمز الاسترجاع يعمل ويُستهلك', async () => {
    resetLoginRate();
    nextWindow();
    // نفعّل لمستخدم آخر لنملك رموزه
    const login = await call('POST', '/api/login', { payload: { username: 'owner', password: 'owner12345' } });
    const session = login.cookies[0]!;
    const start = await call('POST', '/api/me/2fa/start', { cookie: session });
    const confirmed = await call('POST', '/api/me/2fa/confirm', {
      cookie: session,
      payload: { code: currentCode(String(start.body.secret)) },
    });
    const codes = confirmed.body.recoveryCodes as string[];

    const first = await call('POST', '/api/login', { payload: { username: 'owner', password: 'owner12345' } });
    const pending = first.cookies.find((c) => c.startsWith('wabot_pending='))!;
    const used = await call('POST', '/api/login/totp', { cookie: pending, payload: { code: codes[0] } });
    expect(used.status).toBe(200);

    // ولا يُقبل ثانية
    const again = await call('POST', '/api/login', { payload: { username: 'owner', password: 'owner12345' } });
    const pending2 = again.cookies.find((c) => c.startsWith('wabot_pending='))!;
    const reused = await call('POST', '/api/login/totp', { cookie: pending2, payload: { code: codes[0] } });
    expect(reused.status).toBe(401);
  });
});

describe('التعطيل', () => {
  it('لا يُعطَّل بلا كلمة المرور — جهاز مفتوح لا يكفي', async () => {
    resetLoginRate();
    nextWindow();
    const first = await call('POST', '/api/login', { payload: { username: 'root', password: 'root123456' } });
    const done = await call('POST', '/api/login/totp', {
      cookie: first.cookies.find((c) => c.startsWith('wabot_pending='))!,
      payload: { code: currentCode(row('root').totp_secret!) },
    });
    const session = done.cookies.find((c) => c.startsWith('wabot_session='))!;

    const bad = await call('POST', '/api/me/2fa/disable', { cookie: session, payload: { password: 'غلط' } });
    expect(bad.status).toBe(401);
    expect(row('root').totp_enabled).toBe(1);

    const ok = await call('POST', '/api/me/2fa/disable', {
      cookie: session,
      payload: { password: 'root123456' },
    });
    expect(ok.status).toBe(200);
    expect(row('root').totp_enabled).toBe(0);
    expect(row('root').totp_secret).toBeNull();
  });
});
