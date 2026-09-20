/**
 * سجل الوحدات.
 *
 * هذا هو الملف الوحيد الذي يُعدَّل عند إضافة وحدة جديدة: سطر واحد في
 * MODULES. كل شيء آخر — الجداول، والتفعيل لكل منشأة، وتجميع الأدوات
 * والـprompt، وتوجيه نداء الأداة لصاحبها — يعمل تلقائياً بعده.
 */

import type { Db, TenantRow } from '../db/index.ts';
import type { BotModule, ModuleConfig, ModuleContext, ToolDefinition, ToolResult } from './types.ts';
import { SQL_NOW } from '../time.ts';

import { inquiriesModule } from './inquiries.ts';
import { complaintsModule } from './complaints.ts';
import { handoffModule } from './handoff.ts';
import { bookingsModule } from './bookings.ts';

/* ===============================================================
   الوحدات المسجّلة

   لإضافة وحدة: اكتب ملفها في modules/، ثم أضف سطر import لها وضعها في
   هذه القائمة. لا شيء آخر في المشروع يُعدَّل — الجداول والتفعيل وتجميع
   الأدوات والـprompt وتوجيه النداءات كلها تعمل تلقائياً بعدها.
   =============================================================== */
export const MODULES: BotModule[] = [inquiriesModule, complaintsModule, handoffModule, bookingsModule];

/**
 * البحث خطّي عن قصد: الوحدات عشرات لا آلاف، وخريطة تُبنى مرة عند الاستيراد
 * تصبح قديمة إذا عُدّلت القائمة (كما تفعل الاختبارات) — وهذا صنف أخطاء
 * لا يستحق أن نشتريه مقابل بحث أسرع بميكروثانية.
 */
export function getModule(name: string): BotModule | undefined {
  return MODULES.find((m) => m.name === name);
}

/** أساسية = تُفعَّل لكل منشأة جديدة تلقائياً ولا يمكن تعطيلها. */
export function coreModules(): BotModule[] {
  return MODULES.filter((m) => m.core);
}

/* ---------------------------------------------------------------
   الجداول والتفعيل
--------------------------------------------------------------- */

/**
 * تُنشأ جداول **كل** الوحدات عند الإقلاع، حتى المعطّلة.
 * البديل — إنشاء الجدول لحظة التفعيل — يجعل حالة القاعدة تعتمد على تاريخ
 * التفعيل، فتختلف بين منشأة وأخرى ويصعب التشخيص. الجدول الفارغ لا يكلّف شيئاً.
 */
export function migrateAll(db: Db): void {
  for (const module of MODULES) {
    for (const statement of module.tables) db.exec(statement);
  }
}

export interface EnabledModule {
  module: BotModule;
  config: ModuleConfig;
}

/** يضمن وجود صف في tenant_modules لكل وحدة، والأساسية مفعّلة. */
export function ensureTenantModules(db: Db, tenantId: number): void {
  const insert = db.prepare(
    `INSERT INTO tenant_modules (tenant_id, module, enabled, config)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, module) DO NOTHING`,
  );
  const fixCore = db.prepare(
    `UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = ? AND enabled = 0`,
  );
  const transaction = db.transaction(() => {
    for (const module of MODULES) {
      insert.run(tenantId, module.name, module.core ? 1 : 0, JSON.stringify(module.defaultConfig()));
      if (module.core) fixCore.run(tenantId, module.name);
    }
  });
  transaction();
}

function parseConfig(module: BotModule, raw: string): ModuleConfig {
  let stored: ModuleConfig = {};
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as ModuleConfig;
  } catch {
    // إعداد تالف لا يجوز أن يُسقط المنشأة كلها — نرجع للافتراضي بصمت محسوب.
  }
  // الدمج مع الافتراضي يعني أن إضافة مفتاح جديد لوحدة لا تكسر المنشآت القائمة.
  return { ...module.defaultConfig(), ...stored };
}

/** الوحدات المفعّلة لهذه المنشأة بترتيب MODULES الثابت. */
export function enabledFor(db: Db, tenantId: number): EnabledModule[] {
  const rows = db
    .prepare('SELECT module, enabled, config FROM tenant_modules WHERE tenant_id = ?')
    .all(tenantId) as { module: string; enabled: number; config: string }[];
  const state = new Map(rows.map((r) => [r.module, r]));

  const result: EnabledModule[] = [];
  for (const module of MODULES) {
    const row = state.get(module.name);
    // الأساسية مفعّلة حتى لو غاب صفها — منشأة بلا استفسارات ليست منتجاً.
    const enabled = module.core || row?.enabled === 1;
    if (!enabled) continue;
    result.push({ module, config: parseConfig(module, row?.config ?? '{}') });
  }
  return result;
}

/** حالة كل الوحدات لهذه المنشأة — لصفحة الأدمن، فهي تعرض المعطّلة أيضاً. */
export function statusFor(db: Db, tenantId: number): {
  name: string;
  titleAr: string;
  descriptionAr: string;
  core: boolean;
  enabled: boolean;
  config: ModuleConfig;
}[] {
  const rows = db
    .prepare('SELECT module, enabled, config FROM tenant_modules WHERE tenant_id = ?')
    .all(tenantId) as { module: string; enabled: number; config: string }[];
  const state = new Map(rows.map((r) => [r.module, r]));

  return MODULES.map((module) => {
    const row = state.get(module.name);
    return {
      name: module.name,
      titleAr: module.titleAr,
      descriptionAr: module.descriptionAr,
      core: module.core,
      enabled: module.core || row?.enabled === 1,
      config: parseConfig(module, row?.config ?? '{}'),
    };
  });
}

export function setEnabled(db: Db, tenantId: number, name: string, enabled: boolean): void {
  const module = getModule(name);
  if (!module) throw new Error(`وحدة غير معروفة: ${name}`);
  if (module.core && !enabled) throw new Error(`الوحدة «${module.titleAr}» أساسية ولا يمكن تعطيلها.`);
  ensureTenantModules(db, tenantId);
  db.prepare(
    `UPDATE tenant_modules SET enabled = ?, updated_at = ${SQL_NOW} WHERE tenant_id = ? AND module = ?`,
  ).run(enabled ? 1 : 0, tenantId, name);
}

export function setConfig(db: Db, tenantId: number, name: string, input: unknown): ModuleConfig {
  const module = getModule(name);
  if (!module) throw new Error(`وحدة غير معروفة: ${name}`);
  const validated = module.validateConfig(input);
  ensureTenantModules(db, tenantId);
  db.prepare(
    `UPDATE tenant_modules SET config = ?, updated_at = ${SQL_NOW} WHERE tenant_id = ? AND module = ?`,
  ).run(JSON.stringify(validated), tenantId, name);
  return validated;
}

export function getConfig(db: Db, tenantId: number, name: string): ModuleConfig {
  const module = getModule(name);
  if (!module) throw new Error(`وحدة غير معروفة: ${name}`);
  const row = db
    .prepare('SELECT config FROM tenant_modules WHERE tenant_id = ? AND module = ?')
    .get(tenantId, name) as { config: string } | undefined;
  return parseConfig(module, row?.config ?? '{}');
}

/* ---------------------------------------------------------------
   التجميع — ما يراه النموذج
--------------------------------------------------------------- */

type ContextBase = Omit<ModuleContext, 'config'>;

/** أجزاء الـsystem prompt من الوحدات المفعّلة فقط، بلا فراغات زائدة. */
export function composePrompt(enabled: EnabledModule[], base: ContextBase): string {
  return enabled
    .map(({ module, config }) => module.systemPrompt({ ...base, config }).trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * اتحاد أدوات الوحدات المفعّلة.
 * تضارب الأسماء بين وحدتين خطأ برمجي لا خطأ تشغيل، فنسجّله ونُبقي الأولى
 * حسب ترتيب MODULES بدل أن نُسقط الرسالة على العميل.
 */
export function composeTools(enabled: EnabledModule[], base: ContextBase): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const { module, config } of enabled) {
    for (const tool of module.tools({ ...base, config })) {
      if (seen.has(tool.name)) {
        base.logger.warn('تضارب في اسم أداة بين وحدتين، أُهملت الثانية', {
          أداة: tool.name,
          وحدة: module.name,
        });
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}

/** يوجّه نداء الأداة لصاحبها — المحرّك لا يعرف أي وحدة تملك أي أداة. */
export async function dispatchTool(
  enabled: EnabledModule[],
  toolName: string,
  input: Record<string, unknown>,
  base: ContextBase,
): Promise<ToolResult> {
  for (const { module, config } of enabled) {
    const ctx: ModuleContext = { ...base, config };
    if (!module.tools(ctx).some((tool) => tool.name === toolName)) continue;
    try {
      return await module.runTool(toolName, input, ctx);
    } catch (error) {
      base.logger.error('فشل تنفيذ أداة', error, { أداة: toolName, وحدة: module.name });
      return { content: 'تعذّر تنفيذ العملية الآن. اعتذر للعميل واعرض تحويله لموظف.', isError: true };
    }
  }
  // النموذج نادى أداة غير مُفعّلة — يحدث بعد تعطيل وحدة أثناء محادثة جارية.
  base.logger.warn('نداء أداة غير متاحة لهذه المنشأة', { أداة: toolName });
  return { content: 'هذه الخدمة غير متاحة لدى المنشأة. لا تعِد بها واعرض بديلاً.', isError: true };
}

/* ---------------------------------------------------------------
   المهام الدورية
--------------------------------------------------------------- */

export function tickTargets(db: Db, tenants: TenantRow[]): { tenant: TenantRow; module: BotModule; config: ModuleConfig }[] {
  const targets: { tenant: TenantRow; module: BotModule; config: ModuleConfig }[] = [];
  for (const tenant of tenants) {
    for (const { module, config } of enabledFor(db, tenant.id)) {
      if (module.onTick) targets.push({ tenant, module, config });
    }
  }
  return targets;
}
