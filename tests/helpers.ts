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
import type { ChatRequest, ClaudeClient, ModelReply } from '../src/bot/claude.ts';

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
    assigned_to: null,
    assigned_at: null,
    viewing_user_id: null,
    viewing_at: null,
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

/* ---------------------------------------------------------------
   Claude وهمي
--------------------------------------------------------------- */


export interface ScriptedTurn {
  /** نص يردّه النموذج. */
  text?: string;
  /** أدوات يطلب تنفيذها في هذه الجولة. */
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

export interface MockClaude extends ClaudeClient {
  /** كل طلب وصل للنموذج — نفحص منه الـsystem والأدوات. */
  readonly requests: ChatRequest[];
}

/** نموذج مبرمَج: يردّ الجولات بالترتيب، وآخر جولة تتكرر إن نفدت. */
export function mockClaude(turns: ScriptedTurn[]): MockClaude {
  const requests: ChatRequest[] = [];
  let index = 0;

  return {
    requests,
    async chat(request: ChatRequest): Promise<ModelReply> {
      requests.push(request);
      const turn = turns[Math.min(index, turns.length - 1)] ?? { text: '' };
      index += 1;
      const toolCalls = (turn.toolCalls ?? []).map((call, i) => ({
        id: `tool-${index}-${i}`,
        name: call.name,
        input: call.input,
      }));
      return {
        text: turn.text ?? '',
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
        raw: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input })),
        ],
      };
    },
  };
}
