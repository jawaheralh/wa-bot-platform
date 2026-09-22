/**
 * غلاف «عرض فقط».
 *
 * يلفّ أي مزوّد فيستقبل كل شيء ولا يُرسل شيئاً: لا رد بوت، ولا رد موظف،
 * ولا تنبيه واتساب، ولا تذكير موعد.
 *
 * المنع في هذه الطبقة عن قصد — لا في المحرّك ولا في الوحدات. أي مسار
 * إرسال جديد يُكتب مستقبلاً يمر من هنا حتماً، فلا يستطيع أحد أن ينسى
 * احترام الوضع. لو وُضع الشرط في المحرّك لتسرّبت الرسائل من الوحدات.
 */

import type {
  IncomingMessage,
  MessageHandler,
  ProviderStatus,
  SendResult,
  WhatsAppProvider,
} from './provider.ts';
import type { Logger } from '../logger.ts';

export interface BlockedMessage {
  tenantId: number;
  to: string;
  text: string;
  at: Date;
}

export class ReadOnlyProvider implements WhatsAppProvider {
  private readonly inner: WhatsAppProvider;
  private readonly logger: Logger;
  /** ما كان سيُرسل — يظهر في اللوحة فتعرفين ماذا كان البوت سيقول. */
  readonly blocked: BlockedMessage[] = [];
  private counter = 0;

  constructor(inner: WhatsAppProvider, logger: Logger) {
    this.inner = inner;
    this.logger = logger;
  }

  get name(): string {
    return `${this.inner.name} (عرض فقط)`;
  }

  async start(): Promise<void> {
    this.logger.warn('وضع «عرض فقط» مُفعَّل — تُستقبل الرسائل وتُحفظ، ولا يُرسل شيء إطلاقاً.');
    await this.inner.start();
  }

  async stop(): Promise<void> {
    await this.inner.stop();
  }

  onMessage(handler: MessageHandler): void {
    this.inner.onMessage(handler);
  }

  async refreshTenant(tenantId: number): Promise<void> {
    await this.inner.refreshTenant?.(tenantId);
  }

  async sendText(tenantId: number, to: string, text: string): Promise<SendResult> {
    this.counter += 1;
    this.blocked.push({ tenantId, to, text, at: new Date() });
    if (this.blocked.length > 500) this.blocked.shift();

    this.logger.info('حُجبت رسالة صادرة (وضع عرض فقط)', {
      tenant: tenantId,
      إلى: to,
      نص: text.slice(0, 80),
    });

    // نُعيد نجاحاً وهمياً: الهدف أن يعمل بقية النظام طبيعياً (تُحفظ الرسالة
    // في السجل ويُرى ما كان سيُرسل) بلا أن يُسجَّل فشل ويُنبَّه الموظف عبثاً.
    return { id: `readonly-${this.counter}` };
  }

  status(tenantId: number): ProviderStatus {
    const inner = this.inner.status(tenantId);
    return { ...inner, provider: this.name, detail: `عرض فقط — ${inner.detail ?? ''}`.trim() };
  }
}

export type { IncomingMessage };
