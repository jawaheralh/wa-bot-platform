/**
 * التعامل مع Meta برمجياً بدل واجهتها.
 *
 * واجهة Meta متاهة، وتخرج المستخدم من الحساب عند تعدد الحسابات، وتتغير
 * تسمياتها كل بضعة أشهر. كل ما يلزم للربط يمكن عمله عبر Graph API —
 * فنفعله من لوحتنا ونريها النتيجة.
 */

import type { AppConfig } from './config.ts';
import type { MetaCredentials } from './tenant-meta.ts';

const GRAPH = 'https://graph.facebook.com';

export interface MetaResult<T = Record<string, unknown>> {
  ok: boolean;
  message: string;
  data?: T;
}

function errorOf(data: Record<string, unknown>, status: number): string {
  const error = data.error as { message?: string; code?: number } | undefined;
  return error?.message ?? `رفضت Meta (${status})`;
}

async function call(
  config: AppConfig,
  path: string,
  options: { token: string; method?: 'GET' | 'POST'; body?: Record<string, string> },
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `${GRAPH}/${config.cloud.graphVersion}/${path}`;
  const init: RequestInit = { method: options.method ?? 'GET' };

  if (options.method === 'POST') {
    const form = new URLSearchParams({ ...options.body, access_token: options.token });
    init.body = form;
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }

  const response = await fetch(
    options.method === 'POST' ? url : `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(options.token)}`,
    init,
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

/** توكن التطبيق = المعرّف|السرّ — يصلح لعمليات إعداد التطبيق نفسه. */
function appToken(config: AppConfig): string {
  return `${config.cloud.appId}|${config.cloud.appSecret}`;
}

/* ---------------------------------------------------------------
   الفحوص
--------------------------------------------------------------- */

export async function checkToken(config: AppConfig): Promise<MetaResult> {
  if (!config.cloud.accessToken) return { ok: false, message: 'التوكن غير مضبوط.' };
  const result = await call(config, 'me', { token: config.cloud.accessToken });
  if (!result.ok) {
    const message = errorOf(result.data, result.status);
    return {
      ok: false,
      message: message.includes('expired') ? 'التوكن منتهٍ — ولّدي توكناً دائماً.' : message,
    };
  }
  return { ok: true, message: `صالح — ${String(result.data.name ?? result.data.id ?? '')}` };
}

export async function checkAppSecret(config: AppConfig): Promise<MetaResult> {
  if (!config.cloud.appSecret) return { ok: false, message: 'المفتاح السري غير مضبوط.' };
  if (!config.cloud.appId) return { ok: false, message: 'معرّف التطبيق غير مضبوط.' };

  const result = await call(config, config.cloud.appId, { token: appToken(config) });
  if (!result.ok) {
    return { ok: false, message: 'المفتاح السري لا يطابق معرّف التطبيق. تأكدي أنهما من نفس التطبيق.' };
  }
  return { ok: true, message: `يطابق تطبيق «${String(result.data.name ?? '')}»` };
}

export async function checkPhoneNumber(config: AppConfig, phoneNumberId: string): Promise<MetaResult> {
  const result = await call(
    config,
    `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`,
    { token: config.cloud.accessToken },
  );
  if (!result.ok) return { ok: false, message: errorOf(result.data, result.status) };

  const d = result.data as Record<string, string>;
  const quality: Record<string, string> = { GREEN: 'جيد', YELLOW: 'متوسط', RED: 'منخفض' };
  return {
    ok: true,
    message: `${d.display_phone_number} — ${d.verified_name} · التحقق: ${
      d.code_verification_status === 'VERIFIED' ? 'موثّق' : d.code_verification_status
    } · الجودة: ${quality[d.quality_rating ?? ''] ?? 'غير متاح'}`,
    data: d,
  };
}

/** حالة الـwebhook المسجَّل لدى Meta لهذا التطبيق. */
export async function checkWebhook(config: AppConfig): Promise<MetaResult> {
  if (!config.cloud.appId || !config.cloud.appSecret) {
    return { ok: false, message: 'يلزم معرّف التطبيق ومفتاحه السري.' };
  }
  const result = await call(config, `${config.cloud.appId}/subscriptions`, { token: appToken(config) });
  if (!result.ok) return { ok: false, message: errorOf(result.data, result.status) };

  const list = (result.data.data ?? []) as { object?: string; callback_url?: string; active?: boolean; fields?: { name: string }[] }[];
  const whatsapp = list.find((s) => s.object === 'whatsapp_business_account');

  if (!whatsapp) return { ok: false, message: 'لا يوجد webhook مسجَّل بعد.' };

  const fields = (whatsapp.fields ?? []).map((f) => f.name);
  const hasMessages = fields.includes('messages');
  const matches = whatsapp.callback_url === `${config.publicUrl}/webhook/whatsapp`;

  if (!matches) {
    return {
      ok: false,
      message: `مسجَّل على عنوان آخر: ${whatsapp.callback_url ?? '؟'} — اضغطي «اضبط الـwebhook» للتحديث.`,
    };
  }
  if (!hasMessages) return { ok: false, message: 'مسجَّل لكن حقل messages غير مفعّل.' };

  return { ok: true, message: `نشط على ${whatsapp.callback_url}` };
}

/* ---------------------------------------------------------------
   الضبط
--------------------------------------------------------------- */

export async function listWabas(config: AppConfig): Promise<{ id: string; name: string }[]> {
  if (!config.cloud.businessId) return [];
  const result = await call(config, `${config.cloud.businessId}/owned_whatsapp_business_accounts`, {
    token: config.cloud.accessToken,
  });
  if (!result.ok) return [];
  return ((result.data.data ?? []) as { id: string; name?: string }[]).map((w) => ({
    id: w.id,
    name: w.name ?? '',
  }));
}

/**
 * يضبط الـwebhook ويشترك حساب واتساب في التطبيق — الخطوتان اللتان تتمّان
 * عادةً من واجهة Meta.
 */
export async function configureWebhook(config: AppConfig): Promise<MetaResult<{ steps: string[] }>> {
  const steps: string[] = [];

  if (!config.publicUrl) {
    return { ok: false, message: 'لا يوجد عنوان عام (PUBLIC_URL). شغّلي نفقاً أو انشري على خادم أولاً.' };
  }
  if (!config.cloud.appId || !config.cloud.appSecret) {
    return { ok: false, message: 'يلزم معرّف التطبيق ومفتاحه السري.' };
  }
  if (!config.cloud.verifyToken) {
    return { ok: false, message: 'رمز تحقق الـwebhook غير مضبوط.' };
  }

  /* ١ — تسجيل العنوان على التطبيق. Meta تتصل بنا فوراً للتحقق. */
  const subscribe = await call(config, `${config.cloud.appId}/subscriptions`, {
    token: appToken(config),
    method: 'POST',
    body: {
      object: 'whatsapp_business_account',
      callback_url: `${config.publicUrl}/webhook/whatsapp`,
      verify_token: config.cloud.verifyToken,
      fields: 'messages',
    },
  });

  if (!subscribe.ok || !subscribe.data.success) {
    const message = errorOf(subscribe.data, subscribe.status);
    return {
      ok: false,
      message: message.includes('URL')
        ? `تعذّر على Meta الوصول لعنوانك: ${message} — تأكدي أن النفق يعمل.`
        : message,
    };
  }
  steps.push('سُجّل العنوان ونجح تحقق Meta');

  /* ٢ — اشتراك حساب واتساب في التطبيق، وإلا لن تُرسَل الأحداث. */
  const wabas = await listWabas(config);
  if (wabas.length === 0) {
    return {
      ok: true,
      message: 'ضُبط الـwebhook، لكن تعذّر إيجاد حساب واتساب للاشتراك. تأكدي من معرّف النشاط التجاري.',
      data: { steps },
    };
  }

  for (const waba of wabas) {
    const result = await call(config, `${waba.id}/subscribed_apps`, {
      token: config.cloud.accessToken,
      method: 'POST',
      body: {},
    });
    steps.push(
      result.ok && result.data.success
        ? `اشترك التطبيق في «${waba.name}»`
        : `تعذّر الاشتراك في «${waba.name}»: ${errorOf(result.data, result.status)}`,
    );
  }

  return { ok: true, message: 'تم الضبط.', data: { steps } };
}


/* ---------------------------------------------------------------
   نسخ تعمل ببيانات اعتماد منشأة بعينها
--------------------------------------------------------------- */

function withCredentials(config: AppConfig, credentials: MetaCredentials): AppConfig {
  return { ...config, cloud: { ...config.cloud, ...credentials } };
}

export const checkTokenFor = (config: AppConfig, c: MetaCredentials): Promise<MetaResult> =>
  checkToken(withCredentials(config, c));

export const checkAppSecretFor = (config: AppConfig, c: MetaCredentials): Promise<MetaResult> =>
  checkAppSecret(withCredentials(config, c));

export const checkPhoneNumberFor = (
  config: AppConfig,
  c: MetaCredentials,
  phoneNumberId: string,
): Promise<MetaResult> => checkPhoneNumber(withCredentials(config, c), phoneNumberId);

export const checkWebhookFor = (config: AppConfig, c: MetaCredentials): Promise<MetaResult> =>
  checkWebhook(withCredentials(config, c));

/**
 * يضبط الـwebhook لكل تطبيق Meta مستعمل.
 *
 * منشآت تحت حسابك تشترك في تطبيق واحد فيُسجَّل مرة، ومنشأة بحسابها الخاص
 * لها تطبيقها فيُسجَّل لها على حدة. العنوان واحد — النظام يوجّه بـ
 * phone_number_id بعد الاستلام.
 */
export async function configureAllWebhooks(
  config: AppConfig,
  groups: Map<string, { credentials: MetaCredentials; tenants: { name: string }[] }>,
): Promise<MetaResult<{ steps: string[] }>> {
  const steps: string[] = [];
  let failures = 0;

  for (const [appId, group] of groups) {
    const names = group.tenants.map((t) => t.name).join('، ');
    const result = await configureWebhook(withCredentials(config, group.credentials));
    if (result.ok) steps.push(`تطبيق ${appId} (${names}): ${(result.data?.steps ?? []).join(' · ')}`);
    else {
      failures += 1;
      steps.push(`تطبيق ${appId} (${names}): ✗ ${result.message}`);
    }
  }

  if (groups.size === 0) return { ok: false, message: 'لا توجد منشأة نشطة لها معرّف رقم وتطبيق.' };
  return { ok: failures === 0, message: failures ? 'بعض التطبيقات لم تُضبط.' : 'تم الضبط.', data: { steps } };
}
