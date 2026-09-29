/**
 * تدريب البوت من محادثات حقيقية.
 *
 * البوت لا يتعلّم من نفسه — يجيب من معرفة المنشأة حرفياً. فالتحسين الوحيد
 * الممكن هو توسيع تلك المعرفة، والمصدر الأدق لما ينقصها ليس التخمين بل
 * **ما عجز عنه فعلاً مع عملاء حقيقيين**.
 *
 * كل تحويل للموظف بسبب جهل يُسجَّل هنا كسؤال، ويُجمَّع المتشابه ليظهر
 * الأكثر تكراراً أولاً — فتبدأ المالكة بما يوفّر أكبر عدد من التحويلات.
 */

import { type Db } from './db/index.ts';
import { SQL_NOW } from './time.ts';

export interface Gap {
  id: number;
  tenant_id: number;
  conversation_id: number | null;
  question: string;
  reason: string;
  occurrences: number;
  status: 'open' | 'answered' | 'ignored';
  created_at: string;
  last_seen_at: string;
}

/**
 * يوحّد صيغة السؤال للتجميع.
 * «كم سعر البنزين؟» و«كم سعر البنزين» و«كم سعر البنزين!!» سؤال واحد،
 * وعدّها ثلاثة يُغرق القائمة ويُخفي الأهم.
 */
export function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')       // التشكيل
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')            // الترقيم
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** يسجّل سؤالاً عجز عنه البوت، أو يزيد عدّاد سؤال مسجَّل. */
export function recordGap(
  db: Db,
  input: { tenantId: number; conversationId: number | null; question: string; reason?: string },
): void {
  const question = input.question.trim();
  const key = normalize(question);
  // سؤال قصير جداً («نعم»، «طيب») ليس ثغرة معرفة.
  if (key.length < 8) return;

  db.prepare(
    `INSERT INTO knowledge_gaps (tenant_id, conversation_id, question, normalized, reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, normalized) DO UPDATE SET
       occurrences = occurrences + 1,
       last_seen_at = ${SQL_NOW},
       -- سؤال أُجيب عنه ثم تكرر يعود مفتوحاً: الجواب لم يُغنِ عنه
       status = CASE WHEN status = 'ignored' THEN 'ignored' ELSE 'open' END`,
  ).run(input.tenantId, input.conversationId, question, key, input.reason ?? '');
}

/** كلمات دالّة فقط: الأدوات والحروف لا تميّز سؤالاً عن آخر. */
const STOPWORDS = new Set([
  'هل', 'في', 'من', 'على', 'عن', 'الى', 'الي', 'او', 'و', 'ما', 'كم', 'وش', 'ايش',
  'هذا', 'هذه', 'ذلك', 'انا', 'انت', 'هو', 'هي', 'لو', 'اذا', 'عندكم', 'عندك',
  'فيه', 'بس', 'يا', 'ال', 'مع', 'كل', 'بعد', 'قبل', 'لكن', 'يعني',
]);

/**
 * يجرّد السوابق العربية الشائعة.
 * «بمدى» و«مدى» و«المحطة» و«محطة» كلمة واحدة في نظر السائل، وبقاؤها
 * مختلفة يجعل سؤالين متطابقين معنىً يبدوان غريبين أحدهما عن الآخر.
 */
function stem(word: string): string {
  let w = word;
  if (w.startsWith('ال') && w.length > 4) w = w.slice(2);
  else if (/^[بلفوك]/.test(w) && w.length > 3) w = w.slice(1);
  if (w.startsWith('ال') && w.length > 4) w = w.slice(2);
  return w;
}

function words(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(stem)
      .filter((w) => w.length > 2),
  );
}

/**
 * تشابه جاكار بين سؤالين.
 *
 * «تقبلون بطاقة مدى؟» و«هل تقبلون الدفع بمدى في المحطة؟» سؤال واحد في
 * نظر العميل، وعرضهما منفصلين يجعل المالكة تكتب الجواب مرتين. مقارنة
 * الكلمات الدالّة تكفي هنا: لا نحتاج فهماً دلالياً لسؤالين متقاربين نصياً.
 */
export function similarity(a: string, b: string): number {
  const first = words(a);
  const second = words(b);
  if (first.size === 0 || second.size === 0) return 0;

  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared / (first.size + second.size - shared);
}

/** أسئلة مفتوحة تشبه سؤالاً معيّناً بدرجة تكفي لجواب واحد. */
export function similarGaps(db: Db, tenantId: number, gap: Gap, threshold = 0.4): Gap[] {
  return listGaps(db, tenantId, 'open')
    .filter((g) => g.id !== gap.id)
    .filter((g) => similarity(g.question, gap.question) >= threshold);
}

export function listGaps(db: Db, tenantId: number, status: Gap['status'] | 'all' = 'open'): Gap[] {
  const where = status === 'all' ? '' : 'AND status = ?';
  const params = status === 'all' ? [tenantId] : [tenantId, status];
  return db
    .prepare(
      `SELECT * FROM knowledge_gaps WHERE tenant_id = ? ${where}
       ORDER BY occurrences DESC, last_seen_at DESC LIMIT 200`,
    )
    .all(...params) as Gap[];
}

export function setGapStatus(db: Db, tenantId: number, id: number, status: Gap['status']): void {
  const result = db
    .prepare('UPDATE knowledge_gaps SET status = ? WHERE id = ? AND tenant_id = ?')
    .run(status, id, tenantId);
  if (result.changes === 0) throw new Error('السؤال غير موجود.');
}

/** ملخص يظهر في نظرة عامة: كم سؤالاً ينتظر جواباً، وكم تحويلاً وفّره. */
export function gapSummary(db: Db, tenantId: number): { open: number; missedAnswers: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(occurrences), 0) AS total
       FROM knowledge_gaps WHERE tenant_id = ? AND status = 'open'`,
    )
    .get(tenantId) as { n: number; total: number };
  return { open: row.n, missedAnswers: row.total };
}
