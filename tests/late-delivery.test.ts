/**
 * الرسالة المتأخرة التسليم.
 *
 * الحادثة الحقيقية: كتبت العميلة شكواها ٣:٤٦ فلم تصل الخادم. أعادت
 * إرسالها ٤:٠١ فوصلت وسُجّلت شكوى وأُغلقت ٤:٠٣. ثم سلّمت Meta رسالة
 * ٣:٤٦ في ٥:١١ — بعد ساعة ونصف — فردّ عليها البوت وكأنها جديدة،
 * فبدا أنه يفتح موضوعاً منتهياً من تلقاء نفسه.
 *
 * ولم يكن للنظام سبيل ليعرف: لم يكن يقرأ ختم الإرسال إطلاقاً، بل
 * يسجّل لحظة الوصول. فكل رسالة تبدو له جديدة مهما تأخرت.
 *
 * والقيد هنا طرفان: لا تضيع رسالة أبداً، ولا يُردّ على ما تجاوزه
 * الحديث.
 */

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { getOrCreateConversation, recentMessages, type Db } from '../src/db/index.ts';
import { freshDb, seedTenant, silentLogger, mockClaude, type ScriptedTurn } from './helpers.ts';
import { fromEpochSeconds } from '../src/time.ts';

const CUSTOMER = '966501052903';
const TENANT_NUMBER = '966500000001';

function testConfig(): AppConfig {
  return { ...loadConfig(), provider: 'simulator', historyLimit: 20, anthropicApiKey: 'test' };
}

async function setup(turns: ScriptedTurn[]) {
  const db: Db = freshDb();
  const tenant = seedTenant(db, { name: 'وقودي', waNumber: TENANT_NUMBER, staffWaNumber: '966500000099' });
  const provider = new SimulatorProvider();
  const app = await buildApp({ config: testConfig(), db, provider, logger: silentLogger() });
  const claude = mockClaude(turns);
  provider.onMessage(createEngine({ app, claude }));

  return {
    db,
    tenant,
    claude,
    async send(text: string, sentAt?: number) {
      await provider.receive({
        toNumber: TENANT_NUMBER,
        from: CUSTOMER,
        text,
        waMessageId: `wamid.${Math.random()}`,
        ...(sentAt === undefined ? {} : { sentAt }),
      });
    },
    replies(): string[] {
      return provider.outbox.filter((m) => m.to === CUSTOMER).map((m) => m.text);
    },
    stored(): { role: string; body: string; created_at: string }[] {
      const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
      return recentMessages(db, conversation.id, 50).map((m) => ({
        role: m.role,
        body: m.body,
        created_at: m.created_at,
      }));
    },
  };
}

/** ثوانٍ الحقبة لوقت قبل دقائق. */
function minutesAgo(minutes: number): number {
  return Math.floor(Date.now() / 1000) - minutes * 60;
}

describe('ختم الإرسال يُحفظ لا ختم الوصول', () => {
  it('الرسالة تُسجَّل بوقت كتابتها', async () => {
    const h = await setup([{ text: 'أهلاً' }]);
    const sentAt = minutesAgo(90);

    await h.send('رسالة قديمة', sentAt);

    const customer = h.stored().find((m) => m.role === 'customer')!;
    expect(customer.created_at).toBe(fromEpochSeconds(sentAt));
  });

  it('وبلا ختم تُسجَّل بوقت الوصول كما كان', async () => {
    const h = await setup([{ text: 'أهلاً' }]);
    await h.send('رسالة بلا ختم');

    const customer = h.stored().find((m) => m.role === 'customer')!;
    expect(customer.created_at).toBeTruthy();
  });
});

describe('الحادثة كما وقعت', () => {
  it('رسالة سُلّمت متأخرة بعد حديث أحدث: تُحفظ ولا يُردّ عليها', async () => {
    const h = await setup([{ text: 'رد على الأولى' }, { text: 'رد لا يجب أن يحدث' }]);

    // ٤:٠١ — وصلت وسُجّلت ورُدّ عليها
    await h.send('ينبع البحر فرع الصريف تعامل سيئ', minutesAgo(70));
    expect(h.replies()).toHaveLength(1);

    // ٥:١١ — تصل رسالة ٣:٤٦ متأخرة
    await h.send('ينبع البحر فرع الصريف تعامل سيئ', minutesAgo(85));

    // حُفظت
    const bodies = h.stored().filter((m) => m.role === 'customer');
    expect(bodies).toHaveLength(2);

    // ولم يُردّ عليها
    expect(h.replies()).toHaveLength(1);
  });

  it('والرسالة المتأخرة تظهر في مكانها الصحيح زمنياً', async () => {
    const h = await setup([{ text: 'أ' }, { text: 'ب' }]);
    const older = minutesAgo(85);
    const newer = minutesAgo(70);

    await h.send('الأحدث وصلت أولاً', newer);
    await h.send('الأقدم وصلت متأخرة', older);

    const customers = h.stored().filter((m) => m.role === 'customer');
    const oldOne = customers.find((m) => m.body === 'الأقدم وصلت متأخرة')!;
    const newOne = customers.find((m) => m.body === 'الأحدث وصلت أولاً')!;

    // الترتيب الزمني يطابق ما يراه العميل في واتساب
    expect(oldOne.created_at < newOne.created_at).toBe(true);
  });
});

describe('ولا يُمنع ما يجب أن يُردّ عليه', () => {
  it('رسالة متأخرة لكنها الأحدث — كأن يكون الخادم هبط ثم عاد', async () => {
    const h = await setup([{ text: 'أهلاً بعد العودة' }]);

    // لا شيء قبلها؛ سُلّمت متأخرة ساعتين لأن الخادم كان متوقفاً
    await h.send('متى تفتحون؟', minutesAgo(120));

    expect(h.replies()).toHaveLength(1);
  });

  it('ورسالة جديدة بعد قديمة تُردّ عليها عادةً', async () => {
    const h = await setup([{ text: 'أ' }, { text: 'ب' }]);

    await h.send('قديمة', minutesAgo(90));
    await h.send('جديدة', minutesAgo(1));

    expect(h.replies()).toHaveLength(2);
  });

  it('وتسلسل عادي بلا أختام لا يتأثر إطلاقاً', async () => {
    const h = await setup([{ text: 'أ' }, { text: 'ب' }, { text: 'ج' }]);

    await h.send('واحد');
    await h.send('اثنان');
    await h.send('ثلاثة');

    expect(h.replies()).toHaveLength(3);
  });
});
