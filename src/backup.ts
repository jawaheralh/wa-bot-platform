/**
 * النسخ الاحتياطي التلقائي.
 *
 * منع الحذف لا يكفي: ملف SQLite قد يتلف، والجهاز قد يُفقد، والحذف الخاطئ
 * وارد. النسخة هي ما يُعيد الرسائل فعلاً.
 *
 * يُستعمل أمر SQLite الخاص `VACUUM INTO` لا نسخ الملف: النسخ المباشر أثناء
 * الكتابة في وضع WAL يُنتج ملفاً ناقصاً يبدو سليماً حتى تحتاجيه.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { App } from './app.ts';
import { now, today } from './time.ts';

/** كم نسخة يومية نُبقي. الملف بالكيلوبايتات، فالعدد سخي بلا تكلفة. */
const KEEP = 30;

/**
 * الاسم: app-2026-09-28-23-32-14-071.db — بدقة المللي ثانية.
 *
 * دقة الثانية وحدها تُحدث تصادماً يُعالَج بلاحقة «‎-2‎»، لكن اللاحقة تُعاد
 * استعمالها بعد حذف نسخة فتفقد ترتيبها الزمني، فيُحذف الأحدث ويبقى
 * الأقدم — ضياع بيانات لا يُرى حتى تُحتاج النسخة. المللي ثانية تجعل
 * الاسم فريداً ومرتَّباً معجمياً بنفس ترتيبه الزمني، بلا أي لاحقة.
 */
const NAME = /^app-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3})\.db$/;

function sortKey(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null;
}

function stampNow(date = new Date()): string {
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${now(date).replace(/[: ]/g, '-')}-${ms}`;
}

export function backupDir(app: App): string {
  return join(dirname(app.config.dbPath), '..', 'backups');
}

export function takeBackup(app: App): { path: string; bytes: number } {
  if (app.config.dbPath === ':memory:') throw new Error('لا نسخة لقاعدة في الذاكرة.');

  const dir = backupDir(app);
  mkdirSync(dir, { recursive: true });

  // VACUUM INTO يرفض الكتابة فوق ملف موجود. المللي ثانية تكفي للتفرّد،
  // وننتظر مللي ثانية في التصادم النادر بدل لاحقة تُفسد الترتيب.
  let path = join(dir, `app-${stampNow()}.db`);
  while (existsSync(path)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    path = join(dir, `app-${stampNow()}.db`);
  }

  // VACUUM INTO يأخذ لقطة متّسقة بلا إيقاف الكتابة، ويضغط الملف كذلك.
  app.db.prepare(`VACUUM INTO ?`).run(path);

  prune(dir, path);
  return { path, bytes: statSync(path).size };
}

/**
 * يحذف الأقدم ويُبقي KEEP نسخة.
 *
 * الترتيب بوقت التعديل لا بالاسم: الترتيب النصي يضع `…-10.db` قبل
 * `…-2.db`، فيُحذف الأحدث ويبقى الأقدم — وهو ضياع بيانات لا تراه حتى
 * تحتاج النسخة. ويُستثنى الملف المُنشأ للتو صراحةً.
 */
function prune(dir: string, keepPath: string): void {
  const files = readdirSync(dir)
    .map((name) => ({ name, key: sortKey(name) }))
    .filter((f): f is { name: string; key: string } => f.key !== null)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // الأحدث أولاً

  for (const file of files.slice(KEEP)) {
    const path = join(dir, file.name);
    if (path === keepPath) continue;
    try {
      unlinkSync(path);
    } catch {
      // نسخة تعذّر حذفها لا تستحق إسقاط المهمة.
    }
  }
}

export function listBackups(app: App): { name: string; bytes: number; at: string }[] {
  try {
    const dir = backupDir(app);
    return readdirSync(dir)
      .map((name) => ({ name, key: sortKey(name) }))
      .filter((f): f is { name: string; key: string } => f.key !== null)
      .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
      .map(({ name }) => {
        const stat = statSync(join(dir, name));
        return { name, bytes: stat.size, at: now(stat.mtime) };
      });
  } catch {
    return [];
  }
}

/** نسخة يومية واحدة تكفي؛ الرسائل محفوظة لحظياً في القاعدة على أي حال. */
export function backupIfDue(app: App): boolean {
  const last = app.db
    .prepare(`SELECT created_at FROM health_log WHERE summary = 'backup' ORDER BY id DESC LIMIT 1`)
    .get() as { created_at: string } | undefined;

  if (last && last.created_at.slice(0, 10) === today()) return false;

  try {
    const { path, bytes } = takeBackup(app);
    app.db
      .prepare(`INSERT INTO health_log (severity, summary, detail) VALUES ('ok', 'backup', ?)`)
      .run(`${path} · ${Math.round(bytes / 1024)} ك.ب`);
    app.logger.info('أُخذت نسخة احتياطية', { حجم: `${Math.round(bytes / 1024)} ك.ب` });
    return true;
  } catch (error) {
    app.logger.error('فشلت النسخة الاحتياطية', error);
    return false;
  }
}
