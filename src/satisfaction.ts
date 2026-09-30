/**
 * قياس رضا العملاء بعد إغلاق الطلب أو الشكوى.
 *
 * ## لماذا آخر اليوم لا فور الإغلاق
 *
 * الإغلاق في النظام قد يسبق الإغلاق في الواقع: الموظف يُغلق الطلب وهو
 * في الطريق للعميل. وسؤال التقييم في تلك اللحظة يُقاس على خدمةٍ لم
 * تكتمل بعد.
 *
 * وتأجيله ليوم تالٍ يفقده سياقه: من يُسأل غداً عن خدمة أمس يتذكّر
 * انطباعاً لا تجربة. فالسؤال قبيل انتهاء اليوم — بعد أن تكتمل الخدمة
 * وقبل أن تبرد.
 *
 * ## الردّ بالرقم لا بالنموذج
 *
 * رابطُ استبيانٍ يضيع منه نصف من يفتحه. والعميل في واتساب أصلاً، فرقمٌ
 * واحد يكتبه أسهل شيء يُطلب منه — ولهذا يُقبل «٥» و«5» و«خمسة».
 */

import { SQL_NOW, now, today } from './time.ts';
import type { Db } from './db/index.ts';

export const TABLE = `CREATE TABLE IF NOT EXISTS satisfaction (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  customer_wa     TEXT    NOT NULL,
  -- نوع ما أُغلق ورقمه المرجعي، ليُعرف على أيّ خدمة كان التقييم.
  kind            TEXT    NOT NULL,              -- request | complaint
  reference       TEXT    NOT NULL,
  asked_at        TEXT    NOT NULL DEFAULT (${SQL_NOW}),
  rated_at        TEXT,
  rating          INTEGER,                        -- ١ إلى ٥
  comment         TEXT,
  UNIQUE (tenant_id, kind, reference)
)`;

export const INDEX = `CREATE INDEX IF NOT EXISTS idx_satisfaction_tenant
  ON satisfaction(tenant_id, rated_at, id DESC)`;

/** كم ساعة يبقى السؤال قائماً ينتظر رداً. */
export const PENDING_HOURS = 20;

export interface PendingSurvey {
  id: number;
  reference: string;
  kind: string;
}

/* ---------------------------------------------------------------
   قراءة الرقم من ردّ العميل
--------------------------------------------------------------- */

const WORDS: Record<string, number> = {
  واحد: 1,
  اثنين: 2,
  اثنان: 2,
  ثنين: 2,
  ثلاثة: 3,
  ثلاث: 3,
  أربعة: 4,
  اربعة: 4,
  أربع: 4,
  خمسة: 5,
  خمس: 5,
};

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * يقرأ تقديراً من ١ إلى ٥ في نصّ العميل.
 *
 * ويُشترط أن يكون الردّ قصيراً: «٥» تقدير، أما «عندي ٥ سيارات معطلة»
 * فشكوى جديدة. وبلا هذا الشرط يُبتلع سؤالٌ حقيقي ويُسجَّل تقييماً.
 */
export function readRating(text: string): number | null {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 40) return null;

  const latin = raw.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

  // رقم وحده أو مع كلمات قليلة: «٥»، «5 ممتاز»، «اعطيك 4».
  const digits = latin.match(/\d+/g) ?? [];
  if (digits.length === 1) {
    const value = Number(digits[0]);
    if (value >= 1 && value <= 5) return value;
    return null;
  }

  if (digits.length === 0) {
    for (const [word, value] of Object.entries(WORDS)) {
      if (raw.includes(word)) return value;
    }
  }

  return null;
}

/* ---------------------------------------------------------------
   السؤال
--------------------------------------------------------------- */

export interface Closed {
  kind: 'request' | 'complaint';
  reference: string;
  customer_wa: string;
  conversation_id: number | null;
}

/**
 * ما أُغلق اليوم ولم يُسأل عنه بعد.
 *
 * الشرط على `updated_at` لا على وقت الإنشاء: الطلب قد يُفتح الأسبوع
 * الماضي ويُغلق اليوم، وهو ما يُقاس.
 */
export function closedToday(db: Db, tenantId: number): Closed[] {
  const day = today();

  const requests = db
    .prepare(
      `SELECT 'request' AS kind, r.reference, r.customer_wa, r.conversation_id
         FROM requests r
        WHERE r.tenant_id = ? AND r.status = 'done' AND date(r.updated_at) = ?
          AND NOT EXISTS (
            SELECT 1 FROM satisfaction s
             WHERE s.tenant_id = r.tenant_id AND s.kind = 'request' AND s.reference = r.reference
          )`,
    )
    .all(tenantId, day) as Closed[];

  const complaints = db
    .prepare(
      `SELECT 'complaint' AS kind, c.reference, c.customer_wa, c.conversation_id
         FROM complaints c
        WHERE c.tenant_id = ? AND c.status = 'closed' AND date(c.updated_at) = ?
          AND NOT EXISTS (
            SELECT 1 FROM satisfaction s
             WHERE s.tenant_id = c.tenant_id AND s.kind = 'complaint' AND s.reference = c.reference
          )`,
    )
    .all(tenantId, day) as Closed[];

  return [...requests, ...complaints];
}

/**
 * يسجّل أن السؤال أُرسل.
 *
 * يُكتب **قبل** الإرسال لا بعده: لو كُتب بعده وفشلت الكتابة لأُعيد
 * السؤال في النبضة التالية — وإزعاج العميل بسؤالٍ مكرر أسوأ من فقد
 * تقييم واحد.
 */
export function markAsked(db: Db, tenantId: number, closed: Closed): number | null {
  try {
    const info = db
      .prepare(
        `INSERT INTO satisfaction (tenant_id, conversation_id, customer_wa, kind, reference)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenantId, closed.conversation_id, closed.customer_wa, closed.kind, closed.reference);
    return Number(info.lastInsertRowid);
  } catch {
    // UNIQUE يمنع التكرار حين تتسابق نبضتان — وهذا هو المقصود.
    return null;
  }
}

/* ---------------------------------------------------------------
   الردّ
--------------------------------------------------------------- */

/** سؤالٌ قائم لهذه المحادثة ينتظر رداً. */
export function pendingFor(db: Db, tenantId: number, conversationId: number): PendingSurvey | undefined {
  return db
    .prepare(
      `SELECT id, reference, kind FROM satisfaction
        WHERE tenant_id = ? AND conversation_id = ? AND rated_at IS NULL
          AND asked_at > datetime(${SQL_NOW}, '-${PENDING_HOURS} hours')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(tenantId, conversationId) as PendingSurvey | undefined;
}

export function recordRating(db: Db, id: number, rating: number, comment?: string): void {
  db.prepare('UPDATE satisfaction SET rating = ?, comment = ?, rated_at = ? WHERE id = ?').run(
    rating,
    comment?.trim() || null,
    now(),
    id,
  );
}

/** ردّ الشكر — يختلف بالتقدير، فالمستاء لا يُقال له «سعدنا». */
export function thanksFor(rating: number): string {
  if (rating <= 2) {
    return 'شكراً لصراحتك. وصل تقييمك للمسؤول وبيتواصل معك لمعرفة ما الذي قصّرنا فيه.';
  }
  if (rating === 3) return 'شكراً لك. رأيك يهمنا، وإن كان فيه شيء نحسّنه اكتبه لنا.';
  return 'شكراً لك، سعدنا بخدمتك 🌟';
}

/* ---------------------------------------------------------------
   القياس
--------------------------------------------------------------- */

export interface Summary {
  asked: number;
  answered: number;
  average: number | null;
  /** نسبة الراضين (٤ و٥) من المجيبين — وهو ما يُسمّى CSAT. */
  csat: number | null;
  distribution: Record<number, number>;
}

export function summarize(db: Db, tenantId: number, days = 30): Summary {
  const rows = db
    .prepare(
      `SELECT rating FROM satisfaction
        WHERE tenant_id = ? AND asked_at > datetime(${SQL_NOW}, '-${days} days')`,
    )
    .all(tenantId) as { rating: number | null }[];

  const answered = rows.filter((r) => r.rating !== null).map((r) => r.rating!);
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const value of answered) distribution[value] = (distribution[value] ?? 0) + 1;

  const happy = answered.filter((v) => v >= 4).length;

  return {
    asked: rows.length,
    answered: answered.length,
    average: answered.length ? Number((answered.reduce((a, b) => a + b, 0) / answered.length).toFixed(2)) : null,
    csat: answered.length ? Math.round((happy / answered.length) * 100) : null,
    distribution,
  };
}

export interface RatingRow {
  id: number;
  customer_wa: string;
  kind: string;
  reference: string;
  rating: number | null;
  comment: string | null;
  asked_at: string;
  rated_at: string | null;
}

export function listRatings(db: Db, tenantId: number, limit = 100): RatingRow[] {
  return db
    .prepare(`SELECT * FROM satisfaction WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`)
    .all(tenantId, limit) as RatingRow[];
}
