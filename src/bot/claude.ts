/**
 * غلاف Anthropic SDK.
 *
 * كل ما يخص النموذج يمرّ من هنا: إعادة المحاولة، والحدود، واستبداله في
 * الاختبارات. بقية المشروع لا تستورد @anthropic-ai/sdk إطلاقاً.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from '../modules/types.ts';
import type { Logger } from '../logger.ts';
import { withRetry } from '../whatsapp/provider.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ModelReply {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: string | null;
  raw: ContentBlock[];
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
}

/** الواجهة التي يعتمد عليها المحرّك — تُستبدل بـmock في الاختبارات. */
export interface ClaudeClient {
  chat(request: ChatRequest): Promise<ModelReply>;
}

/** أخطاء تستحق إعادة المحاولة: حدّ المعدّل وأعطال الخادم والانقطاع الشبكي. */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const code = (error as { code?: string })?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND';
}

export function createClaudeClient(apiKey: string, model: string, logger: Logger): ClaudeClient {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY غير معرّف — البوت لا يستطيع الرد بدونه.');
  const anthropic = new Anthropic({ apiKey });

  return {
    async chat({ system, messages, tools, maxTokens = 1024 }) {
      const response = await withRetry(
        async () => {
          try {
            return await anthropic.messages.create({
              model,
              max_tokens: maxTokens,
              system,
              messages: messages as Anthropic.MessageParam[],
              ...(tools.length ? { tools: tools as Anthropic.Tool[] } : {}),
            });
          } catch (error) {
            // خطأ في الطلب نفسه (٤٠٠) لا يُصلحه التكرار — نرميه فوراً.
            if (!isRetryable(error)) throw Object.assign(new Error(String(error)), { noRetry: true, cause: error });
            throw error;
          }
        },
        {
          attempts: 3,
          baseDelayMs: 800,
          onRetry: (attempt, error) =>
            logger.warn('فشل نداء Claude، إعادة المحاولة', { محاولة: attempt, سبب: String(error) }),
        },
      );

      const blocks = response.content as unknown as ContentBlock[];
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const toolCalls = blocks
        .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
        )
        .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));

      return { text, toolCalls, stopReason: response.stop_reason ?? null, raw: blocks };
    },
  };
}
