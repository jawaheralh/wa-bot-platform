/**
 * وحدة التحويل للموظف — أساسية.
 *
 * هذه أهم وحدة في المنتج رغم صغرها: هي صمّام الأمان الذي يجعل بقية النظام
 * آمناً. طالما أن البوت يستطيع أن يقول «ما أعرف، بحوّلك» فلن يخترع إجابة.
 *
 * التحويل يُنهي الدورة بنص محدد ولا يعود للنموذج (stopWithMessage): بعد
 * قرار التحويل لا يجوز أن يضيف النموذج جملة تناقضه.
 */

import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { readString } from './types.ts';
import { SQL_NOW } from '../time.ts';
import type { Db } from '../db/index.ts';

export interface HandoffRow {
  id: number;
  tenant_id: number;
  conversation_id: number;
  reason: string;
  created_at: string;
  resolved_at: string | null;
}

interface HandoffConfig extends ModuleConfig {
  /** ما يُقال للعميل عند التحويل. */
  message: string;
  /** دقائق صمت البوت بعد التحويل، حتى لا يقاطع الموظف. */
  silenceMinutes: number;
}

const DEFAULTS: HandoffConfig = {
  message: 'حوّلتك للموظف المختص، بيتواصل معك في أقرب وقت. شكراً لصبرك.',
  silenceMinutes: 120,
};

export function listHandoffs(db: Db, tenantId: number, openOnly = false): HandoffRow[] {
  const where = openOnly ? 'AND resolved_at IS NULL' : '';
  return db
    .prepare(`SELECT * FROM handoffs WHERE tenant_id = ? ${where} ORDER BY id DESC`)
    .all(tenantId) as HandoffRow[];
}

export function resolveHandoffs(db: Db, tenantId: number, conversationId: number): void {
  db.prepare(
    `UPDATE handoffs SET resolved_at = ${SQL_NOW}
     WHERE tenant_id = ? AND conversation_id = ? AND resolved_at IS NULL`,
  ).run(tenantId, conversationId);
}

export const handoffModule: BotModule = {
  name: 'handoff',
  titleAr: 'التحويل للموظف',
  descriptionAr: 'يوقف البوت ويسلّم المحادثة لموظف بشري مع تنبيه فوري وسبب مسجَّل.',
  core: true,

  tables: [
    `CREATE TABLE IF NOT EXISTS handoffs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      reason          TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (${SQL_NOW}),
      resolved_at     TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_handoffs_tenant ON handoffs(tenant_id, resolved_at, id DESC)`,
  ],

  defaultConfig: () => ({ ...DEFAULTS }),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<HandoffConfig>;
    const minutes = Number(raw.silenceMinutes);
    return {
      message: typeof raw.message === 'string' && raw.message.trim() ? raw.message.trim() : DEFAULTS.message,
      silenceMinutes: Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 ? Math.round(minutes) : DEFAULTS.silenceMinutes,
    } satisfies HandoffConfig;
  },

  systemPrompt(): string {
    return `## التحويل للموظف
استعمل handoff_to_human عندما:
- يطلب العميل صراحة موظفاً أو إنساناً.
- تسأل عن شيء ليس في معرفة المنشأة ولا تملك أداة له.
- يتكرر سوء الفهم مرتين في نفس الموضوع.
- يكون العميل غاضباً جداً أو يهدّد بالتصعيد.
- يتعلق الأمر بمبلغ أو استرجاع أو استثناء لا تملك سياسة مكتوبة عنه.

التحويل ليس فشلاً — الإجابة المخترعة هي الفشل.
اكتب reason بالعربي للموظف لا للعميل: سبب التحويل وما يحتاج معرفته باختصار.`;
  },

  tools(): ToolDefinition[] {
    return [
      {
        name: 'handoff_to_human',
        description:
          'يوقف البوت لهذه المحادثة ويحوّلها لموظف بشري مع تنبيهه فوراً. استعمله حين لا تستطيع مساعدة العميل بثقة.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'سبب التحويل وخلاصة ما يحتاجه الموظف، بالعربي، موجّه للموظف لا للعميل.',
            },
          },
          required: ['reason'],
        },
      },
    ];
  },

  async runTool(name, input, ctx: ModuleContext): Promise<ToolResult> {
    if (name !== 'handoff_to_human') return { content: `أداة غير معروفة: ${name}`, isError: true };

    const config = ctx.config as HandoffConfig;
    const reason = readString(input, 'reason', 'طلب العميل موظفاً');

    ctx.db
      .prepare('INSERT INTO handoffs (tenant_id, conversation_id, reason) VALUES (?, ?, ?)')
      .run(ctx.tenant.id, ctx.conversation.id, reason);

    ctx.db
      .prepare('UPDATE conversations SET handoff_reason = ? WHERE id = ?')
      .run(reason, ctx.conversation.id);

    await ctx.notify(
      'handoff',
      'محادثة محوّلة لموظف',
      [`العميل: ${ctx.conversation.customer_wa}`, `السبب: ${reason}`].join('\n'),
    );

    ctx.logger.info('حُوّلت المحادثة لموظف', { سبب: reason });

    return {
      content: `تم التحويل وأُبلغ الموظف. السبب المسجَّل: ${reason}`,
      stopWithMessage: config.message,
      silenceMinutes: config.silenceMinutes,
    };
  },
};
