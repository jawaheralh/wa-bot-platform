/**
 * تنبيه الموظف.
 *
 * مسارَان معاً عن قصد: صف في alerts يظهر في صفحة الأدمن (لا يضيع)، ورسالة
 * واتساب لرقم الموظف (تصل فوراً). فشل الواتساب لا يجوز أن يُلغي التنبيه
 * المحفوظ، ولا أن يُسقط معالجة رسالة العميل.
 */

import { createAlert, getTenant, type Db } from './db/index.ts';
import type { Logger } from './logger.ts';
import type { WhatsAppProvider } from './whatsapp/provider.ts';

export type Notifier = (
  tenantId: number,
  kind: string,
  title: string,
  body?: string,
  conversationId?: number,
) => Promise<void>;

export function createNotifier(db: Db, provider: WhatsAppProvider, logger: Logger): Notifier {
  return async (tenantId, kind, title, body = '', conversationId) => {
    createAlert(db, tenantId, kind, title, body, conversationId);

    const tenant = getTenant(db, tenantId);
    const staff = tenant?.staff_wa_number;
    if (!staff) {
      logger.debug('تنبيه محفوظ بلا إرسال — لا يوجد رقم موظف للمنشأة', { tenant: tenantId, نوع: kind });
      return;
    }

    const lines = [`🔔 ${title}`, body].filter(Boolean);
    try {
      await provider.sendText(tenantId, staff, lines.join('\n\n'));
    } catch (error) {
      logger.error('تعذّر إرسال تنبيه الموظف عبر واتساب — التنبيه محفوظ في لوحة الأدمن', error, {
        tenant: tenantId,
        نوع: kind,
      });
    }
  };
}
