/**
 * الإعدادات.
 *
 * الفصل مقصود: هذا الملف يقرأ **متغيرات التشغيل والأسرار فقط** — المزوّد،
 * المفاتيح، المنفذ. أما إعدادات المنشآت والوحدات (ساعات العمل، النبرة، قاعدة
 * المعرفة) فمكانها قاعدة البيانات وتُحرَّر من صفحة الأدمن، لأنها تتغير لكل
 * عميل وبلا إعادة تشغيل.
 *
 * .env يُقرأ يدوياً بدل dotenv — سطور قليلة تغني عن تبعية كاملة.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { LogLevel } from './logger.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** يقرأ .env إن وُجد بلا أن يدهس متغيرات البيئة المُمرَّرة من سطر الأوامر. */
export function loadEnvFile(path = join(ROOT, '.env')): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type ProviderName = 'baileys' | 'cloud' | 'simulator';

export interface AppConfig {
  port: number;
  host: string;
  /** العنوان العام في الإنتاج. وجوده يعني «هذا خادم على الإنترنت» ويشدّد الفحص. */
  publicUrl: string;
  dbPath: string;
  sessionSecret: string;
  logLevel: LogLevel;
  provider: ProviderName;
  /** رقم الدعم الذي يظهر لأدمن المنشأة عند الوحدات المعطّلة. */
  supportWhatsApp: string;
  anthropicApiKey: string;
  anthropicModel: string;
  /** تحويل الرسائل الصوتية لنص — يُعطَّل تلقائياً إذا لم يوجد مفتاح. */
  transcription: { enabled: boolean; apiKey: string; model: string; baseUrl: string };
  baileys: { authDir: string };
  cloud: { verifyToken: string; appSecret: string; accessToken: string; graphVersion: string };
  /** نافذة الصمت بعد تدخّل الموظف يدوياً (بالدقائق). */
  silentMinutes: number;
  /** عدد الرسائل المحفوظة كسياق للنموذج. */
  historyLimit: number;
}

function str(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function requireIn(key: string, allowed: readonly string[], fallback: string): string {
  const value = str(key, fallback);
  if (!allowed.includes(value)) {
    throw new Error(`قيمة ${key} غير صالحة: «${value}». المسموح: ${allowed.join(' | ')}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  loadEnvFile();

  const provider = requireIn('WA_PROVIDER', ['baileys', 'cloud', 'simulator'], 'simulator') as ProviderName;
  const logLevel = requireIn('LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info') as LogLevel;

  const isPublic = str('PUBLIC_URL') !== '';
  let sessionSecret = str('SESSION_SECRET');

  if (!sessionSecret) {
    if (isPublic) {
      throw new Error(
        'SESSION_SECRET مطلوب في الإنتاج. ولّديه بـ:  openssl rand -hex 32',
      );
    }
    // سرّ عشوائي يكفي للتطوير، لكنه يُبطل الجلسات عند كل إعادة تشغيل.
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('تحذير: SESSION_SECRET غير معرّف، وُلّد سرّ مؤقت — الجلسات تنتهي عند إعادة التشغيل.');
  }

  /**
   * سرّ التطوير المكتوب في .env.example يسري بلا انتباه إلى الخادم.
   * من عرفه زوّر كوكي جلسة لأي مستخدم، فنرفض الإقلاع بدل أن نحذّر —
   * لوحة على الإنترنت بسرّ منشور في مستودع ليست خطأ يُحتمل.
   */
  if (isPublic && (sessionSecret.includes('change-me') || sessionSecret.length < 32)) {
    throw new Error(
      'SESSION_SECRET ضعيف أو هو قيمة المثال. ولّدي سرّاً حقيقياً:  openssl rand -hex 32',
    );
  }

  const transcriptionKey = str('OPENAI_API_KEY');

  const config: AppConfig = {
    port: num('PORT', 4000),
    host: str('HOST', '127.0.0.1'),
    publicUrl: str('PUBLIC_URL').replace(/\/$/, ''),
    dbPath: str('DB_PATH', join(ROOT, 'data', 'app.db')),
    sessionSecret,
    logLevel,
    provider,
    supportWhatsApp: str('SUPPORT_WHATSAPP', '966500000000').replace(/[^\d]/g, ''),
    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    transcription: {
      enabled: str('ENABLE_VOICE', '1') !== '0' && transcriptionKey !== '',
      apiKey: transcriptionKey,
      model: str('TRANSCRIBE_MODEL', 'whisper-1'),
      baseUrl: str('TRANSCRIBE_BASE_URL', 'https://api.openai.com/v1'),
    },
    baileys: { authDir: str('BAILEYS_AUTH_DIR', join(ROOT, 'data', 'baileys')) },
    cloud: {
      verifyToken: str('WA_VERIFY_TOKEN'),
      appSecret: str('WA_APP_SECRET'),
      accessToken: str('WA_ACCESS_TOKEN'),
      graphVersion: str('WA_GRAPH_VERSION', 'v23.0'),
    },
    silentMinutes: num('SILENT_MINUTES', 120),
    historyLimit: num('HISTORY_LIMIT', 20),
  };

  if (config.provider === 'cloud') {
    const missing = (['verifyToken', 'appSecret', 'accessToken'] as const).filter((k) => !config.cloud[k]);
    if (missing.length) {
      throw new Error(
        `WA_PROVIDER=cloud يتطلب المتغيرات: ${missing
          .map((k) => ({ verifyToken: 'WA_VERIFY_TOKEN', appSecret: 'WA_APP_SECRET', accessToken: 'WA_ACCESS_TOKEN' })[k])
          .join('، ')}`,
      );
    }
  }

  return config;
}
