/**
 * إنشاء المنشآت والمستخدمين.
 *
 * مفصول عن db/index.ts لأنه يجمع عدة خطوات ذرّية: المنشأة، وصفوف وحداتها،
 * وأول مستخدم لها. إحداها تفشل ⇐ لا تُنشأ منشأة نصف جاهزة.
 */

import bcrypt from 'bcryptjs';
import { normalizeNumber, toInternational, type Db, type TenantRow, type UserRow } from './db/index.ts';
import { ensureTenantModules } from './modules/registry.ts';
import { normalizeHex } from './branding.ts';

export const BCRYPT_ROUNDS = 10;

export interface NewTenantInput {
  name: string;
  waNumber: string;
  waPhoneNumberId?: string;
  tone?: 'formal' | 'friendly';
  staffWaNumber?: string;
  notes?: string;
  /** لون علامة العميل — تُشتق منه بقية اللوحة. */
  brandColor?: string;
  admin?: { username: string; password: string; displayName?: string };
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

export function createTenant(db: Db, input: NewTenantInput): TenantRow {
  const name = input.name.trim();
  const waNumber = normalizeNumber(input.waNumber);
  if (!name) throw new Error('اسم المنشأة مطلوب.');
  if (waNumber.length < 8) throw new Error('رقم واتساب المنشأة غير صالح.');
  if (input.admin && input.admin.password.length < 8) {
    throw new Error('كلمة المرور يجب ألّا تقل عن ٨ أحرف.');
  }

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tenants (name, wa_number, wa_phone_number_id, tone, staff_wa_number, notes, brand_color)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        waNumber,
        input.waPhoneNumberId?.trim() || null,
        input.tone ?? 'friendly',
        input.staffWaNumber ? normalizeNumber(input.staffWaNumber) : null,
        input.notes ?? null,
        // لونٌ غير صالح لا يمنع إنشاء المنشأة — تُنشأ بألوان المنصة ويُصحَّح لاحقاً.
        normalizeHex(input.brandColor),
      );
    const tenantId = Number(info.lastInsertRowid);

    ensureTenantModules(db, tenantId);

    if (input.admin) {
      createUser(db, {
        tenantId,
        username: input.admin.username,
        password: input.admin.password,
        displayName: input.admin.displayName ?? name,
        role: 'tenant',
      });
    }
    return tenantId;
  });

  const id = run();
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as TenantRow;
}

export interface NewUserInput {
  tenantId: number | null;
  username: string;
  password: string;
  displayName?: string;
  role: 'system' | 'tenant';
}

export function createUser(db: Db, input: NewUserInput): UserRow {
  const username = input.username.trim().toLowerCase();
  if (username.length < 3) throw new Error('اسم المستخدم قصير جداً.');
  if (input.password.length < 8) throw new Error('كلمة المرور يجب ألّا تقل عن ٨ أحرف.');
  if (input.role === 'tenant' && input.tenantId === null) {
    throw new Error('مستخدم المنشأة يحتاج منشأة.');
  }

  const info = db
    .prepare(
      `INSERT INTO users (tenant_id, username, display_name, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.role === 'system' ? null : input.tenantId,
      username,
      input.displayName ?? username,
      hashPassword(input.password),
      input.role,
    );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
}

export function findUser(db: Db, username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase()) as
    | UserRow
    | undefined;
}

/**
 * يجد المستخدم باسمه أو ببريده أو بجواله.
 *
 * الموظف يتذكّر جواله وبريده ولا يتذكّر «rukn_ops_2». وإلزامه باسم
 * المستخدم وحده يعني مكالمةً لمالكه في كل مرة ينساه — وهي مكالمة
 * تتكرر أكثر من نسيان كلمة المرور نفسها.
 *
 * والشكل هو ما يحدّد الحقل: ما فيه «@» بريد، وما هو أرقام كلّه جوال،
 * وما عداهما اسم مستخدم. فلا ثلاثة استعلامات لكل محاولة دخول.
 *
 * ## التكرار
 *
 * اسم المستخدم فريد في القاعدة، أما البريد والجوال فلا. ولو تصادف
 * بريدان متطابقان لَمَا عرفنا أيَّ حسابٍ يُفتح — فيُرفض الاثنان.
 * وإرجاع «الأول» في هذه الحالة يفتح حساب شخصٍ لمن يملك بيانات آخر.
 */
export function findUserByIdentifier(db: Db, identifier: string): UserRow | undefined {
  const raw = identifier.trim();
  if (!raw) return undefined;

  if (raw.includes('@')) {
    return single(db, 'SELECT * FROM users WHERE email = ?', raw.toLowerCase());
  }

  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length >= 8 && /^[\d\s+()-]+$/.test(raw)) {
    /**
     * الصيغتان معاً: الجديد يُخزَّن دولياً، وصفوفٌ حُفظت قبل ذلك
     * بقيت كما كُتبت — ومن حُفظ رقمه «٠٥٥…» يجب أن يدخل به أيضاً.
     */
    const rows = db
      .prepare('SELECT * FROM users WHERE wa_number IN (?, ?)')
      .all(toInternational(digits), digits) as UserRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  return findUser(db, raw);
}

function single(db: Db, sql: string, value: string): UserRow | undefined {
  const rows = db.prepare(sql).all(value) as UserRow[];
  return rows.length === 1 ? rows[0] : undefined;
}
