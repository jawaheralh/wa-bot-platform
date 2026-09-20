/**
 * المحاكي.
 *
 * ليس mock للاختبارات فقط: هو مزوّد كامل يشغّل **نفس** محرّك البوت بالضبط،
 * فما تجرّبه هنا هو ما سيحدث على واتساب الحقيقي. يُستعمل في التطوير، وفي
 * سكربت sim، وفي شاشة التجربة داخل صفحة الأدمن.
 */

import type { IncomingMessage, MessageHandler, ProviderStatus, SendResult, WhatsAppProvider } from './provider.ts';

export interface SentMessage {
  tenantId: number;
  to: string;
  text: string;
  at: Date;
}

export class SimulatorProvider implements WhatsAppProvider {
  readonly name = 'simulator';
  private handler: MessageHandler | null = null;
  /** كل ما «أُرسل» — يقرأه سكربت sim والاختبارات وشاشة التجربة. */
  readonly outbox: SentMessage[] = [];
  private counter = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendText(tenantId: number, to: string, text: string): Promise<SendResult> {
    this.counter += 1;
    this.outbox.push({ tenantId, to, text, at: new Date() });
    return { id: `sim-${this.counter}` };
  }

  status(): ProviderStatus {
    return { provider: this.name, connected: true, detail: 'محاكي — لا اتصال فعلي بواتساب' };
  }

  /** يحقن رسالة واردة كأنها جاءت من واتساب. */
  async receive(message: Omit<IncomingMessage, 'waMessageId'> & { waMessageId?: string }): Promise<void> {
    if (!this.handler) throw new Error('المحاكي لم يُربط بمحرّك البوت بعد.');
    this.counter += 1;
    await this.handler({ waMessageId: `sim-in-${this.counter}`, ...message });
  }

  /** الردود التي أُرسلت لرقم معيّن منذ آخر استدعاء. */
  drain(to?: string): SentMessage[] {
    const taken = to ? this.outbox.filter((m) => m.to === to) : [...this.outbox];
    this.outbox.length = 0;
    return taken;
  }
}
