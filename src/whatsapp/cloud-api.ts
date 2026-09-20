/**
 * مزوّد WhatsApp Cloud API الرسمي — للإنتاج.
 *
 * الفرق الجوهري عن Baileys: لا جلسة ولا QR. Meta تُرسل الرسائل إلى webhook
 * واحد لكل المنشآت، والتوجيه يتم بـ phone_number_id في جسم الطلب. لذلك
 * المزوّد هنا لا «يتصل» بشيء؛ هو يستقبل ويُرسل عبر Graph API.
 *
 * أمنياً: كل طلب يُتحقق من توقيعه بـHMAC-SHA256 على الجسم الخام. بلا هذا
 * يستطيع أي أحد يعرف عنوانك أن يحقن رسائل باسم عملائك.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import { findTenantByPhoneNumberId, normalizeNumber, type Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import type {
  IncomingMessage,
  MessageHandler,
  ProviderStatus,
  SendResult,
  WhatsAppProvider,
} from './provider.ts';
import { withRetry, markNoRetry } from './provider.ts';

/* ---------------------------------------------------------------
   شكل حمولة Meta — نُصرّح ما نستعمله فقط
--------------------------------------------------------------- */

interface CloudMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  image?: { caption?: string };
}

interface CloudValue {
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: CloudMessage[];
  statuses?: unknown[];
}

interface CloudPayload {
  object?: string;
  entry?: { changes?: { field?: string; value?: CloudValue }[] }[];
}

export class CloudApiProvider implements WhatsAppProvider {
  readonly name = 'cloud';

  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private handler: MessageHandler | null = null;

  constructor(db: Db, config: AppConfig, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.logger.info('مزوّد Cloud API جاهز — بانتظار الرسائل على /webhook/whatsapp');
  }

  async stop(): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  status(): ProviderStatus {
    return {
      provider: this.name,
      connected: true,
      detail: 'Cloud API — الاتصال عبر webhook ولا يحتاج QR',
    };
  }

  /* ---------------------------------------------------------------
     الإرسال
  --------------------------------------------------------------- */

  async sendText(tenantId: number, to: string, text: string): Promise<SendResult> {
    const row = this.db
      .prepare('SELECT wa_phone_number_id FROM tenants WHERE id = ?')
      .get(tenantId) as { wa_phone_number_id: string | null } | undefined;

    if (!row?.wa_phone_number_id) {
      throw new Error(`المنشأة ${tenantId} بلا wa_phone_number_id — لا يمكن الإرسال عبر Cloud API.`);
    }

    const url = `https://graph.facebook.com/${this.config.cloud.graphVersion}/${row.wa_phone_number_id}/messages`;

    const data = await withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.cloud.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalizeNumber(to),
            type: 'text',
            text: { preview_url: false, body: text },
          }),
        });

        const body = await response.text();
        if (!response.ok) {
          // ٤xx غير 429 خطأ في الطلب نفسه؛ تكراره يستهلك حدّ المعدّل بلا فائدة.
          const retryable = response.status === 429 || response.status >= 500;
          const error = new Error(`فشل الإرسال (${response.status}): ${body}`);
          throw retryable ? error : markNoRetry(error);
        }
        return JSON.parse(body) as { messages?: { id?: string }[] };
      },
      {
        attempts: 3,
        baseDelayMs: 700,
        onRetry: (attempt, error) =>
          this.logger.warn('فشل إرسال عبر Cloud API، إعادة المحاولة', {
            tenant: tenantId,
            محاولة: attempt,
            سبب: String(error),
          }),
      },
    );

    return { id: data.messages?.[0]?.id ?? '' };
  }

  /* ---------------------------------------------------------------
     التحقق من التوقيع
  --------------------------------------------------------------- */

  /** HMAC-SHA256 على الجسم الخام كما وصل — أي إعادة تسلسل تُفسد التوقيع. */
  verifySignature(rawBody: Buffer | string, header: string | undefined): boolean {
    if (!header?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', this.config.cloud.appSecret)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
      .digest('hex');
    const received = header.slice('sha256='.length);
    if (received.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'));
  }

  /* ---------------------------------------------------------------
     استقبال الحمولة
  --------------------------------------------------------------- */

  /** يُطبّع حمولة Meta ويمرّر كل رسالة للمحرّك. يُصدَّر للاختبار. */
  async handlePayload(payload: CloudPayload): Promise<number> {
    if (!this.handler) return 0;
    let handled = 0;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        // تحديثات الحالة (تم التسليم/القراءة) ليست رسائل.
        if (!value.messages?.length) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const displayNumber = value.metadata?.display_phone_number ?? '';
        const pushName = value.contacts?.[0]?.profile?.name;

        for (const message of value.messages) {
          if (!message.from) continue;

          const incoming: IncomingMessage = {
            toNumber: normalizeNumber(displayNumber),
            toPhoneNumberId: phoneNumberId,
            from: normalizeNumber(message.from),
            pushName,
            waMessageId: message.id,
            text: message.text?.body ?? message.image?.caption,
          };

          if (message.type === 'audio' && message.audio?.id) {
            const mediaId = message.audio.id;
            incoming.audio = {
              mimeType: message.audio.mime_type ?? 'audio/ogg',
              download: () => this.downloadMedia(mediaId),
            };
          }

          if (!incoming.text && !incoming.audio) continue;

          try {
            await this.handler(incoming);
            handled += 1;
          } catch (error) {
            this.logger.error('فشل معالجة رسالة واردة من Cloud API', error, { من: incoming.from });
          }
        }
      }
    }
    return handled;
  }

  /** تحميل الوسائط خطوتان في Cloud API: طلب الرابط ثم تنزيله بنفس التوكن. */
  private async downloadMedia(mediaId: string): Promise<Buffer> {
    const token = this.config.cloud.accessToken;
    const metaResponse = await fetch(
      `https://graph.facebook.com/${this.config.cloud.graphVersion}/${mediaId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!metaResponse.ok) throw new Error(`تعذّر جلب رابط الوسائط (${metaResponse.status}).`);

    const { url } = (await metaResponse.json()) as { url?: string };
    if (!url) throw new Error('استجابة الوسائط بلا رابط.');

    const fileResponse = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!fileResponse.ok) throw new Error(`تعذّر تنزيل الوسائط (${fileResponse.status}).`);
    return Buffer.from(await fileResponse.arrayBuffer());
  }

  /** يعرف إن كانت هذه الحمولة لمنشأة مسجّلة — للتشخيص من صفحة الأدمن. */
  knowsPhoneNumberId(phoneNumberId: string): boolean {
    return findTenantByPhoneNumberId(this.db, phoneNumberId) !== undefined;
  }
}

/* ---------------------------------------------------------------
   مسارات الـwebhook
--------------------------------------------------------------- */

export function registerCloudWebhook(app: FastifyInstance, provider: CloudApiProvider, config: AppConfig, logger: Logger): void {
  // نحتفظ بالجسم الخام: التوقيع يُحسب عليه لا على JSON مُعاد تسلسله.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  /** تحقق Meta من ملكية الـwebhook عند الربط. */
  app.get('/webhook/whatsapp', async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === config.cloud.verifyToken) {
      logger.info('نجح تحقق webhook من Meta');
      return reply.code(200).type('text/plain').send(query['hub.challenge'] ?? '');
    }
    logger.warn('فشل تحقق webhook — رمز تحقق خاطئ');
    return reply.code(403).send('forbidden');
  });

  app.post('/webhook/whatsapp', async (request, reply) => {
    const raw = (request as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
    const signature = request.headers['x-hub-signature-256'];

    if (!provider.verifySignature(raw, typeof signature === 'string' ? signature : undefined)) {
      logger.warn('حمولة webhook بتوقيع غير صالح — رُفضت');
      return reply.code(401).send({ error: 'توقيع غير صالح.' });
    }

    // نردّ 200 فوراً: Meta تعيد الإرسال إن تأخّرنا، فيُعالَج العميل مرتين.
    void provider
      .handlePayload(request.body as never)
      .catch((error) => logger.error('فشل معالجة حمولة webhook', error));

    return reply.code(200).send({ ok: true });
  });
}
