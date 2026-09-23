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
import { errorMessage, type Logger } from './logger.ts';
import { createClaudeClient, type ClaudeClient } from './bot/claude.ts';
import { createEngine } from './bot/engine.ts';
import { createTranscriber } from './stt/index.ts';
import { createServer } from './web/server.ts';
import { startScheduler } from './scheduler.ts';

/** بديل يوقف الردود بوضوح بدل أن يفشل الإقلاع كله. */
function disabledClaude(logger: Logger): ClaudeClient {
  logger.warn('ANTHROPIC_API_KEY غير معرّف — لوحة التحكم تعمل، لكن البوت لن يرد على العملاء.');
  return {
    async chat() {
      throw new Error('ANTHROPIC_API_KEY غير معرّف.');
    },
  };
}

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


  // بلا مفتاح لا يستطيع البوت الرد، لكن لوحة التحكم يجب أن تعمل: الأدمن
  // يحتاجها لإدخال المعرفة وإضافة المنشآت قبل أن يصل أول عميل.
  const claude = config.anthropicApiKey
    ? createClaudeClient(config.anthropicApiKey, config.anthropicModel, logger)
    : disabledClaude(logger);
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

  const stopScheduler = startScheduler(app);

  const server = await createServer(app);
  await server.listen({ port: config.port, host: config.host });
  logger.info(`لوحة التحكم جاهزة على http://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`إيقاف التشغيل (${signal})`);
    stopScheduler();
    await server.close();
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
