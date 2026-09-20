/**
 * طبقة اتصال واتساب المجرّدة.
 *
 * المنطق كله فوق هذه الواجهة ولا يعرف المزوّد. هذا ليس ترفاً معمارياً:
 * التجربة تتم عبر Baileys بمسح QR، والإنتاج عبر Cloud API الرسمي، والاختبارات
 * عبر محاكي — وثلاثتها تشغّل نفس محرّك البوت بالضبط.
 */

/** رسالة واردة بعد تطبيعها من أي مزوّد. */
export interface IncomingMessage {
  /** الرقم المستقبِل (رقم المنشأة) — مفتاح التوجيه في Baileys والمحاكي. */
  toNumber: string;
  /** معرّف الرقم في Cloud API — مفتاح التوجيه البديل حين لا يُعطى الرقم نفسه. */
  toPhoneNumberId?: string;
  from: string;
  pushName?: string;
  text?: string;
  /** رسالة صوتية: نُمرّر دالة تحميل كسولة فلا نُنزّل ما لن نستعمله. */
  audio?: { mimeType: string; download(): Promise<Buffer> };
  waMessageId?: string;
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

export interface WhatsAppProvider {
  readonly name: string;
  /** يبدأ الاتصال لكل المنشآت النشطة. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** يُسجّل معالج الرسائل الواردة — يُستدعى مرة واحدة عند الإقلاع. */
  onMessage(handler: MessageHandler): void;
  /** إرسال نص. على المزوّد أن يُعيد المحاولة داخلياً قبل أن يرمي. */
  sendText(tenantId: number, to: string, text: string): Promise<SendResult>;
  status(tenantId: number): ProviderStatus;
  /** يُعلم المزوّد بأن منشأة أُضيفت أو عُدّلت فيفتح لها جلسة. */
  refreshTenant?(tenantId: number): Promise<void>;
}

/* ---------------------------------------------------------------
   إعادة المحاولة
--------------------------------------------------------------- */

/**
 * تراجع أسّي مع تشويش بسيط.
 * فشل الإرسال شائع ومؤقت (انقطاع socket، حدّ معدّل من Meta)، وخسارة رد
 * البوت تعني عميلاً ينتظر بلا جواب — فالمحاولة أرخص من الصمت.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      options.onRetry?.(attempt, error);
      const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
