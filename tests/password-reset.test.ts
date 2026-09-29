/**
 * استرجاع كلمة المرور.
 *
 * مسار الاسترجاع هو الباب الخلفي لكل حساب في النظام: من يكسره يدخل
 * بحساب أي مالك منشأة. فما يُختبَر هنا الرفضُ أكثر من القبول — الرمز
 * مرة واحدة، ولوقت محدود، وبعدد محاولات محدود، ولا يُعرف من الردّ من
 * هو مسجَّل أصلاً.
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
import { TTL_MINUTES, MAX_ATTEMPTS } from '../src/password-reset.ts';
import type { Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let provider: SimulatorProvider;
let tenantId = 0;
let saraId = 0;

const post = (url: string, payload: Record<string, unknown>) =>
  server.inject({ method: 'POST', url, payload });

/** الرمز كما وصل جوال الموظف — لا كما هو في القاعدة (فهو مُجزّأ هناك). */
function sentCode(): string {
  const last = provider.outbox.at(-1)!;
  return /(\d{6})/.exec(last.text)![1]!;
}

beforeEach(async () => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  createUser(db, { tenantId, username: 'malik', password: 'malik123456', role: 'tenant' });
  saraId = addStaff(db, {
    tenantId,
    username: 'sara',
    password: 'sara12345678',
    waNumber: '966551234567',
    role: 'agent',
  }).id;
  // موظف بلا رقم: لا سبيل لإيصال الرمز إليه.
  addStaff(db, { tenantId, username: 'bila', password: 'bila12345678', role: 'agent' });

  provider = new SimulatorProvider();
  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider,
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('الطلب لا يكشف شيئاً', () => {
  /** ردٌّ مختلف للموجود وغير الموجود يحوّل النموذج إلى أداة جرد أسماء. */
  it('الردّ واحد للموجود وغير الموجود ومن بلا رقم', async () => {
    const found = await post('/api/forgot', { username: 'sara' });
    const missing = await post('/api/forgot', { username: 'لا-أحد' });
    const numberless = await post('/api/forgot', { username: 'bila' });

    expect(found.statusCode).toBe(200);
    expect(missing.statusCode).toBe(200);
    expect(numberless.statusCode).toBe(200);
    expect(found.json()).toEqual(missing.json());
    expect(found.json()).toEqual(numberless.json());
  });

  it('ولا يُرسل شيء إلا لمن يستحق', async () => {
    await post('/api/forgot', { username: 'لا-أحد' });
    await post('/api/forgot', { username: 'bila' });
    expect(provider.outbox).toHaveLength(0);

    await post('/api/forgot', { username: 'sara' });
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]!.to).toBe('966551234567');
  });

  it('والرسالة تعرّف بنفسها ولا تكتفي بالرقم', async () => {
    await post('/api/forgot', { username: 'sara' });
    const text = provider.outbox[0]!.text;
    expect(text).toContain('مطعم الركن');
    expect(text).toContain(String(TTL_MINUTES));
    expect(text).toContain('لا تشاركه');
  });
});

describe('التعيين', () => {
  beforeEach(async () => {
    await post('/api/forgot', { username: 'sara' });
  });

  it('الرمز الصحيح يغيّر كلمة المرور', async () => {
    const response = await post('/api/reset', {
      username: 'sara',
      code: sentCode(),
      password: 'jadeedah12345',
    });
    expect(response.statusCode).toBe(200);

    resetLoginRate();
    const fresh = await post('/api/login', { username: 'sara', password: 'jadeedah12345' });
    expect(fresh.statusCode).toBe(200);

    resetLoginRate();
    const old = await post('/api/login', { username: 'sara', password: 'sara12345678' });
    expect(old.statusCode).toBe(401);
  });

  it('والرمز يُستهلك مرة واحدة', async () => {
    const code = sentCode();
    await post('/api/reset', { username: 'sara', code, password: 'jadeedah12345' });

    const again = await post('/api/reset', { username: 'sara', code, password: 'ukhra12345678' });
    expect(again.statusCode).toBe(400);

    resetLoginRate();
    // كلمة المرور بقيت الأولى، فالمحاولة الثانية لم تمرّ.
    expect((await post('/api/login', { username: 'sara', password: 'jadeedah12345' })).statusCode).toBe(200);
  });

  it('وكلمة المرور القصيرة تُرفض قبل فحص الرمز', async () => {
    const response = await post('/api/reset', { username: 'sara', code: sentCode(), password: '123' });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('٨ أحرف');

    // والرمز لم يُستهلك: خطأ في الطول لا يُضيّع على الموظف رمزه.
    const retry = await post('/api/reset', { username: 'sara', code: sentCode(), password: 'jadeedah12345' });
    expect(retry.statusCode).toBe(200);
  });
});

describe('الرفض', () => {
  beforeEach(async () => {
    await post('/api/forgot', { username: 'sara' });
  });

  it('رمز خاطئ يُرفض برسالة لا تفرّق بين الأسباب', async () => {
    const response = await post('/api/reset', { username: 'sara', code: '000000', password: 'jadeedah12345' });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('غير صحيح أو انتهت صلاحيته');
  });

  it('والمحاولات المحدودة تُبطل الرمز', async () => {
    const code = sentCode();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await post('/api/reset', { username: 'sara', code: '111111', password: 'jadeedah12345' });
    }

    // حتى الرمز الصحيح لا ينفع بعد استنفاد المحاولات.
    const response = await post('/api/reset', { username: 'sara', code, password: 'jadeedah12345' });
    expect(response.statusCode).toBe(400);
  });

  it('والمنتهي لا يعمل', async () => {
    db.prepare(`UPDATE password_resets SET expires_at = datetime('now', '-1 hour')`).run();
    const response = await post('/api/reset', { username: 'sara', code: sentCode(), password: 'jadeedah12345' });
    expect(response.statusCode).toBe(400);
  });

  /**
   * طلبٌ ثانٍ يُبطل الأول.
   *
   * ولولا ذلك لصار من طلب خمس مرات يملك خمسة مفاتيح تعمل، كلٌّ منها
   * رسالة قد تُقرأ من شاشة مقفلة.
   */
  it('وطلب رمز جديد يُبطل ما قبله', async () => {
    const first = sentCode();
    await post('/api/forgot', { username: 'sara' });
    const second = sentCode();
    expect(second).not.toBe(first);

    expect((await post('/api/reset', { username: 'sara', code: first, password: 'jadeedah12345' })).statusCode).toBe(400);
    expect((await post('/api/reset', { username: 'sara', code: second, password: 'jadeedah12345' })).statusCode).toBe(200);
  });

  /** رمز موظف لا يفتح حساب مالك. */
  it('ورمز حسابٍ لا يصلح لحسابٍ آخر', async () => {
    const response = await post('/api/reset', { username: 'malik', code: sentCode(), password: 'jadeedah12345' });
    expect(response.statusCode).toBe(400);

    resetLoginRate();
    expect((await post('/api/login', { username: 'malik', password: 'malik123456' })).statusCode).toBe(200);
  });
});

describe('الأثر في السجل', () => {
  it('الطلب والتغيير يُسجَّلان', async () => {
    await post('/api/forgot', { username: 'sara' });
    await post('/api/reset', { username: 'sara', code: sentCode(), password: 'jadeedah12345' });

    const actions = db
      .prepare('SELECT action FROM audit_log ORDER BY id')
      .all()
      .map((r) => (r as { action: string }).action);

    expect(actions).toContain('password_reset_requested');
    expect(actions).toContain('password_changed');
    expect(saraId).toBeGreaterThan(0);
  });
});
