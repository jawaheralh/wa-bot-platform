/**
 * وحدة الحجوزات.
 *
 * أهم قسم هنا هو الأول: إثبات أن الوحدة المبنية كاملةً لا يراها النموذج
 * حتى تُفعَّل. هذا هو وعد نظام الوحدات كله في اختبار واحد.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, baseContext, silentLogger, mockClaude } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { composeTools, composePrompt, enabledFor, setEnabled, setConfig } from '../src/modules/registry.ts';
import {
  bookingsModule,
  availableSlots,
  listBookings,
  findBooking,
  cancelBooking,
} from '../src/modules/bookings.ts';
import { getOrCreateConversation, type Db, type TenantRow } from '../src/db/index.ts';
import type { ModuleContext } from '../src/modules/types.ts';
import { now, today, addMinutes } from '../src/time.ts';

let db: Db;
let tenant: TenantRow;

/** الاثنين القادم دائماً يوم عمل في الإعداد الافتراضي (الجمعة وحدها إجازة). */
function workday(): string {
  for (let i = 1; i <= 7; i++) {
    const date = today(i);
    if (new Date(`${date}T12:00:00+03:00`).getUTCDay() !== 5) return date;
  }
  return today(1);
}

function ctx(overrides: Record<string, unknown> = {}, nowSql = `${today()} 08:00:00`): ModuleContext {
  const base = baseContext(db, tenant);
  return {
    ...base,
    conversation: getOrCreateConversation(db, tenant.id, '966555555555'),
    now: nowSql,
    config: { ...bookingsModule.defaultConfig(), ...overrides },
  };
}

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db);
});
afterEach(() => db.close());

describe('الوحدة المعطّلة لا يراها النموذج', () => {
  it('أدوات الحجز غائبة قبل التفعيل وحاضرة بعده', () => {
    const base = baseContext(db, tenant);

    const before = composeTools(enabledFor(db, tenant.id), base).map((t) => t.name);
    expect(before).not.toContain('book_appointment');
    expect(before).not.toContain('get_available_slots');
    expect(before).not.toContain('cancel_appointment');

    setEnabled(db, tenant.id, 'bookings', true);
    const after = composeTools(enabledFor(db, tenant.id), base).map((t) => t.name);
    expect(after).toEqual(expect.arrayContaining(['get_available_slots', 'book_appointment', 'cancel_appointment']));

    setEnabled(db, tenant.id, 'bookings', false);
    expect(composeTools(enabledFor(db, tenant.id), base).map((t) => t.name)).not.toContain('book_appointment');
  });

  it('تعليمات الحجز لا تدخل الـprompt قبل التفعيل', () => {
    const base = baseContext(db, tenant);
    expect(composePrompt(enabledFor(db, tenant.id), base)).not.toContain('## الحجوزات');

    setEnabled(db, tenant.id, 'bookings', true);
    expect(composePrompt(enabledFor(db, tenant.id), base)).toContain('## الحجوزات');
  });

  it('جدول bookings موجود دائماً حتى والوحدة معطّلة', () => {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'`)
      .get();
    expect(table).toBeDefined();
  });

  it('محرّك البوت لا يمرر أدوات الحجز لمنشأة لم تُفعّلها', async () => {
    const provider = new SimulatorProvider();
    const config = { ...loadConfig(), provider: 'simulator' as const, anthropicApiKey: 'test' };
    const app = await buildApp({ config, db, provider, logger: silentLogger() });
    const claude = mockClaude([{ text: 'تم' }]);
    provider.onMessage(createEngine({ app, claude }));

    await provider.receive({ toNumber: tenant.wa_number, from: '966555555555', text: 'أبي أحجز' });
    expect(claude.requests[0]!.tools.map((t) => t.name)).not.toContain('book_appointment');

    setEnabled(db, tenant.id, 'bookings', true);
    await provider.receive({ toNumber: tenant.wa_number, from: '966555555555', text: 'أبي أحجز' });
    expect(claude.requests[1]!.tools.map((t) => t.name)).toContain('book_appointment');
  });
});

describe('توليد الفترات', () => {
  beforeEach(() => setEnabled(db, tenant.id, 'bookings', true));

  it('الفترات تتولد من ساعات العمل وبطول الخدمة', () => {
    const date = workday();
    const slots = availableSlots(
      db,
      tenant.id,
      {
        ...bookingsModule.defaultConfig(),
        workingHours: { [String(new Date(`${date}T12:00:00+03:00`).getUTCDay())]: [{ from: '09:00', to: '11:00' }] },
      } as never,
      date,
      'كشف',
      `${date} 08:00:00`,
    );
    expect(slots).toEqual([
      `${date} 09:00:00`,
      `${date} 09:30:00`,
      `${date} 10:00:00`,
      `${date} 10:30:00`,
    ]);
  });

  it('الخدمة الأطول لا تتجاوز وقت الإغلاق', () => {
    const date = workday();
    const day = String(new Date(`${date}T12:00:00+03:00`).getUTCDay());
    const slots = availableSlots(
      db,
      tenant.id,
      {
        ...bookingsModule.defaultConfig(),
        workingHours: { [day]: [{ from: '09:00', to: '10:00' }] },
        services: [{ name: 'علاج', minutes: 45 }],
      } as never,
      date,
      'علاج',
      `${date} 08:00:00`,
    );
    // ٠٩:٠٠ فقط: ٠٩:٣٠ + ٤٥ دقيقة تتجاوز ١٠:٠٠
    expect(slots).toEqual([`${date} 09:00:00`]);
  });

  it('يوم الإجازة بلا فترات', async () => {
    const result = await bookingsModule.runTool(
      'get_available_slots',
      { date: today(0), service: 'كشف' },
      ctx({ workingHours: { '0': [], '1': [], '2': [], '3': [], '4': [], '5': [], '6': [] } }),
    );
    expect(result.content).toMatch(/إجازة|لا توجد فترات/);
  });

  it('الفترات الماضية اليوم لا تُعرض', () => {
    const date = today();
    const day = String(new Date(`${date}T12:00:00+03:00`).getUTCDay());
    const slots = availableSlots(
      db,
      tenant.id,
      { ...bookingsModule.defaultConfig(), workingHours: { [day]: [{ from: '09:00', to: '12:00' }] } } as never,
      date,
      'كشف',
      `${date} 10:15:00`,
    );
    expect(slots).toEqual([`${date} 10:30:00`, `${date} 11:00:00`, `${date} 11:30:00`]);
  });

  it('الحجز أبعد من الحد الأقصى يُرفض بلطف', async () => {
    const result = await bookingsModule.runTool(
      'get_available_slots',
      { date: today(90), service: 'كشف' },
      ctx(),
    );
    expect(result.content).toContain('الحجز متاح حتى');
  });

  it('تاريخ غير مفهوم لا يُخمَّن', async () => {
    const result = await bookingsModule.runTool('get_available_slots', { date: 'قريباً', service: 'كشف' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('غير مفهوم');
  });
});

describe('الحجز والتعارض', () => {
  beforeEach(() => setEnabled(db, tenant.id, 'bookings', true));

  it('حجز ناجح يُنتج رقماً مرجعياً وصفاً في القاعدة', async () => {
    const date = workday();
    const result = await bookingsModule.runTool(
      'book_appointment',
      { date, time: '10:00', service: 'كشف', customer_name: 'سارة' },
      ctx({}, `${date} 08:00:00`),
    );

    const booking = listBookings(db, tenant.id)[0]!;
    expect(result.content).toContain(booking.reference);
    expect(booking.reference).toMatch(/^MWD-\d{4}-\d{6}$/);
    expect(booking.starts_at).toBe(`${date} 10:00:00`);
    expect(booking.ends_at).toBe(`${date} 10:30:00`);
    expect(booking.customer_name).toBe('سارة');
  });

  it('التعارض يُرفض حين maxConcurrent = 1', async () => {
    const date = workday();
    const at = ctx({}, `${date} 08:00:00`);

    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    const second = await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);

    expect(second.isError).toBe(true);
    expect(second.content).toContain('غير متاحة');
    expect(listBookings(db, tenant.id)).toHaveLength(1);
  });

  it('التداخل الجزئي يُرفض أيضاً لا المطابق فقط', async () => {
    const date = workday();
    const at = ctx({ services: [{ name: 'علاج', minutes: 60 }], slotMinutes: 30 }, `${date} 08:00:00`);

    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'علاج' }, at);
    // ١٠:٣٠ يتداخل مع ١٠:٠٠–١١:٠٠
    const overlap = await bookingsModule.runTool('book_appointment', { date, time: '10:30', service: 'علاج' }, at);
    expect(overlap.isError).toBe(true);
    expect(listBookings(db, tenant.id)).toHaveLength(1);
  });

  it('maxConcurrent أكبر من واحد يسمح بالتوازي حتى الحد', async () => {
    const date = workday();
    const at = ctx({ maxConcurrent: 2 }, `${date} 08:00:00`);

    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    const second = await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    const third = await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);

    expect(second.isError).toBeUndefined();
    expect(third.isError).toBe(true);
    expect(listBookings(db, tenant.id).filter((b) => b.status === 'booked')).toHaveLength(2);
  });

  it('حجز خارج ساعات العمل يُرفض', async () => {
    const date = workday();
    const result = await bookingsModule.runTool(
      'book_appointment',
      { date, time: '23:00', service: 'كشف' },
      ctx({}, `${date} 08:00:00`),
    );
    expect(result.isError).toBe(true);
    expect(listBookings(db, tenant.id)).toHaveLength(0);
  });

  it('حجز في الماضي يُرفض', async () => {
    const date = today();
    const result = await bookingsModule.runTool(
      'book_appointment',
      { date, time: '09:00', service: 'كشف' },
      ctx({}, `${date} 14:00:00`),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('مضى');
  });

  it('الإلغاء يحرّر الفترة لعميل آخر', async () => {
    const date = workday();
    const at = ctx({}, `${date} 08:00:00`);

    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    const booking = listBookings(db, tenant.id)[0]!;

    await bookingsModule.runTool('cancel_appointment', { reference: booking.reference }, at);
    expect(findBooking(db, tenant.id, booking.reference)?.status).toBe('cancelled');

    const rebook = await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    expect(rebook.isError).toBeUndefined();
  });

  it('العميل لا يستطيع إلغاء موعد غيره ولو عرف رقمه', async () => {
    const date = workday();
    const at = ctx({}, `${date} 08:00:00`);
    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, at);
    const booking = listBookings(db, tenant.id)[0]!;

    const intruderConversation = getOrCreateConversation(db, tenant.id, '966555555599');
    const result = await bookingsModule.runTool(
      'cancel_appointment',
      { reference: booking.reference },
      { ...at, conversation: intruderConversation },
    );

    expect(result.isError).toBe(true);
    expect(findBooking(db, tenant.id, booking.reference)?.status).toBe('booked');
  });

  it('موعد منشأة لا يُلغى من منشأة أخرى', async () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const date = workday();
    await bookingsModule.runTool('book_appointment', { date, time: '10:00', service: 'كشف' }, ctx({}, `${date} 08:00:00`));
    const booking = listBookings(db, tenant.id)[0]!;

    expect(() => cancelBooking(db, other.id, booking.reference)).toThrow(/غير موجود/);
  });
});

describe('التذكيرات', () => {
  beforeEach(() => setEnabled(db, tenant.id, 'bookings', true));

  it('يُرسل تذكير للموعد القريب مرة واحدة فقط', async () => {
    const provider = new SimulatorProvider();
    const deps = {
      db,
      config: loadConfig(),
      logger: silentLogger(),
      provider,
      notify: async () => {},
    };
    const config = bookingsModule.defaultConfig() as { reminderHours: number };

    db.prepare(
      `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
       VALUES (?, 'MWD-2026-000001', '966555555555', 'كشف', ?, ?)`,
    ).run(tenant.id, addMinutes(now(), 60), addMinutes(now(), 90));

    await bookingsModule.onTick!(tenant, config, deps);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]?.text).toContain('تذكير بموعدك');

    await bookingsModule.onTick!(tenant, config, deps);
    expect(provider.outbox).toHaveLength(1);
  });

  it('الموعد البعيد لا يُذكَّر به بعد', async () => {
    const provider = new SimulatorProvider();
    db.prepare(
      `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
       VALUES (?, 'MWD-2026-000002', '966555555555', 'كشف', ?, ?)`,
    ).run(tenant.id, addMinutes(now(), 60 * 10), addMinutes(now(), 60 * 10 + 30));

    await bookingsModule.onTick!(tenant, bookingsModule.defaultConfig(), {
      db,
      config: loadConfig(),
      logger: silentLogger(),
      provider,
      notify: async () => {},
    });
    expect(provider.outbox).toHaveLength(0);
  });

  it('فشل الإرسال لا يُعلّم التذكير كمُرسَل', async () => {
    const provider = new SimulatorProvider();
    provider.sendText = async () => {
      throw new Error('انقطاع');
    };
    db.prepare(
      `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
       VALUES (?, 'MWD-2026-000003', '966555555555', 'كشف', ?, ?)`,
    ).run(tenant.id, addMinutes(now(), 60), addMinutes(now(), 90));

    await bookingsModule.onTick!(tenant, bookingsModule.defaultConfig(), {
      db,
      config: loadConfig(),
      logger: silentLogger(),
      provider,
      notify: async () => {},
    });

    const row = db.prepare(`SELECT reminder_sent_at FROM bookings`).get() as { reminder_sent_at: string | null };
    expect(row.reminder_sent_at).toBeNull();
  });

  it('الموعد المنتهي يُغلق تلقائياً', async () => {
    db.prepare(
      `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
       VALUES (?, 'MWD-2026-000004', '966555555555', 'كشف', ?, ?)`,
    ).run(tenant.id, addMinutes(now(), -120), addMinutes(now(), -90));

    await bookingsModule.onTick!(tenant, bookingsModule.defaultConfig(), {
      db,
      config: loadConfig(),
      logger: silentLogger(),
      provider: new SimulatorProvider(),
      notify: async () => {},
    });

    expect((db.prepare(`SELECT status FROM bookings`).get() as { status: string }).status).toBe('done');
  });
});

describe('الإعدادات', () => {
  it('القيم السخيفة تُردّ للافتراضي بدل أن تكسر التوليد', () => {
    const config = bookingsModule.validateConfig({
      slotMinutes: 0,
      maxConcurrent: -3,
      maxDaysAhead: 9999,
      reminderHours: 500,
      services: [{ name: 'قص', minutes: 'كثير' }],
      workingHours: { '0': [{ from: '21:00', to: '09:00' }] },
    }) as Record<string, unknown>;

    expect(config.slotMinutes).toBe(30);
    expect(config.maxConcurrent).toBe(1);
    expect(config.maxDaysAhead).toBe(30);
    expect(config.reminderHours).toBe(3);
    expect(config.services).toEqual([{ name: 'قص', minutes: 30 }]);
    // نافذة معكوسة تُهمَل
    expect((config.workingHours as Record<string, unknown[]>)['0']).toEqual([]);
  });

  it('بلا خدمات يُرفض الحفظ', () => {
    expect(() => bookingsModule.validateConfig({ services: [{ name: '  ' }] })).toThrow(/خدمة واحدة/);
  });

  it('الإعداد المحفوظ يظهر في الـprompt', () => {
    setEnabled(db, tenant.id, 'bookings', true);
    setConfig(db, tenant.id, 'bookings', {
      ...bookingsModule.defaultConfig(),
      services: [{ name: 'قص شعر', minutes: 45 }],
    });
    const prompt = composePrompt(enabledFor(db, tenant.id), baseContext(db, tenant));
    expect(prompt).toContain('قص شعر (45 دقيقة)');
  });
});
