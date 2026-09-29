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
  latestCustomerMessageAt,
  DEFAULT_CHANNEL,
  silenceConversation,
  type TenantRow,
} from '../db/index.ts';
import { composePrompt, composeContext, composeTools, dispatchTool, enabledFor } from '../modules/registry.ts';
import { basePrompt, volatilePrompt, FALLBACK_REPLY, VOICE_DISABLED_REPLY } from './prompt.ts';
import { buildHistory } from './history.ts';
import { now, fromEpochSeconds } from '../time.ts';
import { recordGap } from '../training.ts';
import { claudeFor, recordUsage, recordCache } from '../tenant-claude.ts';
import type { Transcriber } from '../stt/index.ts';
import { storeMedia, isVisionImage, MAX_BYTES } from '../media.ts';
import { MEDIA_AR } from '../whatsapp/provider.ts';
import { readFileSync } from 'node:fs';
import { redact, restore, restoreDeep, mergeMaps } from '../redact.ts';

/** أكثر من هذا يعني أن النموذج يدور في حلقة، لا أنه يحتاج خطوة إضافية. */
const MAX_TOOL_ROUNDS = 5;

/** ألفاظ تدل على أن النموذج أعلن التحويل بنفسه. */
const HANDOFF_WORDS = /حوّل|حول|أحول|بحول|يتواصل|بيتواصل|راح يتواصل|للموظف|موظف مختص/;

/**
 * يدمج نص النموذج مع نص الأداة بلا تكرار المعنى.
 *
 * نص التحويل من الأداة ضمانة: العميل يجب أن يعلم أنه حُوّل مهما قال
 * النموذج. لكن حين يعلنها النموذج بنفسه («أبشر، بحوّلك لموظف») يصل
 * العميل جملتان تقولان الشيء نفسه فتبدوان آلية ركيكة.
 *
 * الترجيح مقصود: إن أخطأ الكشف فتُركت الجملتان، فالضرر ركاكة؛ ولو
 * أسقطنا الضمانة لفقد العميل معلومة أنه حُوّل أصلاً.
 */
export function joinWithoutRepeating(modelText: string, toolMessage: string): string {
  const text = modelText.trim();
  if (!text) return toolMessage;
  if (HANDOFF_WORDS.test(text)) return text;
  return `${text}\n\n${toolMessage}`;
}

export interface EngineOptions {
  app: App;
  /** العميل الافتراضي. المنشأة ذات المفتاح الخاص تُبنى لها نسخة تخصّها. */
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
    // القناة من الرسالة لا من المزوّد: مزوّد واحد قد يخدم أكثر من قناة.
    const channel = message.channel ?? DEFAULT_CHANNEL;
    const conversation = getOrCreateConversation(db, tenant.id, message.from, message.pushName, channel);
    const convLogger = logger.child({ conversation: conversation.id });

    /* --- تدخّل الموظف يدوياً: نسجّله ونصمت، ولا نرد --- */
    if (message.fromMe) {
      if (message.text) saveMessage(db, conversation.id, 'staff', message.text, { waMessageId: message.waMessageId });
      silenceConversation(db, conversation.id, config.silentMinutes);
      convLogger.info('ردّ الموظف يدوياً — البوت صامت مؤقتاً', { دقائق: config.silentMinutes });
      return;
    }

    /* --- ما أرسله العميل: نصاً كان أو ملفاً --- */
    let text = message.text?.trim() ?? '';
    const media = message.media;
    let stored: Awaited<ReturnType<typeof storeMedia>>;
    let visionImage: { mimeType: string; base64: string } | undefined;

    if (media) {
      // الموقع وجهة الاتصال يصلان نصاً جاهزاً بلا تحميل.
      if (media.text && !text) text = media.text;

      stored = await storeMedia(config.dbPath, tenant.id, media, convLogger);

      if (media.kind === 'audio' && !text) {
        if (!transcriber) {
          saveMessage(db, conversation.id, 'customer', '(رسالة صوتية)', {
            mediaType: 'audio',
            waMessageId: message.waMessageId,
            mediaPath: stored?.relativePath,
            mediaName: stored?.filename,
            mediaMime: stored?.mimeType,
            mediaBytes: stored?.bytes,
          });
          await send(tenant, conversation.id, message.from, VOICE_DISABLED_REPLY, convLogger);
          return;
        }
        try {
          const buffer = stored ? readFileSync(stored.path) : await media.download!();
          text = await transcriber.transcribe(buffer, media.mimeType);
          convLogger.info('حُوّلت رسالة صوتية لنص', { طول: text.length });
        } catch (error) {
          convLogger.error('فشل تحويل الرسالة الصوتية', error);
          saveMessage(db, conversation.id, 'customer', '(رسالة صوتية تعذّر تحويلها)', {
            mediaType: 'audio',
            mediaPath: stored?.relativePath,
          });
          await send(tenant, conversation.id, message.from, VOICE_DISABLED_REPLY, convLogger);
          return;
        }
      }

      // الصورة يراها النموذج فعلاً — صورة عطل أوضح من وصفه.
      if (stored && isVisionImage(stored.mimeType, stored.bytes)) {
        visionImage = { mimeType: stored.mimeType, base64: readFileSync(stored.path).toString('base64') };
      }
    }

    // ملف بلا نص: نصفه للنموذج ليعرف أن شيئاً وصل.
    if (!text && media) {
      text = visionImage
        ? '(أرسل صورة)'
        : `(أرسل ${MEDIA_AR[media.kind]}${media.filename ? `: ${media.filename}` : ''})`;
    }

    if (!text) return;

    /**
     * الرسالة المتأخرة: تُحفظ دائماً، ويُقرَّر الرد بعد حفظها.
     *
     * القرار يحتاج آخر رسالة سابقة، فيُقرأ قبل الحفظ لئلا تصير
     * الرسالة نفسها هي «الأحدث».
     */
    const newest = latestCustomerMessageAt(db, conversation.id);

    // تُحفظ الرسالة دائماً حتى لو كان البوت صامتاً — الأدمن يحتاج السياق كاملاً.
    saveMessage(db, conversation.id, 'customer', text, {
      mediaType: media?.kind ?? null,
      waMessageId: message.waMessageId,
      sentAt: message.sentAt,
      mediaPath: stored?.relativePath,
      mediaName: stored?.filename,
      mediaMime: stored?.mimeType,
      mediaBytes: stored?.bytes,
    });

    /**
     * رسالة قديمة تجاوزها الحديث: تُحفظ ولا يُردّ عليها.
     *
     * حدث فعلاً: رسالة كُتبت ٣:٤٦ سلّمتها Meta ٥:١١، فردّ عليها البوت
     * بعد ساعة ونصف وقد أُغلقت شكواها وانتهى موضوعها — فبدا وكأنه
     * يفتح الموضوع من جديد بلا سبب.
     *
     * ولا تُهمَل: الحفظ يبقى، فلا تضيع رسالة عميل أبداً. وإن كانت
     * الأحدث — كأن يكون الخادم قد هبط ثم عاد — رُدّ عليها، فالعميل
     * ينتظر ولا شيء تجاوزها.
     */
    if (message.sentAt && newest) {
      const sent = fromEpochSeconds(message.sentAt);
      if (sent < newest) {
        convLogger.warn('رسالة متأخرة التسليم تجاوزها الحديث — حُفظت بلا رد', {
          أُرسلت: sent,
          آخر_رسالة: newest,
        });
        return;
      }
    }

    if (!botMayReply(db, conversation.id)) {
      convLogger.debug('البوت موقوف أو صامت لهذه المحادثة — حُفظت الرسالة بلا رد');
      return;
    }

    /* --- تجميع ما تراه Claude لهذه المنشأة تحديداً --- */
    const nowSql = now();
    const fresh = getOrCreateConversation(db, tenant.id, message.from, undefined, channel);
    const base: Omit<ModuleContext, 'config'> = {
      db,
      tenant,
      conversation: fresh,
      provider,
      logger: convLogger,
      now: nowSql,
      notify: (kind, title, body) => notify(tenant.id, kind, title, body, fresh.id),
    };

    /**
     * عميل Claude: مفتاح المنشأة إن ملكت واحداً، وإلا العميل المُمرَّر.
     *
     * المُمرَّر هو الافتراضي ويمثّل المفتاح العام، ولا يُتجاوز إلا بمفتاح
     * خاص صريح — وإلا لضاع أي عميل يُحقَن (كما في الاختبارات).
     */
    const resolved = tenant.anthropic_api_key ? claudeFor(config, tenant, convLogger) : undefined;
    const model = resolved?.client ?? claude;
    if (resolved) convLogger.debug('استعمال مفتاح Claude الخاص بالمنشأة');

    const enabled = enabledFor(db, tenant.id);
    /**
     * الـprompt مقسوم قسمين لأجل التخزين المؤقت:
     *
     * الثابت — الشخصية والمعرفة والأدوات — يُخزَّن لدى Anthropic ويُقرأ
     * بعُشر السعر. والمتغيّر — الوقت وإشعار المرفق — بعد نقطة التخزين
     * فلا يُبطله تغيّره. الفصل يوفّر ~٨٠٪ من تكلفة الإدخال.
     */
    const system = [basePrompt(tenant), composePrompt(enabled, base)].filter(Boolean).join('\n\n');

    const systemVolatile = [
      volatilePrompt(nowSql),
      // حالة الشكاوى والطلبات الجارية لهذه المحادثة — متغيّرة، فمحلّها
      // هنا لا في الـprompt المخزَّن.
      composeContext(enabled, base),
      media && !visionImage
        ? `أرسل العميل ${MEDIA_AR[media.kind]}${media.filename ? ` باسم «${media.filename}»` : ''}. ` +
          'لا تستطيع فتحه، لكنه محفوظ ويراه الموظف في اللوحة. أقرّ باستلامه، ' +
          'واسأل العميل عمّا فيه إن احتجت، ولا تدّعِ أنك اطّلعت عليه.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const tools = composeTools(enabled, base);
    const messages: ChatMessage[] = buildHistory(db, conversation.id, config.historyLimit);

    /* --- الصورة تُمرَّر مع آخر رسالة ليراها النموذج --- */
    if (visionImage) {
      const last = messages[messages.length - 1];
      const blocks = [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: visionImage.mimeType, data: visionImage.base64 } },
        { type: 'text' as const, text: text || 'انظر للصورة وأجب عمّا فيها.' },
      ];
      if (last && last.role === 'user') last.content = blocks as never;
      else messages.push({ role: 'user', content: blocks as never });
      convLogger.info('مُرّرت صورة للنموذج', { نوع: visionImage.mimeType });
    }

    /**
     * الإخفاء قبل المغادرة.
     *
     * الخادم في جدة، والنموذج على خوادم خارجها. فكل ما يُرسل يمرّ من
     * هنا أولاً: الأرقام والهويات والآيبان تُستبدل برموز، والأصل يبقى
     * في قاعدة البيانات كاملاً.
     *
     * على كامل السياق لا على آخر رسالة: رقم ذُكر قبل عشر رسائل يُعاد
     * إرساله مع كل نداء، فإخفاء الأخيرة وحدها إخفاء لا معنى له.
     */
    const redactions: Map<string, string>[] = [];
    if (config.redactPii) {
      for (const entry of messages) {
        if (typeof entry.content !== 'string') continue;
        const { text: masked, map } = redact(entry.content);
        if (map.size === 0) continue;
        entry.content = masked;
        redactions.push(map);
      }
    }
    const pii = mergeMaps(redactions);

    convLogger.debug('تجميع السياق', {
      وحدات: enabled.map((e) => e.module.name).join(','),
      أدوات: tools.length,
      رسائل: messages.length,
      مخفية: pii.size,
    });

    /* --- حلقة الأدوات --- */
    let reply = '';
    let silenceAfter = 0;

    try {
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        const result = await model.chat({ system, systemVolatile, messages, tools });

        if (result.cache) {
          convLogger.debug('التخزين المؤقت', {
            مقروء: result.cache.read,
            مكتوب: result.cache.created,
            بلا_تخزين: result.cache.uncached,
          });
          recordCache(db, tenant.id, result.cache);
        }

        if (result.toolCalls.length === 0) {
          reply = result.text;
          break;
        }

        messages.push({ role: 'assistant', content: result.raw });
        const toolResults: ContentBlock[] = [];
        let stopMessage: string | null = null;

        recordUsage(db, tenant.id, 'tool_calls', result.toolCalls.length);

        for (const call of result.toolCalls) {
          convLogger.info('نداء أداة', { أداة: call.name });
          // الأصل يعود قبل الحفظ: النموذج يطلب تسجيل طلب برمز، فتُسجّل
          // الشركة الرقم الحقيقي. هنا تحصل المنشأة على بياناتها كاملة
          // دون أن يكون النموذج قد رآها.
          const input = restoreDeep(call.input, pii) as Record<string, unknown>;
          const outcome = await dispatchTool(enabled, call.name, input, base);

          /* --- التحويل للموظف يكشف ثغرة في المعرفة: نسجّل السؤال --- */
          if (call.name === 'handoff_to_human') {
            const reason = typeof input.reason === 'string' ? input.reason : '';
            recordGap(db, {
              tenantId: tenant.id,
              conversationId: conversation.id,
              question: text,
              reason,
            });
            convLogger.info('سُجّلت ثغرة معرفة', { سؤال: text.slice(0, 60) });
          }
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
          reply = joinWithoutRepeating(result.text, stopMessage);
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
      recordUsage(db, tenant.id, 'failures');
      await notify(
        tenant.id,
        'handoff',
        'تعذّر رد البوت على عميل',
        `الرقم: ${message.from}\nآخر رسالة: ${text}`,
        conversation.id,
      );

      // الصمت خيار مقصود: حين يكون العطل عاماً، رسالة اعتذار لكل عميل
      // أسوأ من لا شيء — تُتلف الانطباع وتضرّ تقييم الرقم. الموظف مُنبَّه.
      if (config.silentOnFailure) {
        convLogger.warn('صمت عند الفشل — أُبلغ الموظف ولم يُرسل للعميل شيء');
        silenceConversation(db, conversation.id, config.silentMinutes);
        return;
      }

      reply = FALLBACK_REPLY;
      silenceAfter = Math.max(silenceAfter, config.silentMinutes);
    }

    if (!reply.trim()) {
      if (config.silentOnFailure) {
        convLogger.warn('النموذج لم يُنتج رداً — صمت بدل اعتذار');
        return;
      }
      reply = FALLBACK_REPLY;
    }

    /**
     * الرد يعود لأصله قبل أن يراه العميل.
     *
     * النموذج يردّد ما أعطيناه: «سجّلنا طلبك على ﴿جوال-1﴾». بلا هذا
     * السطر يصل العميل رمزٌ داخلي فيبدو النظام معطوباً — وهو أثر
     * يظهر عند العميل لا عندنا، فلا نراه إلا منه.
     */
    reply = restore(reply, pii);

    recordUsage(db, tenant.id, 'replies');
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
