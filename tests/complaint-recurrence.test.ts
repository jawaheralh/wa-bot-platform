/**
 * حالة الشكاوى والطلبات تصل النموذج.
 *
 * العطل ظهر في محادثة حقيقية: سُجّلت شكوى ٠٤:٠١، وأُغلقت ٠٤:٠٣، ثم
 * أعاد العميل ذكرها ٠٥:١١ فقال البوت «مسجّلة عندنا مسبقاً ويتابعها
 * المسؤول» — وهي مُغلقة منذ ساعة.
 *
 * ولم يكن النموذج كاذباً: لم يكن أحد يخبره. كان يقرأ تاريخ المحادثة
 * وحده، فيرى أنه سجّلها قبل قليل ولا يرى ما جرى لها بعد ذلك.
 *
 * ولذلك يُفحص هنا ما وصل النموذج فعلاً، لا ما ظننّا أننا أرسلناه.
 */

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { getOrCreateConversation, type Db } from '../src/db/index.ts';
import { freshDb, seedTenant, silentLogger, mockClaude, type ScriptedTurn } from './helpers.ts';
import { createComplaint, updateComplaintStatus } from '../src/modules/complaints.ts';
import { setEnabled } from '../src/modules/registry.ts';

const CUSTOMER = '966555555555';
const TENANT_NUMBER = '966500000001';

function testConfig(): AppConfig {
  return { ...loadConfig(), provider: 'simulator', historyLimit: 20, anthropicApiKey: 'test' };
}

async function setup(turns: ScriptedTurn[]) {
  const db: Db = freshDb();
  const tenant = seedTenant(db, { name: 'وقودي', waNumber: TENANT_NUMBER, staffWaNumber: '966500000099' });
  setEnabled(db, tenant.id, 'requests', true);

  const provider = new SimulatorProvider();
  const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
  const claude = mockClaude(turns);
  provider.onMessage(createEngine({ app, claude }));

  return {
    db,
    tenant,
    claude,
    async send(text: string, from = CUSTOMER) {
      await provider.receive({ toNumber: TENANT_NUMBER, from, text });
    },
    /** ما وصل النموذج بعد نقطة التخزين — الجزء المتغيّر. */
    lastVolatile(): string {
      return String(claude.requests[claude.requests.length - 1]?.systemVolatile ?? '');
    },
    /** الجزء الثابت المخزَّن مؤقتاً. */
    lastCached(): string {
      return String(claude.requests[claude.requests.length - 1]?.system ?? '');
    },
  };
}

describe('حالة الشكوى تصل النموذج', () => {
  it('الشكوى المفتوحة تظهر بحالتها', async () => {
    const h = await setup([{ text: 'تم.' }]);
    const conversation = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    createComplaint(h.db, {
      tenantId: h.tenant.id,
      conversationId: conversation.id,
      customerWa: CUSTOMER,
      summary: 'سوء تعامل في محطة الصريف',
      category: 'service',
      severity: 'high',
    });

    await h.send('وش صار بشكواي؟');

    const volatile = h.lastVolatile();
    expect(volatile).toContain('SHK-');
    expect(volatile).toContain('جديدة');
    expect(volatile).toContain('سوء تعامل في محطة الصريف');
  });

  /** جوهر العطل. */
  it('الشكوى المغلقة تصل موصوفة بأنها مغلقة لا «قيد المتابعة»', async () => {
    const h = await setup([{ text: 'تم.' }]);
    const conversation = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    const complaint = createComplaint(h.db, {
      tenantId: h.tenant.id,
      conversationId: conversation.id,
      customerWa: CUSTOMER,
      summary: 'سوء تعامل في محطة الصريف',
      category: 'service',
      severity: 'high',
    });
    updateComplaintStatus(h.db, h.tenant.id, complaint.id, 'closed');

    await h.send('نفس الموضوع صار لي مرة ثانية');

    const volatile = h.lastVolatile();
    expect(volatile).toContain(complaint.reference);
    expect(volatile).toContain('مغلقة');
  });

  it('والتعليمات تأمر بتسجيل شكوى جديدة بعد الإغلاق لا بالإحالة للمغلقة', async () => {
    const h = await setup([{ text: 'تم.' }]);
    await h.send('مرحبا');

    const cached = h.lastCached();
    expect(cached).toContain('مغلقة');
    expect(cached).toContain('سجّل شكوى جديدة');
    expect(cached).toContain('ولا تقل إن المغلقة «قيد المتابعة»');
  });

  it('عميل بلا شكاوى لا يُرسَل له قسم فارغ', async () => {
    const h = await setup([{ text: 'تم.' }]);
    await h.send('متى تفتحون؟');
    expect(h.lastVolatile()).not.toContain('شكاوى هذا العميل');
  });
});

describe('حالة الطلبات كذلك', () => {
  it('الطلب المسجّل يظهر بحالته', async () => {
    const h = await setup([{ text: 'تم.' }]);
    const conversation = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    h.db
      .prepare(
        `INSERT INTO requests (tenant_id, conversation_id, reference, customer_wa, kind, summary, status)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(h.tenant.id, conversation.id, 'TLB-2026-000009', CUSTOMER, 'maintenance', 'المضخة معطلة', 'done');

    await h.send('وش صار بطلبي؟');

    const volatile = h.lastVolatile();
    expect(volatile).toContain('TLB-2026-000009');
    expect(volatile).toContain('المضخة معطلة');
  });
});

/**
 * الحارس الاقتصادي.
 *
 * وضع حالة متغيّرة في الجزء المخزَّن يُبطل التخزين في كل رسالة
 * ويضاعف كلفة الإدخال — عطل لا يظهر إلا في الفاتورة آخر الشهر.
 */
describe('التخزين المؤقت لا ينكسر', () => {
  it('الجزء الثابت لا يحمل رقم شكوى ولا حالتها', async () => {
    const h = await setup([{ text: 'تم.' }]);
    const conversation = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    const complaint = createComplaint(h.db, {
      tenantId: h.tenant.id,
      conversationId: conversation.id,
      customerWa: CUSTOMER,
      summary: 'سوء تعامل',
      category: 'service',
      severity: 'high',
    });

    await h.send('مرحبا');

    const cached = h.lastCached();
    expect(cached).not.toContain(complaint.reference);
    expect(cached).not.toContain('شكاوى هذا العميل المسجّلة');
  });

  /**
   * العميلان يختلفان في الشكاوى ويتفقان في الجزء المخزَّن.
   *
   * لو اختلف الثابت بينهما لبطل التخزين مع كل عميل جديد — وهذا هو
   * ما يجعل الفرق بين توفير ٨٠٪ من كلفة الإدخال وعدم توفير شيء.
   */
  it('والجزء الثابت نفسه لعميلين مختلفين', async () => {
    const h = await setup([{ text: 'أ' }, { text: 'ب' }]);
    const OTHER = '966555000222';

    const first = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    createComplaint(h.db, {
      tenantId: h.tenant.id,
      conversationId: first.id,
      customerWa: CUSTOMER,
      summary: 'شكوى الأول',
      category: 'service',
      severity: 'low',
    });

    await h.send('مرحبا', CUSTOMER);
    const cachedA = h.lastCached();
    const volatileA = h.lastVolatile();

    await h.send('مرحبا', OTHER);
    const cachedB = h.lastCached();
    const volatileB = h.lastVolatile();

    // الثابت واحد — فالتخزين يُقرأ لا يُعاد بناؤه
    expect(cachedA).toBe(cachedB);
    // والمتغيّر مختلف — فكلٌّ يرى شكاواه هو وحده
    expect(volatileA).toContain('شكوى الأول');
    expect(volatileB).not.toContain('شكوى الأول');
  });
});
