/**
 * تركيب التطبيق.
 *
 * مفصول عن index.ts حتى تستطيع الاختبارات وسكربت المحاكاة بناء نفس التطبيق
 * بالضبط بلا فتح منفذ ولا اتصال واتساب.
 */

import { loadConfig, type AppConfig } from './config.ts';
import { sealExistingSecrets, ensureEncryptionKey } from './secrets.ts';
import { createLogger, setLogLevel, type Logger } from './logger.ts';
import { openDb, listTenants, type Db } from './db/index.ts';
import { migrateAll, ensureTenantModules } from './modules/registry.ts';
import { createProvider } from './whatsapp/index.ts';
import { createNotifier, type Notifier } from './notify.ts';
import type { WhatsAppProvider } from './whatsapp/provider.ts';

export interface App {
  config: AppConfig;
  db: Db;
  logger: Logger;
  provider: WhatsAppProvider;
  notify: Notifier;
  close(): Promise<void>;
}

export interface BuildOptions {
  config?: AppConfig;
  db?: Db;
  provider?: WhatsAppProvider;
  logger?: Logger;
}

export async function buildApp(options: BuildOptions = {}): Promise<App> {
  const config = options.config ?? loadConfig();
  setLogLevel(config.logLevel);
  const logger = options.logger ?? createLogger();

  /**
   * المفتاح قبل أول قراءة لمنشأة.
   *
   * القراءة تفكّ التشفير، وبلا مفتاح تفشل — فيُولَّد ويُكتب في .env
   * إن لم يكن موجوداً قبل أن يُفتح شيء.
   */
  ensureEncryptionKey();

  const db = options.db ?? openDb(config.dbPath);
  migrateAll(db);

  // ما بقي نصّاً صريحاً من قاعدة سابقة يُشفَّر مرة واحدة.
  const sealed = sealExistingSecrets(db as never);
  if (sealed > 0) logger.info('شُفّرت أسرار منشآت كانت نصّاً صريحاً', { منشآت: sealed });
  // منشأة أُنشئت قبل إضافة وحدة جديدة تحتاج صفاً لها — نُسوّي الجميع عند الإقلاع.
  for (const tenant of listTenants(db)) ensureTenantModules(db, tenant.id);

  const provider = options.provider ?? (await createProvider(config, db, logger));
  const notify = createNotifier(db, provider, logger);

  return {
    config,
    db,
    logger,
    provider,
    notify,
    async close() {
      await provider.stop();
      db.close();
    },
  };
}
