/**
 * منطق الوحدات الثلاث الأساسية بمعزل عن المحرّك.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, baseContext } from './helpers.ts';
import type { Db, TenantRow } from '../src/db/index.ts';
import { getOrCreateConversation } from '../src/db/index.ts';
import {
  complaintsModule,
  createComplaint,
  findComplaint,
  listComplaints,
  updateComplaintStatus,
  CATEGORIES,
  SEVERITIES,
} from '../src/modules/complaints.ts';
import { handoffModule, listHandoffs, resolveHandoffs } from '../src/modules/handoff.ts';
import {
  inquiriesModule,
  addKbEntry,
  updateKbEntry,
  deleteKbEntry,
  listKb,
  renderKnowledge,
} from '../src/modules/inquiries.ts';
import type { ModuleContext } from '../src/modules/types.ts';

let db: Db;
let tenant: TenantRow;

function ctxFor(moduleName: 'complaints' | 'handoff' | 'inquiries', config?: Record<string, unknown>): ModuleContext {
  const base = baseContext(db, tenant);
  const conv = getOrCreateConversation(db, tenant.id, '966555555555');
  const module = { complaints: complaintsModule, handoff: handoffModule, inquiries: inquiriesModule }[moduleName];
  return { ...base, conversation: conv, config: { ...module.defaultConfig(), ...config } };
}

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db);
});
afterEach(() => db.close());

describe('الشكاوى', () => {
  it('الأداة تسجّل الشكوى وتُعيد الرقم المرجعي للنموذج', async () => {
    const ctx = ctxFor('complaints');
    const result = await complaintsModule.runTool(
      'create_complaint',
      { summary: 'الطلب وصل بارد', category: 'quality', severity: 'medium' },
      ctx,
    );

    const complaint = listComplaints(db, tenant.id)[0]!;
    expect(result.content).toContain(complaint.reference);
    expect(complaint.summary).toBe('الطلب وصل بارد');
    expect(complaint.status).toBe('new');
  });

  it('ملخص فارغ يُرفض بدل تسجيل شكوى جوفاء', async () => {
    const result = await complaintsModule.runTool('create_complaint', { summary: '   ' }, ctxFor('complaints'));
    expect(result.isError).toBe(true);
    expect(listComplaints(db, tenant.id)).toHaveLength(0);
  });

  it('تصنيف أو خطورة خارج القائمة تسقط لقيمة آمنة بدل أن ترمي', async () => {
    await complaintsModule.runTool(
      'create_complaint',
      { summary: 'س', category: 'كارثة', severity: 'critical' },
      ctxFor('complaints'),
    );
    const complaint = listComplaints(db, tenant.id)[0]!;
    expect(CATEGORIES).toContain(complaint.category);
    expect(SEVERITIES).toContain(complaint.severity);
    expect(complaint.category).toBe('other');
    expect(complaint.severity).toBe('medium');
  });

  it('حدّ التصعيد قابل للضبط لكل منشأة', async () => {
    let notified = 0;
    const ctx = { ...ctxFor('complaints', { escalateFrom: 'medium' }), notify: async () => void notified++ };

    await complaintsModule.runTool('create_complaint', { summary: 'س', category: 'other', severity: 'low' }, ctx);
    expect(notified).toBe(0);

    await complaintsModule.runTool('create_complaint', { summary: 'س', category: 'other', severity: 'medium' }, ctx);
    expect(notified).toBe(1);
  });

  it('انتقالات الحالة ومنع الحالة المجهولة', () => {
    const complaint = createComplaint(db, {
      tenantId: tenant.id,
      conversationId: null,
      customerWa: '966555555555',
      summary: 'س',
      category: 'other',
      severity: 'low',
    });

    expect(updateComplaintStatus(db, tenant.id, complaint.id, 'in_progress').status).toBe('in_progress');
    const closed = updateComplaintStatus(db, tenant.id, complaint.id, 'closed', 'عُوّض العميل');
    expect(closed.status).toBe('closed');
    expect(closed.resolution).toBe('عُوّض العميل');
    expect(() => updateComplaintStatus(db, tenant.id, complaint.id, 'ملغاة' as never)).toThrow(/حالة غير معروفة/);
  });

  it('شكوى منشأة لا تُقرأ ولا تُعدَّل من منشأة أخرى', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const complaint = createComplaint(db, {
      tenantId: tenant.id,
      conversationId: null,
      customerWa: '966555555555',
      summary: 'س',
      category: 'other',
      severity: 'low',
    });

    expect(findComplaint(db, other.id, complaint.reference)).toBeUndefined();
    expect(() => updateComplaintStatus(db, other.id, complaint.id, 'closed')).toThrow(/غير موجودة/);
  });

  it('الاستعلام يقبل الرقم بحروف صغيرة ومسافات', async () => {
    const complaint = createComplaint(db, {
      tenantId: tenant.id,
      conversationId: null,
      customerWa: '966555555555',
      summary: 'س',
      category: 'delay',
      severity: 'low',
    });

    const result = await complaintsModule.runTool(
      'get_complaint_status',
      { reference: `  ${complaint.reference.toLowerCase()}  ` },
      ctxFor('complaints'),
    );
    expect(result.content).toContain('جديدة');
    expect(result.content).toContain('تأخير');
  });
});

describe('التحويل للموظف', () => {
  it('يسجّل السبب وينبّه ويُسكت البوت وينهي الدورة', async () => {
    let notifiedTitle = '';
    const ctx = { ...ctxFor('handoff'), notify: async (_k: string, title: string) => void (notifiedTitle = title) };

    const result = await handoffModule.runTool('handoff_to_human', { reason: 'طلب مديراً' }, ctx);

    expect(result.stopWithMessage).toContain('حوّلتك للموظف');
    expect(result.silenceMinutes).toBe(120);
    expect(notifiedTitle).toContain('محوّلة لموظف');
    expect(listHandoffs(db, tenant.id, true)).toHaveLength(1);
  });

  it('بلا سبب يُسجَّل سبب افتراضي بدل نص فارغ', async () => {
    await handoffModule.runTool('handoff_to_human', {}, ctxFor('handoff'));
    expect(listHandoffs(db, tenant.id)[0]?.reason).toBe('طلب العميل موظفاً');
  });

  it('إغلاق التحويل يُخرجه من القائمة المفتوحة', async () => {
    const ctx = ctxFor('handoff');
    await handoffModule.runTool('handoff_to_human', { reason: 'س' }, ctx);
    resolveHandoffs(db, tenant.id, ctx.conversation.id);
    expect(listHandoffs(db, tenant.id, true)).toHaveLength(0);
    expect(listHandoffs(db, tenant.id)).toHaveLength(1);
  });

  it('مدة الصمت قابلة للضبط وتُرفض القيم السخيفة', () => {
    expect(handoffModule.validateConfig({ silenceMinutes: 30 }).silenceMinutes).toBe(30);
    expect(handoffModule.validateConfig({ silenceMinutes: -5 }).silenceMinutes).toBe(120);
    expect(handoffModule.validateConfig({ silenceMinutes: 99_999 }).silenceMinutes).toBe(120);
    expect(handoffModule.validateConfig({ message: '  ' }).message).toContain('حوّلتك');
  });
});

describe('قاعدة المعرفة', () => {
  it('إضافة وتعديل وحذف', () => {
    const entry = addKbEntry(db, tenant.id, 'كم السعر؟', '١٠٠ ريال');
    expect(listKb(db, tenant.id)).toHaveLength(1);

    updateKbEntry(db, tenant.id, entry.id, 'كم سعر الكشف؟', '١٥٠ ريال');
    expect(listKb(db, tenant.id)[0]?.answer).toBe('١٥٠ ريال');

    deleteKbEntry(db, tenant.id, entry.id);
    expect(listKb(db, tenant.id)).toHaveLength(0);
  });

  it('السؤال أو الجواب الفارغ يُرفض', () => {
    expect(() => addKbEntry(db, tenant.id, '  ', 'جواب')).toThrow(/مطلوبان/);
    expect(() => addKbEntry(db, tenant.id, 'سؤال', '')).toThrow(/مطلوبان/);
  });

  it('تعديل سؤال منشأة أخرى يُرفض', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const entry = addKbEntry(db, tenant.id, 'س', 'ج');
    expect(() => updateKbEntry(db, other.id, entry.id, 'س', 'مخترَق')).toThrow(/غير موجود/);
  });

  it('المعرفة تُصاغ نصاً واحداً يجمع النص الحر والأسئلة', () => {
    addKbEntry(db, tenant.id, 'وين موقعكم؟', 'حي النرجس، الرياض.');
    const rendered = renderKnowledge(db, tenant.id, {
      freeText: 'صالون نسائي يفتح من ١٠ صباحاً.',
      unknownPolicy: 'x',
    });
    expect(rendered).toContain('صالون نسائي');
    expect(rendered).toContain('س: وين موقعكم؟');
    expect(rendered).toContain('ج: حي النرجس، الرياض.');
  });

  it('وحدة الاستفسارات لا تضيف أدوات — تعمل بالمعرفة المحقونة', () => {
    expect(inquiriesModule.tools(ctxFor('inquiries'))).toHaveLength(0);
  });
});
