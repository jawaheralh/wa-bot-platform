/**
 * البث المباشر للوحة.
 *
 * كانت الموظفة تحدّث الصفحة لترى رسالة وصلت — فتتأخر على العميل،
 * أو تفوتها رسالة لأنها لم تحدّث.
 *
 * والآلية: الخادم يراقب، لا المتصفح.
 *
 * كان الأسهل أن يسأل المتصفح كل ثانيتين «هل جدّ جديد؟»، لكن عشرة
 * موظفين = ثلاثون ألف طلب في الساعة على خادم بنواة واحدة. هنا مؤقّت
 * واحد لكل منشأة مهما بلغ عدد المتصلين، واستعلام واحد رخيص يقارن
 * بصمة الحالة — ومتى تغيّرت دُفعت للجميع.
 *
 * ولماذا بصمة من القاعدة لا حدث يُطلقه الكود عند كل كتابة؟ لأن الحدث
 * يُنسى: مسار جديد يكتب رسالة ولا يُطلق حدثاً فلا تظهر عند أحد، ولا
 * يُكتشف ذلك إلا من شكوى موظفة. البصمة لا تُنسى — أي كتابة تغيّرها.
 */

import type { Db } from './db/index.ts';

/** يُرسل للمتصل عبر SSE. */
export interface LiveEvent {
  signature: string;
  at: string;
}

type Listener = (event: LiveEvent) => void;

interface Watch {
  listeners: Set<Listener>;
  timer: NodeJS.Timeout;
  last: string;
}

const watches = new Map<number, Watch>();

/** كل ثانيتين: محسوس للموظفة، وزهيد على الخادم. */
const INTERVAL_MS = 2000;

/**
 * وزن الحالة مضروباً في المعرّف.
 *
 * MAX(updated_at) وحده لا يكفي: دقّته ثانية، فتغييران في الثانية
 * نفسها يُنتجان البصمة ذاتها — فيبقى الموظف يرى الحالة القديمة ولا
 * شيء يشير إلى عطل.
 *
 * والضرب في المعرّف يمنع التعادل: لو تغيّرت شكوى من «جديدة» إلى
 * «مغلقة» وأخرى بالعكس في الدورة نفسها، لألغى مجموعٌ بسيط أحدهما
 * الآخر وبدت الحالة ساكنة.
 */
const STATUS_WEIGHT = `(CASE status
    WHEN 'new' THEN 1
    WHEN 'in_progress' THEN 3
    WHEN 'closed' THEN 7
    WHEN 'done' THEN 13
    WHEN 'cancelled' THEN 17
    ELSE 23 END)`;

/**
 * بصمة حالة المنشأة.
 *
 * تشمل ما تعرضه اللوحة فعلاً: الرسائل، والمحادثات، والشكاوى،
 * والطلبات، والتنبيهات. أي إضافة أو تعديل تغيّرها.
 */
export function signatureOf(db: Db, tenantId: number): string {
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(m.id), 0) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
           WHERE c.tenant_id = @t)                                   AS msg,
         (SELECT COALESCE(MAX(last_message_at), '') FROM conversations WHERE tenant_id = @t) AS conv,
         (SELECT COUNT(*) FROM conversations WHERE tenant_id = @t)    AS convN,
         (SELECT COALESCE(SUM(id * ${STATUS_WEIGHT}), 0) FROM complaints WHERE tenant_id = @t) AS cmp,
         (SELECT COUNT(*) FROM complaints WHERE tenant_id = @t)       AS cmpN,
         (SELECT COALESCE(SUM(id * ${STATUS_WEIGHT}), 0) FROM requests WHERE tenant_id = @t)   AS req,
         (SELECT COUNT(*) FROM requests WHERE tenant_id = @t)         AS reqN,
         (SELECT COALESCE(MAX(id), 0) FROM alerts WHERE tenant_id = @t) AS alr`,
    )
    .get({ t: tenantId }) as Record<string, string | number>;

  return Object.values(row).join('|');
}

/**
 * يشترك في تغيّرات منشأة. يُعيد دالة إلغاء الاشتراك.
 *
 * آخر مشترك يُغلق المؤقّت: مؤقّت يعمل لمنشأة لا أحد يشاهدها استعلام
 * كل ثانيتين إلى الأبد.
 */
export function subscribe(db: Db, tenantId: number, listener: Listener): () => void {
  let watch = watches.get(tenantId);

  if (!watch) {
    const created: Watch = {
      listeners: new Set(),
      last: signatureOf(db, tenantId),
      timer: setInterval(() => {
        const current = watches.get(tenantId);
        if (!current) return;
        let signature: string;
        try {
          signature = signatureOf(db, tenantId);
        } catch {
          // قاعدة مقفلة لحظة الكتابة — نحاول في الدورة التالية
          return;
        }
        if (signature === current.last) return;
        current.last = signature;
        const event: LiveEvent = { signature, at: new Date().toISOString() };
        for (const fn of current.listeners) fn(event);
      }, INTERVAL_MS),
    };
    // لا يمنع إغلاق العملية عند التوقّف.
    created.timer.unref?.();
    watches.set(tenantId, created);
    watch = created;
  }

  watch.listeners.add(listener);

  return () => {
    const current = watches.get(tenantId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      watches.delete(tenantId);
    }
  };
}

/** للاختبارات: يوقف كل المراقبات. */
export function stopAll(): void {
  for (const watch of watches.values()) clearInterval(watch.timer);
  watches.clear();
}

/** عدد المنشآت المُراقَبة الآن — للتشخيص والاختبار. */
export function watchCount(): number {
  return watches.size;
}
