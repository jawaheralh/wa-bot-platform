/**
 * محرّك البوت.
 *
 * انتبه: لا يُذكر في هذا الملف اسم أي وحدة. هو يستقبل رسالة، ويسأل السجل
 * «ما الأدوات والتعليمات المتاحة لهذه المنشأة؟»، ثم يدير حلقة الأدوات.
 * هذا هو ما يجعل إضافة وحدة جديدة لا تتطلب لمس أي كود قائم.
 */

import type { App } from '../app.ts';
import type { IncomingMessage } from '../whatsapp/provider.ts';
import type { ClaudeClient, ChatMessage, ContentBlock } from './claude.ts';
import type { ModuleContext } from '../modules/types.ts';
import {
  findTenantByNumber,
  findTenantByPhoneNumberId,
  getOrCreateConversation,
  saveMessage,
  botMayReply,
  silenceConversation,
  type TenantRow,
} from '../db/index.ts';
import { composePrompt, composeTools, dispatchTool, enabledFor } from '../modules/registry.ts';
import { basePrompt, FALLBACK_REPLY, VOICE_DISABLED_REPLY } from './prompt.ts';
import { buildHistory } from './history.ts';
import { now } from '../time.ts';
import type { Transcriber } from '../stt/index.ts';

/** أكثر من هذا يعني أن النموذج يدور في حلقة، لا أنه يحتاج خطوة إضافية. */
const MAX_TOOL_ROUNDS = 5;

export interface EngineOptions {
  app: App;
  claude: ClaudeClient;
  transcriber?: Transcriber;
}

export type Engine = (message: IncomingMessage) => Promise<void>;

export function createEngine({ app, claude, transcriber }: EngineOptions): Engine {
  const { db, config, provider, notify } = app;

  function resolveTenant(message: IncomingMessage): TenantRow | undefined {
    if (message.toPhoneNumberId) {
      const byId = findTenantByPhoneNumberId(db, message.toPhoneNumberId);
      if (byId) return byId;
    }
    return findTenantByNumber(db, message.toNumber);
  }

  return async function handle(message: IncomingMessage): Promise<void> {
    const tenant = resolveTenant(message);
    if (!tenant) {
      app.logger.warn('رسالة لرقم غير مسجَّل لأي منشأة', { إلى: message.toNumber });
      return;
    }

    const logger = app.logger.child({ tenant: tenant.id, منشأة: tenant.name });
    const conversation = getOrCreateConversation(db, tenant.id, message.from, message.pushName);
    const convLogger = logger.child({ conversation: conversation.id });

    /* --- تدخّل الموظف يدوياً: نسجّله ونصمت، ولا نرد --- */
    if (message.fromMe) {
      if (message.text) saveMessage(db, conversation.id, 'staff', message.text, { waMessageId: message.waMessageId });
      silenceConversation(db, conversation.id, config.silentMinutes);
      convLogger.info('ردّ الموظف يدوياً — البوت صامت مؤقتاً', { دقائق: config.silentMinutes });
      return;
    }

    /* --- تحويل الصوت لنص --- */
    let text = message.text?.trim() ?? '';
    let mediaType: string | null = null;

    if (!text && message.audio) {
      mediaType = 'audio';
      if (!transcriber) {
        saveMessage(db, conversation.id, 'customer', '(رسالة صوتية)', {
          mediaType,
          waMessageId: message.waMessageId,
        });
        await send(tenant, conversation.id, message.from, VOICE_DISABLED_REPLY, convLogger);
        return;
      }
      try {
        text = await transcriber.transcribe(await message.audio.download(), message.audio.mimeType);
        convLogger.info('حُوّلت رسالة صوتية لنص', { طول: text.length });
      } catch (error) {
        convLogger.error('فشل تحويل الرسالة الصوتية', error);
        saveMessage(db, conversation.id, 'customer', '(رسالة صوتية تعذّر تحويلها)', { mediaType });
        await send(tenant, conversation.id, message.from, VOICE_DISABLED_REPLY, convLogger);
        return;
      }
    }

    if (!text) return;

    // تُحفظ الرسالة دائماً حتى لو كان البوت صامتاً — الأدمن يحتاج السياق كاملاً.
    saveMessage(db, conversation.id, 'customer', text, { mediaType, waMessageId: message.waMessageId });

    if (!botMayReply(db, conversation.id)) {
      convLogger.debug('البوت موقوف أو صامت لهذه المحادثة — حُفظت الرسالة بلا رد');
      return;
    }

    /* --- تجميع ما تراه Claude لهذه المنشأة تحديداً --- */
    const nowSql = now();
    const fresh = getOrCreateConversation(db, tenant.id, message.from);
    const base: Omit<ModuleContext, 'config'> = {
      db,
      tenant,
      conversation: fresh,
      provider,
      logger: convLogger,
      now: nowSql,
      notify: (kind, title, body) => notify(tenant.id, kind, title, body, fresh.id),
    };

    const enabled = enabledFor(db, tenant.id);
    const system = [basePrompt(tenant, nowSql), composePrompt(enabled, base)].filter(Boolean).join('\n\n');
    const tools = composeTools(enabled, base);
    const messages: ChatMessage[] = buildHistory(db, conversation.id, config.historyLimit);

    convLogger.debug('تجميع السياق', {
      وحدات: enabled.map((e) => e.module.name).join(','),
      أدوات: tools.length,
      رسائل: messages.length,
    });

    /* --- حلقة الأدوات --- */
    let reply = '';
    let silenceAfter = 0;

    try {
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        const result = await claude.chat({ system, messages, tools });

        if (result.toolCalls.length === 0) {
          reply = result.text;
          break;
        }

        messages.push({ role: 'assistant', content: result.raw });
        const toolResults: ContentBlock[] = [];
        let stopMessage: string | null = null;

        for (const call of result.toolCalls) {
          convLogger.info('نداء أداة', { أداة: call.name });
          const outcome = await dispatchTool(enabled, call.name, call.input, base);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          });
          if (outcome.silenceMinutes) silenceAfter = Math.max(silenceAfter, outcome.silenceMinutes);
          if (outcome.stopWithMessage) stopMessage = outcome.stopWithMessage;
        }

        if (stopMessage) {
          // أداة طلبت إنهاء الدورة بنص محدد (التحويل للموظف) — لا نعيد سؤال النموذج.
          reply = [result.text, stopMessage].filter(Boolean).join('\n\n');
          break;
        }

        messages.push({ role: 'user', content: toolResults });

        if (round === MAX_TOOL_ROUNDS) {
          convLogger.warn('بلغت حلقة الأدوات حدّها الأقصى');
          reply = result.text || FALLBACK_REPLY;
        }
      }
    } catch (error) {
      convLogger.error('فشل توليد الرد', error);
      await notify(
        tenant.id,
        'handoff',
        'تعذّر رد البوت على عميل',
        `الرقم: ${message.from}\nآخر رسالة: ${text}`,
        conversation.id,
      );
      reply = FALLBACK_REPLY;
      silenceAfter = Math.max(silenceAfter, config.silentMinutes);
    }

    if (!reply.trim()) reply = FALLBACK_REPLY;

    await send(tenant, conversation.id, message.from, reply, convLogger);
    if (silenceAfter > 0) silenceConversation(db, conversation.id, silenceAfter);
  };

  async function send(
    tenant: TenantRow,
    conversationId: number,
    to: string,
    text: string,
    logger: App['logger'],
  ): Promise<void> {
    try {
      const sent = await provider.sendText(tenant.id, to, text);
      saveMessage(db, conversationId, 'bot', text, { waMessageId: sent.id });
    } catch (error) {
      // الرد لم يصل للعميل. نحفظه ليظهر في لوحة الأدمن وننبّه الموظف.
      logger.error('تعذّر إرسال رد البوت بعد كل المحاولات', error);
      saveMessage(db, conversationId, 'bot', text);
      await notify(tenant.id, 'handoff', 'تعذّر إرسال رد لعميل', `الرقم: ${to}`, conversationId);
    }
  }
}
