/**
 * إخفاء بيانات العميل قبل أن تغادر السعودية.
 *
 * خادمك في جدة، لكن Claude يعمل على خوادم Anthropic خارجها — وهذا
 * لا يُحلّ بإعداد. الذي يُحلّ هو ما نرسله: النموذج يحتاج أن يفهم أن
 * العميل ذكر رقماً، لا أن يعرف الرقم.
 *
 *   الأصل:   «أنا محمد، جوالي 0551234567»
 *   المُرسَل: «أنا محمد، جوالي ﴿جوال-1﴾»
 *   المخزَّن: الأصل كاملاً في جدة
 *
 * ثم يُعاد الأصل إلى مدخلات الأدوات: حين يطلب النموذج تسجيل طلب
 * برقم ﴿جوال-1﴾ يُخزَّن الرقم الحقيقي. فالشركة تحصل على بياناتها
 * كاملة، والنموذج لا يرى منها شيئاً.
 *
 * الأسماء لا تُخفى: بلا اسم يصير البوت غريباً بارداً، والاسم وحده
 * بلا رقم ولا هوية لا يُعرّف أحداً.
 */

/** الرمز يستعمل أقواساً عربية زخرفية لا تَرِد في كلام العملاء. */
const OPEN = '﴿';
const CLOSE = '﴾';

export type PiiKind = 'جوال' | 'هوية' | 'آيبان' | 'بطاقة' | 'بريد';

export interface Redaction {
  /** النص بعد الاستبدال — هذا ما يُرسل للنموذج. */
  text: string;
  /** الرمز ← القيمة الأصلية. */
  map: Map<string, string>;
}

/**
 * ترتيب الأنماط مقصود: الأطول أولاً.
 *
 * الآيبان السعودي يحوي بداخله ما يشبه رقم هوية، ورقم البطاقة يحوي
 * ما يشبه رقم جوال. لو سبق النمط الأقصر لالتهم جزءاً من الأطول
 * وترك بقيته مكشوفة — وهو أسوأ من عدم الإخفاء لأنه يوهم بالأمان.
 */
const PATTERNS: [kind: PiiKind, pattern: RegExp][] = [
  // SA + رقمان + ٢٠ خانة، بمسافات أو بدونها
  ['آيبان', /\bSA\d{2}(?:[ -]?\d){20}\b/gi],
  // البريد قبل الأرقام: قد يحوي أرقاماً في اسمه
  ['بريد', /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g],
  // بطاقة: ١٣–١٩ خانة مجمّعة — تُفحص بلون قبل القبول
  ['بطاقة', /\b(?:\d[ -]?){12,18}\d\b/g],
  // جوال سعودي: 05xxxxxxxx أو 9665xxxxxxxx أو +9665xxxxxxxx
  ['جوال', /(?:\+?966[ -]?|00966[ -]?|\b0)5(?:[ -]?\d){8}\b/g],
  // هوية أو إقامة: عشر خانات تبدأ بـ١ أو ٢
  ['هوية', /\b[12]\d{9}\b/g],
];

function digitsOnly(text: string): string {
  return text.replace(/\D/g, '');
}

/**
 * فحص لون لأرقام البطاقات.
 *
 * بدونه يبتلع نمط البطاقة أي سلسلة أرقام طويلة — رقم طلب، أو رقم
 * فاتورة — فيضيع على الموظف ما يحتاجه، ويظن العميل أن البوت لا يفهم.
 */
function looksLikeCard(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** يُخفي ما يُعرّف صاحبه، ويترك ما عداه كما هو. */
export function redact(text: string): Redaction {
  const map = new Map<string, string>();
  if (!text) return { text, map };

  // القيمة نفسها تأخذ الرمز نفسه: رقم يتكرر في المحادثة يبقى
  // متسقاً، فيفهم النموذج أنه الرقم ذاته لا رقمان.
  const seen = new Map<string, string>();
  const counters = new Map<PiiKind, number>();
  let out = text;

  for (const [kind, pattern] of PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), (match) => {
      if (kind === 'بطاقة' && !looksLikeCard(match)) return match;

      const key = `${kind}:${digitsOnly(match) || match.toLowerCase()}`;
      const existing = seen.get(key);
      if (existing) return existing;

      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      const token = `${OPEN}${kind}-${next}${CLOSE}`;

      seen.set(key, token);
      map.set(token, match);
      return token;
    });
  }

  return { text: out, map };
}

/** يُعيد القيم الأصلية إلى نصٍّ أعاده النموذج. */
export function restore(text: string, map: Map<string, string>): string {
  if (!text || map.size === 0) return text;
  let out = text;
  for (const [token, value] of map) out = out.split(token).join(value);
  return out;
}

/**
 * يُعيد القيم داخل مدخلات أداة — بأي عمق.
 *
 * هذا ما يجعل الشركة تحصل على بياناتها: النموذج يطلب تسجيل طلب
 * برقم ﴿جوال-1﴾، فيُخزَّن الرقم الحقيقي.
 */
export function restoreDeep(input: unknown, map: Map<string, string>): unknown {
  if (map.size === 0) return input;
  if (typeof input === 'string') return restore(input, map);
  if (Array.isArray(input)) return input.map((item) => restoreDeep(item, map));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) out[key] = restoreDeep(value, map);
    return out;
  }
  return input;
}

/** يدمج خرائط عدة رسائل في خريطة واحدة للمحادثة. */
export function mergeMaps(maps: Map<string, string>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const map of maps) for (const [k, v] of map) out.set(k, v);
  return out;
}

/** هل بقي في النص ما يُعرّف صاحبه؟ — للاختبار والتشخيص. */
export function hasPii(text: string): boolean {
  return redact(text).map.size > 0;
}
