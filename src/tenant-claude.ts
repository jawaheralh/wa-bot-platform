/**
 * عميل Claude لكل منشأة.
 *
 * كل عميل يحمل تكلفته: مفتاحه وحده يُخصم منه، وإن نفد رصيده توقّف هو
 * ولم يتوقف بقية عملائك. وهذا ما يجعل التسعير بالاستهلاك ممكناً أصلاً.
 *
 * المنشأة بلا مفتاح ترث المفتاح العام — الحالة البسيطة تبقى بسيطة.
 */

import type { AppConfig } from './config.ts';
import type { TenantRow, Db } from './db/index.ts';
import type { Logger } from './logger.ts';
import { createClaudeClient, type ClaudeClient } from './bot/claude.ts';
import { SQL_NOW, today } from './time.ts';

/** العملاء يُبنون مرة ويُعاد استعمالهم — بناء عميل لكل رسالة هدر. */
const cache = new Map<string, ClaudeClient>();

export interface ResolvedClaude {
  client: ClaudeClient;
  /** هل تستعمل المنشأة مفتاحها الخاص؟ */
  own: boolean;
  model: string;
}

export function claudeFor(
  config: AppConfig,
  tenant: TenantRow,
  logger: Logger,
): ResolvedClaude | undefined {
  const key = tenant.anthropic_api_key || config.anthropicApiKey;
  const model = tenant.anthropic_model || config.anthropicModel;
  if (!key) return undefined;

  const cacheKey = `${key.slice(-12)}:${model}`;
  let client = cache.get(cacheKey);
  if (!client) {
    client = createClaudeClient(key, model, logger);
    cache.set(cacheKey, client);
  }
  return { client, own: Boolean(tenant.anthropic_api_key), model };
}

/** يُبطل عميلاً مخزَّناً بعد تغيير المفتاح من اللوحة. */
export function forgetClaudeCache(): void {
  cache.clear();
}

/* ---------------------------------------------------------------
   الاستهلاك
--------------------------------------------------------------- */

export type UsageKind = 'replies' | 'tool_calls' | 'failures';

export function recordUsage(db: Db, tenantId: number, kind: UsageKind, amount = 1): void {
  const month = today().slice(0, 7);
  db.prepare(
    `INSERT INTO usage_log (tenant_id, month, ${kind}) VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, month) DO UPDATE SET ${kind} = ${kind} + ?`,
  ).run(tenantId, month, amount, amount);
}

export interface UsageRow {
  month: string;
  replies: number;
  tool_calls: number;
  failures: number;
}

export function usageFor(db: Db, tenantId: number, months = 12): UsageRow[] {
  return db
    .prepare('SELECT month, replies, tool_calls, failures FROM usage_log WHERE tenant_id = ? ORDER BY month DESC LIMIT ?')
    .all(tenantId, months) as UsageRow[];
}

export function usageThisMonth(db: Db, tenantId: number): UsageRow {
  const month = today().slice(0, 7);
  return (
    (db
      .prepare('SELECT month, replies, tool_calls, failures FROM usage_log WHERE tenant_id = ? AND month = ?')
      .get(tenantId, month) as UsageRow | undefined) ?? { month, replies: 0, tool_calls: 0, failures: 0 }
  );
}

export { SQL_NOW };
