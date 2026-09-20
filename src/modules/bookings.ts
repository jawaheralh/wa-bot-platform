/**
 * وحدة الحجوزات — اختيارية، معطّلة افتراضياً.
 *
 * هذه الوحدة هي الدليل العملي على أن نظام الوحدات يعمل: مبنية كاملة هنا،
 * ولا يراها النموذج ولا تظهر في صفحة الأدمن حتى يُفعّلها أدمن النظام.
 *
 * كل حساب زمني يمر عبر src/time.ts بتوقيت الرياض. التعارض يُفحص في SQL
 * بمقارنة نصية على طوابع 'YYYY-MM-DD HH:MM:SS' — وهي مقارنة صحيحة لأن
 * هذه الصيغة مرتّبة معجمياً بنفس ترتيبها الزمني.
 */

import type { BotModule, ModuleConfig, ModuleContext, ModuleDeps, ToolDefinition, ToolResult } from './types.ts';
import { readString, readNumber } from './types.ts';
import { nextReference, type Db, type TenantRow } from '../db/index.ts';
import {
  SQL_NOW,
  now,
  today,
  addMinutes,
  diffMinutes,
  fromSql,
  formatDateAr,
  formatTimeAr,
  formatDateTimeAr,
  parseArabicDate,
  dayNameAr,
} from '../time.ts';

export interface BookingRow {
  id: number;
  tenant_id: number;
  conversation_id: number | null;
  reference: string;
  customer_wa: string;
  customer_name: string | null;
  service: string;
  starts_at: string;
  ends_at: string;
  status: 'booked' | 'cancelled' | 'done';
  reminder_sent_at: string | null;
  created_at: string;
}

export interface ServiceConfig {
  name: string;
  minutes: number;
}

/** ساعات العمل لكل يوم: 0 = الأحد … 6 = السبت. القائمة الفارغة = إجازة. */
export type WorkingHours = Record<string, { from: string; to: string }[]>;

interface BookingsConfig extends ModuleConfig {
  workingHours: WorkingHours;
  services: ServiceConfig[];
  slotMinutes: number;
  maxConcurrent: number;
  maxDaysAhead: number;
  reminderHours: number;
}

const WEEK = ['0', '1', '2', '3', '4', '5', '6'];

const DEFAULTS: BookingsConfig = {
  // الجمعة (5) إجازة افتراضياً — الشائع في المنشآت السعودية الصغيرة.
  workingHours: {
    '0': [{ from: '09:00', to: '21:00' }],
    '1': [{ from: '09:00', to: '21:00' }],
    '2': [{ from: '09:00', to: '21:00' }],
    '3': [{ from: '09:00', to: '21:00' }],
    '4': [{ from: '09:00', to: '21:00' }],
    '5': [],
    '6': [{ from: '09:00', to: '21:00' }],
  },
  services: [{ name: 'كشف', minutes: 30 }],
  slotMinutes: 30,
  maxConcurrent: 1,
  maxDaysAhead: 30,
  reminderHours: 3,
};

/* ---------------------------------------------------------------
   حساب الفترات
--------------------------------------------------------------- */

function dayIndex(isoDate: string): string {
  return String(new Date(`${isoDate}T12:00:00+03:00`).getUTCDay());
}

function findService(config: BookingsConfig, name: string): ServiceConfig | undefined {
  const wanted = name.trim();
  if (!wanted) return config.services[0];
  return (
    config.services.find((s) => s.name === wanted) ??
    config.services.find((s) => s.name.includes(wanted) || wanted.includes(s.name))
  );
}

/** عدد الحجوزات المتداخلة مع فترة معيّنة. */
function overlapCount(db: Db, tenantId: number, startsAt: string, endsAt: string, excludeId?: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
       WHERE tenant_id = ? AND status = 'booked'
         AND starts_at < ? AND ends_at > ?
         AND (? IS NULL OR id != ?)`,
    )
    .get(tenantId, endsAt, startsAt, excludeId ?? null, excludeId ?? null) as { n: number };
  return row.n;
}

/**
 * الفترات المتاحة ليوم واحد.
 * تستثني: خارج ساعات العمل، والماضي، وما بلغ الحد الأقصى المتزامن.
 */
export function availableSlots(
  db: Db,
  tenantId: number,
  config: BookingsConfig,
  isoDate: string,
  serviceName: string,
  nowSql: string = now(),
): string[] {
  const service = findService(config, serviceName);
  if (!service) return [];

  const windows = config.workingHours[dayIndex(isoDate)] ?? [];
  const slots: string[] = [];

  for (const window of windows) {
    let cursor = `${isoDate} ${window.from}:00`;
    const closing = `${isoDate} ${window.to}:00`;

    while (true) {
      const end = addMinutes(cursor, service.minutes);
      if (end > closing) break;
      // فترة بدأت أو ستبدأ خلال دقائق لا تُعرض — العميل لا يستطيع الحضور.
      if (cursor > nowSql && overlapCount(db, tenantId, cursor, end) < config.maxConcurrent) {
        slots.push(cursor);
      }
      cursor = addMinutes(cursor, config.slotMinutes);
    }
  }
  return slots;
}

export function listBookings(db: Db, tenantId: number, from?: string): BookingRow[] {
  if (from) {
    return db
      .prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND starts_at >= ? ORDER BY starts_at`)
      .all(tenantId, from) as BookingRow[];
  }
  return db
    .prepare('SELECT * FROM bookings WHERE tenant_id = ? ORDER BY starts_at DESC LIMIT 200')
    .all(tenantId) as BookingRow[];
}

export function findBooking(db: Db, tenantId: number, reference: string): BookingRow | undefined {
  return db
    .prepare('SELECT * FROM bookings WHERE tenant_id = ? AND reference = ?')
    .get(tenantId, reference.trim().toUpperCase()) as BookingRow | undefined;
}

export function cancelBooking(db: Db, tenantId: number, reference: string): BookingRow {
  const booking = findBooking(db, tenantId, reference);
  if (!booking) throw new Error('الموعد غير موجود.');
  if (booking.status === 'cancelled') throw new Error('الموعد ملغى أصلاً.');
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(booking.id);
  return { ...booking, status: 'cancelled' };
}

/* ---------------------------------------------------------------
   الوحدة
--------------------------------------------------------------- */

export const bookingsModule: BotModule = {
  name: 'bookings',
  titleAr: 'الحجوزات',
  descriptionAr:
    'يحجز مواعيد العملاء تلقائياً حسب ساعات عملك وخدماتك، ويمنع التعارض، ويرسل تذكيراً قبل الموعد.',
  core: false,

  tables: [
    `CREATE TABLE IF NOT EXISTS bookings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id  INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      reference        TEXT    NOT NULL,
      customer_wa      TEXT    NOT NULL,
      customer_name    TEXT,
      service          TEXT    NOT NULL,
      starts_at        TEXT    NOT NULL,           -- 'YYYY-MM-DD HH:MM:SS' بتوقيت الرياض
      ends_at          TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'booked',  -- booked|cancelled|done
      reminder_sent_at TEXT,
      created_at       TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      UNIQUE (tenant_id, reference)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_tenant_time ON bookings(tenant_id, status, starts_at)`,
  ],

  defaultConfig: () => structuredClone(DEFAULTS),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<BookingsConfig>;

    const hours: WorkingHours = {};
    for (const day of WEEK) {
      const windows = (raw.workingHours as WorkingHours | undefined)?.[day];
      hours[day] = Array.isArray(windows)
        ? windows
            .filter((w) => /^\d{2}:\d{2}$/.test(w?.from ?? '') && /^\d{2}:\d{2}$/.test(w?.to ?? ''))
            .filter((w) => w.from < w.to)
            .map((w) => ({ from: w.from, to: w.to }))
        : (DEFAULTS.workingHours[day] ?? []);
    }

    const services = Array.isArray(raw.services)
      ? raw.services
          .filter((s) => typeof s?.name === 'string' && s.name.trim())
          .map((s) => ({ name: s.name.trim(), minutes: Math.max(5, Math.round(Number(s.minutes) || 30)) }))
      : structuredClone(DEFAULTS.services);
    if (!services.length) throw new Error('يلزم خدمة واحدة على الأقل.');

    const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    };

    return {
      workingHours: hours,
      services,
      slotMinutes: clamp(raw.slotMinutes, 5, 240, DEFAULTS.slotMinutes),
      maxConcurrent: clamp(raw.maxConcurrent, 1, 50, DEFAULTS.maxConcurrent),
      maxDaysAhead: clamp(raw.maxDaysAhead, 1, 365, DEFAULTS.maxDaysAhead),
      reminderHours: clamp(raw.reminderHours, 0, 72, DEFAULTS.reminderHours),
    } satisfies BookingsConfig;
  },

  systemPrompt(ctx: ModuleContext): string {
    const config = ctx.config as BookingsConfig;
    const services = config.services.map((s) => `${s.name} (${s.minutes} دقيقة)`).join('، ');

    const schedule = WEEK.map((day) => {
      const windows = config.workingHours[day] ?? [];
      const label = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][Number(day)];
      return windows.length
        ? `${label}: ${windows.map((w) => `${w.from}–${w.to}`).join('، ')}`
        : `${label}: إجازة`;
    }).join('\n');

    return `## الحجوزات
الخدمات المتاحة: ${services}.
ساعات العمل:
${schedule}

قواعد الحجز:
- قبل الحجز اعرف الخدمة واليوم. استعمل get_available_slots أولاً دائماً ولا تفترض توفر وقت.
- اعرض ثلاث أو أربع فترات قريبة من طلب العميل، لا القائمة كلها.
- book_appointment يحتاج وقت البدء بالضبط كما أعادته get_available_slots.
- لا تحجز موعداً لم يؤكده العميل صراحةً.
- بعد الحجز اذكر اليوم والوقت والرقم المرجعي كما أعادتها الأداة.
- الإلغاء عبر cancel_appointment بالرقم المرجعي. إن لم يتذكره العميل، حوّله للموظف.
- التاريخ يُمرَّر YYYY-MM-DD؛ حوّل «بكرة» و«الأحد الجاي» بنفسك قبل النداء.`;
  },

  tools(ctx: ModuleContext): ToolDefinition[] {
    const config = ctx.config as BookingsConfig;
    const serviceNames = config.services.map((s) => s.name);

    return [
      {
        name: 'get_available_slots',
        description: 'يُعيد الفترات المتاحة ليوم معيّن. استعمله قبل أي حجز.',
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'التاريخ بصيغة YYYY-MM-DD، أو تعبير مثل «بكرة».' },
            service: { type: 'string', enum: serviceNames, description: 'اسم الخدمة.' },
          },
          required: ['date', 'service'],
        },
      },
      {
        name: 'book_appointment',
        description: 'يحجز موعداً بعد تأكيد العميل، ويُعيد رقماً مرجعياً.',
        input_schema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'التاريخ بصيغة YYYY-MM-DD.' },
            time: { type: 'string', description: 'وقت البدء بصيغة HH:MM كما أعادته get_available_slots.' },
            service: { type: 'string', enum: serviceNames, description: 'اسم الخدمة.' },
            customer_name: { type: 'string', description: 'اسم العميل إن ذكره.' },
          },
          required: ['date', 'time', 'service'],
        },
      },
      {
        name: 'cancel_appointment',
        description: 'يلغي موعداً بالرقم المرجعي.',
        input_schema: {
          type: 'object',
          properties: { reference: { type: 'string', description: 'الرقم المرجعي، مثل MWD-2026-000031.' } },
          required: ['reference'],
        },
      },
    ];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    const config = ctx.config as BookingsConfig;
    const db = ctx.db;

    /* --- الفترات المتاحة --- */
    if (name === 'get_available_slots') {
      const date = parseArabicDate(readString(input, 'date'), ctx.now.slice(0, 10));
      if (!date) {
        return { content: 'التاريخ غير مفهوم. اسأل العميل عن اليوم بوضوح ثم أعد المحاولة.', isError: true };
      }
      const limit = today(config.maxDaysAhead, fromSql(ctx.now));
      if (date > limit) {
        return { content: `الحجز متاح حتى ${formatDateAr(limit)} فقط. اعرض على العميل موعداً أقرب.` };
      }
      if (date < ctx.now.slice(0, 10)) {
        return { content: 'هذا اليوم مضى. اسأل العميل عن يوم قادم.' };
      }

      const service = findService(config, readString(input, 'service'));
      if (!service) {
        return {
          content: `الخدمة غير معروفة. الخدمات المتاحة: ${config.services.map((s) => s.name).join('، ')}.`,
          isError: true,
        };
      }

      const slots = availableSlots(db, ctx.tenant.id, config, date, service.name, ctx.now);
      if (!slots.length) {
        const dayOff = (config.workingHours[dayIndex(date)] ?? []).length === 0;
        return {
          content: dayOff
            ? `${dayNameAr(date)} إجازة. اعرض على العميل يوماً آخر.`
            : `لا توجد فترات متاحة يوم ${formatDateAr(date)}. اعرض يوماً آخر.`,
        };
      }

      return {
        content: `فترات ${formatDateAr(date)} لخدمة «${service.name}»: ${slots
          .map((s) => `${s.slice(11, 16)} (${formatTimeAr(s)})`)
          .join('، ')}. اعرض على العميل ثلاثاً أو أربعاً منها لا كلها.`,
      };
    }

    /* --- الحجز --- */
    if (name === 'book_appointment') {
      const date = parseArabicDate(readString(input, 'date'), ctx.now.slice(0, 10));
      const time = readString(input, 'time');
      if (!date || !/^\d{1,2}:\d{2}$/.test(time)) {
        return { content: 'التاريخ أو الوقت غير واضح. أعد استعمال get_available_slots وخذ وقتاً منها.', isError: true };
      }

      const service = findService(config, readString(input, 'service'));
      if (!service) {
        return {
          content: `الخدمة غير معروفة. المتاح: ${config.services.map((s) => s.name).join('، ')}.`,
          isError: true,
        };
      }

      const startsAt = `${date} ${time.padStart(5, '0')}:00`;
      const endsAt = addMinutes(startsAt, service.minutes);

      if (startsAt <= ctx.now) {
        return { content: 'هذا الوقت مضى. اعرض على العميل فترة قادمة.', isError: true };
      }
      if (!availableSlots(db, ctx.tenant.id, config, date, service.name, ctx.now).includes(startsAt)) {
        return {
          content: 'هذه الفترة غير متاحة (خارج الدوام أو محجوزة). استعمل get_available_slots واعرض بديلاً.',
          isError: true,
        };
      }

      const reference = nextReference(db, 'MWD', ctx.tenant.id);
      const customerName = readString(input, 'customer_name') || ctx.conversation.customer_name || null;

      db.prepare(
        `INSERT INTO bookings (tenant_id, conversation_id, reference, customer_wa, customer_name, service, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ctx.tenant.id,
        ctx.conversation.id,
        reference,
        ctx.conversation.customer_wa,
        customerName,
        service.name,
        startsAt,
        endsAt,
      );

      ctx.logger.info('حُجز موعد', { مرجع: reference, وقت: startsAt, خدمة: service.name });
      await ctx.notify(
        'booking',
        `موعد جديد — ${reference}`,
        [`الخدمة: ${service.name}`, `الوقت: ${formatDateTimeAr(startsAt)}`, `العميل: ${ctx.conversation.customer_wa}`].join('\n'),
      );

      return {
        content: `تم الحجز: ${service.name} يوم ${formatDateAr(date)} الساعة ${formatTimeAr(startsAt)}، الرقم المرجعي ${reference}. أبلغ العميل بهذه التفاصيل بالضبط.`,
      };
    }

    /* --- الإلغاء --- */
    if (name === 'cancel_appointment') {
      const reference = readString(input, 'reference');
      try {
        const booking = cancelBooking(db, ctx.tenant.id, reference);
        // موعد عميل آخر لا يُلغى من محادثة هذا العميل مهما عرف رقمه.
        if (booking.customer_wa !== ctx.conversation.customer_wa) {
          db.prepare(`UPDATE bookings SET status = 'booked' WHERE id = ?`).run(booking.id);
          return { content: 'هذا الرقم المرجعي ليس لموعد هذا العميل. تحقق من الرقم أو حوّله للموظف.', isError: true };
        }
        await ctx.notify(
          'booking',
          `إلغاء موعد — ${booking.reference}`,
          `كان ${formatDateTimeAr(booking.starts_at)} — ${booking.service}`,
        );
        return { content: `أُلغي الموعد ${booking.reference}. أبلغ العميل واعرض عليه حجز موعد آخر.` };
      } catch (error) {
        return { content: `${(error as Error).message} اطلب من العميل التأكد من الرقم أو حوّله للموظف.` };
      }
    }

    return { content: `أداة غير معروفة: ${name}`, isError: true };
  },

  /* ---------------------------------------------------------------
     التذكيرات
  --------------------------------------------------------------- */

  async onTick(tenant: TenantRow, rawConfig: ModuleConfig, deps: ModuleDeps): Promise<void> {
    const config = rawConfig as BookingsConfig;
    if (config.reminderHours <= 0) return;

    const nowSql = now();
    const due = deps.db
      .prepare(
        `SELECT * FROM bookings
         WHERE tenant_id = ? AND status = 'booked' AND reminder_sent_at IS NULL
           AND starts_at > ? AND starts_at <= datetime(?, '+' || ? || ' hours')`,
      )
      .all(tenant.id, nowSql, nowSql, config.reminderHours) as BookingRow[];

    for (const booking of due) {
      const text = [
        `تذكير بموعدك في ${tenant.name}:`,
        `${booking.service} — ${formatDateTimeAr(booking.starts_at)}.`,
        `رقم الموعد ${booking.reference}. للإلغاء ردّ برسالة.`,
      ].join('\n');

      try {
        await deps.provider.sendText(tenant.id, booking.customer_wa, text);
        // نُعلّم بعد النجاح فقط، فالفشل يعني إعادة المحاولة في النبضة القادمة.
        deps.db.prepare(`UPDATE bookings SET reminder_sent_at = ${SQL_NOW} WHERE id = ?`).run(booking.id);
        deps.logger.info('أُرسل تذكير موعد', { tenant: tenant.id, مرجع: booking.reference });
      } catch (error) {
        deps.logger.error('فشل إرسال تذكير موعد', error, { tenant: tenant.id, مرجع: booking.reference });
      }
    }

    // المواعيد التي مضت تُغلق تلقائياً حتى لا تبقى «محجوزة» للأبد.
    deps.db
      .prepare(`UPDATE bookings SET status = 'done' WHERE tenant_id = ? AND status = 'booked' AND ends_at < ?`)
      .run(tenant.id, nowSql);
  },

  routes(app, deps) {
    /** قائمة المواعيد لصفحة الأدمن. */
    app.get('/api/tenants/:tenantId/bookings', async (request) => {
      const tenantId = Number((request.params as { tenantId: string }).tenantId);
      const user = request.user;
      if (!user || (user.role !== 'system' && user.tenantId !== tenantId)) {
        throw Object.assign(new Error('لا تملك صلاحية على هذه المنشأة.'), { statusCode: 403 });
      }
      const from = (request.query as { from?: string })?.from;
      return listBookings(deps.db, tenantId, from);
    });

    app.post('/api/tenants/:tenantId/bookings/:reference/cancel', async (request) => {
      const tenantId = Number((request.params as { tenantId: string }).tenantId);
      const user = request.user;
      if (!user || (user.role !== 'system' && user.tenantId !== tenantId)) {
        throw Object.assign(new Error('لا تملك صلاحية على هذه المنشأة.'), { statusCode: 403 });
      }
      const reference = (request.params as { reference: string }).reference;
      const booking = cancelBooking(deps.db, tenantId, reference);
      try {
        await deps.provider.sendText(
          tenantId,
          booking.customer_wa,
          `أُلغي موعدك ${booking.reference} (${formatDateTimeAr(booking.starts_at)}). نعتذر عن الإزعاج.`,
        );
      } catch {
        // الإلغاء تم في القاعدة؛ فشل الإبلاغ لا يُرجعه.
      }
      return booking;
    });
  },
};

export { diffMinutes };
