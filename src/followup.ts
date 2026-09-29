/**
 * متابعة العميل قبل أن تُغلق نافذته.
 *
 * واتساب يسمح بالنص الحر أربعاً وعشرين ساعة من آخر رسالة للعميل،
 * وبعدها لا يُقبل إلا قالب مدفوع. فمن ينتظر جواباً ولم يعد يكتب
 * يُغلق بابه بصمت — ويظل ينتظر.
 *
 * فقبل انتهاء النافذة بساعتين تُرسل رسالة متابعة واحدة.
 *
 * وتصحيح فهم شائع: إرسالنا **لا يمدّد النافذة**. النافذة يحسبها
 * واتساب من آخر رسالة للعميل وحده. فائدة المتابعة أنها قد تدفعه
 * للرد — وردّه هو ما يفتح نافذة جديدة.
 *
 * ولا تُرسل إلا لمن له بند معلّق فعلاً. إزعاج من انتهى أمره يُفقد
 * الثقة بالرقم، وقد يُبلَّغ عنه فيُحظر — وحينها تُفقد القناة كلها.
 */

import type { App } from './app.ts';
import type { ModuleContext } from './modules/types.ts';
import { composePending, enabledFor } from './modules/registry.ts';
import { basePrompt } from './bot/prompt.ts';
import { claudeFor, recordUsage } from './tenant-claude.ts';
import { saveMessage, listTenants, getConversation, type Db, type TenantRow } from './db/index.ts';
import { now, SQL_NOW } from './time.ts';
import type { ClaudeClient } from './bot/claude.ts';

/** ساعتان قبل الإغلاق: تكفي ليرى العميل الرسالة ويرد، ولا تسبق أوانها. */
const BEFORE_MINUTES = 120;
const WINDOW_HOURS = 24;

/** نص احتياطي حين يتعذّر النموذج — المتابعة أهم من بلاغتها. */
const FALLBACK = 'نتابع معك بخصوص طلبك. فيه شي ثاني نقدر نساعد فيه؟';

export interface Candidate {
  conversationId: number;
  customerWa: string;
  pending: string[];
  /** دقائق متبقية على إغلاق النافذة — للسجل. */
  minutesLeft: number;
}

/**
 * من يستحق متابعة الآن.
 *
 * الشروط مجتمعة: نافذته على الإغلاق، وله بند معلّق، والبوت مفعَّل
 * غير صامت، ولم تُرسل له متابعة لهذه النافذة.
 */
export function findCandidates(app: App, tenant: TenantRow): Candidate[] {
  const { db } = app;

  const rows = db
    .prepare(
      `SELECT c.id, c.customer_wa,
              (SELECT MAX(m.created_at) FROM messages m
                WHERE m.conversation_id = c.id AND m.role = 'customer') AS last_customer
         FROM conversations c
        WHERE c.tenant_id = ?
          AND c.bot_enabled = 1
          AND (c.silent_until IS NULL OR c.silent_until <= ${SQL_NOW})
          AND (c.followup_at IS NULL OR c.followup_at < (
                SELECT MAX(m2.created_at) FROM messages m2
                 WHERE m2.conversation_id = c.id AND m2.role = 'customer'))`,
    )
    .all(tenant.id) as { id: number; customer_wa: string; last_customer: string | null }[];

  const nowSql = now();
  const enabled = enabledFor(db, tenant.id);
  const out: Candidate[] = [];

  for (const row of rows) {
    if (!row.last_customer) continue;

    const minutesLeft = minutesUntilClose(row.last_customer, nowSql);
    // خارج النافذة أصلاً: فات الأوان، ولا يُقبل إلا قالب.
    if (minutesLeft <= 0 || minutesLeft > BEFORE_MINUTES) continue;

    const conversation = getConversation(db, row.id);
    if (!conversation) continue;

    const base: Omit<ModuleContext, 'config'> = {
      db,
      tenant,
      conversation,
      provider: app.provider,
      logger: app.logger,
      now: nowSql,
      notify: async () => {},
    };

    const pending = composePending(enabled, base);
    if (pending.length === 0) continue;

    out.push({ conversationId: row.id, customerWa: row.customer_wa, pending, minutesLeft });
  }

  return out;
}

/** الفرق بالدقائق بين إغلاق النافذة والآن — بصيغة أختام SQLite. */
export function minutesUntilClose(lastCustomerAt: string, nowSql: string): number {
  const parse = (stamp: string): number => new Date(`${stamp.replace(' ', 'T')}Z`).getTime();
  const closesAt = parse(lastCustomerAt) + WINDOW_HOURS * 3600_000;
  return Math.round((closesAt - parse(nowSql)) / 60_000);
}

/** يصوغ المتابعة بالنموذج، ويسقط لنصّ ثابت إن تعذّر. */
export async function composeFollowup(
  app: App,
  tenant: TenantRow,
  candidate: Candidate,
  claude: ClaudeClient,
): Promise<string> {
  const instruction = [
    'اكتب رسالة متابعة قصيرة جداً لعميل على واتساب.',
    'سطران على الأكثر. لا تحية طويلة ولا مقدمات.',
    'اذكر ما هو معلّق له بإيجاز، واسأله إن كان يحتاج شيئاً.',
    'لا تَعِد بموعد ولا بنتيجة، ولا تعتذر عن التأخير.',
    '',
    'المعلّق:',
    ...candidate.pending.map((p) => `- ${p}`),
  ].join('\n');

  try {
    const result = await claude.chat({
      system: basePrompt(tenant),
      messages: [{ role: 'user', content: instruction }],
      tools: [],
    });
    const text = result.text.trim();
    return text || FALLBACK;
  } catch (error) {
    app.logger.warn('تعذّرت صياغة المتابعة بالنموذج — أُرسل النص الثابت', {
      tenant: tenant.id,
      سبب: String(error),
    });
    return FALLBACK;
  }
}

/** يعلّم المحادثة بأن متابعة أُرسلت لهذه النافذة. */
function markSent(db: Db, conversationId: number): void {
  db.prepare(`UPDATE conversations SET followup_at = ${SQL_NOW} WHERE id = ?`).run(conversationId);
}

/**
 * الجولة الكاملة لكل المنشآت.
 *
 * تُستدعى من النبضة، وتُعيد عدد ما أُرسل — للسجل والاختبار.
 */
export async function runFollowups(app: App, claude: ClaudeClient | undefined): Promise<number> {
  if (!app.config.followup) return 0;

  let sent = 0;

  for (const tenant of listTenants(app.db)) {
    if (tenant.status !== 'active') continue;

    const candidates = findCandidates(app, tenant);
    if (candidates.length === 0) continue;

    // مفتاح المنشأة إن ملكته: متابعاتها على حسابها لا على حسابك.
    const model = tenant.anthropic_api_key
      ? claudeFor(app.config, tenant, app.logger)?.client
      : claude;

    for (const candidate of candidates) {
      // العلامة أولاً: فشل الإرسال لا يجوز أن يُعيد المحاولة كل دقيقة.
      markSent(app.db, candidate.conversationId);

      try {
        const text = model
          ? await composeFollowup(app, tenant, candidate, model)
          : FALLBACK;

        await app.provider.sendText(tenant.id, candidate.customerWa, text);
        saveMessage(app.db, candidate.conversationId, 'bot', text);
        recordUsage(app.db, tenant.id, 'followups');
        sent += 1;

        app.logger.info('أُرسلت متابعة قبل إغلاق النافذة', {
          tenant: tenant.id,
          conversation: candidate.conversationId,
          متبقٍ: candidate.minutesLeft,
        });
      } catch (error) {
        app.logger.warn('تعذّرت متابعة عميل', {
          tenant: tenant.id,
          conversation: candidate.conversationId,
          سبب: String(error),
        });
      }
    }
  }

  return sent;
}
