/**
 * نقطة الدخول.
 *
 * الترتيب مقصود: الإعدادات ثم القاعدة ثم الوحدات ثم المزوّد ثم الخادم.
 * أي فشل في الأولَين يوقف التشغيل فوراً برسالة عربية واضحة بدل أن يظهر
 * لاحقاً كسلوك غريب في منتصف محادثة عميل.
 */

import { buildApp } from './app.ts';
import { listTenants } from './db/index.ts';
import { MODULES } from './modules/registry.ts';
import { errorMessage } from './logger.ts';
import { createClaudeClient } from './bot/claude.ts';
import { createEngine } from './bot/engine.ts';
import { createTranscriber } from './stt/index.ts';

async function main(): Promise<void> {
  const app = await buildApp();
  const { config, db, logger, provider } = app;

  const tenants = listTenants(db);
  logger.info('بدأ التشغيل', {
    مزوّد: config.provider,
    منشآت: tenants.length,
    وحدات: MODULES.length,
    قاعدة: config.dbPath,
  });

  if (tenants.length === 0) {
    logger.warn('لا توجد منشآت بعد — شغّلي «npm run seed» لإنشاء منشأة تجريبية.');
  }

  const claude = createClaudeClient(config.anthropicApiKey, config.anthropicModel, logger);
  const transcriber = createTranscriber(config, logger);
  const engine = createEngine({ app, claude, transcriber });

  provider.onMessage(async (message) => {
    try {
      await engine(message);
    } catch (error) {
      // خط الدفاع الأخير: خطأ غير متوقع في رسالة واحدة لا يُسقط العملية كلها.
      logger.error('خطأ غير متوقع في معالجة رسالة', error, { من: message.from });
    }
  });

  await provider.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`إيقاف التشغيل (${signal})`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`فشل الإقلاع: ${errorMessage(error)}`);
  process.exit(1);
});
