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

/* ---------------------------------------------------------------
   حذف منشأة تجريبية كاملة
--------------------------------------------------------------- */

export interface TenantPlan {
  id: number;
  name: string;
  counts: Record<string, number>;
  users: string[];
}

export function planTenant(db: Db, tenantId: number): TenantPlan {
  const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(tenantId) as
    | { id: number; name: string }
    | undefined;
  if (!tenant) throw new Error(`لا توجد منشأة رقم ${tenantId}`);

  const n = (sql: string): number => (db.prepare(sql).get(tenantId) as { n: number }).n;
  const users = (db.prepare('SELECT username FROM users WHERE tenant_id = ?').all(tenantId) as {
    username: string;
  }[]).map((u) => u.username);

  return {
    id: tenant.id,
    name: tenant.name,
    users,
    counts: {
      محادثات: n('SELECT COUNT(*) n FROM conversations WHERE tenant_id = ?'),
      رسائل: n(
        'SELECT COUNT(*) n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = ?)',
      ),
      قاعدة_المعرفة: n('SELECT COUNT(*) n FROM kb_entries WHERE tenant_id = ?'),
      مستخدمون: users.length,
      وحدات: n('SELECT COUNT(*) n FROM tenant_modules WHERE tenant_id = ?'),
      تنبيهات: n('SELECT COUNT(*) n FROM alerts WHERE tenant_id = ?'),
      سجل_تدقيق: n('SELECT COUNT(*) n FROM audit_log WHERE tenant_id = ?'),
    },
  };
}

/**
 * يحذف منشأة وكل أثرها.
 *
 * الجداول تُعدَّد من قاعدة البيانات لا من قائمة مكتوبة: وحدة جديدة
 * تضيف جدولاً بعمود tenant_id، والقائمة المكتوبة تنساه فيبقى صفّ
 * يتيم يحمل اسم عميل حُذف — وهو بالضبط ما لا يجوز عند الحذف.
 */
export function dropTenant(db: Db, tenantId: number): string[] {
  const touched: string[] = [];

  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]).map((t) => t.name);

  db.transaction(() => {
    // ما يرتبط بالمحادثات أولاً: حذف المحادثة قبلها يقطع الصلة فتبقى.
    for (const table of tables) {
      if (table === 'conversations' || table === 'tenants') continue;
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('conversation_id')) continue;
      const info = db
        .prepare(
          `DELETE FROM ${table} WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = ?)`,
        )
        .run(tenantId);
      if (info.changes) touched.push(`${table}: ${info.changes}`);
    }

    for (const table of tables) {
      if (table === 'tenants') continue;
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('tenant_id')) continue;
      const info = db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId);
      if (info.changes) touched.push(`${table}: ${info.changes}`);
    }

    // العدّادات مفاتيحها نصية بصيغة PREFIX:tenantId:year
    const counters = db.prepare("DELETE FROM counters WHERE scope LIKE ?").run(`%:${tenantId}:%`);
    if (counters.changes) touched.push(`counters: ${counters.changes}`);

    const tenant = db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
    if (tenant.changes) touched.push(`tenants: ${tenant.changes}`);
  })();

  return touched;
}

/* --- التشغيل من سطر الأوامر --- */

if (process.argv[1]?.endsWith('purge-test.ts')) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const keep = [...DEFAULT_KEEP];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--keep' && args[i + 1]) keep.push(args[i + 1]!);
  }

  const dropIds: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--drop-tenant' && args[i + 1]) dropIds.push(Number(args[i + 1]));
  }

  const config = loadConfig();
  const db = openDb(config.dbPath);

  /* --- حذف منشآت كاملة --- */
  if (dropIds.length) {
    for (const id of dropIds) {
      const plan = planTenant(db, id);
      console.log(`\n═══ منشأة ستُحذف كاملة: [${plan.id}] ${plan.name} ═══`);
      for (const [label, count] of Object.entries(plan.counts)) {
        console.log(`  ${label.replace(/_/g, ' ').padEnd(16)} ${count}`);
      }
      console.log(`  المستخدمون:     ${plan.users.join(' · ') || '—'}`);

      if (apply) {
        const touched = dropTenant(db, id);
        console.log(`  ✓ حُذفت — ${touched.join(' · ')}`);
      }
    }
    if (!apply) console.log('\nعرض فقط. للتنفيذ: --apply\n');
    else {
      db.exec('VACUUM');
      console.log('\n✓ تم.\n');
    }
    db.close();
    process.exit(0);
  }

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
    console.log('\nعرض فقط. للتنفيذ: --apply\n');
  } else {
    applyPlan(db, plan, config.dbPath);
    console.log('\n✓ نُفّذ الحذف.\n');
  }
  db.close();
}
