/**
 * تنبيه الموظف.
 *
 * مساران معاً عن قصد: صف في alerts يظهر في صفحة الأدمن (لا يضيع)، ورسالة
 * واتساب لمن يعنيه الأمر (تصل فوراً). فشل الواتساب لا يجوز أن يُلغي التنبيه
 * المحفوظ، ولا أن يُسقط معالجة رسالة العميل.
 *
 * مَن يُنبَّه: صاحب المحادثة إن كانت مُسندة، وإلا كل الفريق. توجيه التنبيه
 * للمسؤول وحده يمنع تحوّله لضجيج يتجاهله الجميع لأن كلاً منهم يفترض أن
 * الآخر يتابع.
 */

import { createAlert, getConversation, type Db } from './db/index.ts';
import { alertNumbers } from './staff.ts';
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

    const assignedTo = conversationId ? getConversation(db, conversationId)?.assigned_to : null;
    const numbers = alertNumbers(db, tenantId, assignedTo);

    if (numbers.length === 0) {
      logger.debug('تنبيه محفوظ بلا إرسال — لا يوجد رقم موظف للمنشأة', { tenant: tenantId, نوع: kind });
      return;
    }

    const text = [`🔔 ${title}`, body].filter(Boolean).join('\n\n');

    // فشل رقم لا يمنع البقية: لكلٍّ محاولته.
    await Promise.all(
      numbers.map(async (number) => {
        try {
          await provider.sendText(tenantId, number, text);
        } catch (error) {
          logger.error('تعذّر إرسال تنبيه لموظف — التنبيه محفوظ في لوحة الأدمن', error, {
            tenant: tenantId,
            نوع: kind,
            رقم: number,
          });
        }
      }),
    );
  };
}
