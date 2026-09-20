/**
 * النواة: التوجيه للمنشأة، المحادثات، الرسائل، الوضع الصامت، الأرقام المرجعية.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findTenantByNumber,
  getOrCreateConversation,
  saveMessage,
  recentMessages,
  botMayReply,
  silenceConversation,
  nextReference,
  normalizeNumber,
  type Db,
} from '../src/db/index.ts';
import { createTenant, createUser, findUser, hashPassword, verifyPassword } from '../src/tenants.ts';
import { freshDb, seedTenant } from './helpers.ts';

let db: Db;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

describe('تطبيع الأرقام', () => {
  it('كل صيغ الرقم السعودي تؤدي لنفس المفتاح', () => {
    for (const raw of ['+966 50 000 0001', '00966500000001', '966-500-000-001', '966500000001']) {
      expect(normalizeNumber(raw)).toBe('966500000001');
    }
  });
});

describe('توجيه الرسالة للمنشأة الصحيحة', () => {
  it('الرقم المستقبِل يحدد المنشأة', () => {
    const clinic = seedTenant(db, { name: 'عيادة', waNumber: '966500000001' });
    const restaurant = seedTenant(db, { name: 'مطعم', waNumber: '966500000002' });

    expect(findTenantByNumber(db, '+966 50 000 0001')?.id).toBe(clinic.id);
    expect(findTenantByNumber(db, '966500000002')?.id).toBe(restaurant.id);
    expect(findTenantByNumber(db, '966500000009')).toBeUndefined();
  });

  it('المنشأة الموقوفة لا تستقبل', () => {
    const tenant = seedTenant(db);
    db.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = ?`).run(tenant.id);
    expect(findTenantByNumber(db, tenant.wa_number)).toBeUndefined();
  });

  it('نفس رقم العميل لدى منشأتين محادثتان منفصلتان', () => {
    const a = seedTenant(db, { name: 'أ', waNumber: '966500000001' });
    const b = seedTenant(db, { name: 'ب', waNumber: '966500000002' });

    const convA = getOrCreateConversation(db, a.id, '966555555555');
    const convB = getOrCreateConversation(db, b.id, '966555555555');

    expect(convA.id).not.toBe(convB.id);
    expect(getOrCreateConversation(db, a.id, '+966 55 555 5555').id).toBe(convA.id);
  });
});

describe('الرسائل والسياق', () => {
  it('يُعاد آخر N رسالة بالترتيب الزمني الصاعد', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    for (let i = 1; i <= 25; i++) saveMessage(db, conv.id, i % 2 ? 'customer' : 'bot', `رسالة ${i}`);

    const recent = recentMessages(db, conv.id, 20);
    expect(recent).toHaveLength(20);
    expect(recent[0]?.body).toBe('رسالة 6');
    expect(recent[19]?.body).toBe('رسالة 25');
  });

  it('حفظ رسالة يحدّث آخر نشاط للمحادثة', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    expect(conv.last_message_at).toBeNull();
    saveMessage(db, conv.id, 'customer', 'سلام');
    const row = db.prepare('SELECT last_message_at FROM conversations WHERE id = ?').get(conv.id) as {
      last_message_at: string;
    };
    expect(row.last_message_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });
});

describe('الوضع الصامت وإيقاف البوت', () => {
  it('البوت يرد افتراضياً', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    expect(botMayReply(db, conv.id)).toBe(true);
  });

  it('الإيقاف اليدوي من الأدمن يمنع الرد', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    db.prepare('UPDATE conversations SET bot_enabled = 0 WHERE id = ?').run(conv.id);
    expect(botMayReply(db, conv.id)).toBe(false);
  });

  it('صمت ساعتين بعد تدخّل الموظف، ثم يعود البوت', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');

    silenceConversation(db, conv.id, 120);
    expect(botMayReply(db, conv.id)).toBe(false);

    // نافذة انتهت للتو — الحدّ يُقارَن بتوقيت الرياض لا UTC، وهذا محكّ الاختبار
    db.prepare(`UPDATE conversations SET silent_until = datetime('now','+3 hours','-1 minutes') WHERE id = ?`).run(
      conv.id,
    );
    expect(botMayReply(db, conv.id)).toBe(true);
  });

  it('نافذة الصمت تُحسب بتوقيت الرياض: طابع UTC خام يظل صامتاً بالخطأ لو خُلط', () => {
    const tenant = seedTenant(db);
    const conv = getOrCreateConversation(db, tenant.id, '966555555555');
    // لو استُعملت datetime('now') المجرّدة لصار الفرق ثلاث ساعات وظهرت المحادثة صامتة.
    db.prepare(`UPDATE conversations SET silent_until = datetime('now','+1 minutes') WHERE id = ?`).run(conv.id);
    expect(botMayReply(db, conv.id)).toBe(true);
  });
});

describe('الأرقام المرجعية', () => {
  it('متسلسلة ومقروءة ومعزولة لكل منشأة', () => {
    const a = seedTenant(db, { name: 'أ', waNumber: '966500000001' });
    const b = seedTenant(db, { name: 'ب', waNumber: '966500000002' });
    const year = new Date().getFullYear();

    expect(nextReference(db, 'SHK', a.id)).toBe(`SHK-${year}-000001`);
    expect(nextReference(db, 'SHK', a.id)).toBe(`SHK-${year}-000002`);
    // منشأة أخرى تبدأ من واحد — حجم أعمال المنشأة لا يُسرَّب لغيرها
    expect(nextReference(db, 'SHK', b.id)).toBe(`SHK-${year}-000001`);
    // بادئة أخرى عدّاد مستقل
    expect(nextReference(db, 'MWD', a.id)).toBe(`MWD-${year}-000001`);
  });
});

describe('المنشآت والمستخدمون', () => {
  it('إنشاء منشأة يُنشئ صفوف وحداتها وأول مستخدم لها', () => {
    const tenant = createTenant(db, {
      name: 'صالون الياسمين',
      waNumber: '+966 50 111 2233',
      admin: { username: 'Yasmin', password: 'yasmin12345' },
    });

    expect(tenant.wa_number).toBe('966501112233');
    const user = findUser(db, 'yasmin');
    expect(user?.role).toBe('tenant');
    expect(user?.tenant_id).toBe(tenant.id);
  });

  it('رقم مكرر يُرفض', () => {
    seedTenant(db, { waNumber: '966500000001' });
    expect(() => seedTenant(db, { name: 'أخرى', waNumber: '+966500000001' })).toThrow();
  });

  it('كلمة مرور قصيرة تُرفض برسالة عربية', () => {
    expect(() =>
      createTenant(db, { name: 'س', waNumber: '966500000077', admin: { username: 'x1', password: '123' } }),
    ).toThrow(/٨ أحرف/);
  });

  it('المنشأة لا تُنشأ ناقصة إذا فشل إنشاء مستخدمها', () => {
    createUser(db, { tenantId: null, username: 'taken', password: 'password123', role: 'system' });
    expect(() =>
      createTenant(db, {
        name: 'منشأة',
        waNumber: '966500000088',
        admin: { username: 'taken', password: 'password123' },
      }),
    ).toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE wa_number = '966500000088'`).get()).toEqual({ n: 0 });
  });

  it('كلمة المرور تُخزَّن مشفّرة بـbcrypt', () => {
    const hash = hashPassword('password123');
    expect(hash).not.toContain('password123');
    expect(hash.startsWith('$2')).toBe(true);
    expect(verifyPassword('password123', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });
});
