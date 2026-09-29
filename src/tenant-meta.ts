/**
 * بيانات Meta لكل منشأة.
 *
 * كل عميل يملك حساب واتساب أعمال خاصاً به: رقمه وتطبيقه وتوكنه. لا يمكن
 * أن يشترك عميلان في توكن واحد — التوكن يخوّل الإرسال باسم صاحبه.
 *
 * ولا توارث بين المنشآت افتراضياً.
 *
 * كانت المنشأة الفارغة ترث قيم .env تسهيلاً. لكن تلك القيم في الواقع
 * تخصّ أول عميل أُعدّ النظام له، فكان كل عميل جديد يعمل — بصمت — تحت
 * تطبيق غيره وبتوكنه وعلى حساب Claude الخاص به: رقمه يظهر تحت تطبيق
 * شركة أخرى، وفاتورته تُحمّل على غيره.
 *
 * والعطل لا يُرى: كل شيء يعمل. فصار التوارث قراراً صريحاً بمتغيّر
 * SHARED_META_FALLBACK، وافتراضه الفصل.
 */

import type { AppConfig } from './config.ts';
import { listTenants, type Db, type TenantRow } from './db/index.ts';

export interface MetaCredentials {
  accessToken: string;
  appSecret: string;
  appId: string;
  businessId: string;
  /** هل تستعمل هذه المنشأة حساب Meta الخاص بها أم الحساب العام؟ */
  own: boolean;
}

export function credentialsFor(config: AppConfig, tenant: TenantRow | undefined): MetaCredentials {
  const own = Boolean(tenant?.wa_access_token && tenant.wa_app_secret);
  if (own || config.sharedMetaFallback) {
    return {
      accessToken: tenant?.wa_access_token || config.cloud.accessToken,
      appSecret: tenant?.wa_app_secret || config.cloud.appSecret,
      appId: tenant?.wa_app_id || config.cloud.appId,
      businessId: tenant?.wa_business_id || config.cloud.businessId,
      own,
    };
  }

  /**
   * منشأة بلا بيانات خاصة: فارغة لا موروثة.
   *
   * الفراغ يُنتج رسالة صريحة («بلا توكن Meta — أدخليه في إعدادات
   * المنشأة») ويمنع تسجيل webhook لها. وهذا أفضل بكثير من أن تعمل
   * على حساب عميل آخر بلا أن يعلم أحد.
   */
  return { accessToken: '', appSecret: '', appId: '', businessId: '', own: false };
}

/**
 * كل الأسرار الممكنة للتحقق من توقيع webhook وارد.
 *
 * التوقيع يُحسب بسرّ التطبيق الذي أرسله، ولا نعرف المرسِل قبل التحقق.
 * تحليل الحمولة أولاً لمعرفة المنشأة يعني الثقة بمحتوى لم يُتحقق منه،
 * فنجرّب الأسرار المعروفة كلها بدل ذلك — عددها بعدد عملائك لا أكثر.
 */
export function allAppSecrets(db: Db, config: AppConfig): string[] {
  const secrets = new Set<string>();
  if (config.cloud.appSecret) secrets.add(config.cloud.appSecret);
  for (const tenant of listTenants(db)) {
    if (tenant.wa_app_secret) secrets.add(tenant.wa_app_secret);
  }
  return [...secrets];
}

/** المنشآت التي تحتاج تسجيل webhook مستقلاً — مجمّعة بالتطبيق. */
export function tenantsByApp(db: Db, config: AppConfig): Map<string, { credentials: MetaCredentials; tenants: TenantRow[] }> {
  const groups = new Map<string, { credentials: MetaCredentials; tenants: TenantRow[] }>();

  for (const tenant of listTenants(db)) {
    if (tenant.status !== 'active' || !tenant.wa_phone_number_id) continue;
    const credentials = credentialsFor(config, tenant);
    if (!credentials.appId || !credentials.appSecret) continue;

    const group = groups.get(credentials.appId);
    if (group) group.tenants.push(tenant);
    else groups.set(credentials.appId, { credentials, tenants: [tenant] });
  }
  return groups;
}
