/**
 * الامتثال: حق المحو، ومدة الاحتفاظ، وسجل التدقيق.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant } from './helpers.ts';
import {
  audit,
  listAudit,
  deleteCustomerData,
  exportCustomerData,
  purgeOldMessages,
} from '../src/compliance.ts';
import {
  getOrCreateConversation,
  saveMessage,
  assignConversation,
  createAlert,
  type Db,
  type TenantRow,
} from '../src/db/index.ts';
import { createComplaint } from '../src/modules/complaints.ts';
import { createRequest } from '../src/modules/requests.ts';
import { addStaff } from '../src/staff.ts';
import { SQL_NOW } from '../src/time.ts';

let db: Db;
let tenant: TenantRow;
let other: TenantRow;

/** عميل كامل البيانات في منشأة. */
function seedCustomer(t: TenantRow, wa: string): number {
  const conversation = getOrCreateConversation(db, t.id, wa, 'خالد');
  saveMessage(db, conversation.id, 'customer', 'رسالة سرية');
  saveMessage(db, conversation.id, 'bot', 'رد');
  createAlert(db, t.id, 'handoff', 'تنبيه', '', conversation.id);
  createComplaint(db, {
    tenantId: t.id,
    conversationId: conversation.id,
    customerWa: wa,
    summary: 'شكوى',
    category: 'other',
    severity: 'low',
  });
  createRequest(db, {
    tenantId: t.id,
    conversationId: conversation.id,
    customerWa: wa,
    kind: 'maintenance',
    priority: 'normal',
    summary: 'طلب',
  });
  // المرجع فريد لكل (منشأة، رقم) وإلا اصطدم عميلان في نفس المنشأة
  db.prepare(
    `INSERT INTO bookings (tenant_id, reference, customer_wa, service, starts_at, ends_at)
     VALUES (?, ?, ?, 'كشف', '2030-01-01 10:00:00', '2030-01-01 10:30:00')`,
  ).run(t.id, `MWD-2026-${wa.slice(-6)}`, wa);
  return conversation.id;
}

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db);
  other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
});
afterEach(() => db.close());

describe('حق المحو', () => {
  it('يحذف كل أثر للعميل ويُعيد تقريراً', () => {
    seedCustomer(tenant, '966555123456');

    const report = deleteCustomerData(db, tenant.id, '+966 55 512 3456');

    expect(report).toMatchObject({
      customerWa: '966555123456',
      conversations: 1,
      messages: 2,
      complaints: 1,
      requests: 1,
      bookings: 1,
    });

    const remains = (sql: string): number =>
      (db.prepare(sql).get(tenant.id, '966555123456') as { n: number }).n;
    expect(remains('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND customer_wa = ?')).toBe(0);
    expect(remains('SELECT COUNT(*) AS n FROM complaints WHERE tenant_id = ? AND customer_wa = ?')).toBe(0);
    expect(remains('SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND customer_wa = ?')).toBe(0);
    expect(remains('SELECT COUNT(*) AS n FROM bookings WHERE tenant_id = ? AND customer_wa = ?')).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM alerts').get() as { n: number }).n).toBe(0);
  });

  it('لا يمسّ نفس العميل لدى منشأة أخرى', () => {
    seedCustomer(tenant, '966555123456');
    seedCustomer(other, '966555123456');

    deleteCustomerData(db, tenant.id, '966555123456');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ?').get(other.id) as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM complaints WHERE tenant_id = ?').get(other.id) as { n: number }).n,
    ).toBe(1);
  });

  it('لا يمسّ عميلاً آخر في نفس المنشأة', () => {
    seedCustomer(tenant, '966555123456');
    seedCustomer(tenant, '966555999999');

    deleteCustomerData(db, tenant.id, '966555123456');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ?').get(tenant.id) as { n: number }).n,
    ).toBe(1);
  });

  it('رقم فارغ يُرفض', () => {
    expect(() => deleteCustomerData(db, tenant.id, '  ')).toThrow(/مطلوب/);
  });

  it('عميل غير موجود يُعيد أصفاراً بلا خطأ', () => {
    expect(deleteCustomerData(db, tenant.id, '966500000000').messages).toBe(0);
  });
});

describe('حق الاطلاع', () => {
  it('التصدير يجمع كل ما يخص العميل', () => {
    seedCustomer(tenant, '966555123456');
    const data = exportCustomerData(db, tenant.id, '966555123456') as Record<string, unknown[]>;

    expect(data.conversations).toHaveLength(1);
    expect(data.messages).toHaveLength(2);
    expect(data.complaints).toHaveLength(1);
    expect(data.requests).toHaveLength(1);
    expect(data.bookings).toHaveLength(1);
    expect(JSON.stringify(data)).toContain('رسالة سرية');
  });

  it('لا يصدّر بيانات منشأة أخرى', () => {
    seedCustomer(other, '966555123456');
    const data = exportCustomerData(db, tenant.id, '966555123456') as Record<string, unknown[]>;
    expect(data.messages).toHaveLength(0);
  });
});

describe('مدة الاحتفاظ', () => {
  it('تحذف الرسائل القديمة وتُبقي الحديثة', () => {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    saveMessage(db, conversation.id, 'customer', 'حديثة');
    saveMessage(db, conversation.id, 'customer', 'قديمة');
    db.prepare(
      `UPDATE messages SET created_at = datetime(${SQL_NOW}, '-100 days') WHERE body = 'قديمة'`,
    ).run();

    expect(purgeOldMessages(db, tenant.id, 90)).toBe(1);
    const left = db.prepare('SELECT body FROM messages').all() as { body: string }[];
    expect(left.map((m) => m.body)).toEqual(['حديثة']);
  });

  it('لا تحذف الشكاوى ولا الطلبات — سجلات عمل', () => {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    createComplaint(db, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerWa: '966555123456',
      summary: 'شكوى قديمة',
      category: 'other',
      severity: 'low',
    });
    saveMessage(db, conversation.id, 'customer', 'قديمة');
    db.prepare(`UPDATE messages SET created_at = datetime(${SQL_NOW}, '-400 days')`).run();

    purgeOldMessages(db, tenant.id, 30);
    expect((db.prepare('SELECT COUNT(*) AS n FROM complaints').get() as { n: number }).n).toBe(1);
  });

  it('صفر يعني بلا حذف', () => {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    saveMessage(db, conversation.id, 'customer', 'قديمة جداً');
    db.prepare(`UPDATE messages SET created_at = '2000-01-01 00:00:00'`).run();

    expect(purgeOldMessages(db, tenant.id, 0)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
  });

  it('لا تمسّ منشأة أخرى', () => {
    const mine = getOrCreateConversation(db, tenant.id, '966555111111');
    const theirs = getOrCreateConversation(db, other.id, '966555222222');
    saveMessage(db, mine.id, 'customer', 'لي');
    saveMessage(db, theirs.id, 'customer', 'لهم');
    db.prepare(`UPDATE messages SET created_at = datetime(${SQL_NOW}, '-400 days')`).run();

    purgeOldMessages(db, tenant.id, 30);
    const left = db.prepare('SELECT body FROM messages').all() as { body: string }[];
    expect(left.map((m) => m.body)).toEqual(['لهم']);
  });

  it('المحادثة المُسندة تبقى حتى لو فرغت من الرسائل', () => {
    const staff = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    saveMessage(db, conversation.id, 'customer', 'قديمة');
    assignConversation(db, conversation.id, staff.id);
    db.prepare(`UPDATE messages SET created_at = datetime(${SQL_NOW}, '-400 days')`).run();

    purgeOldMessages(db, tenant.id, 30);
    expect((db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n).toBe(1);
  });
});

describe('سجل التدقيق', () => {
  it('يسجّل ويُقرأ بترتيب عكسي', () => {
    audit(db, { tenantId: tenant.id, username: 'noor', action: 'login', ip: '127.0.0.1' });
    audit(db, { tenantId: tenant.id, username: 'mona', action: 'status_change', target: 'SHK-2026-000001' });

    const entries = listAudit(db, tenant.id) as { action: string; username: string }[];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.action).toBe('status_change');
  });

  it('معزول بين المنشآت', () => {
    audit(db, { tenantId: tenant.id, username: 'noor', action: 'login' });
    expect(listAudit(db, other.id)).toHaveLength(0);
  });

  it('اسم المستخدم يبقى نصاً بعد حذف الحساب', () => {
    const staff = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', displayName: 'منى' });
    audit(db, { tenantId: tenant.id, userId: staff.id, username: 'mona', action: 'manual_reply' });

    db.prepare('DELETE FROM users WHERE id = ?').run(staff.id);

    const entry = listAudit(db, tenant.id)[0] as { username: string; user_id: number | null };
    expect(entry.username).toBe('mona');
    expect(entry.user_id).toBeNull();
  });

  it('حذف بيانات عميل يُسجَّل بلا محتوى الرسائل', () => {
    seedCustomer(tenant, '966555123456');
    const report = deleteCustomerData(db, tenant.id, '966555123456');
    audit(db, {
      tenantId: tenant.id,
      username: 'noor',
      action: 'delete_customer',
      target: report.customerWa,
      detail: `رسائل ${report.messages}`,
    });

    const entry = listAudit(db, tenant.id)[0] as { target: string; detail: string };
    expect(entry.target).toBe('966555123456');
    expect(JSON.stringify(entry)).not.toContain('رسالة سرية');
  });
});
