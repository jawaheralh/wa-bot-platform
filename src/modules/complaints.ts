/**
 * وحدة الشكاوى — أساسية.
 *
 * التصنيف والخطورة يحدّدهما النموذج ضمن مدخلات الأداة، فهو يقرأ نبرة العميل
 * ولا نحتاج قوائم كلمات هشّة. لكن القرار التالي — التصعيد — منطق برمجي لا
 * نتركه للنموذج: خطورة عالية ⇐ تنبيه فوري وتحويل، دائماً وبلا استثناء.
 */

import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { readString, readEnum } from './types.ts';
import { parseFields, fieldsToText, toolProperties, validateValues, describeValues, type FieldValues } from '../case-fields.ts';
import { nextReference, type Db } from '../db/index.ts';
import { SQL_NOW } from '../time.ts';

export const CATEGORIES = ['service', 'quality', 'delay', 'billing', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_AR: Record<Category, string> = {
  service: 'خدمة',
  quality: 'جودة',
  delay: 'تأخير',
  billing: 'فوترة',
  other: 'أخرى',
};

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_AR: Record<Severity, string> = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية' };

export const STATUSES = ['new', 'in_progress', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_AR: Record<Status, string> = {
  new: 'جديدة',
  in_progress: 'قيد المعالجة',
  closed: 'مغلقة',
};

export interface ComplaintRow {
  /** قيم الحقول الإضافية، JSON. */
  extra?: string | null;
  id: number;
  tenant_id: number;
  conversation_id: number | null;
  reference: string;
  customer_wa: string;
  summary: string;
  category: Category;
  severity: Severity;
  status: Status;
  resolution: string | null;
  notified_status: string | null;
  created_at: string;
  updated_at: string;
}

interface ComplaintsConfig extends ModuleConfig {
  /** إبلاغ العميل على واتساب بكل تغيير في حالة شكواه. */
  notifyCustomer: boolean;
  /** الخطورة التي تُصعَّد فوراً للموظف. */
  escalateFrom: Severity;
  /** نص إضافي يُضاف لرسالة تأكيد الشكوى (مثلاً: مدة الرد المتوقعة). */
  acknowledgement: string;
  /** حقول إضافية — سطرٌ لكل حقل: «التسمية* | النوع | الخيارات». */
  fields: string;
}

const DEFAULTS: ComplaintsConfig = {
  notifyCustomer: true,
  escalateFrom: 'high',
  acknowledgement: 'راح يتواصل معك المسؤول في أقرب وقت.',
  fields: '',
};

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/* ---------------------------------------------------------------
   عمليات القاعدة — تستعملها الأداة وصفحة الأدمن معاً
--------------------------------------------------------------- */

export function createComplaint(
  db: Db,
  input: {
    tenantId: number;
    conversationId: number | null;
    customerWa: string;
    summary: string;
    category: Category;
    severity: Severity;
    extra?: FieldValues;
  },
): ComplaintRow {
  const reference = nextReference(db, 'SHK', input.tenantId);
  const info = db
    .prepare(
      `INSERT INTO complaints (tenant_id, conversation_id, reference, customer_wa, summary, category, severity, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.conversationId,
      reference,
      input.customerWa,
      input.summary,
      input.category,
      input.severity,
      JSON.stringify(input.extra ?? {}),
    );
  return db.prepare('SELECT * FROM complaints WHERE id = ?').get(info.lastInsertRowid) as ComplaintRow;
}

export function findComplaint(db: Db, tenantId: number, reference: string): ComplaintRow | undefined {
  return db
    .prepare('SELECT * FROM complaints WHERE tenant_id = ? AND reference = ?')
    .get(tenantId, reference.trim().toUpperCase()) as ComplaintRow | undefined;
}

export function listComplaints(db: Db, tenantId: number, status?: Status): ComplaintRow[] {
  if (status) {
    return db
      .prepare('SELECT * FROM complaints WHERE tenant_id = ? AND status = ? ORDER BY id DESC')
      .all(tenantId, status) as ComplaintRow[];
  }
  return db.prepare('SELECT * FROM complaints WHERE tenant_id = ? ORDER BY id DESC').all(tenantId) as ComplaintRow[];
}

export function updateComplaintStatus(
  db: Db,
  tenantId: number,
  id: number,
  status: Status,
  resolution?: string,
): ComplaintRow {
  if (!STATUSES.includes(status)) throw new Error('حالة غير معروفة.');
  const result = db
    .prepare(
      `UPDATE complaints SET status = ?, resolution = COALESCE(?, resolution), updated_at = ${SQL_NOW}
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(status, resolution ?? null, id, tenantId);
  if (result.changes === 0) throw new Error('الشكوى غير موجودة.');
  return db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) as ComplaintRow;
}

/* ---------------------------------------------------------------
   الوحدة
--------------------------------------------------------------- */

export const complaintsModule: BotModule = {
  name: 'complaints',
  titleAr: 'الشكاوى',
  descriptionAr: 'يسجّل شكاوى العملاء برقم مرجعي، ويصنّفها تلقائياً، ويصعّد العاجل منها للموظف فوراً.',
  core: true,

  tables: [
    `CREATE TABLE IF NOT EXISTS complaints (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
      reference       TEXT    NOT NULL,
      customer_wa     TEXT    NOT NULL,
      summary         TEXT    NOT NULL,
      category        TEXT    NOT NULL DEFAULT 'other',   -- service|quality|delay|billing|other
      severity        TEXT    NOT NULL DEFAULT 'medium',  -- low|medium|high
      status          TEXT    NOT NULL DEFAULT 'new',     -- new|in_progress|closed
      resolution      TEXT,
      notified_status TEXT,
      created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      updated_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      UNIQUE (tenant_id, reference)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id, status, id DESC)`,
  ],

  // قيم الحقول الإضافية التي يعرّفها المالك — JSON.
  columns: [['complaints', 'extra', 'TEXT']],

  defaultConfig: () => ({ ...DEFAULTS }),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<ComplaintsConfig>;
    return {
      fields: fieldsToText(parseFields(raw.fields)),
      notifyCustomer: raw.notifyCustomer !== false,
      escalateFrom: SEVERITIES.includes(raw.escalateFrom as Severity)
        ? (raw.escalateFrom as Severity)
        : DEFAULTS.escalateFrom,
      acknowledgement:
        typeof raw.acknowledgement === 'string' ? raw.acknowledgement.trim() : DEFAULTS.acknowledgement,
    } satisfies ComplaintsConfig;
  },

  systemPrompt(): string {
    return `## الشكاوى
الشكوى **اعتراض على ما حدث**: سوء تعامل، تأخير، جودة رديئة، خطأ في فاتورة.
وتختلف عن الطلب، وهو **بلاغ بشيء يُنجَز**: عطل يحتاج صيانة، اشتراك، عرض سعر.

القاعدة: عميل يبلّغ عن عطل ليُصلَح ⇐ **طلب** لا شكوى، ولو كان منزعجاً.
عميل يعترض على ما جرى له ⇐ **شكوى**. وإن اجتمعا (عطل وغضب من التأخر في
إصلاحه) سجّل الطلب أولاً ثم الشكوى.

- إذا عبّر العميل عن استياء من خدمة أو تعامل، سجّلها بأداة create_complaint ولا تكتفِ بالاعتذار.
- اجمع ما يكفي أولاً: ماذا حصل، ومتى. سؤال توضيحي واحد يكفي، لا تستجوب العميل.
- summary: ملخص بالعربي بجملة أو جملتين من كلام العميل نفسه، لا تفسيرك له.
- category: service (سوء تعامل أو خدمة) | quality (جودة منتج أو عمل) | delay (تأخير أو انتظار) | billing (فاتورة أو مبلغ أو استرجاع) | other.
- severity: high إذا كان العميل غاضباً بوضوح، أو تضرّر مالياً أو صحياً، أو هدّد بالتصعيد أو بشكوى رسمية. medium للمشكلة الواضحة بلا غضب. low للملاحظة العابرة.
- بعد التسجيل، اذكر الرقم المرجعي للعميل كما أعادته الأداة بالضبط.
- إذا سأل عن شكوى سابقة وذكر رقمها، استعمل get_complaint_status.
- لا تَعِد بحل ولا بمدة ولا بتعويض — التسجيل والتصعيد فقط.

### الشكاوى القائمة لهذا العميل
ستصلك قائمة بشكاواه وحالتها. اعمل بها:
- شكوى **مفتوحة أو قيد المعالجة** عن نفس الموضوع ⇐ لا تسجّل جديدة.
  اذكر رقمها وقل إنها ما زالت قيد المتابعة.
- شكوى **مغلقة** يعود العميل لذكرها ⇐ **سجّل شكوى جديدة**، فعودته
  بعد الإغلاق تعني أن المشكلة تكرّرت أو لم تُحل. اذكر الرقم الجديد،
  وأشر إلى أن السابقة أُغلقت. ولا تقل إن المغلقة «قيد المتابعة».
- موضوع مختلف ⇐ شكوى جديدة دائماً.`;
  },

  /** الشكاوى المفتوحة — صاحبها ينتظر ولا يجوز أن يُغلق بابه بصمت. */
  pendingFor(ctx: ModuleContext): string[] {
    if (!ctx.conversation) return [];
    const rows = ctx.db
      .prepare(
        `SELECT reference, status, substr(summary, 1, 60) AS summary
           FROM complaints
          WHERE tenant_id = ? AND customer_wa = ? AND status IN ('new', 'in_progress')
          ORDER BY id DESC LIMIT 3`,
      )
      .all(ctx.tenant.id, ctx.conversation.customer_wa) as {
      reference: string;
      status: string;
      summary: string;
    }[];
    return rows.map((r) => `شكوى ${r.reference} (${STATUS_AR[r.status as Status] ?? r.status}): ${r.summary}`);
  },

  /**
   * حالة شكاوى هذا العميل — بعد نقطة التخزين المؤقت.
   *
   * بدونها يقرأ النموذج تاريخ المحادثة وحده: يرى أنه سجّل
   * SHK-2026-000003 قبل ساعة فيقول «مسجّلة ويتابعها المسؤول» — وقد
   * أُغلقت بينهما. لا يكذب النموذج، بل لم يُخبره أحد.
   */
  contextPrompt(ctx: ModuleContext): string {
    if (!ctx.conversation) return '';

    const rows = ctx.db
      .prepare(
        `SELECT reference, status, severity, substr(summary, 1, 80) AS summary, created_at
           FROM complaints
          WHERE tenant_id = ? AND customer_wa = ?
          ORDER BY id DESC LIMIT 5`,
      )
      .all(ctx.tenant.id, ctx.conversation.customer_wa) as {
      reference: string;
      status: string;
      severity: string;
      summary: string;
      created_at: string;
    }[];

    if (rows.length === 0) return '';

    const lines = rows.map(
      (r) => `- ${r.reference} · ${STATUS_AR[r.status as Status] ?? r.status} · ${r.created_at} · ${r.summary}`,
    );

    return ['## شكاوى هذا العميل المسجّلة', ...lines].join('\n');
  },

  tools(ctx: ModuleContext): ToolDefinition[] {
    const config = ctx.config as ComplaintsConfig;
    return [
      {
        name: 'create_complaint',
        description:
          'يسجّل شكوى العميل ويُعيد رقماً مرجعياً. استعمله مرة واحدة للشكوى الواحدة، بعد فهم المشكلة.',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'ملخص الشكوى بالعربي بجملة أو جملتين.' },
            category: {
              type: 'string',
              enum: [...CATEGORIES],
              description: 'تصنيف الشكوى.',
            },
            severity: {
              type: 'string',
              enum: [...SEVERITIES],
              description: 'خطورة الشكوى بحسب تضرر العميل ونبرته.',
            },
            ...toolProperties(parseFields(config.fields)),
          },
          required: [
            'summary',
            'category',
            'severity',
            ...parseFields(config.fields)
              .filter((f) => f.required)
              .map((f) => f.key),
          ],
        },
      },
      {
        name: 'get_complaint_status',
        description: 'يستعلم عن حالة شكوى سابقة برقمها المرجعي.',
        input_schema: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'الرقم المرجعي كما أعطاه العميل، مثل SHK-2026-000147.' },
          },
          required: ['reference'],
        },
      },
    ];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    const config = ctx.config as ComplaintsConfig;

    if (name === 'create_complaint') {
      const summary = readString(input, 'summary');
      if (!summary) {
        return { content: 'الملخص مطلوب. اسأل العميل عن تفاصيل المشكلة أولاً ثم أعد المحاولة.', isError: true };
      }

      const category = readEnum(input, 'category', CATEGORIES, 'other');
      const severity = readEnum(input, 'severity', SEVERITIES, 'medium');

      const defs = parseFields((ctx.config as ComplaintsConfig).fields);
      const checked = validateValues(defs, input);
      if (checked.error) {
        return { content: `${checked.error} اسأل العميل عنه ثم أعد المحاولة.`, isError: true };
      }

      const complaint = createComplaint(ctx.db, {
        tenantId: ctx.tenant.id,
        conversationId: ctx.conversation.id,
        customerWa: ctx.conversation.customer_wa,
        summary,
        category,
        severity,
        extra: checked.values,
      });

      ctx.db.prepare(`UPDATE complaints SET notified_status = 'new' WHERE id = ?`).run(complaint.id);
      ctx.logger.info('سُجّلت شكوى', { مرجع: complaint.reference, تصنيف: category, خطورة: severity });

      /* --- التصعيد قرار برمجي لا يُترك للنموذج --- */
      const mustEscalate = SEVERITY_RANK[severity] >= SEVERITY_RANK[config.escalateFrom];
      if (mustEscalate) {
        await ctx.notify(
          'complaint',
          `شكوى ${SEVERITY_AR[severity]} الخطورة — ${complaint.reference}`,
          [
            `التصنيف: ${CATEGORY_AR[category]}`,
            `العميل: ${ctx.conversation.customer_wa}`,
            `الشكوى: ${summary}`,
          ].join('\n'),
        );
        return {
          content: [
            `سُجّلت الشكوى برقم ${complaint.reference} وأُبلغ المسؤول فوراً.`,
            `أبلغ العميل بالرقم المرجعي ${complaint.reference}، واعتذر بوضوح، وأخبره أن المسؤول تم تنبيهه وسيتواصل معه.`,
            'بعدها لا تحاول حل المشكلة بنفسك.',
          ].join(' '),
          silenceMinutes: 0,
        };
      }

      return {
        content: [
          `سُجّلت الشكوى برقم ${complaint.reference}.`,
          `أبلغ العميل بهذا الرقم بالضبط، واعتذر باختصار.`,
          config.acknowledgement,
        ].join(' '),
      };
    }

    if (name === 'get_complaint_status') {
      const reference = readString(input, 'reference');
      const complaint = findComplaint(ctx.db, ctx.tenant.id, reference);
      if (!complaint) {
        return {
          content: `لا توجد شكوى بالرقم ${reference || '(فارغ)'}. اطلب من العميل التأكد من الرقم، أو اعرض تسجيل شكوى جديدة.`,
        };
      }
      const resolution = complaint.resolution ? ` ملاحظة المنشأة: ${complaint.resolution}` : '';
      return {
        content: `الشكوى ${complaint.reference} (${CATEGORY_AR[complaint.category]}) حالتها: ${STATUS_AR[complaint.status]}.${resolution} أبلغ العميل بهذا.`,
      };
    }

    return { content: `أداة غير معروفة: ${name}`, isError: true };
  },
};


/** نص التحديث الذي يصل العميل على واتساب عند تغيير حالة شكواه. */
export function complaintUpdateText(row: ComplaintRow, tenantName: string): string {
  const closing: Record<Status, string> = {
    new: 'استلمنا شكواك وسجّلناها.',
    in_progress: 'نعمل على معالجة شكواك الآن.',
    closed: 'أُغلقت شكواك. نعتذر عن الإزعاج ونشكرك على إبلاغنا.',
  };
  return [
    `تحديث على شكواك لدى ${tenantName}`,
    '',
    `الرقم المرجعي: ${row.reference}`,
    `التصنيف: ${CATEGORY_AR[row.category]}`,
    `الحالة: ${STATUS_AR[row.status]}`,
    '',
    closing[row.status],
    row.resolution ? `ملاحظة المنشأة: ${row.resolution}` : '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n')
    .trim();
}
