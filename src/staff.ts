/**
 * فريق المنشأة.
 *
 * ثلاثة أدوار:
 *   system — أنا. كل المنشآت، وتفعيل الوحدات.
 *   tenant — مالك المنشأة. كل شيء داخل منشأته، ومنه إدارة موظفيه.
 *   agent  — موظف. يرد على العملاء ويتابع الشكاوى والمواعيد، ولا يمسّ
 *            قاعدة المعرفة ولا إعدادات الوحدات ولا الموظفين.
 *
 * التمييز ليس ترفاً: بدونه يستطيع أي موظف حذف حساب مالك المنشأة أو تغيير
 * قاعدة المعرفة التي يتكلم بها البوت مع كل العملاء.
 */

import { normalizeNumber, type Db, type UserRow } from './db/index.ts';
import { hashPassword } from './tenants.ts';

export type Role = 'system' | 'tenant' | 'agent';

export const ROLE_AR: Record<Role, string> = {
  system: 'أدمن النظام',
  tenant: 'مالك المنشأة',
  agent: 'موظف',
};

/** ملخص آمن للعرض — بلا هاش كلمة المرور أبداً. */
export interface StaffSummary {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  waNumber: string | null;
  active: boolean;
  createdAt: string;
  /** عدد الردود التي كتبها، لأن الحذف ممنوع وهذا يفسّر سبب بقاء المعطَّل. */
  replies: number;
}

export function listStaff(db: Db, tenantId: number): StaffSummary[] {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS replies
       FROM users u WHERE u.tenant_id = ? ORDER BY u.role, u.id`,
    )
    .all(tenantId) as (UserRow & { replies: number })[];

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as Role,
    waNumber: row.wa_number,
    active: row.active === 1,
    createdAt: row.created_at,
    replies: row.replies,
  }));
}

export interface NewStaffInput {
  tenantId: number;
  username: string;
  password: string;
  displayName?: string;
  waNumber?: string;
  role?: 'tenant' | 'agent';
}

export function addStaff(db: Db, input: NewStaffInput): StaffSummary {
  const username = input.username.trim().toLowerCase();
  if (username.length < 3) throw new Error('اسم المستخدم قصير جداً.');
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new Error('اسم المستخدم بحروف إنجليزية وأرقام فقط (ونقطة أو شرطة).');
  }
  if (input.password.length < 8) throw new Error('كلمة المرور يجب ألّا تقل عن ٨ أحرف.');

  const info = db
    .prepare(
      `INSERT INTO users (tenant_id, username, display_name, password_hash, role, wa_number, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      input.tenantId,
      username,
      (input.displayName ?? username).trim(),
      hashPassword(input.password),
      input.role ?? 'agent',
      input.waNumber ? normalizeNumber(input.waNumber) : null,
    );

  return listStaff(db, input.tenantId).find((s) => s.id === Number(info.lastInsertRowid))!;
}

function requireStaffOf(db: Db, tenantId: number, userId: number): UserRow {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(tenantId ? userId : userId, tenantId) as
    | UserRow
    | undefined;
  if (!row) throw new Error('الموظف غير موجود في هذه المنشأة.');
  return row;
}

export function updateStaff(
  db: Db,
  tenantId: number,
  userId: number,
  changes: { displayName?: string; waNumber?: string | null; role?: 'tenant' | 'agent'; active?: boolean; password?: string },
): StaffSummary {
  const user = requireStaffOf(db, tenantId, userId);

  // آخر مالك نشط لا يجوز تعطيله أو تنزيله — وإلا بقيت المنشأة بلا من يديرها.
  const losingOwner =
    user.role === 'tenant' && (changes.active === false || (changes.role && changes.role !== 'tenant'));
  if (losingOwner) {
    const owners = db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'tenant' AND active = 1 AND id != ?`)
      .get(tenantId, userId) as { n: number };
    if (owners.n === 0) {
      throw new Error('لا يمكن تعطيل آخر مالك للمنشأة — عيّني مالكاً آخر أولاً.');
    }
  }

  if (changes.password !== undefined) {
    if (changes.password.length < 8) throw new Error('كلمة المرور يجب ألّا تقل عن ٨ أحرف.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(changes.password), userId);
  }

  db.prepare(
    `UPDATE users SET
       display_name = COALESCE(?, display_name),
       wa_number    = CASE WHEN ? THEN ? ELSE wa_number END,
       role         = COALESCE(?, role),
       active       = COALESCE(?, active)
     WHERE id = ?`,
  ).run(
    changes.displayName?.trim() || null,
    changes.waNumber === undefined ? 0 : 1,
    changes.waNumber ? normalizeNumber(changes.waNumber) : null,
    changes.role ?? null,
    changes.active === undefined ? null : changes.active ? 1 : 0,
    userId,
  );

  return listStaff(db, tenantId).find((s) => s.id === userId)!;
}

/**
 * أرقام من يجب تنبيههم بمحادثة.
 * المحادثة المُسندة تُنبّه صاحبها وحده — وإلا تحوّل التنبيه لضجيج يتجاهله
 * الجميع لأن كلاً منهم يفترض أن الآخر يتابع.
 */
export function alertNumbers(db: Db, tenantId: number, assignedTo?: number | null): string[] {
  if (assignedTo) {
    const owner = db
      .prepare(`SELECT wa_number FROM users WHERE id = ? AND tenant_id = ? AND active = 1`)
      .get(assignedTo, tenantId) as { wa_number: string | null } | undefined;
    if (owner?.wa_number) return [owner.wa_number];
  }

  const numbers = new Set<string>();
  const tenant = db.prepare('SELECT staff_wa_number FROM tenants WHERE id = ?').get(tenantId) as
    | { staff_wa_number: string | null }
    | undefined;
  if (tenant?.staff_wa_number) numbers.add(tenant.staff_wa_number);

  for (const row of db
    .prepare(`SELECT wa_number FROM users WHERE tenant_id = ? AND active = 1 AND wa_number IS NOT NULL`)
    .all(tenantId) as { wa_number: string }[]) {
    numbers.add(row.wa_number);
  }
  return [...numbers];
}
