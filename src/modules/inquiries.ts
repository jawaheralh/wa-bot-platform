/**
 * وحدة الاستفسارات — أساسية.
 *
 * تُغذّي النموذج بمعرفة المنشأة في الـsystem prompt بدل أن تعطيه أداة بحث.
 * السبب: قواعد معرفة المنشآت الصغيرة صغيرة (عشرات الأسطر)، وحقنها كاملة
 * أرخص وأسرع وأدق من دورة أداة إضافية لكل سؤال. لو كبرت المعرفة يوماً،
 * تُضاف أداة بحث هنا بلا أي تغيير خارج هذا الملف.
 */

import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { SQL_NOW } from '../time.ts';
import type { Db } from '../db/index.ts';

export interface KbEntry {
  id: number;
  tenant_id: number;
  question: string;
  answer: string;
  position: number;
}

interface InquiriesConfig extends ModuleConfig {
  /** نص حر: وصف المنشأة، الخدمات، الأسعار، الموقع، ساعات العمل. */
  freeText: string;
  /** ما يقوله البوت حين لا تُغطّي المعرفة السؤال. */
  unknownPolicy: string;
}

const DEFAULTS: InquiriesConfig = {
  freeText: '',
  unknownPolicy: 'أعتذر، ما عندي إجابة مؤكدة على هذا. بحوّلك للموظف المختص وبيرد عليك قريب.',
};

export function listKb(db: Db, tenantId: number): KbEntry[] {
  return db
    .prepare('SELECT * FROM kb_entries WHERE tenant_id = ? ORDER BY position, id')
    .all(tenantId) as KbEntry[];
}

export function addKbEntry(db: Db, tenantId: number, question: string, answer: string): KbEntry {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a) throw new Error('السؤال والجواب مطلوبان.');
  const next = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM kb_entries WHERE tenant_id = ?').get(
    tenantId,
  ) as { p: number };
  const info = db
    .prepare('INSERT INTO kb_entries (tenant_id, question, answer, position) VALUES (?, ?, ?, ?)')
    .run(tenantId, q, a, next.p);
  return db.prepare('SELECT * FROM kb_entries WHERE id = ?').get(info.lastInsertRowid) as KbEntry;
}

export function updateKbEntry(db: Db, tenantId: number, id: number, question: string, answer: string): void {
  const result = db
    .prepare('UPDATE kb_entries SET question = ?, answer = ? WHERE id = ? AND tenant_id = ?')
    .run(question.trim(), answer.trim(), id, tenantId);
  if (result.changes === 0) throw new Error('السؤال غير موجود.');
}

export function deleteKbEntry(db: Db, tenantId: number, id: number): void {
  db.prepare('DELETE FROM kb_entries WHERE id = ? AND tenant_id = ?').run(id, tenantId);
}

/** المعرفة كنص جاهز للحقن في الـprompt. */
export function renderKnowledge(db: Db, tenantId: number, config: InquiriesConfig): string {
  const parts: string[] = [];
  if (config.freeText.trim()) parts.push(config.freeText.trim());

  const entries = listKb(db, tenantId);
  if (entries.length) {
    parts.push(entries.map((e) => `س: ${e.question}\nج: ${e.answer}`).join('\n\n'));
  }
  return parts.join('\n\n');
}

export const inquiriesModule: BotModule = {
  name: 'inquiries',
  titleAr: 'الاستفسارات',
  descriptionAr: 'يرد على أسئلة العملاء من معرفة المنشأة: الخدمات والأسعار والموقع وساعات العمل.',
  core: true,

  tables: [
    `CREATE TABLE IF NOT EXISTS kb_entries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      question  TEXT    NOT NULL,
      answer    TEXT    NOT NULL,
      position  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT   NOT NULL DEFAULT (${SQL_NOW})
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kb_tenant ON kb_entries(tenant_id, position)`,
  ],

  defaultConfig: () => ({ ...DEFAULTS }),

  validateConfig(input) {
    const raw = (input ?? {}) as Partial<InquiriesConfig>;
    return {
      freeText: typeof raw.freeText === 'string' ? raw.freeText.slice(0, 20_000) : DEFAULTS.freeText,
      unknownPolicy:
        typeof raw.unknownPolicy === 'string' && raw.unknownPolicy.trim()
          ? raw.unknownPolicy.trim()
          : DEFAULTS.unknownPolicy,
    } satisfies InquiriesConfig;
  },

  systemPrompt(ctx: ModuleContext): string {
    const config = ctx.config as InquiriesConfig;
    const knowledge = renderKnowledge(ctx.db, ctx.tenant.id, config);

    if (!knowledge.trim()) {
      return `## معرفة المنشأة
لا توجد معلومات مُدخَلة عن «${ctx.tenant.name}» بعد.
لا تجاوب على أي سؤال عن الخدمات أو الأسعار أو المواعيد أو الموقع من عندك.
قل للعميل: «${config.unknownPolicy}» ثم حوّله للموظف.`;
    }

    return `## معرفة المنشأة
هذه كل المعلومات المعتمدة عن «${ctx.tenant.name}». أجب منها حرفياً ولا تضف عليها:

${knowledge}

قواعد الإجابة:
- إن لم يكن الجواب في النص أعلاه بوضوح، لا تستنتجه ولا تقرّبه ولا تقل «غالباً».
- في هذه الحالة قل: «${config.unknownPolicy}» ثم حوّل العميل للموظف.
- الأسعار والمواعيد والأرقام تحديداً: انقلها كما هي أو لا تذكرها.`;
  },

  // الاستفسارات تعمل بالمعرفة المحقونة، فلا أدوات لها.
  tools(): ToolDefinition[] {
    return [];
  },

  async runTool(name): Promise<ToolResult> {
    return { content: `وحدة الاستفسارات لا تملك أداة باسم ${name}.`, isError: true };
  },
};
