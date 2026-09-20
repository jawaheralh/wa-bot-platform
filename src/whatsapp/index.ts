/**
 * مصنع المزوّد.
 *
 * نقطة الاختيار الوحيدة في المشروع: بعدها لا يعرف أي ملف آخر أي مزوّد يعمل.
 */

import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../logger.ts';
import type { WhatsAppProvider } from './provider.ts';
import { SimulatorProvider } from './simulator.ts';

export async function createProvider(config: AppConfig, db: Db, logger: Logger): Promise<WhatsAppProvider> {
  switch (config.provider) {
    case 'baileys': {
      // استيراد كسول: Baileys ثقيل ولا داعي لتحميله في المحاكي أو الاختبارات.
      const { BaileysProvider } = await import('./baileys.ts');
      return new BaileysProvider(db, config.baileys.authDir, logger.child({ مزوّد: 'baileys' }));
    }
    case 'cloud': {
      const { CloudApiProvider } = await import('./cloud-api.ts');
      return new CloudApiProvider(db, config, logger.child({ مزوّد: 'cloud' }));
    }
    case 'simulator':
      return new SimulatorProvider();
  }
}

export { SimulatorProvider };
export type { WhatsAppProvider };
