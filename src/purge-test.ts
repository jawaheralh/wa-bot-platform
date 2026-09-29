/**
 * حذف بيانات التجربة.
 *
 * منصة تُعرض على عميل وفيها «سعد المطيري» و«شركة الرياض للنقل» تبدو
 * لعبة لا نظاماً. ومحادثات التجربة تُفسد أيضاً شاشة التدريب وإحصاءات
 * اللوحة، فتُقاس جودة البوت على أسئلة لم يسألها أحد.
 *
 * يعرض ما سيُحذف ولا يحذف — إلا بـ--apply:
 *
 *   node src/purge-test.ts                       عرض فقط
 *   node src/purge-test.ts --apply               تنفيذ
 *   node src/purge-test.ts --keep 966501052903   أرقام تُستثنى
 *
 * ما لا يُمَسّ أبداً: قاعدة المعرفة، والمنشآت، والمستخدمون، وسجل
 * التدقيق — الأخير لأنه سجل أمني، وحذفه من نظام يحذف أثره ليس سجلاً.
 */

import { openDb, type Db } from './db/index.ts';
import { loadConfig } from './config.ts';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** أرقام حقيقية تُستثنى دائماً ما لم يُطلب غير ذلك. */
const DEFAULT_KEEP: string[] = [];

interface Plan {
  keepNumbers: string[];
  conversations: { id: number; wa: string; name: string | null; msgs: number; tenant: string }[];
  counts: Record<string, number>;
  mediaPaths: string[];
}

export function buildPlan(db: Db, keepNumbers: string[]): Plan {
  const keep = new Set(keepNumbers);

  const all = db
    .prepare(
      `SELECT c.id, c.customer_wa AS wa, c.customer_name AS name, t.name AS tenant,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
         FROM conversations c JOIN tenants t ON t.id = c.tenant_id
        ORDER BY c.id`,
    )
    .all() as Plan['conversations'][number][];

  const doomed = all.filter((c) => !keep.has(c.wa));
  const ids = doomed.map((c) => c.id);
  const list = ids.length ? `(${ids.join(',')})` : '(NULL)';

  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  const mediaPaths = ids.length
    ? (db
        .prepare(`SELECT media_path FROM messages WHERE conversation_id IN ${list} AND media_path IS NOT NULL`)
        .all() as { media_path: string }[]).map((r) => r.media_path)
    : [];

  return {
    keepNumbers,
    conversations: doomed,
    counts: {
      محادثات: doomed.length,
      رسائل: one(`SELECT COUNT(*) n FROM messages WHERE conversation_id IN ${list}`),
      طلبات: one('SELECT COUNT(*) n FROM requests'),
      شكاوى: one('SELECT COUNT(*) n FROM complaints'),
      حجوزات: one('SELECT COUNT(*) n FROM bookings'),
      تحويلات: one(`SELECT COUNT(*) n FROM handoffs WHERE conversation_id IN ${list}`),
      تنبيهات: one(`SELECT COUNT(*) n FROM alerts WHERE conversation_id IN ${list}`),
      ثغرات_معرفة: one(`SELECT COUNT(*) n FROM knowledge_gaps WHERE conversation_id IN ${list}`),
      ملفات: mediaPaths.length,
    },
    mediaPaths,
  };
}

export function applyPlan(db: Db, plan: Plan, dbPath: string): void {
  const ids = plan.conversations.map((c) => c.id);
  const list = ids.length ? `(${ids.join(',')})` : '(NULL)';

  // معاملة واحدة: حذف نصفه أسوأ من عدم الحذف — يترك طلباً بلا محادثة.
  db.transaction(() => {
    db.exec(`DELETE FROM knowledge_gaps WHERE conversation_id IN ${list}`);
    db.exec(`DELETE FROM alerts WHERE conversation_id IN ${list}`);
    db.exec(`DELETE FROM handoffs WHERE conversation_id IN ${list}`);
    // الطلبات والشكاوى والحجوزات كلها تجريبية، فتُحذف كاملة لا المرتبط
    // منها بالمحادثات المحذوفة وحده.
    db.exec('DELETE FROM bookings');
    db.exec('DELETE FROM complaints');
    db.exec('DELETE FROM requests');
    db.exec(`DELETE FROM messages WHERE conversation_id IN ${list}`);
    db.exec(`DELETE FROM conversations WHERE id IN ${list}`);

    /**
     * العدّادات تعود للصفر.
     *
     * بدونها يبدأ أول طلب حقيقي بـTLB-2026-000006 فيسأل العميل عن
     * الخمسة قبله — وليس لها وجود.
     */
    db.exec("DELETE FROM counters WHERE scope LIKE 'complaint%' OR scope LIKE 'request%' OR scope LIKE 'booking%'");
  })();

  // الملفات بعد المعاملة: فشل حذف ملف لا يجوز أن يُسقط حذف البيانات.
  const mediaRoot = join(dirname(dbPath), 'media');
  for (const relative of plan.mediaPaths) {
    const full = join(mediaRoot, relative);
    if (full.startsWith(mediaRoot) && existsSync(full)) {
      try {
        rmSync(full);
      } catch {
        // ملف مفقود أو بلا صلاحية — البيانات حُذفت وهذا ما يهم
      }
    }
  }

  db.exec('VACUUM');
}

/* --- التشغيل من سطر الأوامر --- */

if (process.argv[1]?.endsWith('purge-test.ts')) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const keep = [...DEFAULT_KEEP];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--keep' && args[i + 1]) keep.push(args[i + 1]!);
  }

  const config = loadConfig();
  const db = openDb(config.dbPath);
  const plan = buildPlan(db, keep);

  console.log('\n═══ أرقام تبقى ═══');
  console.log(keep.length ? keep.map((k) => `  ✓ ${k}`).join('\n') : '  (لا شيء)');

  console.log('\n═══ محادثات ستُحذف ═══');
  for (const c of plan.conversations) {
    console.log(`  ✗ ${c.wa} · ${c.name ?? '—'} · ${c.msgs} رسالة · ${c.tenant}`);
  }

  console.log('\n═══ الإجمالي ═══');
  for (const [label, count] of Object.entries(plan.counts)) {
    console.log(`  ${label.replace(/_/g, ' ').padEnd(14)} ${count}`);
  }

  if (!apply) {
    console.log('\nعرض فقط. للتنفيذ أضيفي --apply\n');
  } else {
    applyPlan(db, plan, config.dbPath);
    console.log('\n✓ نُفّذ الحذف.\n');
  }
  db.close();
}
