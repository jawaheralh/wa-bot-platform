/**
 * وحدة الطلبات وإبلاغ العميل التلقائي.
 * المحك: أي تغيير حالة يصل العميل على واتساب مرة واحدة لا أكثر،
 * والفشل يُعاد صراحةً ولا يُوهم الموظف أن العميل عَلِم.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, baseContext, silentLogger } from './helpers.ts';
import { loadConfig } from '../src/config.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { getOrCreateConversation, type Db, type TenantRow } from '../src/db/index.ts';
import { composeTools, enabledFor, setEnabled } from '../src/modules/registry.ts';
import {
  requestsModule,
  createRequest,
  listRequests,
  findRequest,
  setRequestStatus,
  notifyRequestCustomer,
  customerUpdateText,
  type RequestRow,
} from '../src/modules/requests.ts';
import type { ModuleContext, ModuleDeps } from '../src/modules/types.ts';

let db: Db;
let tenant: TenantRow;
let provider: SimulatorProvider;

function deps(): ModuleDeps {
  return { db, config: loadConfig(), logger: silentLogger(), provider, notify: async () => {} };
}

function ctx(overrides: Record<string, unknown> = {}): ModuleContext {
  const base = baseContext(db, tenant);
  return {
    ...base,
    provider,
    conversation: getOrCreateConversation(db, tenant.id, '966555123456', 'خالد'),
    config: { ...requestsModule.defaultConfig(), ...overrides },
  };
}

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db, { name: 'منشأة الاختبار' });
  provider = new SimulatorProvider();
  setEnabled(db, tenant.id, 'requests', true);
});
afterEach(() => db.close());

describe('الوحدة اختيارية', () => {
  it('أدواتها غائبة قبل التفعيل', () => {
    const fresh = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const names = composeTools(enabledFor(db, fresh.id), baseContext(db, fresh)).map((t) => t.name);
    expect(names).not.toContain('create_request');
  });

  it('وحاضرة بعده', () => {
    const names = composeTools(enabledFor(db, tenant.id), baseContext(db, tenant)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_request', 'get_request_status']));
  });
});

describe('تسجيل الطلب', () => {
  it('يُنتج رقماً مرجعياً بصيغة TLB', async () => {
    const result = await requestsModule.runTool(
      'create_request',
      { summary: 'المضخة رقم ٣ معطلة', kind: 'maintenance', priority: 'urgent' },
      ctx(),
    );
    const row = listRequests(db, tenant.id)[0]!;
    expect(row.reference).toMatch(/^TLB-\d{4}-\d{6}$/);
    expect(result.content).toContain(row.reference);
    expect(row.kind).toBe('maintenance');
    expect(row.status).toBe('new');
  });

  it('الطلب العاجل ينبّه الموظف', async () => {
    let alerts = 0;
    await requestsModule.runTool(
      'create_request',
      { summary: 'تسرب وقود', kind: 'maintenance', priority: 'urgent' },
      { ...ctx(), notify: async () => void alerts++ },
    );
    expect(alerts).toBe(1);
  });

  it('الطلب العادي لا ينبّه', async () => {
    let alerts = 0;
    await requestsModule.runTool(
      'create_request',
      { summary: 'أبغى عرض سعر', kind: 'quote', priority: 'normal' },
      { ...ctx(), notify: async () => void alerts++ },
    );
    expect(alerts).toBe(0);
  });

  it('لا تُرسل رسالة ثانية عند التسجيل — البوت يذكر الرقم في ردّه', async () => {
    await requestsModule.runTool(
      'create_request',
      { summary: 'س', kind: 'other', priority: 'normal' },
      ctx(),
    );
    expect(provider.outbox).toHaveLength(0);
    expect(listRequests(db, tenant.id)[0]?.notified_status).toBe('new');
  });

  it('وصف فارغ يُرفض', async () => {
    const result = await requestsModule.runTool('create_request', { summary: '  ' }, ctx());
    expect(result.isError).toBe(true);
    expect(listRequests(db, tenant.id)).toHaveLength(0);
  });

  it('نوع خارج المسموح يسقط لقيمة آمنة', async () => {
    await requestsModule.runTool(
      'create_request',
      { summary: 'س', kind: 'اختراق', priority: 'فوري' },
      ctx({ kinds: ['maintenance', 'quote'] }),
    );
    const row = listRequests(db, tenant.id)[0]!;
    expect(row.kind).toBe('maintenance');
    expect(row.priority).toBe('normal');
  });
});

describe('إبلاغ العميل بتغيير الحالة', () => {
  function seedRequest(): RequestRow {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456', 'خالد');
    const row = createRequest(db, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerWa: '966555123456',
      customerName: 'خالد',
      kind: 'maintenance',
      priority: 'normal',
      summary: 'المضخة معطلة',
    });
    db.prepare(`UPDATE requests SET notified_status = 'new' WHERE id = ?`).run(row.id);
    return { ...row, notified_status: 'new' };
  }

  it('الرسالة تحمل رقم الطلب والحالة بالعربي', () => {
    const row = { ...seedRequest(), status: 'in_progress' as const };
    const text = customerUpdateText(row, 'منشأة الاختبار');
    expect(text).toContain(row.reference);
    expect(text).toContain('قيد التنفيذ');
    expect(text).toContain('بدأنا العمل على طلبك');
    expect(text).toContain('منشأة الاختبار');
  });

  it('تغيير الحالة يرسل للعميل مرة واحدة', async () => {
    const row = seedRequest();
    const updated = setRequestStatus(db, tenant.id, row.id, 'in_progress');

    const first = await notifyRequestCustomer(db, deps(), updated, 'منشأة الاختبار');
    expect(first.sent).toBe(true);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]?.to).toBe('966555123456');

    // إعادة النداء لنفس الحالة لا تُزعج العميل مرة ثانية
    const again = await notifyRequestCustomer(db, deps(), findRequest(db, tenant.id, row.reference)!, 'منشأة الاختبار');
    expect(again.sent).toBe(false);
    expect(provider.outbox).toHaveLength(1);
  });

  it('كل انتقال حالة جديد يُبلَّغ به', async () => {
    const row = seedRequest();
    for (const status of ['in_progress', 'waiting_customer', 'done'] as const) {
      const updated = setRequestStatus(db, tenant.id, row.id, status);
      await notifyRequestCustomer(db, deps(), updated, 'منشأة الاختبار');
    }
    expect(provider.outbox).toHaveLength(3);
    expect(provider.outbox.map((m) => m.text.includes('منجز')).filter(Boolean)).toHaveLength(1);
  });

  it('فشل الإرسال يُعاد صراحةً ولا يُعلَّم كمُبلَّغ', async () => {
    const row = seedRequest();
    provider.sendText = async () => {
      throw new Error('خارج نافذة ٢٤ ساعة');
    };
    const updated = setRequestStatus(db, tenant.id, row.id, 'in_progress');

    const result = await notifyRequestCustomer(db, deps(), updated, 'منشأة الاختبار');
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('٢٤ ساعة');
    // يبقى قابلاً لإعادة الإرسال لاحقاً
    expect(findRequest(db, tenant.id, row.reference)?.notified_status).toBe('new');
  });

  it('حالة غير معروفة تُرفض', () => {
    const row = seedRequest();
    expect(() => setRequestStatus(db, tenant.id, row.id, 'مؤجل' as never)).toThrow(/حالة غير معروفة/);
  });

  it('طلب منشأة لا يُعدَّل من منشأة أخرى', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const row = seedRequest();
    expect(() => setRequestStatus(db, other.id, row.id, 'done')).toThrow(/غير موجود/);
  });
});

describe('الاستعلام', () => {
  it('رقم غير موجود لا يُخترع له جواب', async () => {
    const result = await requestsModule.runTool('get_request_status', { reference: 'TLB-2026-999999' }, ctx());
    expect(result.content).toContain('لا يوجد طلب');
  });

  it('الرقم الصحيح يُعيد الحالة بالعربي', async () => {
    await requestsModule.runTool('create_request', { summary: 'س', kind: 'visit', priority: 'normal' }, ctx());
    const row = listRequests(db, tenant.id)[0]!;
    setRequestStatus(db, tenant.id, row.id, 'waiting_customer');

    const result = await requestsModule.runTool('get_request_status', { reference: row.reference }, ctx());
    expect(result.content).toContain('بانتظار العميل');
    expect(result.content).toContain('زيارة');
  });
});

describe('الملاحظة تخصّ حالتها', () => {
  it('ملاحظة حالة سابقة لا تُلصق برسالة حالة جديدة', () => {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    const row = createRequest(db, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerWa: '966555123456',
      kind: 'maintenance',
      priority: 'normal',
      summary: 'عطل',
    });

    const waiting = setRequestStatus(db, tenant.id, row.id, 'waiting_customer', 'نحتاج تأكيد موعد الفني');
    expect(customerUpdateText(waiting, 'منشأة الاختبار')).toContain('موعد الفني');

    const done = setRequestStatus(db, tenant.id, row.id, 'done');
    expect(done.note).toBeNull();
    expect(customerUpdateText(done, 'منشأة الاختبار')).not.toContain('موعد الفني');
    expect(customerUpdateText(done, 'منشأة الاختبار')).toContain('اكتمل طلبك');
  });

  it('حفظ بنفس الحالة لا يمسح الملاحظة', () => {
    const conversation = getOrCreateConversation(db, tenant.id, '966555123456');
    const row = createRequest(db, {
      tenantId: tenant.id,
      conversationId: conversation.id,
      customerWa: '966555123456',
      kind: 'other',
      priority: 'normal',
      summary: 'س',
    });
    setRequestStatus(db, tenant.id, row.id, 'in_progress', 'الفني في الطريق');
    const again = setRequestStatus(db, tenant.id, row.id, 'in_progress');
    expect(again.note).toBe('الفني في الطريق');
  });
});
