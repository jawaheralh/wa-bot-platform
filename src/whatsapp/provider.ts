/**
 * طبقة اتصال واتساب المجرّدة.
 *
 * المنطق كله فوق هذه الواجهة ولا يعرف المزوّد. هذا ليس ترفاً معمارياً:
 * التجربة تتم عبر Baileys بمسح QR، والإنتاج عبر Cloud API الرسمي، والاختبارات
 * عبر محاكي — وثلاثتها تشغّل نفس محرّك البوت بالضبط.
 */

/** أنواع ما يرسله العميل غير النص. */
export type MediaKind = 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location' | 'contact';

export const MEDIA_AR: Record<MediaKind, string> = {
  image: 'صورة',
  document: 'ملف',
  audio: 'رسالة صوتية',
  video: 'مقطع فيديو',
  sticker: 'ملصق',
  location: 'موقع',
  contact: 'جهة اتصال',
};

export interface IncomingMedia {
  kind: MediaKind;
  mimeType: string;
  /** اسم الملف كما أرسله العميل، إن وُجد. */
  filename?: string;
  /** نص مصاحب للصورة أو الفيديو. */
  caption?: string;
  /** وصف نصي جاهز للموقع وجهة الاتصال — لا تحميل لهما. */
  text?: string;
  /** التحميل كسول: لا نُنزّل ما لن نستعمله. */
  download?: () => Promise<Buffer>;
}

/** رسالة واردة بعد تطبيعها من أي مزوّد. */
export interface IncomingMessage {
  /** الرقم المستقبِل (رقم المنشأة) — مفتاح التوجيه في Baileys والمحاكي. */
  toNumber: string;
  /** معرّف الرقم في Cloud API — مفتاح التوجيه البديل حين لا يُعطى الرقم نفسه. */
  toPhoneNumberId?: string;
  from: string;
  pushName?: string;
  text?: string;
  /** كل ما ليس نصاً: صورة، ملف، صوت، فيديو، موقع، جهة اتصال. */
  media?: IncomingMedia;
  waMessageId?: string;
  /**
   * لحظة إرسال العميل للرسالة (ثوانٍ منذ الحقبة) — لا لحظة وصولها.
   *
   * الفرق ليس نظرياً: رسالة أُرسلت ٣:٤٦ وصلت الخادم ٥:١١، فردّ عليها
   * البوت بعد ساعة ونصف من كتابتها وقد انتهى موضوعها. بلا هذا الختم
   * لا سبيل للنظام أن يعرف أن الرسالة قديمة أصلاً.
   */
  sentAt?: number;
  /** رسالة صادرة من رقم المنشأة نفسه — غالباً الموظف ردّ يدوياً من جواله. */
  fromMe?: boolean;
}

export interface SendResult {
  id: string;
}

export interface ProviderStatus {
  /** baileys | cloud | simulator */
  provider: string;
  connected: boolean;
  /** نص QR لعرضه في صفحة الأدمن (Baileys فقط). */
  qr?: string;
  detail?: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** قالب معتمد كما تُعيده Meta. */
export interface TemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string;
  /** نص المتن بمتغيّراته {{1}} — لتعرف الموظفة ما تملؤه. */
  body: string;
  /** عدد المتغيّرات المطلوبة. */
  variables: number;
}

export interface WhatsAppProvider {
  readonly name: string;
  /** يبدأ الاتصال لكل المنشآت النشطة. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** يُسجّل معالج الرسائل الواردة — يُستدعى مرة واحدة عند الإقلاع. */
  onMessage(handler: MessageHandler): void;
  /** إرسال نص. على المزوّد أن يُعيد المحاولة داخلياً قبل أن يرمي. */
  sendText(tenantId: number, to: string, text: string): Promise<SendResult>;
  /**
   * إرسال بقالب معتمد من Meta.
   *
   * السبيل الوحيد لمراسلة رقم لم يراسلك، أو مضى على رسالته أكثر من
   * أربع وعشرين ساعة. المزوّدات التي لا تدعمه ترمي برسالة صريحة بدل
   * أن تصمت — الصمت هنا يُفهَم نجاحاً.
   */
  sendTemplate?(
    tenantId: number,
    to: string,
    template: { name: string; language: string; variables?: string[] },
  ): Promise<SendResult>;
  /** القوالب المعتمدة لدى Meta لهذه المنشأة. */
  listTemplates?(tenantId: number): Promise<TemplateSummary[]>;
  status(tenantId: number): ProviderStatus;
  /** يُعلم المزوّد بأن منشأة أُضيفت أو عُدّلت فيفتح لها جلسة. */
  refreshTenant?(tenantId: number): Promise<void>;
}

/* ---------------------------------------------------------------
   إعادة المحاولة
--------------------------------------------------------------- */

/**
 * خطأ لا فائدة من تكراره — طلب خاطئ، توكن منتهٍ، رقم غير صالح.
 * المستدعي يضع هذه العلامة، و withRetry تستسلم فوراً بدل إهدار ثلاث
 * محاولات وحدّ معدّل على خطأ لن يتغير.
 */
export function markNoRetry<E extends object>(error: E): E & { noRetry: true } {
  return Object.assign(error, { noRetry: true as const });
}

export function isNoRetry(error: unknown): boolean {
  return (error as { noRetry?: boolean })?.noRetry === true;
}

/**
 * تراجع أسّي مع تشويش بسيط.
 * فشل الإرسال شائع ومؤقت (انقطاع socket، حدّ معدّل من Meta)، وخسارة رد
 * البوت تعني عميلاً ينتظر بلا جواب — فالمحاولة أرخص من الصمت.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    /** افتراضياً: أعد المحاولة إلا إذا وُسم الخطأ بـnoRetry. */
    shouldRetry?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  const shouldRetry = options.shouldRetry ?? ((error: unknown) => !isNoRetry(error));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      options.onRetry?.(attempt, error);
      const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}


/**
 * يُعيد المزوّد الأصلي من تحت أي أغلفة.
 *
 * وضع «عرض فقط» يلفّ المزوّد ويغيّر اسمه، فأي فحص على `provider.name`
 * يسقط بصمت — وهذا ما عطّل تسجيل webhook الـCloud API. الفحص على النوع
 * المُغلَّف لا على الاسم.
 */
export function unwrapProvider(provider: WhatsAppProvider): WhatsAppProvider {
  let current = provider;
  for (let depth = 0; depth < 5; depth++) {
    const inner = (current as { wrapped?: WhatsAppProvider }).wrapped;
    if (!inner) break;
    current = inner;
  }
  return current;
}
