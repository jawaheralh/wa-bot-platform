/**
 * مزوّد WhatsApp Cloud API الرسمي — يُستكمل في المرحلة الخامسة.
 */

import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import type { MessageHandler, ProviderStatus, SendResult, WhatsAppProvider } from './provider.ts';

export class CloudApiProvider implements WhatsAppProvider {
  readonly name = 'cloud';

  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(db: Db, config: AppConfig, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger;
  }

  async start(): Promise<void> {
    throw new Error('مزوّد Cloud API لم يُستكمل بعد.');
  }
  async stop(): Promise<void> {}
  onMessage(_handler: MessageHandler): void {}
  async sendText(_tenantId: number, _to: string, _text: string): Promise<SendResult> {
    throw new Error('مزوّد Cloud API لم يُستكمل بعد.');
  }
  status(): ProviderStatus {
    return { provider: this.name, connected: false, detail: 'لم يُستكمل بعد' };
  }
}
