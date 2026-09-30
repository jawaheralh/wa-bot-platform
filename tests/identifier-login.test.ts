/**
 * الدخول والاسترجاع بثلاثة معرّفات: الاسم والبريد والجوال.
 *
 * الموظف يتذكّر جواله وبريده ولا يتذكّر «rukn_ops_2». وإلزامه باسم
 * المستخدم وحده يعني مكالمةً لمالكه كلما نسيه — وهي أكثر تكراراً من
 * نسيان كلمة المرور نفسها.
 *
 * وأخطر ما هنا التكرار: اسم المستخدم فريد في القاعدة، أما البريد
 * والجوال فلا. فلو تصادف بريدان متطابقان لَمَا عُرف أيُّ حسابٍ يُفتح،
 * وإرجاع «الأول» يفتح حساب شخصٍ لمن يملك بيانات آخر.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { addStaff, updateStaff } from '../src/staff.ts';
import { findUserByIdentifier } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import type { Db } from '../src/db/index.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let provider: SimulatorProvider;
let tenantId = 0;

const login = (username: string, password = 'sara12345678') => {
  resetLoginRate();
  return server.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
};

const forgot = (username: string) => {
  resetLoginRate();
  return server.inject({ method: 'POST', url: '/api/forgot', payload: { username } });
};

beforeEach(async () => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  addStaff(db, {
    tenantId,
    username: 'sara',
    password: 'sara12345678',
    displayName: 'سارة',
    waNumber: '966551234567',
    email: 'Sara@Rukn.SA',
    role: 'agent',
  });

  provider = new SimulatorProvider();
  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider,
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
});

afterEach(async () => {
  await server.close();
  db.close();
});

describe('الدخول بالثلاثة', () => {
  it('بالاسم', async () => {
    expect((await login('sara')).statusCode).toBe(200);
  });

  it('وبالبريد بأي حالة أحرف', async () => {
    expect((await login('sara@rukn.sa')).statusCode).toBe(200);
    expect((await login('SARA@RUKN.SA')).statusCode).toBe(200);
  });

  /** الموظف يكتب رقمه كما يكتبه في جواله لا كما نخزّنه نحن. */
  it('وبالجوال بأي صيغة يكتبها', async () => {
    for (const form of ['966551234567', '0551234567', '+966 55 123 4567', '+966-55-123-4567']) {
      expect((await login(form)).statusCode).toBe(200);
    }
  });

  it('وكلمة مرور خاطئة تُرفض مهما كان المعرّف', async () => {
    expect((await login('sara@rukn.sa', 'غلط')).statusCode).toBe(401);
    expect((await login('0551234567', 'غلط')).statusCode).toBe(401);
  });

  /** رسالة واحدة لكل الأسباب: لا تكشف أيُّ بريدٍ مسجَّل وأيٌّ ليس. */
  it('ورسالة الرفض لا تفرّق بين معرّف مجهول وكلمة خاطئة', async () => {
    const unknown = await login('لا-أحد@مكان.sa');
    const wrong = await login('sara', 'غلط');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe(wrong.json().error);
  });
});

describe('التكرار', () => {
  it('البريد المكرر يُرفض عند الحفظ', () => {
    expect(() =>
      addStaff(db, { tenantId, username: 'thani', password: 'thani1234567', email: 'sara@rukn.sa', role: 'agent' }),
    ).toThrow(/مستعمل لحساب آخر/);
  });

  it('والجوال المكرر كذلك', () => {
    expect(() =>
      addStaff(db, {
        tenantId,
        username: 'thani',
        password: 'thani1234567',
        waNumber: '0551234567',
        role: 'agent',
      }),
    ).toThrow(/مستعمل لحساب آخر/);
  });

  it('وتعديل الحساب بنفس بريده لا يُرفض', () => {
    const sara = db.prepare("SELECT id FROM users WHERE username = 'sara'").get() as { id: number };
    expect(() => updateStaff(db, tenantId, sara.id, { email: 'sara@rukn.sa' })).not.toThrow();
  });

  /**
   * الحارس عند الكتابة لا يمنع تكراراً سابقاً، فالقراءة تحتاط:
   * معرّفٌ يطابق حسابين لا يفتح أيّهما.
   */
  it('ولو تكرر في القاعدة رغم ذلك لم يفتح أيَّ حساب', () => {
    addStaff(db, { tenantId, username: 'thani', password: 'thani1234567', role: 'agent' });
    db.prepare("UPDATE users SET email = 'sara@rukn.sa' WHERE username = 'thani'").run();

    expect(findUserByIdentifier(db, 'sara@rukn.sa')).toBeUndefined();
    // والاسم الفريد يبقى بابه مفتوحاً.
    expect(findUserByIdentifier(db, 'sara')?.username).toBe('sara');
  });
});

describe('الاسترجاع بالثلاثة', () => {
  it('يصل الرمز أياً كان المعرّف المكتوب', async () => {
    for (const identifier of ['sara', 'sara@rukn.sa', '0551234567']) {
      provider.outbox.length = 0;
      const response = await forgot(identifier);
      expect(response.statusCode).toBe(200);
      expect(provider.outbox).toHaveLength(1);
    }
  });

  it('ومعرّف مجهول يُجاب بنفس الردّ بلا إرسال', async () => {
    const known = await forgot('sara');
    provider.outbox.length = 0;

    const unknown = await forgot('mystery@nowhere.sa');
    expect(unknown.json()).toEqual(known.json());
    expect(provider.outbox).toHaveLength(0);
  });
});
