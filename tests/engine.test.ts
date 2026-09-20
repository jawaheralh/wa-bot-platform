/**
 * محرّك البوت من الرسالة الواردة حتى الرد المُرسَل.
 * نستعمل مزوّد المحاكي و Claude مبرمَجاً، فنختبر المسار الحقيقي كاملاً
 * بلا شبكة: التوجيه، والسياق، وحلقة الأدوات، والصمت، والفشل.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { botMayReply, getOrCreateConversation, recentMessages, type Db } from '../src/db/index.ts';
import { addKbEntry } from '../src/modules/inquiries.ts';
import { setConfig } from '../src/modules/registry.ts';
import { freshDb, seedTenant, silentLogger, mockClaude, type ScriptedTurn } from './helpers.ts';

function testConfig(): AppConfig {
  const config = loadConfig();
  return { ...config, provider: 'simulator', historyLimit: 20, silentMinutes: 120, anthropicApiKey: 'test' };
}

interface Harness {
  app: App;
  provider: SimulatorProvider;
  db: Db;
  claude: ReturnType<typeof mockClaude>;
  send(text: string, options?: { from?: string; fromMe?: boolean; to?: string }): Promise<void>;
  replies(): string[];
}

let harness: Harness;

async function setup(turns: ScriptedTurn[], tenantNumber = '966500000001'): Promise<Harness> {
  const db = freshDb();
  seedTenant(db, { name: 'عيادة النور', waNumber: '966500000001', tone: 'formal', staffWaNumber: '966500000099' });
  seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002', tone: 'friendly' });

  const provider = new SimulatorProvider();
  const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
  const claude = mockClaude(turns);
  provider.onMessage(createEngine({ app, claude }));

  return {
    app,
    provider,
    db,
    claude,
    async send(text, options = {}) {
      await provider.receive({
        toNumber: options.to ?? tenantNumber,
        from: options.from ?? '966555555555',
        text,
        fromMe: options.fromMe,
      });
    },
    // رسائل العميل فقط — تنبيهات الموظف تذهب لرقم آخر ولا يجب أن تُحسب رداً.
    replies() {
      const customerNumber = '966555555555';
      return provider.outbox.filter((m) => m.to === customerNumber).map((m) => m.text);
    },
  };
}

afterEach(() => {
  harness?.db.close();
});

describe('المسار الأساسي', () => {
  it('رسالة العميل تُحفظ ويُرسَل الرد ويُحفظ', async () => {
    harness = await setup([{ text: 'هلا والله، كيف أقدر أساعدك؟' }]);
    await harness.send('السلام عليكم');

    expect(harness.replies()).toEqual(['هلا والله، كيف أقدر أساعدك؟']);

    const conv = getOrCreateConversation(harness.db, 1, '966555555555');
    const messages = recentMessages(harness.db, conv.id, 10);
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ['customer', 'السلام عليكم'],
      ['bot', 'هلا والله، كيف أقدر أساعدك؟'],
    ]);
  });

  it('رسالة لرقم غير مسجَّل تُهمل بلا رد', async () => {
    harness = await setup([{ text: 'مرحبا' }]);
    await harness.send('سلام', { to: '966599999999' });
    expect(harness.replies()).toEqual([]);
  });

  it('كل منشأة تحصل على prompt يحمل اسمها ونبرتها', async () => {
    harness = await setup([{ text: 'تم' }]);
    await harness.send('سلام', { to: '966500000001' });
    await harness.send('سلام', { to: '966500000002' });

    expect(harness.claude.requests[0]?.system).toContain('عيادة النور');
    expect(harness.claude.requests[0]?.system).toContain('أسلوبك رسمي');
    expect(harness.claude.requests[1]?.system).toContain('مطعم الركن');
    expect(harness.claude.requests[1]?.system).toContain('أسلوبك ودّي');
  });

  it('الوقت الحالي بتوقيت الرياض يُحقن في الـprompt', async () => {
    harness = await setup([{ text: 'تم' }]);
    await harness.send('كم الساعة؟');
    expect(harness.claude.requests[0]?.system).toMatch(/الساعة الآن \d{2}:\d{2} (صباحاً|ظهراً|مساءً|ليلاً) بتوقيت الرياض/);
  });
});

describe('السياق', () => {
  it('يُمرَّر آخر ٢٠ رسالة فقط', async () => {
    harness = await setup([{ text: 'تم' }]);
    for (let i = 1; i <= 15; i++) await harness.send(`رسالة ${i}`);

    const last = harness.claude.requests[harness.claude.requests.length - 1]!;
    expect(last.messages.length).toBeLessThanOrEqual(20);
    expect(last.messages[last.messages.length - 1]?.content).toBe('رسالة 15');
  });

  it('المحادثة تبدأ دائماً برسالة عميل كما يشترط الـAPI', async () => {
    harness = await setup([{ text: 'تم' }]);
    for (let i = 1; i <= 15; i++) await harness.send(`رسالة ${i}`);
    for (const request of harness.claude.requests) {
      expect(request.messages[0]?.role).toBe('user');
    }
  });

  it('محادثتا عميلين مختلفين لا تتداخلان', async () => {
    harness = await setup([{ text: 'تم' }]);
    await harness.send('أنا الأول', { from: '966555555551' });
    await harness.send('أنا الثاني', { from: '966555555552' });

    const second = harness.claude.requests[1]!;
    expect(JSON.stringify(second.messages)).not.toContain('أنا الأول');
  });
});

describe('حلقة الأدوات', () => {
  it('الشكوى تُسجَّل ويُبلَّغ العميل برقمها', async () => {
    harness = await setup([
      {
        toolCalls: [
          { name: 'create_complaint', input: { summary: 'الطلب تأخر ساعتين', category: 'delay', severity: 'medium' } },
        ],
      },
      { text: 'أعتذر عن التأخير. سجّلت شكواك برقم SHK.' },
    ]);
    await harness.send('طلبي تأخر ساعتين');

    const row = harness.db.prepare('SELECT * FROM complaints').get() as { reference: string; category: string };
    expect(row.category).toBe('delay');
    expect(row.reference).toMatch(/^SHK-\d{4}-\d{6}$/);

    // نتيجة الأداة عادت للنموذج قبل صياغة الرد
    const second = harness.claude.requests[1]!;
    expect(JSON.stringify(second.messages)).toContain(row.reference);
    expect(harness.replies()).toHaveLength(1);
  });

  it('الشكوى عالية الخطورة تنبّه الموظف فوراً', async () => {
    harness = await setup([
      {
        toolCalls: [
          {
            name: 'create_complaint',
            input: { summary: 'العامل تعامل بأسلوب سيئ وأنا زعلان', category: 'service', severity: 'high' },
          },
        ],
      },
      { text: 'أعتذر بشدة. سجّلت الشكوى وأبلغت المسؤول.' },
    ]);
    await harness.send('العامل تعامل معي بأسلوب سيئ جداً!');

    const alert = harness.db.prepare(`SELECT * FROM alerts WHERE kind = 'complaint'`).get() as
      | { title: string; body: string }
      | undefined;
    expect(alert?.title).toContain('عالية الخطورة');

    // وتنبيه واتساب فعلي لرقم الموظف
    const staffMessages = harness.provider.outbox.filter((m) => m.to === '966500000099');
    expect(staffMessages).toHaveLength(1);
    expect(staffMessages[0]?.text).toContain('أسلوب سيئ');
  });

  it('الشكوى المتوسطة لا تنبّه الموظف', async () => {
    harness = await setup([
      { toolCalls: [{ name: 'create_complaint', input: { summary: 'ملاحظة', category: 'other', severity: 'medium' } }] },
      { text: 'تم التسجيل.' },
    ]);
    await harness.send('عندي ملاحظة بسيطة');
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM alerts').get()).toEqual({ n: 0 });
  });

  it('الاستعلام عن شكوى غير موجودة لا يخترع نتيجة', async () => {
    harness = await setup([
      { toolCalls: [{ name: 'get_complaint_status', input: { reference: 'SHK-2026-999999' } }] },
      { text: 'ما لقيت شكوى بهذا الرقم.' },
    ]);
    await harness.send('وش صار على شكواي SHK-2026-999999؟');

    const second = harness.claude.requests[1]!;
    expect(JSON.stringify(second.messages)).toContain('لا توجد شكوى');
  });

  it('التحويل يوقف الدورة ويُرسل نص التحويل بلا سؤال النموذج مرة أخرى', async () => {
    harness = await setup([
      { toolCalls: [{ name: 'handoff_to_human', input: { reason: 'سأل عن استرجاع مبلغ ولا توجد سياسة' } }] },
      { text: 'يجب ألّا يُستدعى النموذج بعد التحويل' },
    ]);
    await harness.send('أبغى أسترجع فلوسي');

    expect(harness.claude.requests).toHaveLength(1);
    expect(harness.replies()[0]).toContain('حوّلتك للموظف المختص');

    const handoff = harness.db.prepare('SELECT * FROM handoffs').get() as { reason: string };
    expect(handoff.reason).toContain('استرجاع مبلغ');
  });

  it('التحويل يُسكت البوت، فالرسالة التالية تُحفظ بلا رد', async () => {
    harness = await setup([
      { toolCalls: [{ name: 'handoff_to_human', input: { reason: 'طلب موظفاً' } }] },
    ]);
    await harness.send('أبي أكلم موظف');
    const afterHandoff = harness.replies().length;

    await harness.send('ألو؟');
    expect(harness.replies()).toHaveLength(afterHandoff);

    const conv = getOrCreateConversation(harness.db, 1, '966555555555');
    expect(botMayReply(harness.db, conv.id)).toBe(false);
    expect(recentMessages(harness.db, conv.id, 10).some((m) => m.body === 'ألو؟')).toBe(true);
  });

  it('نداء أداة غير مفعّلة يعود للنموذج كخطأ مفهوم لا كانهيار', async () => {
    harness = await setup([
      { toolCalls: [{ name: 'book_appointment', input: { when: 'بكرة' } }] },
      { text: 'أعتذر، الحجز غير متاح.' },
    ]);
    await harness.send('أبي أحجز موعد');

    expect(JSON.stringify(harness.claude.requests[1]!.messages)).toContain('غير متاحة');
    expect(harness.replies()).toEqual(['أعتذر، الحجز غير متاح.']);
  });

  it('حلقة أدوات لا تنتهي تتوقف عند الحدّ الأقصى', async () => {
    harness = await setup([{ toolCalls: [{ name: 'get_complaint_status', input: { reference: 'X' } }] }]);
    await harness.send('وش صار؟');
    expect(harness.claude.requests.length).toBeLessThanOrEqual(5);
    expect(harness.replies()).toHaveLength(1);
  });
});

describe('تدخّل الموظف يدوياً', () => {
  it('رسالة من رقم المنشأة تُسجَّل كرد موظف وتُسكت البوت ساعتين', async () => {
    harness = await setup([{ text: 'رد البوت' }]);
    await harness.send('عندي سؤال');
    expect(harness.replies()).toHaveLength(1);

    await harness.send('أهلاً، أنا محمد من العيادة', { fromMe: true });
    expect(harness.replies()).toHaveLength(1);

    const conv = getOrCreateConversation(harness.db, 1, '966555555555');
    expect(botMayReply(harness.db, conv.id)).toBe(false);
    expect(recentMessages(harness.db, conv.id, 10).some((m) => m.role === 'staff')).toBe(true);

    await harness.send('طيب شكراً');
    expect(harness.replies()).toHaveLength(1);
  });

  it('بعد انتهاء نافذة الصمت يعود البوت', async () => {
    harness = await setup([{ text: 'رجعت' }]);
    await harness.send('رد الموظف', { fromMe: true });

    harness.db
      .prepare(`UPDATE conversations SET silent_until = datetime('now','+3 hours','-1 minutes')`)
      .run();

    await harness.send('في أحد؟');
    expect(harness.replies()).toEqual(['رجعت']);
  });
});

describe('قاعدة المعرفة', () => {
  it('المعرفة تُحقن في الـprompt والسياسة تمنع الاختراع', async () => {
    harness = await setup([{ text: 'تم' }]);
    addKbEntry(harness.db, 1, 'كم سعر الكشف؟', 'الكشف ١٥٠ ريال.');
    setConfig(harness.db, 1, 'inquiries', { freeText: 'نفتح من ٩ صباحاً إلى ٩ مساءً.' });

    await harness.send('كم سعر الكشف؟');
    const system = harness.claude.requests[0]!.system;
    expect(system).toContain('الكشف ١٥٠ ريال.');
    expect(system).toContain('نفتح من ٩ صباحاً');
    expect(system).toContain('لا تستنتجه');
  });

  it('منشأة بلا معرفة يُمنع عليها الجواب صراحةً', async () => {
    harness = await setup([{ text: 'تم' }]);
    await harness.send('كم السعر؟');
    expect(harness.claude.requests[0]!.system).toContain('لا توجد معلومات مُدخَلة');
  });

  it('معرفة منشأة لا تتسرب لأخرى', async () => {
    harness = await setup([{ text: 'تم' }]);
    addKbEntry(harness.db, 1, 'س', 'سرّ العيادة');

    await harness.send('سلام', { to: '966500000002' });
    expect(harness.claude.requests[0]!.system).not.toContain('سرّ العيادة');
  });
});

describe('الفشل', () => {
  it('فشل النموذج يُنتج اعتذاراً ويُنبّه الموظف بدل صمت العميل', async () => {
    const db = freshDb();
    seedTenant(db, { name: 'عيادة', waNumber: '966500000001', staffWaNumber: '966500000099' });
    const provider = new SimulatorProvider();
    const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
    provider.onMessage(
      createEngine({
        app,
        claude: {
          async chat() {
            throw new Error('انقطاع في الشبكة');
          },
        },
      }),
    );
    harness = {
      app,
      provider,
      db,
      claude: mockClaude([]),
      send: async (text) => provider.receive({ toNumber: '966500000001', from: '966555555555', text }),
      replies: () => provider.outbox.filter((m) => m.to === '966555555555').map((m) => m.text),
    };

    await harness.send('سلام');

    const customerReply = harness.provider.outbox.find((m) => m.to === '966555555555');
    expect(customerReply?.text).toContain('عطل تقني');
    expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE kind = 'handoff'`).get()).toEqual({ n: 1 });
  });

  it('فشل الإرسال يحفظ الرد وينبّه الموظف بدل ضياعه', async () => {
    const db = freshDb();
    seedTenant(db, { name: 'عيادة', waNumber: '966500000001', staffWaNumber: '966500000099' });
    const provider = new SimulatorProvider();
    const original = provider.sendText.bind(provider);
    let first = true;
    provider.sendText = async (tenantId, to, text) => {
      if (first && to === '966555555555') {
        first = false;
        throw new Error('انقطع الاتصال');
      }
      return original(tenantId, to, text);
    };

    const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
    provider.onMessage(createEngine({ app, claude: mockClaude([{ text: 'أهلاً بك' }]) }));
    harness = {
      app,
      provider,
      db,
      claude: mockClaude([]),
      send: async (text) => provider.receive({ toNumber: '966500000001', from: '966555555555', text }),
      replies: () => provider.outbox.filter((m) => m.to === '966555555555').map((m) => m.text),
    };

    await harness.send('سلام');

    const conv = getOrCreateConversation(db, 1, '966555555555');
    expect(recentMessages(db, conv.id, 10).some((m) => m.role === 'bot' && m.body === 'أهلاً بك')).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM alerts`).get()).toEqual({ n: 1 });
  });
});

describe('الرسائل الصوتية', () => {
  it('بلا مزوّد تحويل يطلب البوت رسالة نصية بلطف', async () => {
    const db = freshDb();
    seedTenant(db, { name: 'عيادة', waNumber: '966500000001' });
    const provider = new SimulatorProvider();
    const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
    provider.onMessage(createEngine({ app, claude: mockClaude([{ text: 'لن يُستدعى' }]) }));

    await provider.receive({
      toNumber: '966500000001',
      from: '966555555555',
      audio: { mimeType: 'audio/ogg', download: async () => Buffer.from('') },
    });

    expect(provider.outbox[0]?.text).toContain('ما أقدر أسمع الرسائل الصوتية');
    harness = { app, provider, db, claude: mockClaude([]), send: async () => {}, replies: () => [] };
  });

  it('مع مزوّد تحويل يُعامَل النص كرسالة عادية', async () => {
    const db = freshDb();
    seedTenant(db, { name: 'عيادة', waNumber: '966500000001' });
    const provider = new SimulatorProvider();
    const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
    const claude = mockClaude([{ text: 'الكشف ١٥٠ ريال' }]);
    provider.onMessage(
      createEngine({ app, claude, transcriber: { transcribe: async () => 'كم سعر الكشف؟' } }),
    );

    await provider.receive({
      toNumber: '966500000001',
      from: '966555555555',
      audio: { mimeType: 'audio/ogg', download: async () => Buffer.from('fake') },
    });

    expect(JSON.stringify(claude.requests[0]!.messages)).toContain('كم سعر الكشف؟');
    expect(provider.outbox[0]?.text).toBe('الكشف ١٥٠ ريال');
    harness = { app, provider, db, claude, send: async () => {}, replies: () => [] };
  });
});
