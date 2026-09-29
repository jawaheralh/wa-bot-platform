/**
 * وحدة الطلبات — تسجيل طلبات العملاء ومتابعتها.
 *
 * تختلف عن الشكاوى في القصد: الشكوى اعتراض على ما حدث، والطلب مبادرة لشيء
 * يُنجَز (صيانة، اشتراك، عرض سعر، زيارة). ولذلك حالاتها أكثر تفصيلاً.
 *
 * الأهم فيها: **العميل يُبلَّغ تلقائياً بكل تغيير** في طلبه عبر واتساب —
 * عند التسجيل، وعند كل انتقال حالة، وعند الإغلاق. هذا ما يجعل العميل
 * يتوقف عن السؤال «وش صار على طلبي».
 */

import type { BotModule, ModuleConfig, ModuleContext, ModuleDeps, ToolDefinition, ToolResult } from './types.ts';
import { readString, readEnum } from './types.ts';
import { nextReference, type Db } from '../db/index.ts';
import { SQL_NOW, formatDateTimeAr } from '../time.ts';

export const KINDS = ['maintenance', 'subscription', 'quote', 'visit', 'supply', 'other'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_AR: Record<Kind, string> = {
  maintenance: 'صيانة',
  subscription: 'اشتراك',
  quote: 'عرض سعر',
  visit: 'زيارة',
  supply: 'توريد',
  other: 'أخرى',
};

export const PRIORITIES = ['normal', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_AR: Record<Priority, string> = { normal: 'عادي', urgent: 'عاجل' };

export const STATUSES = ['new', 'in_progress', 'waiting_customer', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_AR: Record<Status, string> = {
  new: 'جديد',
  in_progress: 'قيد التنفيذ',
  waiting_customer: 'بانتظار العميل',
  done: 'منجز',
  cancelled: 'ملغى',
};

/** ما يُقال للعميل عند كل حالة — بصيغته لا بمصطلحاتنا الداخلية. */
const STATUS_MESSAGE: Record<Status, string> = {
  new: 'استلمنا طلبك وسجّلناه.',
  in_progress: 'بدأنا العمل على طلبك.',
  waiting_customer: 'طلبك بانتظار ردّك أو معلومة منك حتى نكمل.',
  done: 'اكتمل طلبك. شكراً لك.',
  cancelled: 'أُلغي طلبك.',
};

export interface RequestRow {
  id: number;
  tenant_id: number;
  conversation_id: number | null;
  reference: string;
  customer_wa: string;
  customer_name: string | null;
  kind: Kind;
  priority: Priority;
  summary: string;
  status: Status;
  note: string | null;
  notified_status: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestsConfig extends ModuleConfig {
  /** إبلاغ العميل تلقائياً بكل تغيير حالة. */
  notifyCustomer: boolean;
  /** أنواع الطلبات المعروضة للنموذج — تُضبط لكل منشأة. */
  kinds: Kind[];
  /** يُضاف لرسالة التسجيل (مثل مدة الاستجابة المتوقعة). */
  acknowledgement: string;
}

const DEFAULTS: RequestsConfig = {
  notifyCustomer: true,
  kinds: [...KINDS],
  acknowledgement: 'راح نتواصل معك عند أي تحديث.',
};

/* ---------------------------------------------------------------
   عمليات القاعدة
--------------------------------------------------------------- */

export function createRequest(
  db: Db,
  input: {
    tenantId: number;
    conversationId: number | null;
    customerWa: string;
    customerName?: string | null;
    kind: Kind;
    priority: Priority;
    summary: string;
  },
): RequestRow {
  const reference = nextReference(db, 'TLB', input.tenantId);
  const info = db
    .prepare(
      `INSERT INTO requests (tenant_id, conversation_id, reference, customer_wa, customer_name, kind, priority, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.conversationId,
      reference,
      input.customerWa,
      input.customerName ?? null,
      input.kind,
      input.priority,
      input.summary,
    );
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(info.lastInsertRowid) as RequestRow;
}

export function findRequest(db: Db, tenantId: number, reference: string): RequestRow | undefined {
  return db
    .prepare('SELECT * FROM requests WHERE tenant_id = ? AND reference = ?')
    .get(tenantId, reference.trim().toUpperCase()) as RequestRow | undefined;
}

export function listRequests(db: Db, tenantId: number, status?: Status): RequestRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM requests WHERE tenant_id = ? AND status = ? ORDER BY id DESC')
      .all(tenantId, status) as RequestRow[];
  }
  return db.prepare('SELECT * FROM requests WHERE tenant_id = ? ORDER BY id DESC LIMIT 300').all(tenantId) as RequestRow[];
}

/**
 * تغيير الحالة، والملاحظة تخصّ هذا التغيير وحده.
 *
 * الملاحظة تُستبدل لا تُدمج: «نحتاج تأكيد موعد الفني» كُتبت وهو بانتظار
 * العميل، وبقاؤها في رسالة «اكتمل طلبك» يناقضها ويربك العميل.
 */
export function setRequestStatus(
  db: Db,
  tenantId: number,
  id: number,
  status: Status,
  note?: string,
): RequestRow {
  if (!STATUSES.includes(status)) throw new Error('حالة غير معروفة.');

  const current = db.prepare('SELECT status FROM requests WHERE id = ? AND tenant_id = ?').get(id, tenantId) as
    | { status: Status }
    | undefined;
  if (!current) throw new Error('الطلب غير موجود.');

  // ملاحظة جديدة تُكتب؛ وبلا ملاحظة مع تغيّر الحالة تُمسح القديمة.
  const nextNote = note !== undefined ? note.trim() || null : current.status === status ? undefined : null;

  db.prepare(
    `UPDATE requests SET status = ?, note = CASE WHEN ? THEN note ELSE ? END, updated_at = ${SQL_NOW}
     WHERE id = ? AND tenant_id = ?`,
  ).run(status, nextNote === undefined ? 1 : 0, nextNote ?? null, id, tenantId);

  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow;
}

/* ---------------------------------------------------------------
   إبلاغ العميل
--------------------------------------------------------------- */

export function customerUpdateText(row: RequestRow, tenantName: string, extra = ''): string {
  return [
    `تحديث على طلبك لدى ${tenantName}`,
    ``,
    `رقم الطلب: ${row.reference}`,
    `النوع: ${KIND_AR[row.kind]}`,
    `الحالة: ${STATUS_AR[row.status]}`,
    ``,
    STATUS_MESSAGE[row.status],
    extra || (row.note ? `ملاحظة: ${row.note}` : ''),
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
    .trim();
}

/**
 * يرسل التحديث للعميل ويُعلّم الحالة المُبلَّغ عنها.
 *
 * `notified_status` يمنع تكرار الإشعار لنفس الحالة — الأدمن قد يحفظ مرتين،
 * وإزعاج العميل برسالتين متطابقتين يجعله يحظر الرقم.
 *
 * ينجح الإرسال أو يفشل، والنتيجة تُعاد للواجهة: الفشل وارد على Cloud API
 * خارج نافذة ٢٤ ساعة، ولا يجوز أن يُوهَم الموظف أن العميل عَلِم.
 */
export async function notifyRequestCustomer(
  db: Db,
  deps: ModuleDeps,
  row: RequestRow,
  tenantName: string,
): Promise<{ sent: boolean; reason?: string }> {
  if (row.notified_status === row.status) return { sent: false, reason: 'أُبلغ العميل بهذه الحالة سابقاً.' };

  try {
    await deps.provider.sendText(row.tenant_id, row.customer_wa, customerUpdateText(row, tenantName));
    db.prepare(`UPDATE requests SET notified_status = ? WHERE id = ?`).run(row.status, row.id);
    return { sent: true };
  } catch (error) {
    const reason = (error as Error).message;
    deps.logger.error('تعذّر إبلاغ العميل بتحديث طلبه', error, {
      tenant: row.tenant_id,
      مرجع: row.reference,
    });

    /**
     * الفشل يُبلَّغ به موظف، لا يُكتب في سجل لا يقرؤه أحد.
     *
     * أشهر أسبابه انقضاء نافذة الأربع والعشرين ساعة: الطلب أُنجز
     * والعميل ينتظر، ولا سبيل لإبلاغه إلا باتصال أو قالب معتمد.
     * وبلا تنبيه يبقى منتظراً وتظنّ المنشأة أنه أُبلغ.
     */
    await deps.notify(
      row.tenant_id,
      'handoff',
      `تعذّر إبلاغ العميل بتحديث الطلب ${row.reference}`,
      [
        `العميل: ${row.customer_wa}`,
        `الحالة الجديدة: ${STATUS_AR[row.status]}`,
        `السبب: ${reason}`,
        '',
        'أبلغيه باتصال، أو بقالب معتمد من شاشة المحادثة.',
      ].join('\n'),
      row.conversation_id ?? undefined,
    );

    return { sent: false, reason };
  }
}

/* ---------------------------------------------------------------
   الوحدة
--------------------------------------------------------------- */

export const requestsModule: BotModule = {
  name: 'requests',
  titleAr: 'الطلبات',
  descriptionAr:
    'يستقبل طلبات العملاء (صيانة، اشتراك، عرض سعر) برقم مرجعي، ويُبلغ العميل تلقائياً على واتساب بكل تغيير في حالة طلبه.',
  core: false,

  tables: [
    `CREATE TABLE IF NOT EXISTS requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      reference       TEXT    NOT NULL,
      customer_wa     TEXT    NOT NULL,
      customer_name   TEXT,
      kind            TEXT    NOT NULL DEFAULT 'other',    -- maintenance|subscription|quote|visit|supply|other
      priority        TEXT    NOT NULL DEFAULT 'normal',   -- normal|urgent
      summary         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'new',      -- new|in_progress|waiting_customer|done|cancelled
      note            TEXT,
      notified_status TEXT,                                -- آخر حالة أُبلغ بها العميل
      created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      updated_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      UNIQUE (tenant_id, reference)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_requests_tenant ON requests(tenant_id, status, id DESC)`,
  ],

  defaultConfig: () => structuredClone(DEFAULTS),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<RequestsConfig>;
    const kinds = Array.isArray(raw.kinds)
      ? raw.kinds.filter((k): k is Kind => (KINDS as readonly string[]).includes(k))
      : [...KINDS];
    if (!kinds.length) throw new Error('يلزم نوع طلب واحد على الأقل.');

    return {
      notifyCustomer: raw.notifyCustomer !== false,
      kinds,
      acknowledgement:
        typeof raw.acknowledgement === 'string' ? raw.acknowledgement.trim() : DEFAULTS.acknowledgement,
    } satisfies RequestsConfig;
  },

  systemPrompt(ctx: ModuleContext): string {
    const config = ctx.config as RequestsConfig;
    const kinds = config.kinds.map((k) => `${k} (${KIND_AR[k]})`).join('، ');

    return `## الطلبات
الطلب **بلاغ بشيء يُنجَز**: عطل يحتاج صيانة، اشتراك، عرض سعر، زيارة، توريد.

**البلاغ عن عطل طلبُ صيانة لا شكوى**، ولو ذكره العميل بانزعاج: «المضخة
معطلة»، «الماكينة ما تقرأ البطاقة»، «الإضاءة مطفية». العميل يريد إصلاحاً
لا اعتذاراً. أما اعتراضه على ما جرى له — سوء تعامل، تأخير، فاتورة خاطئة —
فشكوى.

سجّل الطلب بأداة create_request.

- الأنواع المتاحة: ${kinds}.
- priority: urgent إذا كان هناك تعطّل قائم أو ضرر مستمر أو موعد ضاغط، وإلا normal.
- summary: ما يريده العميل بجملة أو جملتين من كلامه هو.
- اجمع ما يكفي أولاً (ماذا يريد، وأين، ومتى) بسؤال أو سؤالين لا أكثر.
- بعد التسجيل اذكر رقم الطلب كما أعادته الأداة بالضبط، وأخبره أنه سيصله
  تحديث على الواتساب عند أي تغيير.
- إذا سأل عن طلب سابق بذكر رقمه، استعمل get_request_status.
- لا تَعِد بموعد إنجاز ولا بسعر لم يرد في معرفة المنشأة.

### الطلبات القائمة لهذا العميل
ستصلك قائمة بطلباته وحالتها. اعمل بها:
- طلب **جارٍ** عن نفس الموضوع ⇐ لا تسجّل جديداً، اذكر رقمه وحالته.
- طلب **منجَز أو ملغى** يعود العميل لذكره ⇐ **سجّل طلباً جديداً**،
  فعودته تعني حاجة جديدة أو أن الأولى لم تُنجَز فعلاً. ولا تقل عن
  المنجَز إنه «قيد التنفيذ».`;
  },

  /** الطلبات التي ما زالت جارية — من ينتظرها يستحق متابعة. */
  pendingFor(ctx: ModuleContext): string[] {
    if (!ctx.conversation) return [];
    const rows = ctx.db
      .prepare(
        `SELECT reference, status, substr(summary, 1, 60) AS summary
           FROM requests
          WHERE tenant_id = ? AND customer_wa = ? AND status IN ('new', 'in_progress')
          ORDER BY id DESC LIMIT 3`,
      )
      .all(ctx.tenant.id, ctx.conversation.customer_wa) as {
      reference: string;
      status: string;
      summary: string;
    }[];
    return rows.map((r) => `طلب ${r.reference} (${STATUS_AR[r.status as Status] ?? r.status}): ${r.summary}`);
  },

  /**
   * حالة طلبات هذا العميل — بعد نقطة التخزين المؤقت.
   *
   * نفس علّة الشكاوى: بلا هذا يقرأ النموذج تاريخ المحادثة وحده،
   * فيخبر العميل أن طلباً أُنجز أو أُلغي ما زال «قيد التنفيذ».
   */
  contextPrompt(ctx: ModuleContext): string {
    if (!ctx.conversation) return '';

    const rows = ctx.db
      .prepare(
        `SELECT reference, status, substr(summary, 1, 80) AS summary, created_at
           FROM requests
          WHERE tenant_id = ? AND customer_wa = ?
          ORDER BY id DESC LIMIT 5`,
      )
      .all(ctx.tenant.id, ctx.conversation.customer_wa) as {
      reference: string;
      status: string;
      summary: string;
      created_at: string;
    }[];

    if (rows.length === 0) return '';

    const lines = rows.map(
      (r) => `- ${r.reference} · ${STATUS_AR[r.status as Status] ?? r.status} · ${r.created_at} · ${r.summary}`,
    );
    return ['## طلبات هذا العميل المسجّلة', ...lines].join('\n');
  },

  tools(ctx: ModuleContext): ToolDefinition[] {
    const config = ctx.config as RequestsConfig;
    return [
      {
        name: 'create_request',
        description: 'يسجّل طلب خدمة للعميل ويُعيد رقماً مرجعياً. استعمله مرة واحدة للطلب الواحد.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'ما يريده العميل، بالعربي، بجملة أو جملتين.' },
            kind: { type: 'string', enum: [...config.kinds], description: 'نوع الطلب.' },
            priority: { type: 'string', enum: [...PRIORITIES], description: 'عاجل أم عادي.' },
            customer_name: { type: 'string', description: 'اسم العميل إن ذكره.' },
          },
          required: ['summary', 'kind', 'priority'],
        },
      },
      {
        name: 'get_request_status',
        description: 'يستعلم عن حالة طلب سابق برقمه المرجعي.',
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'رقم الطلب، مثل TLB-2026-000042.' },
          },
          required: ['reference'],
        },
      },
    ];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    const config = ctx.config as RequestsConfig;

    if (name === 'create_request') {
      const summary = readString(input, 'summary');
      if (!summary) {
        return { content: 'وصف الطلب مطلوب. اسأل العميل عمّا يريده تحديداً ثم أعد المحاولة.', isError: true };
      }

      const kind = readEnum(input, 'kind', config.kinds, config.kinds[0] ?? 'other');
      const priority = readEnum(input, 'priority', PRIORITIES, 'normal');

      const row = createRequest(ctx.db, {
        tenantId: ctx.tenant.id,
        conversationId: ctx.conversation.id,
        customerWa: ctx.conversation.customer_wa,
        customerName: readString(input, 'customer_name') || ctx.conversation.customer_name,
        kind,
        priority,
        summary,
      });

      // العميل في المحادثة الآن، والبوت سيذكر الرقم في ردّه — فلا نرسل
      // رسالة ثانية مكررة، ونكتفي بتعليم الحالة كمُبلَّغ عنها.
      ctx.db.prepare(`UPDATE requests SET notified_status = 'new' WHERE id = ?`).run(row.id);

      ctx.logger.info('سُجّل طلب', { مرجع: row.reference, نوع: kind, أولوية: priority });

      if (priority === 'urgent') {
        await ctx.notify(
          'request',
          `طلب عاجل — ${row.reference}`,
          [`النوع: ${KIND_AR[kind]}`, `العميل: ${ctx.conversation.customer_wa}`, `الطلب: ${summary}`].join('\n'),
        );
      }

      return {
        content: [
          `سُجّل الطلب برقم ${row.reference}.`,
          `أبلغ العميل بهذا الرقم بالضبط، وأخبره أنه سيصله تحديث على الواتساب عند أي تغيير في حالة طلبه.`,
          config.acknowledgement,
        ].join(' '),
      };
    }

    if (name === 'get_request_status') {
      const reference = readString(input, 'reference');
      const row = findRequest(ctx.db, ctx.tenant.id, reference);
      if (!row) {
        return {
          content: `لا يوجد طلب بالرقم ${reference || '(فارغ)'}. اطلب من العميل التأكد من الرقم، أو اعرض تسجيل طلب جديد.`,
        };
      }
      const note = row.note ? ` ملاحظة المنشأة: ${row.note}` : '';
      return {
        content:
          `الطلب ${row.reference} (${KIND_AR[row.kind]}) حالته: ${STATUS_AR[row.status]}، ` +
          `آخر تحديث ${formatDateTimeAr(row.updated_at)}.${note} أبلغ العميل بهذا.`,
      };
    }

    return { content: `أداة غير معروفة: ${name}`, isError: true };
  },

  /* --- مسارات الأدمن --- */
  routes(app, deps) {
    const access = (request: { params: unknown; user?: { role: string; tenantId: number | null } }): number => {
      const tenantId = Number((request.params as { tenantId: string }).tenantId);
      const user = request.user;
      if (!user || (user.role !== 'system' && user.tenantId !== tenantId)) {
        throw Object.assign(new Error('لا تملك صلاحية على هذه المنشأة.'), { statusCode: 403 });
      }
      return tenantId;
    };

    app.get('/api/tenants/:tenantId/requests', async (request) => {
      const tenantId = access(request);
      const status = (request.query as { status?: string })?.status as Status | undefined;
      return {
        requests: listRequests(deps.db, tenantId, STATUSES.includes(status as Status) ? status : undefined),
        statuses: STATUS_AR,
        kinds: KIND_AR,
      };
    });

    /** تغيير الحالة — يُبلغ العميل تلقائياً على واتساب. */
    app.patch('/api/tenants/:tenantId/requests/:requestId', async (request) => {
      const tenantId = access(request);
      const requestId = Number((request.params as { requestId: string }).requestId);
      const body = (request.body ?? {}) as { status?: Status; note?: string };
      if (!body.status) throw Object.assign(new Error('الحالة مطلوبة.'), { statusCode: 400 });

      const before = deps.db.prepare('SELECT status FROM requests WHERE id = ? AND tenant_id = ?').get(requestId, tenantId) as
        | { status: Status }
        | undefined;
      if (!before) throw Object.assign(new Error('الطلب غير موجود.'), { statusCode: 404 });

      const row = setRequestStatus(deps.db, tenantId, requestId, body.status, body.note);

      const tenant = deps.db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as { name: string };
      const config = deps.db
        .prepare(`SELECT config FROM tenant_modules WHERE tenant_id = ? AND module = 'requests'`)
        .get(tenantId) as { config: string } | undefined;
      const notifyEnabled = (JSON.parse(config?.config ?? '{}') as RequestsConfig).notifyCustomer !== false;

      let notice: { sent: boolean; reason?: string } = { sent: false, reason: 'إبلاغ العميل معطَّل لهذه المنشأة.' };
      if (notifyEnabled && before.status !== row.status) {
        notice = await notifyRequestCustomer(deps.db, deps, row, tenant.name);
      } else if (before.status === row.status) {
        notice = { sent: false, reason: 'الحالة لم تتغير.' };
      }

      return { request: row, notice };
    });

    /** إعادة إرسال التحديث يدوياً — بعد إصلاح سبب الفشل. */
    app.post('/api/tenants/:tenantId/requests/:requestId/notify', async (request) => {
      const tenantId = access(request);
      const requestId = Number((request.params as { requestId: string }).requestId);
      const row = deps.db.prepare('SELECT * FROM requests WHERE id = ? AND tenant_id = ?').get(requestId, tenantId) as
        | RequestRow
        | undefined;
      if (!row) throw Object.assign(new Error('الطلب غير موجود.'), { statusCode: 404 });

      const tenant = deps.db.prepare('SELECT name FROM tenants WHERE id = ?').get(tenantId) as { name: string };
      // إعادة الإرسال المتعمَّدة تتجاوز حارس التكرار
      deps.db.prepare(`UPDATE requests SET notified_status = NULL WHERE id = ?`).run(requestId);
      return notifyRequestCustomer(deps.db, deps, { ...row, notified_status: null }, tenant.name);
    });
  },
};
