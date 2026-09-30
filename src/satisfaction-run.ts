/**
 * إرسال سؤال التقييم آخر اليوم.
 *
 * يُنادى من النبضة الدقيقية، ويعمل في ساعة واحدة من اليوم فقط. وحارسُ
 * «أُرسل اليوم» في القاعدة لا في الذاكرة: إعادة تشغيل الخادم في تلك
 * الساعة كانت ستُعيد السؤال على من سُئل قبل دقيقتين.
 */

import type { App } from './app.ts';
import { listTenants, getTenant } from './db/index.ts';
import { getConfig } from './modules/registry.ts';
import { closedToday, markAsked, type Closed } from './satisfaction.ts';
import { checkBudget, recordConversation } from './billing.ts';
import { hourNow } from './time.ts';

/** القالب الذي يُرسل به السؤال — واحدٌ من الجاهزة في شاشة القوالب. */
export const RATING_TEMPLATE = 'service_rating';

export interface RatingSettings {
  enabled: boolean;
  /** ساعة الإرسال بتوقيت الرياض (٠–٢٣). */
  hour: number;
  template: string;
}

/**
 * الإعداد من وحدة الطلبات.
 *
 * ولا وحدة ثالثة للتقييم: هو قياسٌ لما تفعله الوحدتان لا وظيفةٌ
 * تُشترى وحدها، وإفرادُه بوحدة يجعل المالك يُفعّلها ويتساءل لماذا لا
 * يصله شيء وهو لم يفعّل الطلبات أصلاً.
 */
export function ratingSettings(app: App, tenantId: number): RatingSettings {
  const config = getConfig(app.db, tenantId, 'requests') as {
    ratingEnabled?: boolean;
    ratingHour?: number;
    ratingTemplate?: string;
  };

  const hour = Number(config.ratingHour);
  return {
    enabled: config.ratingEnabled === true,
    hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 20,
    template: String(config.ratingTemplate || RATING_TEMPLATE),
  };
}

/**
 * يرسل سؤال التقييم لمن أُغلقت خدمته اليوم.
 *
 * بقالب لا بنصّ حرّ: العميل خارج نافذة الأربع والعشرين ساعة غالباً —
 * فآخر رسالة منه سبقت إغلاق طلبه بساعات أو أيام.
 */
export async function runRatingSurvey(app: App): Promise<void> {
  if (!app.provider.sendTemplate) return;

  const hour = hourNow();

  for (const tenant of listTenants(app.db)) {
    if (tenant.status !== 'active') continue;

    const settings = ratingSettings(app, tenant.id);
    if (!settings.enabled || settings.hour !== hour) continue;

    /**
     * السقف يُفحص مرة لكل منشأة لا لكل صفّ.
     *
     * وإن بلغته تُترك صفوفها كلها بلا تسجيل: لو سُجّلت كمسؤولة عنها
     * لما سُئل عنها أحد أبداً بعد رفع السقف.
     */
    if (!checkBudget(app.db, tenant.id, 'utility').allowed) {
      app.logger.warn('سقف ميتا بلغ حدّه — أُجّلت أسئلة التقييم', { tenant: tenant.id });
      continue;
    }

    for (const closed of closedToday(app.db, tenant.id)) {
      // التسجيل قبل الإرسال: سؤالٌ مكرر أسوأ من تقييم مفقود.
      const id = markAsked(app.db, tenant.id, closed);
      if (!id) continue;

      try {
        await app.provider.sendTemplate(tenant.id, closed.customer_wa, {
          name: settings.template,
          language: 'ar',
          variables: [closed.reference],
        });
        recordConversation(app.db, tenant.id, 'utility');
        app.logger.info('أُرسل سؤال التقييم', {
          tenant: tenant.id,
          مرجع: closed.reference,
        });
      } catch (error) {
        /**
         * الفشل لا يُعيد المحاولة.
         *
         * أكثره قالبٌ غير معتمد أو رقمٌ لا يقبل، وكلاهما لا يُصلحه
         * التكرار — ويبقى الصفّ بلا تقييم فيظهر في شاشة القياس أن
         * السؤال أُرسل ولم يُجَب.
         */
        app.logger.error('تعذّر إرسال سؤال التقييم', error, {
          tenant: tenant.id,
          مرجع: closed.reference,
        });
      }
    }
  }
}

/** يُستعمل في الاختبار لبناء صفوف مغلقة بلا تشغيل النبضة. */
export type { Closed };
export { getTenant };
