/**
 * فريق المنشأة: الأدوار، والإسناد، ونسبة الردود، وتوجيه التنبيهات.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { addStaff, listStaff, updateStaff, alertNumbers } from '../src/staff.ts';
import {
  getOrCreateConversation,
  saveMessage,
  assignConversation,
  ensureColumn,
  openDb,
  type Db,
  type TenantRow,
} from '../src/db/index.ts';
import { createUser, findUser } from '../src/tenants.ts';
import { createNotifier } from '../src/notify.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';

let db: Db;
let tenant: TenantRow;

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db, { staffWaNumber: '966500000099' });
  createUser(db, { tenantId: tenant.id, username: 'owner', password: 'owner12345', displayName: 'المالك', role: 'tenant' });
});
afterEach(() => db.close());

describe('إضافة الموظفين', () => {
  it('الموظف الجديد دوره agent افتراضياً ونشط', () => {
    const staff = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', displayName: 'منى' });
    expect(staff.role).toBe('agent');
    expect(staff.active).toBe(true);
    expect(staff.replies).toBe(0);
  });

  it('عدة موظفين لنفس المنشأة', () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    addStaff(db, { tenantId: tenant.id, username: 'fahad', password: 'fahad12345' });
    expect(listStaff(db, tenant.id)).toHaveLength(3);
  });

  it('اسم مستخدم بحروف عربية أو مسافات يُرفض', () => {
    expect(() => addStaff(db, { tenantId: tenant.id, username: 'منى', password: 'mona12345' })).toThrow(/إنجليزية/);
    expect(() => addStaff(db, { tenantId: tenant.id, username: 'mo na', password: 'mona12345' })).toThrow(/إنجليزية/);
  });

  it('اسم مستخدم مكرر يُرفض ولو في منشأة أخرى', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    expect(() => addStaff(db, { tenantId: other.id, username: 'mona', password: 'mona12345' })).toThrow();
  });

  it('القائمة لا تُسرّب هاش كلمة المرور', () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    expect(JSON.stringify(listStaff(db, tenant.id))).not.toContain('$2');
  });

  it('موظفو منشأة لا يظهرون في منشأة أخرى', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    expect(listStaff(db, other.id)).toHaveLength(0);
  });
});

describe('التعطيل بدل الحذف', () => {
  it('الحساب المعطَّل يبقى وتبقى ردوده منسوبة له', () => {
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', displayName: 'منى' });
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    saveMessage(db, conv.id, 'staff', 'أهلاً', { userId: mona.id });

    updateStaff(db, tenant.id, mona.id, { active: false });

    const after = listStaff(db, tenant.id).find((s) => s.id === mona.id)!;
    expect(after.active).toBe(false);
    expect(after.replies).toBe(1);

    const message = db
      .prepare('SELECT u.display_name FROM messages m JOIN users u ON u.id = m.user_id')
      .get() as { display_name: string };
    expect(message.display_name).toBe('منى');
  });

  it('آخر مالك نشط لا يُعطَّل ولا يُنزَّل لموظف', () => {
    const owner = findUser(db, 'owner')!;
    expect(() => updateStaff(db, tenant.id, owner.id, { active: false })).toThrow(/آخر مالك/);
    expect(() => updateStaff(db, tenant.id, owner.id, { role: 'agent' })).toThrow(/آخر مالك/);
  });

  it('بوجود مالك ثانٍ يجوز تعطيل الأول', () => {
    const owner = findUser(db, 'owner')!;
    addStaff(db, { tenantId: tenant.id, username: 'owner2', password: 'owner12345', role: 'tenant' });
    expect(() => updateStaff(db, tenant.id, owner.id, { active: false })).not.toThrow();
  });

  it('موظف منشأة لا يُعدَّل من منشأة أخرى', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    expect(() => updateStaff(db, other.id, mona.id, { active: false })).toThrow(/غير موجود/);
  });

  it('تغيير كلمة المرور يرفض القصيرة', () => {
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    expect(() => updateStaff(db, tenant.id, mona.id, { password: '123' })).toThrow(/٨ أحرف/);
  });
});

describe('الإسناد', () => {
  it('الإسناد ورفعه', () => {
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345' });
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');

    assignConversation(db, conv.id, mona.id);
    let row = db.prepare('SELECT assigned_to, assigned_at FROM conversations WHERE id = ?').get(conv.id) as {
      assigned_to: number | null;
      assigned_at: string | null;
    };
    expect(row.assigned_to).toBe(mona.id);
    expect(row.assigned_at).toMatch(/^\d{4}-\d{2}-\d{2} /);

    assignConversation(db, conv.id, null);
    row = db.prepare('SELECT assigned_to, assigned_at FROM conversations WHERE id = ?').get(conv.id) as never;
    expect(row.assigned_to).toBeNull();
    expect(row.assigned_at).toBeNull();
  });
});

describe('توجيه التنبيهات', () => {
  it('بلا إسناد: المنشأة وكل موظف له رقم', () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    addStaff(db, { tenantId: tenant.id, username: 'fahad', password: 'fahad12345', waNumber: '966500000022' });
    addStaff(db, { tenantId: tenant.id, username: 'saad', password: 'saad12345' }); // بلا رقم

    expect(alertNumbers(db, tenant.id).sort()).toEqual(['966500000011', '966500000022', '966500000099']);
  });

  it('مع إسناد: صاحب المحادثة وحده', () => {
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    addStaff(db, { tenantId: tenant.id, username: 'fahad', password: 'fahad12345', waNumber: '966500000022' });

    expect(alertNumbers(db, tenant.id, mona.id)).toEqual(['966500000011']);
  });

  it('المُسند إليه معطَّل أو بلا رقم ⇐ يُنبَّه الفريق كله بدل ضياع التنبيه', () => {
    const saad = addStaff(db, { tenantId: tenant.id, username: 'saad', password: 'saad12345' });
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });

    expect(alertNumbers(db, tenant.id, saad.id).sort()).toEqual(['966500000011', '966500000099']);

    const mona = listStaff(db, tenant.id).find((s) => s.username === 'mona')!;
    updateStaff(db, tenant.id, mona.id, { active: false });
    expect(alertNumbers(db, tenant.id, mona.id)).toEqual(['966500000099']);
  });

  it('الرقم المكرر بين المنشأة وموظف يُرسل مرة واحدة', () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000099' });
    expect(alertNumbers(db, tenant.id)).toEqual(['966500000099']);
  });

  it('المُنبِّه يرسل فعلياً لكل الأرقام ويحفظ صفاً واحداً', async () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    const provider = new SimulatorProvider();
    const notify = createNotifier(db, provider, silentLogger());

    await notify(tenant.id, 'complaint', 'شكوى عاجلة', 'التفاصيل');

    expect(provider.outbox.map((m) => m.to).sort()).toEqual(['966500000011', '966500000099']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM alerts').get()).toEqual({ n: 1 });
  });

  it('فشل رقم لا يمنع البقية ولا يُسقط التنبيه المحفوظ', async () => {
    addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    const provider = new SimulatorProvider();
    const original = provider.sendText.bind(provider);
    provider.sendText = async (tenantId, to, text) => {
      if (to === '966500000099') throw new Error('انقطاع');
      return original(tenantId, to, text);
    };

    await createNotifier(db, provider, silentLogger())(tenant.id, 'handoff', 'تحويل');

    expect(provider.outbox.map((m) => m.to)).toEqual(['966500000011']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM alerts').get()).toEqual({ n: 1 });
  });

  it('المحادثة المُسندة تُنبّه صاحبها وحده', async () => {
    const mona = addStaff(db, { tenantId: tenant.id, username: 'mona', password: 'mona12345', waNumber: '966500000011' });
    addStaff(db, { tenantId: tenant.id, username: 'fahad', password: 'fahad12345', waNumber: '966500000022' });
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    assignConversation(db, conv.id, mona.id);

    const provider = new SimulatorProvider();
    await createNotifier(db, provider, silentLogger())(tenant.id, 'complaint', 'شكوى', '', conv.id);

    expect(provider.outbox.map((m) => m.to)).toEqual(['966500000011']);
  });
});

describe('ترقية قاعدة قائمة', () => {
  it('قاعدة بلا أعمدة الفريق تُرقّى عند الفتح بلا فقد بيانات', () => {
    const old = openDb(':memory:');
    // نحاكي قاعدة قديمة: نحذف الأعمدة الجديدة ونضع صفاً فيها
    old.exec('DROP TABLE messages');
    old.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      media_type TEXT, wa_message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','+3 hours'))
    )`);
    old.prepare(`INSERT INTO messages (conversation_id, role, body) VALUES (1, 'customer', 'رسالة قديمة')`).run();

    expect(() => ensureColumn(old, 'messages', 'user_id', 'INTEGER')).not.toThrow();

    const columns = (old.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('user_id');
    expect(old.prepare('SELECT body FROM messages').get()).toEqual({ body: 'رسالة قديمة' });

    // التنفيذ مرة ثانية لا يرمي
    expect(() => ensureColumn(old, 'messages', 'user_id', 'INTEGER')).not.toThrow();
    old.close();
  });

  it('عمود لجدول غير موجود يُتجاهل بصمت', () => {
    expect(() => ensureColumn(db, 'table_that_does_not_exist', 'x', 'TEXT')).not.toThrow();
  });
});
