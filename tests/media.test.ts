/**
 * استقبال الملفات.
 * المحك: لا شيء يُسقَط بصمت — كل ما يرسله العميل يُحفظ ويُعرض ويُقَرّ به.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, seedTenant, silentLogger, mockClaude } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { storeMedia, isVisionImage, extensionFor, readStored, MAX_BYTES } from '../src/media.ts';
import { getOrCreateConversation, recentMessages, openDb, type Db, type TenantRow } from '../src/db/index.ts';
import { migrateAll } from '../src/modules/registry.ts';

let dir: string;
let dbPath: string;
let db: Db;
let tenant: TenantRow;
let provider: SimulatorProvider;

/** PNG صالح ١×١ — نختبر مساراً حقيقياً لا بايتات عشوائية. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wabot-media-'));
  dbPath = join(dir, 'data', 'app.db');
  db = openDb(dbPath);
  migrateAll(db);
  tenant = seedTenant(db, { name: 'وقودي' });
  provider = new SimulatorProvider();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function engineWith(claude: ReturnType<typeof mockClaude>, transcriber?: { transcribe(): Promise<string> }) {
  const app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', dbPath, anthropicApiKey: 'x', readOnly: false },
    db,
    provider,
    logger: silentLogger(),
  });
  provider.onMessage(createEngine({ app, claude, transcriber: transcriber as never }));
}

describe('الحفظ على القرص', () => {
  it('الصورة تُحفظ ويُسجَّل مسارها', async () => {
    const stored = await storeMedia(dbPath, tenant.id, {
      kind: 'image',
      mimeType: 'image/png',
      download: async () => PNG,
    }, silentLogger());

    expect(stored).toBeDefined();
    expect(existsSync(stored!.path)).toBe(true);
    expect(readFileSync(stored!.path)).toEqual(PNG);
    expect(stored!.relativePath.startsWith(`${tenant.id}/`)).toBe(true);
  });

  it('الملف الضخم لا يُحفظ ولا يُسقط الرسالة', async () => {
    const stored = await storeMedia(dbPath, tenant.id, {
      kind: 'video',
      mimeType: 'video/mp4',
      download: async () => Buffer.alloc(MAX_BYTES + 1),
    }, silentLogger());
    expect(stored).toBeUndefined();
  });

  it('فشل التحميل لا يرمي', async () => {
    const stored = await storeMedia(dbPath, tenant.id, {
      kind: 'image',
      mimeType: 'image/png',
      download: async () => {
        throw new Error('انقطاع');
      },
    }, silentLogger());
    expect(stored).toBeUndefined();
  });

  it('الامتداد من النوع أو من اسم الملف', () => {
    expect(extensionFor('image/png')).toBe('.png');
    expect(extensionFor('application/pdf')).toBe('.pdf');
    expect(extensionFor('application/x-weird', 'عقد.docx')).toBe('.docx');
    expect(extensionFor('application/x-weird')).toBe('.bin');
  });

  it('مسار فيه ../ يُرفض — لا يُقرأ ملف خارج المجلد', () => {
    expect(readStored(dbPath, '../../../etc/passwd')).toBeUndefined();
    expect(readStored(dbPath, '/etc/passwd')).toBeUndefined();
  });

  it('الصور الكبيرة لا تُمرَّر للنموذج', () => {
    expect(isVisionImage('image/png', 1000)).toBe(true);
    expect(isVisionImage('image/png', 9 * 1024 * 1024)).toBe(false);
    expect(isVisionImage('application/pdf', 1000)).toBe(false);
  });
});

describe('من المحرّك', () => {
  it('الصورة تُحفظ وتُمرَّر للنموذج ليراها', async () => {
    const claude = mockClaude([{ text: 'أشوف المضخة معطلة، سجّلت لك طلب صيانة.' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: { kind: 'image', mimeType: 'image/png', download: async () => PNG },
    });

    // النموذج استلم كتلة صورة فعلية
    const blocks = claude.requests[0]!.messages.at(-1)!.content as { type: string }[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.some((b) => b.type === 'image')).toBe(true);

    // والرسالة محفوظة بمسارها
    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    const saved = recentMessages(db, conv.id, 5)[0]!;
    expect(saved.media_type).toBe('image');
    expect(saved.media_path).toBeTruthy();
    expect(saved.media_mime).toBe('image/png');
  });

  it('الملف غير المرئي يُقَرّ به ولا يُدّعى الاطلاع عليه', async () => {
    const claude = mockClaude([{ text: 'استلمنا الملف.' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: {
        kind: 'document',
        mimeType: 'application/pdf',
        filename: 'فاتورة.pdf',
        download: async () => Buffer.from('%PDF-1.4'),
      },
    });

    // إشعار المرفق في الجزء المتغيّر: يخص هذه الرسالة وحدها ولا يُخزَّن
    expect(claude.requests[0]!.systemVolatile).toContain('أرسل العميل ملف');
    expect(claude.requests[0]!.systemVolatile).toContain('فاتورة.pdf');
    expect(claude.requests[0]!.systemVolatile).toContain('لا تدّعِ أنك اطّلعت عليه');
    expect(claude.requests[0]!.system).not.toContain('فاتورة.pdf');
    expect(provider.outbox.some((m) => m.to === '966555123456')).toBe(true);
  });

  it('الموقع يصل نصاً بلا تحميل', async () => {
    const claude = mockClaude([{ text: 'وصلنا موقعك.' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: { kind: 'location', mimeType: 'text/plain', text: 'محطة الربيع — الإحداثيات: 25.0, 37.2' },
    });

    expect(JSON.stringify(claude.requests[0]!.messages)).toContain('الإحداثيات');
  });

  it('الوصف المصاحب للصورة هو طلب العميل', async () => {
    const claude = mockClaude([{ text: 'تم' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      text: 'هذي المضخة المعطلة',
      media: { kind: 'image', mimeType: 'image/png', download: async () => PNG },
    });

    const blocks = claude.requests[0]!.messages.at(-1)!.content as { type: string; text?: string }[];
    expect(blocks.some((b) => b.type === 'text' && b.text === 'هذي المضخة المعطلة')).toBe(true);
  });

  it('الملصق لا يُسقط المحادثة', async () => {
    const claude = mockClaude([{ text: '🙂' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: { kind: 'sticker', mimeType: 'image/webp', download: async () => Buffer.from('x') },
    });

    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    expect(recentMessages(db, conv.id, 5).length).toBeGreaterThan(0);
  });

  it('الصوت بلا مزوّد تحويل: يُحفظ الملف ويُطلب نص', async () => {
    const claude = mockClaude([{ text: 'لن يُستدعى' }]);
    await engineWith(claude);

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: { kind: 'audio', mimeType: 'audio/ogg', download: async () => Buffer.from('voice') },
    });

    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    const saved = recentMessages(db, conv.id, 5)[0]!;
    expect(saved.media_path).toBeTruthy();       // الملف محفوظ رغم عدم التحويل
    expect(provider.outbox[0]?.text).toContain('ما أقدر أسمع');
  });

  it('الصوت مع مزوّد تحويل: النص يُعامَل كرسالة والملف يبقى', async () => {
    const claude = mockClaude([{ text: 'الديزل متوفر' }]);
    await engineWith(claude, { transcribe: async () => 'عندكم ديزل؟' });

    await provider.receive({
      toNumber: tenant.wa_number,
      from: '966555123456',
      media: { kind: 'audio', mimeType: 'audio/ogg', download: async () => Buffer.from('voice') },
    });

    expect(JSON.stringify(claude.requests[0]!.messages)).toContain('عندكم ديزل؟');
    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    expect(recentMessages(db, conv.id, 5)[0]?.media_path).toBeTruthy();
  });
});
