/**
 * بيانات Meta لكل منشأة.
 *
 * المحك التجاري: عميلان بحسابَي Meta مختلفين يعملان معاً على نفس النظام،
 * ولا يستطيع أحدهما الإرسال بتوكن الآخر.
 *
 * والافتراض الفصل لا التوارث: منشأة بلا بيانات خاصة لا ترث بيانات أول
 * عميل أُعدّ النظام له، فتعمل تحت تطبيقه وتُحمّل فاتورتها عليه بلا أن
 * يرى أحد عطلاً — كل شيء يعمل.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { credentialsFor, allAppSecrets, tenantsByApp } from '../src/tenant-meta.ts';
import { CloudApiProvider } from '../src/whatsapp/cloud-api.ts';
import { getTenant, type Db } from '../src/db/index.ts';

const GLOBAL = { token: 'GLOBAL_TOKEN', secret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', app: 'APP_GLOBAL', biz: 'BIZ_GLOBAL' };
const OWN = { token: 'OWN_TOKEN', secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', app: 'APP_OWN', biz: 'BIZ_OWN' };

function config(): AppConfig {
  return {
    ...loadConfig(),
    provider: 'cloud',
    sharedMetaFallback: false,
    cloud: {
      verifyToken: 'v',
      appSecret: GLOBAL.secret,
      accessToken: GLOBAL.token,
      graphVersion: 'v23.0',
      appId: GLOBAL.app,
      businessId: GLOBAL.biz,
    },
  };
}

let db: Db;

/** منشأة بحساب Meta خاص بها. */
function seedOwn(name: string, waNumber: string, phoneNumberId: string): number {
  const tenant = seedTenant(db, { name, waNumber, waPhoneNumberId: phoneNumberId });
  db.prepare(
    `UPDATE tenants SET wa_access_token = ?, wa_app_secret = ?, wa_app_id = ?, wa_business_id = ? WHERE id = ?`,
  ).run(OWN.token, OWN.secret, OWN.app, OWN.biz, tenant.id);
  return tenant.id;
}

beforeEach(() => {
  db = freshDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('اختيار بيانات الاعتماد', () => {
  it('منشأة بلا حساب خاص لا ترث شيئاً — هذا هو الافتراض', () => {
    const tenant = seedTenant(db, { name: 'عادية', waPhoneNumberId: 'PN1' });
    const c = credentialsFor(config(), getTenant(db, tenant.id));
    expect(c.accessToken).toBe('');
    expect(c.appSecret).toBe('');
    expect(c.own).toBe(false);
  });

  it('وترث فقط حين يُطلب التوارث صراحةً', () => {
    const tenant = seedTenant(db, { name: 'عادية', waPhoneNumberId: 'PN1' });
    const shared = { ...config(), sharedMetaFallback: true };
    const c = credentialsFor(shared, getTenant(db, tenant.id));
    expect(c.accessToken).toBe(GLOBAL.token);
    expect(c.own).toBe(false);
  });

  it('منشأة بحساب خاص تستعمله', () => {
    const id = seedOwn('خاصة', '966500000002', 'PN2');
    const c = credentialsFor(config(), getTenant(db, id));
    expect(c.accessToken).toBe(OWN.token);
    expect(c.appId).toBe(OWN.app);
    expect(c.own).toBe(true);
  });

  it('حساب ناقص (توكن بلا سرّ) لا يُعدّ خاصاً', () => {
    const tenant = seedTenant(db, { name: 'ناقصة', waPhoneNumberId: 'PN3' });
    db.prepare('UPDATE tenants SET wa_access_token = ? WHERE id = ?').run('X', tenant.id);
    expect(credentialsFor(config(), getTenant(db, tenant.id)).own).toBe(false);
  });
});

describe('الإرسال بتوكن المنشأة', () => {
  it('كل منشأة تُرسل بتوكنها هي', async () => {
    const ownId = seedOwn('خاصة', '966500000002', 'PN_OWN');
    const otherId = seedTenant(db, { name: 'أخرى', waNumber: '966500000004', waPhoneNumberId: 'PN_OTHER' }).id;
    db.prepare('UPDATE tenants SET wa_access_token=?, wa_app_secret=?, wa_app_id=? WHERE id=?')
      .run('TOKEN_2', 'dddddddddddddddddddddddddddddddd', 'APP_2', otherId);

    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ messages: [{ id: 'x' }] }), { status: 200 });
    });

    const provider = new CloudApiProvider(db, config(), silentLogger());
    await provider.sendText(ownId, '966555555555', 'أ');
    await provider.sendText(otherId, '966555555555', 'ب');

    expect(calls[0]?.auth).toBe(`Bearer ${OWN.token}`);
    expect(calls[0]?.url).toContain('PN_OWN');
    expect(calls[1]?.auth).toBe('Bearer TOKEN_2');
    expect(calls[1]?.url).toContain('PN_OTHER');
  });

  /** الأهم تجارياً: عميل جديد لا يُرسل بتوكن عميل قديم. */
  it('منشأة بلا بيانات خاصة تُرفض ولا تُرسل بتوكن غيرها', async () => {
    const plain = seedTenant(db, { name: 'جديدة', waNumber: '966500000001', waPhoneNumberId: 'PN_PLAIN' });
    const provider = new CloudApiProvider(db, config(), silentLogger());
    await expect(provider.sendText(plain.id, '966555555555', 'أ')).rejects.toThrow(/توكن Meta/);
  });

  it('منشأة بلا توكن ولا حساب عام تُرفض برسالة واضحة', async () => {
    const tenant = seedTenant(db, { name: 'بلا توكن', waPhoneNumberId: 'PN_X' });
    const bare = { ...config(), cloud: { ...config().cloud, accessToken: '' } };
    const provider = new CloudApiProvider(db, bare, silentLogger());
    await expect(provider.sendText(tenant.id, '966555555555', 'س')).rejects.toThrow(/توكن Meta/);
  });
});

describe('التحقق من التوقيع', () => {
  it('يقبل توقيع الحساب العام وتوقيع حساب المنشأة الخاص', () => {
    seedTenant(db, { name: 'عادية', waNumber: '966500000001', waPhoneNumberId: 'PN_PLAIN' });
    seedOwn('خاصة', '966500000002', 'PN_OWN');

    const provider = new CloudApiProvider(db, config(), silentLogger());
    const body = '{"entry":[]}';

    for (const secret of [GLOBAL.secret, OWN.secret]) {
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      expect(provider.verifySignature(body, signature)).toBe(true);
    }
  });

  it('يرفض سرّاً لا يخص أي منشأة', () => {
    seedOwn('خاصة', '966500000002', 'PN_OWN');
    const provider = new CloudApiProvider(db, config(), silentLogger());
    const body = '{"entry":[]}';
    const signature = `sha256=${createHmac('sha256', 'cccccccccccccccccccccccccccccccc').update(body).digest('hex')}`;
    expect(provider.verifySignature(body, signature)).toBe(false);
  });

  it('الأسرار المجمَّعة بلا تكرار', () => {
    seedTenant(db, { name: 'عادية', waNumber: '966500000001' });
    seedOwn('خاصة', '966500000002', 'PN_OWN');
    seedOwn('خاصة٢', '966500000003', 'PN_OWN2');

    const secrets = allAppSecrets(db, config());
    expect(secrets).toHaveLength(2);           // العام + الخاص (المكرر مرة)
    expect(secrets).toContain(GLOBAL.secret);
    expect(secrets).toContain(OWN.secret);
  });
});

describe('تجميع المنشآت بالتطبيق', () => {
  it('لا تُسجَّل webhook لمنشأة بلا بيانات خاصة', () => {
    seedTenant(db, { name: 'أ', waNumber: '966500000001', waPhoneNumberId: 'PN1' });
    seedTenant(db, { name: 'ب', waNumber: '966500000002', waPhoneNumberId: 'PN2' });
    seedOwn('ج', '966500000003', 'PN3');

    const groups = tenantsByApp(db, config());
    // الخاصة وحدها — الاثنتان بلا بيانات لا تُسجَّلان تحت تطبيق غيرهما
    expect(groups.size).toBe(1);
    expect(groups.get(OWN.app)?.tenants).toHaveLength(1);
    expect(groups.get(GLOBAL.app)).toBeUndefined();
  });

  it('ومع التوارث الصريح تنضم للمجموعة العامة', () => {
    seedTenant(db, { name: 'أ', waNumber: '966500000001', waPhoneNumberId: 'PN1' });
    seedOwn('ج', '966500000003', 'PN3');

    const groups = tenantsByApp(db, { ...config(), sharedMetaFallback: true });
    expect(groups.size).toBe(2);
    expect(groups.get(GLOBAL.app)?.tenants).toHaveLength(1);
  });

  it('المنشأة الموقوفة أو بلا معرّف رقم تُستثنى', () => {
    const a = seedTenant(db, { name: 'موقوفة', waNumber: '966500000001', waPhoneNumberId: 'PN1' });
    db.prepare(`UPDATE tenants SET status='suspended' WHERE id=?`).run(a.id);
    seedTenant(db, { name: 'بلا معرّف', waNumber: '966500000002' });

    expect(tenantsByApp(db, config()).size).toBe(0);
  });
});

describe('مفتاح Claude لكل منشأة', () => {
  it('المنشأة بمفتاحها الخاص، وغيرها بالمفتاح العام', async () => {
    const { claudeFor, forgetClaudeCache } = await import('../src/tenant-claude.ts');
    forgetClaudeCache();

    const plain = seedTenant(db, { name: 'عادية', waNumber: '966500000001' });
    const own = seedTenant(db, { name: 'خاصة', waNumber: '966500000002' });
    db.prepare('UPDATE tenants SET anthropic_api_key = ? WHERE id = ?').run('sk-ant-own', own.id);

    const base = { ...config(), anthropicApiKey: 'sk-ant-global' };
    expect(claudeFor(base, getTenant(db, plain.id)!, silentLogger())?.own).toBe(false);
    expect(claudeFor(base, getTenant(db, own.id)!, silentLogger())?.own).toBe(true);
  });

  it('بلا مفتاح خاص ولا عام: لا عميل', async () => {
    const { claudeFor } = await import('../src/tenant-claude.ts');
    const tenant = seedTenant(db, { name: 'بلا مفتاح' });
    expect(claudeFor({ ...config(), anthropicApiKey: '' }, getTenant(db, tenant.id)!, silentLogger())).toBeUndefined();
  });

  it('الاستهلاك يُعدّ لكل منشأة على حدة', async () => {
    const { recordUsage, usageThisMonth } = await import('../src/tenant-claude.ts');
    const a = seedTenant(db, { name: 'أ', waNumber: '966500000001' });
    const b = seedTenant(db, { name: 'ب', waNumber: '966500000002' });

    recordUsage(db, a.id, 'replies', 3);
    recordUsage(db, a.id, 'tool_calls', 2);
    recordUsage(db, a.id, 'failures');
    recordUsage(db, b.id, 'replies');

    expect(usageThisMonth(db, a.id)).toMatchObject({ replies: 3, tool_calls: 2, failures: 1 });
    expect(usageThisMonth(db, b.id)).toMatchObject({ replies: 1, tool_calls: 0 });
  });
});

describe('المحرّك يحترم العميل المُمرَّر', () => {
  it('منشأة بلا مفتاح خاص تستعمل العميل المحقون لا عميلاً جديداً', async () => {
    const { buildApp } = await import('../src/app.ts');
    const { createEngine } = await import('../src/bot/engine.ts');
    const { SimulatorProvider } = await import('../src/whatsapp/simulator.ts');
    const { mockClaude } = await import('./helpers.ts');

    const tenant = seedTenant(db, { name: 'بلا مفتاح خاص', waNumber: '966500000009' });
    const provider = new SimulatorProvider();
    const app = await buildApp({
      // مفتاح عام موجود — ومع ذلك يجب أن يُستعمل المحقون
      config: { ...loadConfig(), provider: 'simulator', anthropicApiKey: 'sk-ant-global' },
      db,
      provider,
      logger: silentLogger(),
    });
    const claude = mockClaude([{ text: 'من العميل المحقون' }]);
    provider.onMessage(createEngine({ app, claude }));

    await provider.receive({ toNumber: tenant.wa_number, from: '966555555555', text: 'سلام' });

    expect(claude.requests).toHaveLength(1);
    expect(provider.outbox[0]?.text).toBe('من العميل المحقون');
  });
});

describe('تقدير التكلفة والوفر', () => {
  it('الوفر يُحسب من عدّادات التخزين الحقيقية', async () => {
    const { estimateInputCost } = await import('../src/tenant-claude.ts');

    // ما قِيس فعلياً: كتابة مرة، ثم ثلاث قراءات
    const cost = estimateInputCost({
      month: '2026-09',
      replies: 4,
      tool_calls: 0,
      failures: 0,
      cache_written: 7019,
      cache_read: 7019 * 3,
      uncached: 535,
    });

    expect(cost.actual).toBeLessThan(cost.withoutCache);
    expect(cost.savedPercent).toBeGreaterThan(50);
  });

  it('بلا استهلاك: صفر بلا قسمة على صفر', async () => {
    const { estimateInputCost } = await import('../src/tenant-claude.ts');
    const cost = estimateInputCost({
      month: '2026-09', replies: 0, tool_calls: 0, failures: 0,
      cache_written: 0, cache_read: 0, uncached: 0,
    });
    expect(cost.actual).toBe(0);
    expect(cost.savedPercent).toBe(0);
  });

  it('الوفر يزيد كلما كثرت القراءات — الكتابة تُستهلك مرة', async () => {
    const { estimateInputCost } = await import('../src/tenant-claude.ts');
    const few = estimateInputCost({
      month: '2026-09', replies: 2, tool_calls: 0, failures: 0,
      cache_written: 7000, cache_read: 7000, uncached: 260,
    });
    const many = estimateInputCost({
      month: '2026-09', replies: 50, tool_calls: 0, failures: 0,
      cache_written: 7000, cache_read: 7000 * 49, uncached: 6500,
    });
    expect(many.savedPercent).toBeGreaterThan(few.savedPercent);
    expect(many.savedPercent).toBeGreaterThan(80);
  });
});
