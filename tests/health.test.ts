/**
 * فحص الصحة.
 *
 * المحك: العطل الصامت يُكتشف ويُنبَّه عنه مرة واحدة لا كل نبضة، والتعافي
 * يُبلَّغ به أيضاً.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { runHealthCheck, alertIfChanged, worstOf } from '../src/health.ts';
import { setConfig } from '../src/modules/registry.ts';
import { addKbEntry } from '../src/modules/inquiries.ts';
import type { Db } from '../src/db/index.ts';

let db: Db;
let provider: SimulatorProvider;

async function makeApp(overrides: Record<string, unknown> = {}): Promise<App> {
  return buildApp({
    config: { ...loadConfig(), provider: 'simulator', anthropicApiKey: 'sk-ant-test', ...overrides },
    db,
    provider,
    logger: silentLogger(),
  });
}

function mockAnthropic(status: number, body: object = {}): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  db = freshDb();
  seedTenant(db, { name: 'وقودي', staffWaNumber: '966500000099' });
  provider = new SimulatorProvider();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('كشف الأعطال', () => {
  it('مفتاح مرفوض يُكتشف مع حلّه', async () => {
    mockAnthropic(401, { error: { message: 'invalid x-api-key' } });
    const checks = await runHealthCheck(await makeApp());

    const claude = checks.find((c) => c.key === 'claude')!;
    expect(claude.severity).toBe('down');
    expect(claude.message).toContain('invalid x-api-key');
    expect(claude.fix).toContain('Organization');
  });

  it('نفاد الرصيد يُميَّز عن المفتاح الخاطئ', async () => {
    mockAnthropic(429, { error: { message: 'credit balance is too low' } });
    const claude = (await runHealthCheck(await makeApp())).find((c) => c.key === 'claude')!;
    expect(claude.severity).toBe('down');
    expect(claude.fix).toContain('الرصيد');
  });

  it('مفتاح غائب يُكتشف بلا نداء شبكة', async () => {
    const claude = (await runHealthCheck(await makeApp({ anthropicApiKey: '' }))).find((c) => c.key === 'claude')!;
    expect(claude.severity).toBe('down');
    expect(claude.message).toContain('غير مضبوط');
  });

  it('مفتاح سليم يُعطي ok', async () => {
    mockAnthropic(200, { content: [{ type: 'text', text: 'ok' }] });
    expect((await runHealthCheck(await makeApp())).find((c) => c.key === 'claude')!.severity).toBe('ok');
  });

  it('معرفة فارغة تحذير لا عطل — البوت يعمل لكنه يحوّل كل شيء', async () => {
    mockAnthropic(200, { content: [] });
    const kb = (await runHealthCheck(await makeApp())).find((c) => c.key.startsWith('kb_'))!;
    expect(kb.severity).toBe('warn');
    expect(kb.message).toContain('فارغة');
  });

  it('معرفة معبّأة تُعطي ok', async () => {
    mockAnthropic(200, { content: [] });
    setConfig(db, 1, 'inquiries', { freeText: 'ش'.repeat(80), unknownPolicy: 'x' });
    addKbEntry(db, 1, 'سؤال', 'جواب');
    const kb = (await runHealthCheck(await makeApp())).find((c) => c.key.startsWith('kb_'))!;
    expect(kb.severity).toBe('ok');
  });

  it('الحالة العامة أسوأ الفحوص', () => {
    expect(worstOf([{ severity: 'ok' }, { severity: 'warn' }] as never)).toBe('warn');
    expect(worstOf([{ severity: 'warn' }, { severity: 'down' }] as never)).toBe('down');
    expect(worstOf([{ severity: 'ok' }] as never)).toBe('ok');
  });
});

describe('التنبيه عند التغيّر فقط', () => {
  it('ينبّه مرة عند السقوط ولا يكرر', async () => {
    mockAnthropic(401, { error: { message: 'invalid x-api-key' } });
    const app = await makeApp();

    expect(await alertIfChanged(app, await runHealthCheck(app))).toBe(true);
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]?.text).toContain('متعطّل');
    expect(provider.outbox[0]?.text).toContain('مفتاح Claude');
    expect(provider.outbox[0]?.to).toBe('966500000099');

    // نبضة ثانية بنفس العطل: لا تنبيه — التكرار يُدرّب الموظف على التجاهل
    expect(await alertIfChanged(app, await runHealthCheck(app))).toBe(false);
    expect(provider.outbox).toHaveLength(1);
  });

  it('يبلّغ بالتعافي', async () => {
    mockAnthropic(401, { error: { message: 'bad' } });
    const app = await makeApp();
    await alertIfChanged(app, await runHealthCheck(app));

    mockAnthropic(200, { content: [] });
    expect(await alertIfChanged(app, await runHealthCheck(app))).toBe(true);
    expect(provider.outbox.at(-1)?.text).toContain('عاد النظام');
  });

  it('عطل جديد يُنبَّه به ولو كان هناك عطل قائم', async () => {
    const app = await makeApp({ provider: 'simulator' });
    await alertIfChanged(app, [
      { key: 'claude', label: 'مفتاح Claude', severity: 'down', message: 'x' },
    ] as never);
    const first = provider.outbox.length;

    await alertIfChanged(app, [
      { key: 'claude', label: 'مفتاح Claude', severity: 'down', message: 'x' },
      { key: 'webhook', label: 'الـwebhook', severity: 'down', message: 'y' },
    ] as never);
    expect(provider.outbox.length).toBe(first + 1);
  });

  it('التنبيه يحمل الحل لا العطل فقط', async () => {
    const app = await makeApp();
    await alertIfChanged(app, [
      { key: 'claude', label: 'مفتاح Claude', severity: 'down', message: 'مرفوض', fix: 'الصقي مفتاحاً جديداً' },
    ] as never);
    expect(provider.outbox[0]?.text).toContain('الحل: الصقي مفتاحاً جديداً');
  });

  it('كل فحص يُسجَّل في health_log', async () => {
    mockAnthropic(401, { error: { message: 'bad' } });
    const app = await makeApp();
    await alertIfChanged(app, await runHealthCheck(app));
    await alertIfChanged(app, await runHealthCheck(app));

    const rows = db.prepare('SELECT severity, summary FROM health_log ORDER BY id').all() as {
      severity: string;
      summary: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.severity).toBe('down');
    expect(rows[0]?.summary).toContain('مفتاح Claude');
  });

  it('فشل إرسال التنبيه لا يُسقط الفحص', async () => {
    provider.sendText = async () => {
      throw new Error('انقطاع');
    };
    const app = await makeApp();
    await expect(
      alertIfChanged(app, [{ key: 'claude', label: 'م', severity: 'down', message: 'x' }] as never),
    ).resolves.toBe(true);
  });
});
