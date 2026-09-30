/**
 * رضا العملاء.
 *
 * أخطر ما هنا ليس حساب المتوسط بل **التقاط الردّ**: العميل يكتب «٥»
 * فتُسجَّل تقييماً، ويكتب «عندي ٥ سيارات معطلة» فتكون شكوى جديدة.
 * والخلط بينهما يبتلع شكوى حقيقية ويسجّلها رضاً.
 *
 * ثم **عدم تكرار السؤال**: إزعاج العميل بسؤالٍ مكرر أسوأ من فقد تقييم.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readRating,
  closedToday,
  markAsked,
  pendingFor,
  recordRating,
  summarize,
  thanksFor,
  listRatings,
} from '../src/satisfaction.ts';
import { freshDb, seedTenant } from './helpers.ts';
import { createRequest } from '../src/modules/requests.ts';
import { createComplaint } from '../src/modules/complaints.ts';
import { getOrCreateConversation, type Db } from '../src/db/index.ts';
import { SQL_NOW } from '../src/time.ts';

let db: Db;
let tenantId = 0;
let conversationId = 0;

beforeEach(() => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  conversationId = getOrCreateConversation(db, tenantId, '966551112233', 'خالد').id;
});

afterEach(() => {
  db.close();
});

function closedRequest(): string {
  const row = createRequest(db, {
    tenantId,
    conversationId,
    customerWa: '966551112233',
    kind: 'maintenance',
    priority: 'normal',
    summary: 'المضخة معطلة',
  });
  db.prepare(`UPDATE requests SET status = 'done', updated_at = ${SQL_NOW} WHERE id = ?`).run(row.id);
  return row.reference;
}

describe('قراءة التقدير من ردّ العميل', () => {
  it('الرقم وحده بالعربي وباللاتيني', () => {
    expect(readRating('٥')).toBe(5);
    expect(readRating('5')).toBe(5);
    expect(readRating(' 3 ')).toBe(3);
  });

  it('ومع كلمات قليلة', () => {
    expect(readRating('5 ممتاز')).toBe(5);
    expect(readRating('أعطيك ٤')).toBe(4);
  });

  it('وبالحروف', () => {
    expect(readRating('خمسة')).toBe(5);
    expect(readRating('ثلاثة')).toBe(3);
  });

  /** هذا هو الاختبار الذي يمنع ابتلاع شكوى حقيقية. */
  it('ولا يُقرأ رقمٌ داخل جملة طويلة', () => {
    expect(readRating('عندي ٥ سيارات معطلة في المحطة ومحتاج فني بأسرع وقت')).toBeNull();
  });

  it('ولا رقم خارج المدى ولا رقمان', () => {
    expect(readRating('7')).toBeNull();
    expect(readRating('0')).toBeNull();
    expect(readRating('4 أو 5')).toBeNull();
  });

  it('ولا نصّ بلا رقم', () => {
    expect(readRating('شكراً لكم')).toBeNull();
    expect(readRating('')).toBeNull();
  });
});

describe('من يُسأل', () => {
  it('ما أُغلق اليوم فقط', () => {
    const reference = closedRequest();

    // طلبٌ ما زال مفتوحاً لا يُسأل عنه.
    createRequest(db, {
      tenantId,
      conversationId,
      customerWa: '966551112233',
      kind: 'quote',
      priority: 'normal',
      summary: 'عرض سعر',
    });

    const closed = closedToday(db, tenantId);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.reference).toBe(reference);
  });

  it('والشكاوى المغلقة كذلك', () => {
    const row = createComplaint(db, {
      tenantId,
      conversationId,
      customerWa: '966551112233',
      summary: 'تأخير',
      category: 'delay',
      severity: 'medium',
    });
    db.prepare(`UPDATE complaints SET status = 'closed', updated_at = ${SQL_NOW} WHERE id = ?`).run(row.id);

    expect(closedToday(db, tenantId).some((c) => c.kind === 'complaint')).toBe(true);
  });

  /** السؤال يُسجَّل قبل الإرسال، فلا يُعاد في النبضة التالية. */
  it('ومن سُئل لا يُسأل ثانية', () => {
    closedRequest();
    const first = closedToday(db, tenantId);
    markAsked(db, tenantId, first[0]!);

    expect(closedToday(db, tenantId)).toHaveLength(0);
  });

  it('ونبضتان متسابقتان لا تُنتجان سؤالين', () => {
    closedRequest();
    const closed = closedToday(db, tenantId)[0]!;

    expect(markAsked(db, tenantId, closed)).toBeGreaterThan(0);
    expect(markAsked(db, tenantId, closed)).toBeNull();
  });

  it('ومنشأة لا ترى ما أُغلق في غيرها', () => {
    closedRequest();
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000003' }).id;
    expect(closedToday(db, other)).toHaveLength(0);
  });
});

describe('الردّ والتسجيل', () => {
  it('السؤال القائم يُوجد ثم يُستهلك', () => {
    closedRequest();
    markAsked(db, tenantId, closedToday(db, tenantId)[0]!);

    const pending = pendingFor(db, tenantId, conversationId);
    expect(pending).toBeDefined();

    recordRating(db, pending!.id, 5, '5 ممتاز');
    expect(pendingFor(db, tenantId, conversationId)).toBeUndefined();
  });

  /** سؤالٌ مضى عليه أكثر من مهلته لا يلتقط ردّاً جديداً. */
  it('والسؤال القديم لا يبقى منتظراً إلى الأبد', () => {
    closedRequest();
    markAsked(db, tenantId, closedToday(db, tenantId)[0]!);
    db.prepare(`UPDATE satisfaction SET asked_at = datetime(${SQL_NOW}, '-30 hours')`).run();

    expect(pendingFor(db, tenantId, conversationId)).toBeUndefined();
  });

  /** المستاء لا يُقال له «سعدنا بخدمتك». */
  it('وردّ الشكر يختلف بالتقدير', () => {
    expect(thanksFor(1)).toContain('صراحتك');
    expect(thanksFor(3)).toContain('نحسّنه');
    expect(thanksFor(5)).toContain('سعدنا');
  });
});

describe('القياس', () => {
  function rate(values: number[]): void {
    for (const [i, value] of values.entries()) {
      db.prepare(
        `INSERT INTO satisfaction (tenant_id, conversation_id, customer_wa, kind, reference, rating, rated_at)
         VALUES (?, ?, '966551112233', 'request', ?, ?, ${SQL_NOW})`,
      ).run(tenantId, conversationId, `R-${i}`, value);
    }
  }

  it('المتوسط والنسبة والتوزيع', () => {
    rate([5, 5, 4, 3, 1]);
    const summary = summarize(db, tenantId);

    expect(summary.answered).toBe(5);
    expect(summary.average).toBe(3.6);
    // الراضون ٤ و٥ = ثلاثة من خمسة.
    expect(summary.csat).toBe(60);
    expect(summary.distribution[5]).toBe(2);
  });

  /**
   * من سُئل ولم يُجب يُحسب في «سُئلوا» لا في المتوسط.
   *
   * متوسطُ ٤٫٨ من ثلاثة ردود لا يقول شيئاً عن مئة عميل صامت، وخلطهما
   * يجعل الرقم يبدو أفضل مما هو.
   */
  it('ومن لم يجب لا يرفع المتوسط ولا يخفضه', () => {
    rate([5, 5]);
    closedRequest();
    markAsked(db, tenantId, closedToday(db, tenantId)[0]!);

    const summary = summarize(db, tenantId);
    expect(summary.asked).toBe(3);
    expect(summary.answered).toBe(2);
    expect(summary.average).toBe(5);
  });

  it('وبلا ردود لا رقم مختلق', () => {
    const summary = summarize(db, tenantId);
    expect(summary.average).toBeNull();
    expect(summary.csat).toBeNull();
  });

  it('والسرد يعرض المنتظر والمُجاب', () => {
    rate([4]);
    closedRequest();
    markAsked(db, tenantId, closedToday(db, tenantId)[0]!);

    const rows = listRatings(db, tenantId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.rating === null)).toHaveLength(1);
  });
});
