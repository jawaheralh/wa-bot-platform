/**
 * الإخفاء على المسار الحقيقي: من رسالة العميل حتى ما يُرسَل للنموذج.
 *
 * اختبار redact.ts وحده لا يكفي — قد يكون الإخفاء سليماً ولا يُستدعى،
 * أو يُستدعى على آخر رسالة دون بقية السياق. وهذا عطل صامت تماماً:
 * كل شيء يعمل، والأرقام تغادر.
 *
 * فهنا نفتّش ما وصل النموذج فعلاً — عبر claude.requests — لا ما ظننّا
 * أننا أرسلناه.
 */

import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { recentMessages, getOrCreateConversation, type Db } from '../src/db/index.ts';
import { freshDb, seedTenant, silentLogger, mockClaude, type ScriptedTurn } from './helpers.ts';

const CUSTOMER = '966555555555';
const TENANT_NUMBER = '966500000001';

function testConfig(redactPii: boolean): AppConfig {
  return {
    ...loadConfig(),
    provider: 'simulator',
    historyLimit: 20,
    anthropicApiKey: 'test',
    redactPii,
  };
}

async function setup(turns: ScriptedTurn[], redactPii = true) {
  const db: Db = freshDb();
  const tenant = seedTenant(db, { name: 'عيادة', waNumber: TENANT_NUMBER, staffWaNumber: '966500000099' });
  const provider = new SimulatorProvider();
  const app = await buildApp({ config: testConfig(redactPii), db, provider, logger: silentLogger() });
  const claude = mockClaude(turns);
  provider.onMessage(createEngine({ app, claude }));

  return {
    db,
    tenant,
    claude,
    provider,
    async send(text: string) {
      await provider.receive({ toNumber: TENANT_NUMBER, from: CUSTOMER, text });
    },
    /** كل ما وصل النموذج نصاً — النظام والرسائل معاً. */
    sentToModel(): string {
      return claude.requests
        .map((r) => {
          const messages = r.messages
            .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
            .join('\n');
          return `${r.system}\n${r.systemVolatile ?? ''}\n${messages}`;
        })
        .join('\n');
    },
    replies() {
      return provider.outbox.filter((m) => m.to === CUSTOMER).map((m) => m.text);
    },
  };
}

describe('ما يغادر السعودية', () => {
  it('رقم جوال العميل لا يصل النموذج', async () => {
    const h = await setup([{ text: 'أبشر، سجّلناه.' }]);
    await h.send('أنا محمد وجوالي 0551234567');

    const sent = h.sentToModel();
    expect(sent).not.toContain('0551234567');
    expect(sent).toContain('﴿جوال-1﴾');
    // والاسم يبقى: بلا اسم يصير البوت بارداً
    expect(sent).toContain('محمد');
  });

  it('رقم الهوية والآيبان لا يصلان', async () => {
    const h = await setup([{ text: 'تم.' }]);
    await h.send('هويتي 1012345678 وحسابي SA0380000000608010167519');

    const sent = h.sentToModel();
    expect(sent).not.toContain('1012345678');
    expect(sent).not.toContain('SA0380000000608010167519');
  });

  /**
   * الأهم: السياق كله لا الرسالة الأخيرة. رقم ذُكر سابقاً يُعاد
   * إرساله مع كل نداء — فإخفاء الأخيرة وحدها إخفاء بلا أثر.
   */
  it('رقم من رسالة سابقة يبقى مخفياً في النداءات التالية', async () => {
    const h = await setup([{ text: 'أهلاً.' }, { text: 'تمام.' }]);
    await h.send('جوالي 0551234567');
    await h.send('متى تفتحون؟');

    // النداء الثاني يحمل السياق كاملاً
    const second = h.claude.requests[1]!;
    const context = second.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(context).toContain('متى تفتحون؟');
    expect(context).not.toContain('0551234567');
  });

  it('النص العادي يمرّ كما هو — الإخفاء لا يُفسد الفهم', async () => {
    const h = await setup([{ text: 'نعم.' }]);
    await h.send('كم سعر بنزين ٩١؟');
    expect(h.sentToModel()).toContain('كم سعر بنزين ٩١؟');
  });
});

describe('ما يبقى عندنا كاملاً', () => {
  it('الرسالة تُحفظ بالرقم الحقيقي في قاعدة البيانات', async () => {
    const h = await setup([{ text: 'تم.' }]);
    await h.send('جوالي 0551234567');

    const conversation = getOrCreateConversation(h.db, h.tenant.id, CUSTOMER);
    const rows = recentMessages(h.db, conversation.id, 10);
    const customerRow = rows.find((r) => r.role === 'customer')!;

    expect(customerRow.body).toContain('0551234567');
    expect(customerRow.body).not.toContain('﴿');
  });

  /**
   * هذا هو بيت القصيد: الشركة تحتاج الرقم لترفع الطلب. النموذج يطلب
   * التسجيل برمز، ويُخزَّن الرقم الحقيقي.
   */
  it('الأداة تستقبل الرقم الحقيقي لا الرمز', async () => {
    const h = await setup([
      { text: '', toolCalls: [{ name: 'handoff_to_human', input: { reason: 'العميل على ﴿جوال-1﴾ يطلب موظفاً' } }] },
      { text: 'حوّلناك.' },
    ]);
    await h.send('جوالي 0551234567 أبغى موظف');

    // التنبيه الذاهب للموظف يحمل الرقم الحقيقي
    const staffNotes = h.provider.outbox.filter((m) => m.to === '966500000099').map((m) => m.text).join('\n');
    expect(staffNotes).toContain('0551234567');
    expect(staffNotes).not.toContain('﴿جوال-1﴾');
  });

  it('الرد للعميل لا يحمل رمزاً داخلياً', async () => {
    const h = await setup([{ text: 'سجّلنا رقمك ﴿جوال-1﴾ وبنتواصل معك.' }]);
    await h.send('جوالي 0551234567');

    const reply = h.replies().join('\n');
    expect(reply).toContain('0551234567');
    expect(reply).not.toContain('﴿');
  });
});

describe('التعطيل', () => {
  it('REDACT_PII=0 يُمرّر النص كما هو', async () => {
    const h = await setup([{ text: 'تم.' }], false);
    await h.send('جوالي 0551234567');
    expect(h.sentToModel()).toContain('0551234567');
  });
});
