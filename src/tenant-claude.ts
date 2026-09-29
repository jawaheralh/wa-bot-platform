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
  cache_read: number;
  cache_written: number;
  uncached: number;
}

/** يسجّل توكنات الإدخال مفصّلة — منها يُحسب الوفر الفعلي للتخزين. */
export function recordCache(
  db: Db,
  tenantId: number,
  cache: { read: number; created: number; uncached: number },
): void {
  const month = today().slice(0, 7);
  db.prepare(
    `INSERT INTO usage_log (tenant_id, month, cache_read, cache_written, uncached)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, month) DO UPDATE SET
       cache_read = cache_read + ?, cache_written = cache_written + ?, uncached = uncached + ?`,
  ).run(tenantId, month, cache.read, cache.created, cache.uncached, cache.read, cache.created, cache.uncached);
}

export function usageFor(db: Db, tenantId: number, months = 12): UsageRow[] {
  return db
    .prepare('SELECT * FROM usage_log WHERE tenant_id = ? ORDER BY month DESC LIMIT ?')
    .all(tenantId, months) as UsageRow[];
}

export function usageThisMonth(db: Db, tenantId: number): UsageRow {
  const month = today().slice(0, 7);
  return (
    (db.prepare('SELECT * FROM usage_log WHERE tenant_id = ? AND month = ?').get(tenantId, month) as
      | UsageRow
      | undefined) ?? { month, replies: 0, tool_calls: 0, failures: 0, cache_read: 0, cache_written: 0, uncached: 0 }
  );
}

export { SQL_NOW };


/* ---------------------------------------------------------------
   التكلفة
--------------------------------------------------------------- */

/** أسعار Sonnet 5 لكل مليون توكن إدخال. */
const PRICE_PER_M = 2;
const WRITE_MULTIPLIER = 1.25;
const READ_MULTIPLIER = 0.1;

export interface CostEstimate {
  /** التكلفة الفعلية بالدولار — الإدخال وحده. */
  actual: number;
  /** ما كانت ستكون بلا تخزين مؤقت. */
  withoutCache: number;
  /** نسبة الوفر المئوية. */
  savedPercent: number;
}

/**
 * تقدير تكلفة الإدخال من عدّادات التخزين.
 *
 * الإدخال وحده — الإخراج قصير (ردّ واتساب) وتقديره يحتاج عدّه، وإدراج
 * رقم غير مقيس يُفسد الغرض من هذا الحساب.
 */
export function estimateInputCost(usage: UsageRow): CostEstimate {
  const actualTokens = usage.cache_read * READ_MULTIPLIER + usage.cache_written * WRITE_MULTIPLIER + usage.uncached;
  const plainTokens = usage.cache_read + usage.cache_written + usage.uncached;

  const actual = (actualTokens * PRICE_PER_M) / 1e6;
  const withoutCache = (plainTokens * PRICE_PER_M) / 1e6;

  return {
    actual,
    withoutCache,
    savedPercent: plainTokens > 0 ? Math.round((1 - actual / withoutCache) * 100) : 0,
  };
}
