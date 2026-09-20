/**
 * وحدة الشكاوى — أساسية.
 *
 * التصنيف والخطورة يحدّدهما النموذج ضمن مدخلات الأداة، فهو يقرأ نبرة العميل
 * ولا نحتاج قوائم كلمات هشّة. لكن القرار التالي — التصعيد — منطق برمجي لا
 * نتركه للنموذج: خطورة عالية ⇐ تنبيه فوري وتحويل، دائماً وبلا استثناء.
 */

import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { readString, readEnum } from './types.ts';
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
  created_at: string;
  updated_at: string;
}

interface ComplaintsConfig extends ModuleConfig {
  /** الخطورة التي تُصعَّد فوراً للموظف. */
  escalateFrom: Severity;
  /** نص إضافي يُضاف لرسالة تأكيد الشكوى (مثلاً: مدة الرد المتوقعة). */
  acknowledgement: string;
}

const DEFAULTS: ComplaintsConfig = {
  escalateFrom: 'high',
  acknowledgement: 'راح يتواصل معك المسؤول في أقرب وقت.',
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
  },
): ComplaintRow {
  const reference = nextReference(db, 'SHK', input.tenantId);
  const info = db
    .prepare(
      `INSERT INTO complaints (tenant_id, conversation_id, reference, customer_wa, summary, category, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      input.conversationId,
      reference,
      input.customerWa,
      input.summary,
      input.category,
      input.severity,
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
      created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      updated_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      UNIQUE (tenant_id, reference)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id, status, id DESC)`,
  ],

  defaultConfig: () => ({ ...DEFAULTS }),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<ComplaintsConfig>;
    return {
      escalateFrom: SEVERITIES.includes(raw.escalateFrom as Severity)
        ? (raw.escalateFrom as Severity)
        : DEFAULTS.escalateFrom,
      acknowledgement:
        typeof raw.acknowledgement === 'string' ? raw.acknowledgement.trim() : DEFAULTS.acknowledgement,
    } satisfies ComplaintsConfig;
  },

  systemPrompt(): string {
    return `## الشكاوى
- إذا عبّر العميل عن استياء أو مشكلة، سجّلها بأداة create_complaint ولا تكتفِ بالاعتذار.
- اجمع ما يكفي أولاً: ماذا حصل، ومتى. سؤال توضيحي واحد يكفي، لا تستجوب العميل.
- summary: ملخص بالعربي بجملة أو جملتين من كلام العميل نفسه، لا تفسيرك له.
- category: service (سوء تعامل أو خدمة) | quality (جودة منتج أو عمل) | delay (تأخير أو انتظار) | billing (فاتورة أو مبلغ أو استرجاع) | other.
- severity: high إذا كان العميل غاضباً بوضوح، أو تضرّر مالياً أو صحياً، أو هدّد بالتصعيد أو بشكوى رسمية. medium للمشكلة الواضحة بلا غضب. low للملاحظة العابرة.
- بعد التسجيل، اذكر الرقم المرجعي للعميل كما أعادته الأداة بالضبط.
- إذا سأل عن شكوى سابقة وذكر رقمها، استعمل get_complaint_status.
- لا تَعِد بحل ولا بمدة ولا بتعويض — التسجيل والتصعيد فقط.`;
  },

  tools(): ToolDefinition[] {
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
          },
          required: ['summary', 'category', 'severity'],
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

      const complaint = createComplaint(ctx.db, {
        tenantId: ctx.tenant.id,
        conversationId: ctx.conversation.id,
        customerWa: ctx.conversation.customer_wa,
        summary,
        category,
        severity,
      });

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
