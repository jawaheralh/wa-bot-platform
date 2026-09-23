/**
 * الامتثال لحماية البيانات.
 *
 * ثلاث قدرات يفرضها نظام حماية البيانات الشخصية عملياً:
 *   ١. حق المحو — حذف كل بيانات عميل بطلبه
 *   ٢. تحديد مدة الاحتفاظ — لا تُحفظ البيانات بلا أجل
 *   ٣. سجل تدقيق — من اطّلع أو غيّر، ومتى
 *
 * ليست هذه استشارة قانونية ولا تغني عنها؛ هي الأدوات التقنية التي يحتاجها
 * المسؤول لتنفيذ ما يقرره المختص.
 */

import { normalizeNumber, type Db } from './db/index.ts';
import { SQL_NOW } from './time.ts';

/* ---------------------------------------------------------------
   سجل التدقيق
--------------------------------------------------------------- */

export interface AuditEntry {
  tenantId: number | null;
  userId?: number | null;
  username?: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
}

export function audit(db: Db, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (tenant_id, user_id, username, action, target, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.tenantId,
    entry.userId ?? null,
    entry.username ?? '',
    entry.action,
    entry.target ?? '',
    entry.detail ?? '',
    entry.ip ?? null,
  );
}

export const ACTION_AR: Record<string, string> = {
  login: 'تسجيل دخول',
  login_failed: 'محاولة دخول فاشلة',
  status_change: 'تغيير حالة',
  manual_reply: 'رد يدوي',
  assign: 'إسناد محادثة',
  bot_toggle: 'إيقاف/تشغيل البوت',
  kb_change: 'تعديل قاعدة المعرفة',
  module_config: 'تعديل إعدادات وحدة',
  staff_change: 'تعديل موظف',
  delete_customer: 'حذف بيانات عميل',
  retention_purge: 'حذف تلقائي بانتهاء مدة الاحتفاظ',
  export_customer: 'تصدير بيانات عميل',
};

export function listAudit(db: Db, tenantId: number, limit = 200): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit) as Record<string, unknown>[];
}

/* ---------------------------------------------------------------
   حق المحو
--------------------------------------------------------------- */

export interface DeletionReport {
  customerWa: string;
  conversations: number;
  messages: number;
  complaints: number;
  requests: number;
  bookings: number;
}

/**
 * يحذف كل ما يخص رقم عميل داخل منشأة واحدة.
 *
 * الحذف فعلي لا تعليم — حق المحو يعني الإزالة. ويقتصر على المنشأة المطلوبة:
 * العميل نفسه قد يتعامل مع منشأتين، وطلبه لدى إحداهما لا يخوّل حذف بياناته
 * لدى الأخرى.
 */
export function deleteCustomerData(db: Db, tenantId: number, rawNumber: string): DeletionReport {
  const customerWa = normalizeNumber(rawNumber);
  if (!customerWa) throw new Error('رقم العميل مطلوب.');

  const count = (sql: string): number =>
    (db.prepare(sql).get(tenantId, customerWa) as { n: number }).n;

  const report: DeletionReport = {
    customerWa,
    conversations: count('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND customer_wa = ?'),
    messages: count(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE tenant_id = ? AND customer_wa = ?)`,
    ),
    complaints: count('SELECT COUNT(*) AS n FROM complaints WHERE tenant_id = ? AND customer_wa = ?'),
    requests: tableExists(db, 'requests')
      ? count('SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND customer_wa = ?')
      : 0,
    bookings: count('SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND customer_wa = ?'),
  };

  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE tenant_id = ? AND customer_wa = ?)`,
    ).run(tenantId, customerWa);
    db.prepare('DELETE FROM complaints WHERE tenant_id = ? AND customer_wa = ?').run(tenantId, customerWa);
    if (tableExists(db, 'requests')) {
      db.prepare('DELETE FROM requests WHERE tenant_id = ? AND customer_wa = ?').run(tenantId, customerWa);
    }
    db.prepare('DELETE FROM bookings WHERE tenant_id = ? AND customer_wa = ?').run(tenantId, customerWa);
    db.prepare(
      `DELETE FROM alerts WHERE tenant_id = ? AND conversation_id IN
       (SELECT id FROM conversations WHERE tenant_id = ? AND customer_wa = ?)`,
    ).run(tenantId, tenantId, customerWa);
    db.prepare('DELETE FROM conversations WHERE tenant_id = ? AND customer_wa = ?').run(tenantId, customerWa);
  });
  run();

  return report;
}

/** كل ما لدينا عن عميل — لحق الاطلاع. */
export function exportCustomerData(db: Db, tenantId: number, rawNumber: string): Record<string, unknown> {
  const customerWa = normalizeNumber(rawNumber);
  const conversations = db
    .prepare('SELECT * FROM conversations WHERE tenant_id = ? AND customer_wa = ?')
    .all(tenantId, customerWa) as { id: number }[];

  return {
    customerWa,
    exportedAt: (db.prepare(`SELECT ${SQL_NOW} AS t`).get() as { t: string }).t,
    conversations,
    messages: conversations.flatMap((c) =>
      db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(c.id),
    ),
    complaints: db.prepare('SELECT * FROM complaints WHERE tenant_id = ? AND customer_wa = ?').all(tenantId, customerWa),
    requests: tableExists(db, 'requests')
      ? db.prepare('SELECT * FROM requests WHERE tenant_id = ? AND customer_wa = ?').all(tenantId, customerWa)
      : [],
    bookings: db.prepare('SELECT * FROM bookings WHERE tenant_id = ? AND customer_wa = ?').all(tenantId, customerWa),
  };
}

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

/* ---------------------------------------------------------------
   مدة الاحتفاظ
--------------------------------------------------------------- */

/**
 * يحذف الرسائل الأقدم من المدة المحددة للمنشأة.
 *
 * الرسائل وحدها تُحذف، لا الشكاوى والطلبات: تلك سجلات عمل لها قيمة إدارية
 * وقانونية، بينما نصوص المحادثات هي الجزء الأكثر حساسية والأقل فائدة بعد
 * انتهاء التعامل. صفر = بلا حذف.
 */
export function purgeOldMessages(db: Db, tenantId: number, retentionDays: number): number {
  if (!retentionDays || retentionDays <= 0) return 0;

  const result = db
    .prepare(
      `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = ?)
         AND created_at < datetime(${SQL_NOW}, '-' || ? || ' days')`,
    )
    .run(tenantId, retentionDays);

  // محادثة لم يبقَ فيها رسالة ولا إسناد مفتوح لا معنى لبقائها.
  db.prepare(
    `DELETE FROM conversations
     WHERE tenant_id = ? AND assigned_to IS NULL
       AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)`,
  ).run(tenantId);

  return result.changes;
}
