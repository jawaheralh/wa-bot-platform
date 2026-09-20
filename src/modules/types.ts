/**
 * عقد الوحدة.
 *
 * هذا الملف هو الحدّ الفاصل بين محرّك البوت والوظائف. المحرّك لا يعرف أن
 * «الشكاوى» أو «الحجوزات» موجودة؛ هو يطلب من السجل أدوات المنشأة وprompt‑ها
 * وينفّذ. لذلك إضافة وحدة جديدة = ملف يحقّق BotModule + سطر في registry.ts،
 * بلا أي تعديل في engine.ts ولا في قاعدة البيانات ولا في صفحة الأدمن.
 */

import type { FastifyInstance } from 'fastify';
import type { Db, TenantRow, ConversationRow } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import type { AppConfig } from '../config.ts';
import type { WhatsAppProvider } from '../whatsapp/provider.ts';

/** إعدادات الوحدة لمنشأة معيّنة — تُخزَّن JSON في tenant_modules.config. */
export type ModuleConfig = Record<string, unknown>;

/** تعريف أداة بصيغة Anthropic tool use. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** نتيجة تنفيذ أداة: نص يعود للنموذج + آثار جانبية اختيارية على المحادثة. */
export interface ToolResult {
  /** ما يراه النموذج كنتيجة — بالعربي، فالنموذج يردّ بالعربي. */
  content: string;
  isError?: boolean;
  /** يوقف حلقة الأدوات ويُرسل هذا النص للعميل مباشرة (يستخدمه التحويل للموظف). */
  stopWithMessage?: string;
  /** يُسكت البوت لهذا العدد من الدقائق بعد انتهاء الدورة. */
  silenceMinutes?: number;
}

/** كل ما تحتاجه الوحدة أثناء خدمة رسالة واحدة. */
export interface ModuleContext {
  db: Db;
  tenant: TenantRow;
  conversation: ConversationRow;
  /** إعدادات هذه الوحدة لهذه المنشأة، بعد دمجها مع الافتراضي. */
  config: ModuleConfig;
  provider: WhatsAppProvider;
  logger: Logger;
  /** الوقت الحالي بتوقيت الرياض بصيغة SQLite — يُمرَّر ليمكن تثبيته في الاختبارات. */
  now: string;
  /** تنبيه الموظف: يكتب في alerts ويرسل واتساب لرقم المنشأة إن وُجد. */
  notify(kind: string, title: string, body?: string): Promise<void>;
}

/** ما تحتاجه مسارات الأدمن والمهام الدورية (خارج سياق رسالة بعينها). */
export interface ModuleDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  provider: WhatsAppProvider;
  notify(tenantId: number, kind: string, title: string, body?: string, conversationId?: number): Promise<void>;
}

export interface BotModule {
  /** المعرّف المخزَّن في tenant_modules.module — لا يتغير بعد الإطلاق. */
  name: string;
  titleAr: string;
  /** يظهر لأدمن المنشأة حين تكون الوحدة معطّلة، فاكتبه كعبارة بيع مختصرة. */
  descriptionAr: string;
  /** أساسية: تُفعَّل تلقائياً لكل منشأة جديدة ولا يستطيع أحد تعطيلها. */
  core: boolean;

  /** جمل CREATE TABLE IF NOT EXISTS — تُنفَّذ عند الإقلاع حتى لو كانت الوحدة معطّلة. */
  tables: string[];

  defaultConfig(): ModuleConfig;
  /** يتحقق مما يرسله الأدمن ويرمي Error برسالة عربية عند الخطأ. */
  validateConfig(input: unknown): ModuleConfig;

  /** جزء الـsystem prompt الخاص بالوحدة — يُضاف فقط إن كانت مفعّلة. */
  systemPrompt(ctx: ModuleContext): string;
  /** الأدوات التي تراها Claude — القائمة قد تعتمد على الإعدادات. */
  tools(ctx: ModuleContext): ToolDefinition[];
  runTool(name: string, input: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult>;

  /** مسارات API إضافية لصفحة الأدمن، تُركَّب تحت /api/tenants/:tenantId/modules/<name>. */
  routes?(app: FastifyInstance, deps: ModuleDeps): void;
  /** مهمة دورية (تذكيرات المواعيد مثلاً) — تُنادى للمنشآت المفعِّلة فقط. */
  onTick?(tenant: TenantRow, config: ModuleConfig, deps: ModuleDeps): Promise<void>;
}

/** يقرأ حقلاً نصياً من مدخلات أداة بلا ثقة في النموذج. */
export function readString(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

export function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = input[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(input[key]);
  return Number.isFinite(value) ? value : fallback;
}
