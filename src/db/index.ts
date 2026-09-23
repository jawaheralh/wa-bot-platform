/**
 * قاعدة البيانات.
 *
 * better-sqlite3 متزامنة، وهذا مقصود: كل العمليات هنا قصيرة (قراءة محادثة،
 * حفظ رسالة)، والانتظار الحقيقي في المنصة هو نداء Claude وإرسال واتساب،
 * وكلاهما غير متزامن أصلاً. WAL يسمح بالقراءة أثناء الكتابة.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORE_TABLES, CORE_COLUMNS } from './schema.ts';
import { SQL_NOW, today } from '../time.ts';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  for (const statement of CORE_TABLES) db.exec(statement);
  for (const [table, column, definition] of CORE_COLUMNS) ensureColumn(db, table, column, definition);
  return db;
}

/**
 * إضافة عمود لجدول قائم.
 *
 * CREATE TABLE IF NOT EXISTS لا يضيف أعمدة لجدول موجود، فقاعدة أُنشئت قبل
 * إضافة ميزة تبقى ناقصة بصمت. هذه الدالة تسدّ ذلك: تقرأ أعمدة الجدول
 * فعلياً وتضيف الناقص، فتعمل على القاعدة الجديدة والقديمة سواء.
 *
 * تُصدَّر لأن الوحدات تحتاجها أيضاً حين تضيف عموداً لجدول أصدرته سابقاً.
 */
export function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) return;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/* ---------------------------------------------------------------
   الأرقام المرجعية
--------------------------------------------------------------- */

/**
 * رقم مرجعي مقروء ومتسلسل لكل منشأة وسنة: SHK-2026-000147.
 * العميل يقرأه في واتساب ويعيد ذكره، فالتسلسل أوضح من UUID،
 * وعزله لكل منشأة يمنع تسريب حجم أعمال منشأة لأخرى.
 */
export function nextReference(db: Db, prefix: string, tenantId: number): string {
  const year = today().slice(0, 4);
  const scope = `${prefix}:${tenantId}:${year}`;
  const row = db
    .prepare(
      `INSERT INTO counters (scope, value) VALUES (?, 1)
       ON CONFLICT(scope) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(scope) as { value: number };
  return `${prefix}-${year}-${String(row.value).padStart(6, '0')}`;
}

/* ---------------------------------------------------------------
   أنواع صفوف النواة
--------------------------------------------------------------- */

export interface TenantRow {
  id: number;
  name: string;
  wa_number: string;
  wa_phone_number_id: string | null;
  tone: 'formal' | 'friendly';
  staff_wa_number: string | null;
  status: 'active' | 'suspended';
  retention_days: number;
  notes: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: number;
  tenant_id: number;
  customer_wa: string;
  customer_name: string | null;
  bot_enabled: number;
  silent_until: string | null;
  handoff_reason: string | null;
  assigned_to: number | null;
  assigned_at: string | null;
  viewing_user_id: number | null;
  viewing_at: string | null;
  last_message_at: string | null;
  created_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: 'customer' | 'bot' | 'staff' | 'system';
  user_id: number | null;
  body: string;
  media_type: string | null;
  wa_message_id: string | null;
  created_at: string;
}

export interface UserRow {
  id: number;
  tenant_id: number | null;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'system' | 'tenant' | 'agent';
  wa_number: string | null;
  active: number;
  created_at: string;
}

/* ---------------------------------------------------------------
   المنشآت والتوجيه
--------------------------------------------------------------- */

/** يُبقي الأرقام فقط، فالعملاء والمزوّدون يكتبونها بصيغ مختلفة (+966, 00966, مسافات). */
export function normalizeNumber(raw: string): string {
  return (raw ?? '').replace(/\D/g, '').replace(/^00/, '');
}

export function findTenantByNumber(db: Db, waNumber: string): TenantRow | undefined {
  return db
    .prepare(`SELECT * FROM tenants WHERE wa_number = ? AND status = 'active'`)
    .get(normalizeNumber(waNumber)) as TenantRow | undefined;
}

export function findTenantByPhoneNumberId(db: Db, phoneNumberId: string): TenantRow | undefined {
  return db
    .prepare(`SELECT * FROM tenants WHERE wa_phone_number_id = ? AND status = 'active'`)
    .get(phoneNumberId) as TenantRow | undefined;
}

export function getTenant(db: Db, id: number): TenantRow | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as TenantRow | undefined;
}

export function listTenants(db: Db): TenantRow[] {
  return db.prepare('SELECT * FROM tenants ORDER BY id').all() as TenantRow[];
}

/* ---------------------------------------------------------------
   المحادثات والرسائل
--------------------------------------------------------------- */

/** يجد المحادثة أو يُنشئها — كل (منشأة، رقم عميل) لها صف واحد أبداً. */
export function getOrCreateConversation(db: Db, tenantId: number, customerWa: string, name?: string): ConversationRow {
  const number = normalizeNumber(customerWa);
  const existing = db
    .prepare('SELECT * FROM conversations WHERE tenant_id = ? AND customer_wa = ?')
    .get(tenantId, number) as ConversationRow | undefined;
  if (existing) {
    if (name && !existing.customer_name) {
      db.prepare('UPDATE conversations SET customer_name = ? WHERE id = ?').run(name, existing.id);
      existing.customer_name = name;
    }
    return existing;
  }
  const info = db
    .prepare('INSERT INTO conversations (tenant_id, customer_wa, customer_name) VALUES (?, ?, ?)')
    .run(tenantId, number, name ?? null);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid) as ConversationRow;
}

export function getConversation(db: Db, id: number): ConversationRow | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
}

export function saveMessage(
  db: Db,
  conversationId: number,
  role: MessageRow['role'],
  body: string,
  extra: { mediaType?: string | null; waMessageId?: string | null; userId?: number | null } = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO messages (conversation_id, role, body, media_type, wa_message_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(conversationId, role, body, extra.mediaType ?? null, extra.waMessageId ?? null, extra.userId ?? null);
  db.prepare(`UPDATE conversations SET last_message_at = ${SQL_NOW} WHERE id = ?`).run(conversationId);
  return Number(info.lastInsertRowid);
}

/** آخر N رسالة بالترتيب الزمني الصاعد — جاهزة للنموذج. */
export function recentMessages(db: Db, conversationId: number, limit: number): MessageRow[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse();
}

/** هل البوت مسموح له بالرد الآن؟ الصمت المؤقت يُحسب بتوقيت الرياض لا UTC. */
export function botMayReply(db: Db, conversationId: number): boolean {
  const row = db
    .prepare(
      `SELECT bot_enabled,
              CASE WHEN silent_until IS NOT NULL AND silent_until > ${SQL_NOW} THEN 1 ELSE 0 END AS silent
       FROM conversations WHERE id = ?`,
    )
    .get(conversationId) as { bot_enabled: number; silent: number } | undefined;
  if (!row) return false;
  return row.bot_enabled === 1 && row.silent === 0;
}

/** يُسكت البوت لمدة محددة — يُستدعى عند تدخّل الموظف يدوياً. */
export function silenceConversation(db: Db, conversationId: number, minutes: number): void {
  db.prepare(
    `UPDATE conversations SET silent_until = datetime(${SQL_NOW}, '+' || ? || ' minutes') WHERE id = ?`,
  ).run(minutes, conversationId);
}

/* ---------------------------------------------------------------
   التنبيهات
--------------------------------------------------------------- */

export function createAlert(
  db: Db,
  tenantId: number,
  kind: string,
  title: string,
  body = '',
  conversationId?: number,
): number {
  const info = db
    .prepare('INSERT INTO alerts (tenant_id, conversation_id, kind, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, conversationId ?? null, kind, title, body);
  return Number(info.lastInsertRowid);
}

/* ---------------------------------------------------------------
   الإسناد والحضور
--------------------------------------------------------------- */

/** يُسند المحادثة لموظف، أو يرفع الإسناد بتمرير null. */
export function assignConversation(db: Db, conversationId: number, userId: number | null): void {
  db.prepare(
    `UPDATE conversations SET assigned_to = ?, assigned_at = CASE WHEN ? IS NULL THEN NULL ELSE ${SQL_NOW} END
     WHERE id = ?`,
  ).run(userId, userId, conversationId);
}

/**
 * يسجّل أن موظفاً يفتح هذه المحادثة الآن.
 * حضور بسيط بلا websockets: يكفي أن يرى الثاني «منى فتحتها قبل ٢٠ ثانية»
 * ليتوقف قبل أن يرد على نفس العميل مرتين.
 */
export function markViewing(db: Db, conversationId: number, userId: number): void {
  db.prepare(`UPDATE conversations SET viewing_user_id = ?, viewing_at = ${SQL_NOW} WHERE id = ?`).run(
    userId,
    conversationId,
  );
}
