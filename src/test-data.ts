/**
 * بيانات التجربة — وسمها وحذفها.
 *
 * زرٌّ يحذف «ما يبدو تجريبياً» خطر: التخمين يخطئ يوماً فيمحو عميلاً
 * حقيقياً، والحذف لا يُسترجع. فلا يُحذف هنا إلا ما وُسم تجريبياً
 * صراحةً — بيد الأدمن أو تلقائياً حين تأتي الرسالة من المحاكي.
 *
 * وما لا يحمل الوسم لا يملك النظام مساراً لحذفه إطلاقاً: لا زر، ولا
 * مسار، ولا وسيط. هذا قيد مقصود لا نقص.
 */

import { SQL_NOW } from './time.ts';
import type { Db } from './db/index.ts';

export interface TestDataSummary {
  conversations: number;
  messages: number;
  requests: number;
  complaints: number;
  bookings: number;
  /** عيّنة للعرض قبل الحذف — لا يُحذف شيء بلا أن يُرى. */
  preview: { id: number; tenant: string; customerWa: string; customerName: string | null; messages: number }[];
}

/** يُظهر ما سيُحذف. لا يحذف. */
export function summarizeTestData(db: Db, tenantId?: number): TestDataSummary {
  const scope = tenantId ? 'AND c.tenant_id = @tenantId' : '';
  const params = { tenantId: tenantId ?? 0 };

  const ids = (
    db
      .prepare(`SELECT c.id FROM conversations c WHERE c.is_test = 1 ${scope}`)
      .all(params) as { id: number }[]
  ).map((r) => r.id);

  const list = ids.length ? `(${ids.join(',')})` : '(NULL)';
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  const preview = db
    .prepare(
      `SELECT c.id, t.name AS tenant, c.customer_wa AS customerWa, c.customer_name AS customerName,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages
         FROM conversations c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id IN ${list}
        ORDER BY c.id`,
    )
    .all() as TestDataSummary['preview'];

  return {
    conversations: ids.length,
    messages: one(`SELECT COUNT(*) n FROM messages WHERE conversation_id IN ${list}`),
    requests: one(`SELECT COUNT(*) n FROM requests WHERE conversation_id IN ${list}`),
    complaints: one(`SELECT COUNT(*) n FROM complaints WHERE conversation_id IN ${list}`),
    bookings: one(`SELECT COUNT(*) n FROM bookings WHERE conversation_id IN ${list}`),
    preview,
  };
}

/**
 * يحذف المحادثات الموسومة وما تعلّق بها — ولا شيء غيرها.
 *
 * الجداول تُعدَّد من القاعدة لا من قائمة مكتوبة: وحدة جديدة تضيف
 * جدولاً بعمود conversation_id، والقائمة تنساه فيبقى صفّ يتيم يشير
 * إلى محادثة لم تعد موجودة.
 */
export function deleteTestData(db: Db, tenantId?: number): TestDataSummary {
  const before = summarizeTestData(db, tenantId);
  const ids = before.preview.map((p) => p.id);
  if (ids.length === 0) return before;

  const list = `(${ids.join(',')})`;
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((t) => t.name);

  db.transaction(() => {
    for (const table of tables) {
      if (table === 'conversations') continue;
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('conversation_id')) continue;
      db.prepare(`DELETE FROM ${table} WHERE conversation_id IN ${list}`).run();
    }
    db.prepare(`DELETE FROM conversations WHERE id IN ${list}`).run();
  })();

  return before;
}

/** يضع الوسم أو يرفعه عن محادثة بعينها. */
export function markConversation(db: Db, tenantId: number, conversationId: number, isTest: boolean): void {
  const info = db
    .prepare('UPDATE conversations SET is_test = ? WHERE id = ? AND tenant_id = ?')
    .run(isTest ? 1 : 0, conversationId, tenantId);
  if (info.changes === 0) {
    throw Object.assign(new Error('المحادثة غير موجودة في هذه المنشأة.'), { statusCode: 404 });
  }
}

/**
 * يسم المحادثات التي أنشأها المحاكي.
 *
 * رسالة جاءت من `npm run sim` تجريبية بلا خلاف، فوسمها تلقائياً
 * يوفّر على الأدمن وسم كل محادثة يدوياً بعد كل تجربة.
 */
export function markSimulated(db: Db, conversationId: number): void {
  db.prepare(`UPDATE conversations SET is_test = 1, last_message_at = ${SQL_NOW} WHERE id = ?`).run(
    conversationId,
  );
}
