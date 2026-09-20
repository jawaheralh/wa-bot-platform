/**
 * أدوات الاختبار المشتركة.
 *
 * قاعدة بيانات في الذاكرة لكل اختبار: التشغيلة لا ترث حالة سابقة، وهو درس
 * مدفوع الثمن من مشروع 9200 حيث كانت اختبارات التوقيت تتأثر بتشغيلاتها السابقة.
 */

import { openDb, type Db, type TenantRow, type ConversationRow } from '../src/db/index.ts';
import { migrateAll, ensureTenantModules } from '../src/modules/registry.ts';
import { createTenant } from '../src/tenants.ts';
import { createLogger, type Logger } from '../src/logger.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { now } from '../src/time.ts';
import type { BotModule, ModuleContext } from '../src/modules/types.ts';

export function freshDb(): Db {
  const db = openDb(':memory:');
  migrateAll(db);
  return db;
}

export function seedTenant(db: Db, overrides: Partial<Parameters<typeof createTenant>[1]> = {}): TenantRow {
  const tenant = createTenant(db, {
    name: 'منشأة الاختبار',
    waNumber: '966500000001',
    tone: 'friendly',
    staffWaNumber: '966500000099',
    ...overrides,
  });
  ensureTenantModules(db, tenant.id);
  return tenant;
}

/** سجل صامت — لا نريد ضجيجاً في مخرجات vitest. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

export function loudLogger(): Logger {
  return createLogger();
}

export function fakeConversation(tenantId: number): ConversationRow {
  return {
    id: 1,
    tenant_id: tenantId,
    customer_wa: '966555555555',
    customer_name: 'عميل',
    bot_enabled: 1,
    silent_until: null,
    handoff_reason: null,
    last_message_at: null,
    created_at: now(),
  };
}

export function baseContext(db: Db, tenant: TenantRow): Omit<ModuleContext, 'config'> {
  return {
    db,
    tenant,
    conversation: fakeConversation(tenant.id),
    provider: new SimulatorProvider(),
    logger: silentLogger(),
    now: now(),
    notify: async () => {},
  };
}

/** وحدة صورية لاختبار آليات السجل بمعزل عن الوحدات الحقيقية. */
export function makeFakeModule(name: string, options: Partial<BotModule> = {}): BotModule {
  return {
    name,
    titleAr: `وحدة ${name}`,
    descriptionAr: `وصف ${name}`,
    core: false,
    tables: [],
    defaultConfig: () => ({}),
    validateConfig: (input) => (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
    systemPrompt: () => `تعليمات ${name}`,
    tools: () => [
      {
        name: `${name}_tool`,
        description: `أداة ${name}`,
        input_schema: { type: 'object', properties: {} },
      },
    ],
    runTool: async () => ({ content: `نُفِّذت ${name}` }),
    ...options,
  };
}
