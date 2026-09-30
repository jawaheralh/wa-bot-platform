/**
 * إرسال البريد.
 *
 * ## لماذا عبر HTTP لا SMTP
 *
 * SMTP يحتاج مكتبة تتكلم البروتوكول وتتفاوض على TLS وتتعامل مع أخطائه
 * — مئتا سطر وتبعية جديدة لأجل رسالة رمزٍ في الشهر. ومزوّدو البريد
 * كلهم يعرضون نفس الخدمة عبر نداء HTTP واحد، و`fetch` موجود في Node
 * أصلاً. فبقي المشروع بلا تبعية جديدة.
 *
 * ## لماذا مزوّدان
 *
 * لا للتنوّع بل للانتقال: الطبقة المجانية تُلغى أو تتغيّر، ومزوّدٌ
 * واحد مكتوب في قلب الشيفرة يعني إعادة كتابة يوم يتغيّر. والفرق
 * بينهما هنا ثمانية أسطر.
 *
 * ## التكلفة
 *
 * رسائل الاسترجاع بالعشرات في الشهر لا بالآلاف، وهي داخل الطبقة
 * المجانية لكلا المزوّدين بفارق كبير. والتكلفة الحقيقية ليست المال بل
 * **النطاق**: بلا نطاق موثّق بسجلات SPF وDKIM تقع الرسالة في
 * «المهملات»، فيتصل العميل رغم وجود الميزة.
 */

import type { AppConfig } from './config.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  /** نصّ صِرف لا HTML: رسالة الرمز سطران، والـHTML يزيد فرص حجبها. */
  text: string;
}

export interface EmailResult {
  ok: boolean;
  message: string;
}

/** هل البريد مضبوط أصلاً؟ الواجهة تسأل قبل أن تَعِد المستخدم برسالة. */
export function emailEnabled(config: AppConfig): boolean {
  return Boolean(config.email.apiKey && config.email.from);
}

export function isEmail(value: unknown): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

/* ---------------------------------------------------------------
   المزوّدون
--------------------------------------------------------------- */

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function resend(config: AppConfig, message: EmailMessage): Call {
  return {
    url: 'https://api.resend.com/emails',
    headers: {
      authorization: `Bearer ${config.email.apiKey}`,
      'content-type': 'application/json',
    },
    body: {
      from: config.email.fromName ? `${config.email.fromName} <${config.email.from}>` : config.email.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    },
  };
}

function brevo(config: AppConfig, message: EmailMessage): Call {
  return {
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: {
      'api-key': config.email.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: {
      sender: { email: config.email.from, name: config.email.fromName || undefined },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
    },
  };
}

const PROVIDERS: Record<string, (config: AppConfig, message: EmailMessage) => Call> = {
  resend,
  brevo,
};

/* ---------------------------------------------------------------
   الإرسال
--------------------------------------------------------------- */

export async function sendEmail(config: AppConfig, message: EmailMessage): Promise<EmailResult> {
  if (!emailEnabled(config)) return { ok: false, message: 'البريد غير مضبوط.' };
  if (!isEmail(message.to)) return { ok: false, message: 'عنوان البريد غير صحيح.' };

  const build = PROVIDERS[config.email.provider];
  if (!build) return { ok: false, message: `مزوّد بريد غير معروف: ${config.email.provider}` };

  const call = build(config, message);
  const response = await fetch(call.url, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify(call.body),
  });

  if (response.ok) return { ok: true, message: 'أُرسل البريد.' };

  /**
   * سبب الرفض يُنقل كما هو.
   *
   * أكثره نطاقٌ غير موثّق أو مُرسِلٌ غير مطابق — وهما خطآ إعداد يصلحهما
   * من يقرأ الرسالة في دقيقة، بينما «تعذّر الإرسال» تُبقيه يخمّن.
   */
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const detail =
    (body.message as string) ?? (body.error as string) ?? ((body.error as { message?: string })?.message ?? '');
  return { ok: false, message: `رفض مزوّد البريد (${response.status}): ${detail || 'بلا تفصيل'}` };
}
