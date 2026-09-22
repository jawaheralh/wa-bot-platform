/**
 * وضع «عرض فقط».
 *
 * المحك: لا يخرج أي بايت إلى واتساب مهما كان مصدر الإرسال — بوت أو موظف
 * أو تنبيه أو تذكير موعد. ويبقى كل شيء آخر يعمل: الاستقبال والحفظ والعرض.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, silentLogger, mockClaude } from './helpers.ts';
import { ReadOnlyProvider } from '../src/whatsapp/read-only.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { createNotifier } from '../src/notify.ts';
import { getOrCreateConversation, recentMessages, type Db, type TenantRow } from '../src/db/index.ts';
import { setEnabled } from '../src/modules/registry.ts';
import { bookingsModule } from '../src/modules/bookings.ts';
import { addStaff } from '../src/staff.ts';
import { now, addMinutes } from '../src/time.ts';

let db: Db;
let tenant: TenantRow;
let inner: SimulatorProvider;
let provider: ReadOnlyProvider;

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db, { staffWaNumber: '966500000099' });
  inner = new SimulatorProvider();
  provider = new ReadOnlyProvider(inner, silentLogger());
});
afterEach(() => db.close());

describe('حجب الإرسال', () => {
  it('لا شيء يصل المزوّد الحقيقي', async () => {
    await provider.sendText(tenant.id, '966555555555', 'أهلاً');
    expect(inner.outbox).toHaveLength(0);
    expect(provider.blocked).toHaveLength(1);
    expect(provider.blocked[0]?.text).toBe('أهلاً');
  });

  it('يُعيد نجاحاً وهمياً فلا يُسجَّل فشل ولا يُنبَّه الموظف عبثاً', async () => {
    const result = await provider.sendText(tenant.id, '966555555555', 'س');
    expect(result.id).toMatch(/^readonly-/);
  });

  it('اسم المزوّد يُظهر الوضع في اللوحة', () => {
    expect(provider.name).toContain('عرض فقط');
    expect(provider.status(tenant.id).detail).toContain('عرض فقط');
  });

  it('السجل المحجوب لا ينمو بلا حد', async () => {
    for (let i = 0; i < 520; i++) await provider.sendText(tenant.id, '966555555555', `رسالة ${i}`);
    expect(provider.blocked.length).toBeLessThanOrEqual(500);
    expect(provider.blocked.at(-1)?.text).toBe('رسالة 519');
  });
});

describe('الاستقبال يبقى كاملاً', () => {
  it('رسالة العميل تُحفظ وتظهر، ورد البوت يُحجب', async () => {
    const app = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', readOnly: true, anthropicApiKey: 'test' },
      db,
      provider,
      logger: silentLogger(),
    });
    provider.onMessage(createEngine({ app, claude: mockClaude([{ text: 'هلا والله' }]) }));

    await inner.receive({ toNumber: tenant.wa_number, from: '966555555555', text: 'متى تفتحون؟' });

    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    const messages = recentMessages(db, conv.id, 10);

    // رسالة العميل محفوظة، والرد محفوظ في السجل للاطلاع، لكن لم يُرسل
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ['customer', 'متى تفتحون؟'],
      ['bot', 'هلا والله'],
    ]);
    expect(inner.outbox).toHaveLength(0);
    expect(provider.blocked.map((b) => b.text)).toEqual(['هلا والله']);
  });
});

describe('كل مسارات الإرسال محجوبة', () => {
  it('تنبيه الموظف لا يخرج', async () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    await createNotifier(db, provider, silentLogger())(tenant.id, 'complaint', 'شكوى عاجلة');

    expect(inner.outbox).toHaveLength(0);
    // التنبيه محفوظ في اللوحة رغم حجب الواتساب — لا يضيع
    expect(db.prepare('SELECT COUNT(*) AS n FROM alerts').get()).toEqual({ n: 1 });
  });

  it('تذكير الموعد لا يخرج', async () => {
    setEnabled(db, tenant.id, 'bookings', true);
    db.prepare(
      `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
       VALUES (?, 'MWD-2026-000001', '966555555555', 'كشف', ?, ?)`,
    ).run(tenant.id, addMinutes(now(), 60), addMinutes(now(), 90));

    await bookingsModule.onTick!(tenant, bookingsModule.defaultConfig(), {
      db,
      config: { ...loadConfig(), readOnly: true },
      logger: silentLogger(),
      provider,
      notify: async () => {},
    });

    expect(inner.outbox).toHaveLength(0);
    expect(provider.blocked[0]?.text).toContain('تذكير بموعدك');
  });
});

describe('الوضع العادي غير متأثر', () => {
  it('بلا READ_ONLY تُرسل الرسائل فعلاً', async () => {
    const app = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', readOnly: false, anthropicApiKey: 'test' },
      db,
      provider: inner,
      logger: silentLogger(),
    });
    inner.onMessage(createEngine({ app, claude: mockClaude([{ text: 'أهلاً بك' }]) }));

    await inner.receive({ toNumber: tenant.wa_number, from: '966555555555', text: 'سلام' });
    expect(inner.outbox.map((m) => m.text)).toEqual(['أهلاً بك']);
  });
});

describe('حماية رقم Cloud API من Baileys', () => {
  it('الرقم المسجَّل في Meta لا تُفتح له جلسة QR', async () => {
    const cloudTenant = seedTenant(db, {
      name: 'الرقم الموحّد',
      waNumber: '966920000000',
      waPhoneNumberId: 'PNID_EXAMPLE',
    });

    const { BaileysProvider } = await import('../src/whatsapp/baileys.ts');
    const baileys = new BaileysProvider(db, '/tmp/baileys-test-never-used', silentLogger());

    // لا يرمي، ولا يفتح جلسة، ويُسجّل الرفض في الحالة
    await baileys.start();
    const status = baileys.status(cloudTenant.id);
    expect(status.connected).toBe(false);
    expect(status.detail).toContain('مرفوض');

    // ولا حتى عند إضافة المنشأة لاحقاً
    await baileys.refreshTenant(cloudTenant.id);
    expect(baileys.status(cloudTenant.id).detail).toContain('مرفوض');
    await baileys.stop();
  });
});
