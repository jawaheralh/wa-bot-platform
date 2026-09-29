/**
 * المتابعة قبل إغلاق النافذة.
 *
 * الغرض توفير كلفة القوالب: الرسالة داخل النافذة مجانية، وردّ العميل
 * يفتح نافذة جديدة. لكن الخطر مقابلها مباشر — رسالة تصل من لا ينتظر
 * شيئاً إزعاج، وتكرارها بلاغٌ يُحظر به الرقم كله.
 *
 * فأكثر ما يُفحص هنا هو متى لا تُرسل.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { freshDb, seedTenant, silentLogger, mockClaude } from './helpers.ts';
import {
  getOrCreateConversation,
  saveMessage,
  silenceConversation,
  type Db,
  type TenantRow,
} from '../src/db/index.ts';
import { findCandidates, runFollowups, minutesUntilClose } from '../src/followup.ts';
import { createComplaint, updateComplaintStatus } from '../src/modules/complaints.ts';
import { setEnabled } from '../src/modules/registry.ts';
import { now } from '../src/time.ts';

const CUSTOMER = '966555000111';

let db: Db;
let app: App;
let provider: SimulatorProvider;
let tenant: TenantRow;

function config(): AppConfig {
  return { ...loadConfig(), provider: 'simulator', anthropicApiKey: 'test', followup: true };
}

/** يضع آخر رسالة للعميل قبل كذا دقيقة من الآن. */
function customerSpokeMinutesAgo(conversationId: number, minutes: number): void {
  const stamp = now(new Date(Date.now() - minutes * 60_000));
  const id = saveMessage(db, conversationId, 'customer', 'رسالة');
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(stamp, id);
}

function openComplaint(conversationId: number): number {
  return createComplaint(db, {
    tenantId: tenant.id,
    conversationId,
    customerWa: CUSTOMER,
    summary: 'المضخة معطلة',
    category: 'service',
    severity: 'medium',
  }).id;
}

beforeEach(async () => {
  db = freshDb();
  tenant = seedTenant(db, { name: 'وقودي', waNumber: '966500000001' });
  setEnabled(db, tenant.id, 'requests', true);
  provider = new SimulatorProvider();
  app = await buildApp({ config: config(), db, provider, logger: silentLogger() });
});

afterEach(() => db.close());

describe('حساب المتبقّي', () => {
  it('أربع وعشرون ساعة من آخر رسالة للعميل', () => {
    expect(minutesUntilClose('2026-09-29 10:00:00', '2026-09-29 10:00:00')).toBe(24 * 60);
    expect(minutesUntilClose('2026-09-29 10:00:00', '2026-09-30 09:00:00')).toBe(60);
    expect(minutesUntilClose('2026-09-29 10:00:00', '2026-09-30 11:00:00')).toBeLessThan(0);
  });
});

describe('من يستحق متابعة', () => {
  it('عميل على الإغلاق وله شكوى مفتوحة', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60); // بقي ٦٠ دقيقة
    openComplaint(conversation.id);

    const candidates = findCandidates(app, tenant);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.pending[0]).toContain('المضخة معطلة');
  });
});

describe('ومن لا يستحق', () => {
  it('من لا شيء معلّق له — لا يُزعَج', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });

  it('ومن أُغلقت شكواه', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    const complaint = openComplaint(conversation.id);
    updateComplaintStatus(db, tenant.id, complaint, 'closed');

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });

  it('ومن نافذته ما زالت واسعة', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 60); // بقي ٢٣ ساعة
    openComplaint(conversation.id);

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });

  /** فات الأوان: لا يُقبل إلا قالب، وإرسال نص حر يُرفض. */
  it('ومن انقضت نافذته أصلاً', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 25 * 60);
    openComplaint(conversation.id);

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });

  it('ومن أوقف له البوت', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);
    db.prepare('UPDATE conversations SET bot_enabled = 0 WHERE id = ?').run(conversation.id);

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });

  /** الصمت يعني أن موظفاً يعالج الحالة — لا يقاطعه البوت. */
  it('ومن يعالجه موظف الآن', () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);
    silenceConversation(db, conversation.id, 120);

    expect(findCandidates(app, tenant)).toHaveLength(0);
  });
});

describe('الإرسال', () => {
  it('يُرسل رسالة واحدة ويحفظها', async () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);

    const claude = mockClaude([{ text: 'نتابع معك بخصوص شكواك. تحتاج شيئاً؟' }]);
    const sent = await runFollowups(app, claude);

    expect(sent).toBe(1);
    const outbox = provider.outbox.filter((m) => m.to === CUSTOMER);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.text).toContain('نتابع معك');
  });

  /** النبضة كل دقيقة — بلا علامة يُرسَل ستون رسالة في الساعة. */
  it('ولا تتكرر في النبضة التالية', async () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);

    const claude = mockClaude([{ text: 'متابعة' }, { text: 'متابعة ثانية' }]);
    await runFollowups(app, claude);
    const second = await runFollowups(app, claude);

    expect(second).toBe(0);
    expect(provider.outbox.filter((m) => m.to === CUSTOMER)).toHaveLength(1);
  });

  /** رسالة جديدة من العميل = نافذة جديدة = يستحق متابعتها لاحقاً. */
  it('وتعود بعد أن يتكلّم العميل من جديد', async () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);

    const claude = mockClaude([{ text: 'أولى' }, { text: 'ثانية' }]);
    await runFollowups(app, claude);

    /**
     * مرّ يوم: المتابعة الأولى صارت بالأمس، ثم تكلّم العميل من جديد
     * واقتربت نافذته الجديدة من الإغلاق.
     *
     * تأخير العلامة لازم — بدونه يكون «رسالة العميل الجديدة» أقدم من
     * متابعةٍ أُرسلت للتو، وهو ترتيب لا يقع في الواقع.
     */
    const yesterday = now(new Date(Date.now() - 25 * 60 * 60_000));
    db.prepare('UPDATE conversations SET followup_at = ? WHERE id = ?').run(yesterday, conversation.id);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);

    const again = await runFollowups(app, claude);
    expect(again).toBe(1);
  });

  it('وتعطيلها يمنعها تماماً', async () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);

    const off = await buildApp({
      config: { ...config(), followup: false },
      db,
      provider,
      logger: silentLogger(),
    });
    expect(await runFollowups(off, mockClaude([{ text: 'x' }]))).toBe(0);
  });

  it('وفشل النموذج لا يمنع المتابعة', async () => {
    const conversation = getOrCreateConversation(db, tenant.id, CUSTOMER);
    customerSpokeMinutesAgo(conversation.id, 23 * 60);
    openComplaint(conversation.id);

    const broken = {
      async chat() {
        throw new Error('النموذج متوقف');
      },
    } as never;

    expect(await runFollowups(app, broken)).toBe(1);
    expect(provider.outbox.filter((m) => m.to === CUSTOMER)[0]!.text).toContain('نتابع معك');
  });
});
