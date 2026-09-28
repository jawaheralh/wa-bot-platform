/**
 * النسخ الاحتياطي.
 * المحك: النسخة متّسقة وقابلة للفتح فعلاً، لا ملف يبدو سليماً حتى تحتاجيه.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { silentLogger, seedTenant } from './helpers.ts';
import { takeBackup, listBackups, backupIfDue } from '../src/backup.ts';
import { openDb, getOrCreateConversation, saveMessage } from '../src/db/index.ts';
import { migrateAll } from '../src/modules/registry.ts';

let dir: string;
let app: App;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wabot-backup-'));
  const dbPath = join(dir, 'data', 'app.db');
  const db = openDb(dbPath);
  migrateAll(db);
  seedTenant(db, { name: 'وقودي' });

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', dbPath },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
});

afterEach(() => {
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('النسخة', () => {
  it('تُنشأ وتُفتح فعلاً وتحمل نفس الرسائل', () => {
    const conv = getOrCreateConversation(app.db, 1, '966555123456', 'خالد');
    saveMessage(app.db, conv.id, 'customer', 'رسالة مهمة');
    saveMessage(app.db, conv.id, 'bot', 'رد');

    const { path, bytes } = takeBackup(app);
    expect(existsSync(path)).toBe(true);
    expect(bytes).toBeGreaterThan(0);

    // المحك الحقيقي: نفتح النسخة ونقرأ منها
    const copy = new Database(path, { readonly: true });
    const rows = copy.prepare('SELECT body FROM messages ORDER BY id').all() as { body: string }[];
    expect(rows.map((r) => r.body)).toEqual(['رسالة مهمة', 'رد']);
    copy.close();
  });

  it('تبقى متّسقة رغم الكتابة المستمرة أثناءها', () => {
    const conv = getOrCreateConversation(app.db, 1, '966555123456');
    for (let i = 0; i < 200; i++) saveMessage(app.db, conv.id, 'customer', `رسالة ${i}`);

    const { path } = takeBackup(app);
    saveMessage(app.db, conv.id, 'customer', 'بعد النسخة');

    const copy = new Database(path, { readonly: true });
    const count = (copy.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(count).toBe(200);
    expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    copy.close();
  });

  it('تُدرَج في القائمة', () => {
    takeBackup(app);
    const list = listBackups(app);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toMatch(/^app-\d{4}-\d{2}-\d{2}/);
  });

  it('واحدة يومياً لا أكثر', () => {
    expect(backupIfDue(app)).toBe(true);
    expect(backupIfDue(app)).toBe(false);
    expect(listBackups(app)).toHaveLength(1);
  });

  it('تُبقي ٣٠ نسخة وتحذف الأقدم لا الأحدث', () => {
    const paths: string[] = [];
    for (let i = 0; i < 34; i++) paths.push(takeBackup(app).path);

    const list = listBackups(app);
    expect(list.length).toBeLessThanOrEqual(30);

    // المحك: آخر نسخة أُخذت يجب أن تبقى موجودة
    expect(existsSync(paths.at(-1)!)).toBe(true);
    // وأقدمها يجب أن تكون حُذفت
    expect(existsSync(paths[0]!)).toBe(false);
  });

  it('نسختان في نفس الثانية لا تتصادمان', () => {
    const a = takeBackup(app);
    const b = takeBackup(app);
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });
});
