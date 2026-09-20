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

  provider.onMessage(async (message) => {
    // محرّك البوت يُركَّب في المرحلة الثانية؛ حالياً نُثبت وصول الرسائل فقط.
    logger.info('رسالة واردة', { إلى: message.toNumber, من: message.from, نص: message.text ?? '(صوت)' });
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
