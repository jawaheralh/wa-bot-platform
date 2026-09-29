/**
 * مراقبة النفق وإصلاحه ذاتياً.
 *
 * أنفاق trycloudflare مؤقتة: تنتهي صلاحيتها فيرد الخادم
 * «Unauthorized: Tunnel not found»، و cloudflared يُعيد المحاولة على نفق
 * ميت إلى الأبد بدل إنشاء جديد. العملية لا تموت، فلا يُنقذها إشراف
 * launchd — لذلك تلزم مراقبة من الخارج.
 *
 * الدورة: اختبر العنوان → إن مات أعد تشغيل النفق → التقط العنوان الجديد
 * → حدّث .env → أعد تسجيل الـwebhook لدى Meta. بلا تدخّل.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from './app.ts';
import { ROOT } from './config.ts';
import { writeEnvFile } from './env-file.ts';

const run = promisify(execFile);

/** فشلان متتاليان قبل الإصلاح: انقطاع شبكة لحظي لا يستحق إعادة تشغيل. */
const FAILURES_BEFORE_HEAL = 2;
const TUNNEL_LABEL = 'sa.waqodi.wabot-tunnel';
const TUNNEL_LOG = join(ROOT, 'logs', `${TUNNEL_LABEL}.log`);

let consecutiveFailures = 0;
let lastHealAt = 0;

/**
 * هل العنوان العام حيّ؟
 *
 * نطلب مسار الـwebhook برمز تحقق خاطئ: العنوان الحيّ يرد 403 (رفض
 * التحقق)، والميت لا يرد أو يرد 5xx. نتعمّد ألّا نستعمل رمزاً صحيحاً
 * حتى لا يبدو الفحص محاولة ربط.
 */
export async function isPublicUrlAlive(publicUrl: string, timeoutMs = 12_000): Promise<boolean> {
  if (!publicUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${publicUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=probe`, {
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** آخر عنوان ظهر في سجل cloudflared. */
export function readTunnelUrl(logPath = TUNNEL_LOG): string | undefined {
  if (!existsSync(logPath)) return undefined;
  const matches = readFileSync(logPath, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return matches?.at(-1);
}

async function restartTunnel(): Promise<void> {
  await run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${TUNNEL_LABEL}`]);
}

/**
 * يُعيد تشغيل النفق ويُعيد ربطه بـMeta.
 * يُعيد العنوان الجديد، أو undefined إن تعذّر.
 */
export async function healTunnel(app: App): Promise<string | undefined> {
  const dead = app.config.publicUrl;

  /**
   * قبل إعادة التشغيل: هل تعافى النفق بنفسه بعنوان جديد؟
   *
   * cloudflared قد يُنشئ نفقاً جديداً وحده ويكتب عنوانه في السجل، بينما
   * يبقى .env على العنوان القديم. إعادة تشغيله حينها تقتل نفقاً سليماً
   * وتبدأ دورة لا تستقر. التبنّي أرخص وأسرع من الإصلاح.
   */
  const logged = readTunnelUrl();
  if (logged && logged !== dead && (await isPublicUrlAlive(logged))) {
    app.logger.info('النفق أنشأ عنواناً جديداً وحده — تبنّيه', { عنوان: logged });
    return adopt(app, logged);
  }

  app.logger.warn('النفق لا يستجيب — إعادة تشغيله', { عنوان: dead || '؟' });

  try {
    await restartTunnel();
  } catch (error) {
    app.logger.error('تعذّر إعادة تشغيل النفق', error);
    return undefined;
  }

  /**
   * ننتظر عنواناً **حيّاً**، لا عنواناً مختلفاً.
   *
   * المقارنة بآخر سطر في السجل كانت خطأ: النفق قد يكون كتب عنوانه الجديد
   * قبل أن نبدأ الإصلاح، فننتظر تغيّراً وقع أصلاً ولا يقع ثانيةً.
   * الحياة هي المعيار الصحيح — وإن عاد بنفس العنوان فهذا نجاح لا فشل.
   */
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const url = readTunnelUrl();
    if (url && (await isPublicUrlAlive(url, 6000))) return adopt(app, url);
  }

  app.logger.error('أُعيد تشغيل النفق ولم يظهر عنوان حيّ');
  return undefined;
}

/** يعتمد عنواناً حيّاً: يحفظه، ويحدّث الإعدادات الجارية، ويُعيد ربط Meta. */
async function adopt(app: App, url: string): Promise<string> {
  const previous = app.config.publicUrl;
  writeEnvFile(new Map([['PUBLIC_URL', url]]));
  // الإعدادات تُقرأ مرة عند الإقلاع، فنحدّث النسخة الجارية أيضاً ليصح
  // تسجيل الـwebhook فوراً بلا انتظار إعادة تشغيل.
  (app.config as { publicUrl: string }).publicUrl = url;

  if (url === previous) {
    app.logger.info('تعافى النفق بنفس العنوان — لا حاجة لإعادة الربط', { عنوان: url });
    return url;
  }

  const meta = await import('./meta-setup.ts');
  const result = await meta.configureWebhook(app.config);
  app.logger.info(
    result.ok ? 'تعافى النفق وأُعيد ربط الـwebhook' : `تعافى النفق لكن فشل ربط الـwebhook: ${result.message}`,
    { عنوان: url },
  );
  return url;
}

/**
 * نبضة المراقبة. تُنادى دورياً من المجدول.
 * تُعيد true إن جرى إصلاح.
 */
export async function watchTunnel(app: App): Promise<boolean> {
  if (!app.config.publicUrl) return false;
  // النفق المحلي وحده يُدار هكذا؛ الخادم الحقيقي له عنوان ثابت.
  if (!app.config.publicUrl.includes('trycloudflare.com')) return false;

  if (await isPublicUrlAlive(app.config.publicUrl)) {
    if (consecutiveFailures > 0) app.logger.info('عاد العنوان العام للاستجابة');
    consecutiveFailures = 0;
    return false;
  }

  /**
   * قبل عدّ الفشل: هل في السجل عنوان أحدث وحيّ؟
   *
   * cloudflared يُنشئ نفقاً جديداً عند كل إعادة تشغيل ويكتب عنوانه، بينما
   * يبقى .env على القديم. الفحص هنا — لا بعد عتبة الفشل — يلتقط التعافي
   * في نبضة واحدة بدل دقيقتين، ويمنع إعادة تشغيل تقتل نفقاً سليماً.
   */
  const logged = readTunnelUrl();
  if (logged && logged !== app.config.publicUrl && (await isPublicUrlAlive(logged))) {
    app.logger.info('عنوان نفق أحدث وحيّ في السجل — تبنّيه', { عنوان: logged });
    await adopt(app, logged);
    consecutiveFailures = 0;
    return true;
  }

  consecutiveFailures += 1;
  app.logger.warn('العنوان العام لا يستجيب', { محاولة: consecutiveFailures });
  if (consecutiveFailures < FAILURES_BEFORE_HEAL) return false;

  // حدّ أدنى بين محاولتي إصلاح: إعادة تشغيل متكررة تمنع النفق من الاستقرار.
  if (Date.now() - lastHealAt < 3 * 60_000) return false;
  lastHealAt = Date.now();

  const healed = await healTunnel(app);
  if (healed) consecutiveFailures = 0;
  return Boolean(healed);
}
