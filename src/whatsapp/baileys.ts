/**
 * مزوّد Baileys — للتجربة عبر مسح QR برقم واتساب عادي.
 *
 * جلسة منفصلة لكل منشأة في مجلد مستقل تحت data/baileys/<tenantId>، فمسح QR
 * لمنشأة لا يمسّ غيرها. هذا المزوّد غير رسمي ومناسب للتجربة والعروض فقط؛
 * الإنتاج على CloudApiProvider.
 *
 * نقطة دقيقة: رسالة يرسلها صاحب الرقم من جواله تصل هنا بـ fromMe=true،
 * وهي إشارتنا الوحيدة أن الموظف تدخّل يدوياً — عليها يقوم الوضع الصامت.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import baileysDefault, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import type { IncomingMessage, MessageHandler, ProviderStatus, SendResult, WhatsAppProvider } from './provider.ts';
import { withRetry } from './provider.ts';
import { listTenants, normalizeNumber, type Db, type TenantRow } from '../db/index.ts';
import type { Logger } from '../logger.ts';

const makeWASocket = baileysDefault as unknown as typeof import('@whiskeysockets/baileys').makeWASocket;

/**
 * Baileys يطبع سجل pino خاماً بصيغة JSON تُغرق سجلنا العربي بالكامل.
 * نمرّر له سجلاً صامتاً ونكتفي بما نسجّله نحن من أحداث ذات معنى.
 */
const QUIET_LOGGER = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child() {
    return QUIET_LOGGER;
  },
};

interface Session {
  tenant: TenantRow;
  socket: WASocket | null;
  connected: boolean;
  qr?: string;
  detail: string;
  stopping: boolean;
}

/** جوال سعودي 9665… يصبح 9665…@s.whatsapp.net */
function toJid(number: string): string {
  return `${normalizeNumber(number)}@s.whatsapp.net`;
}

function fromJid(jid: string): string {
  return normalizeNumber(jid.split('@')[0] ?? '');
}

/** يستخرج النص من أي من أشكال الرسائل التي يرسلها واتساب. */
function extractText(message: WAMessage): string | undefined {
  const content = message.message;
  if (!content) return undefined;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    undefined
  );
}

export class BaileysProvider implements WhatsAppProvider {
  readonly name = 'baileys';
  private readonly sessions = new Map<number, Session>();
  private handler: MessageHandler | null = null;

  private readonly db: Db;
  private readonly authDir: string;
  private readonly logger: Logger;

  constructor(db: Db, authDir: string, logger: Logger) {
    this.db = db;
    this.authDir = authDir;
    this.logger = logger;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    for (const tenant of listTenants(this.db)) {
      if (tenant.status !== 'active') continue;
      if (this.refuseCloudNumber(tenant)) continue;
      await this.connect(tenant);
    }
  }

  /**
   * رفض فتح جلسة Baileys لرقم مسجَّل في Meta Cloud API.
   *
   * Baileys عميل غير رسمي مبني على هندسة عكسية لواتساب ويب، وواتساب يوقف
   * الأرقام بسببه. رقم مسجَّل رسمياً في Meta — كرقم موحّد 9200 — لا يجوز
   * مسحه بـQR إطلاقاً: هذا هو الفعل الوحيد في النظام كله الذي قد يُفقدك
   * الرقم. لذلك نمنعه في الكود ولا نكتفي بتحذير في التوثيق.
   */
  private refuseCloudNumber(tenant: TenantRow): boolean {
    if (!tenant.wa_phone_number_id) return false;
    this.logger.error(
      `رُفض فتح جلسة QR للمنشأة «${tenant.name}» (${tenant.wa_number}): الرقم مسجَّل في Meta Cloud API. ` +
        'مسحه بـBaileys قد يعرّض الرقم للإيقاف — استعملي WA_PROVIDER=cloud لهذه المنشأة.',
      undefined,
      { tenant: tenant.id },
    );
    this.sessions.set(tenant.id, {
      tenant,
      socket: null,
      connected: false,
      detail: 'مرفوض: رقم Cloud API لا يُمسح بـQR',
      stopping: true,
    });
    return true;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.stopping = true;
      try {
        session.socket?.end(undefined);
      } catch {
        // الإغلاق أثناء انقطاع الشبكة يرمي أحياناً — لا يهم عند الإيقاف.
      }
    }
    this.sessions.clear();
  }

  async refreshTenant(tenantId: number): Promise<void> {
    const tenant = listTenants(this.db).find((t) => t.id === tenantId);
    if (!tenant || tenant.status !== 'active') return;
    if (this.sessions.has(tenantId)) return;
    if (this.refuseCloudNumber(tenant)) return;
    await this.connect(tenant);
  }

  status(tenantId: number): ProviderStatus {
    const session = this.sessions.get(tenantId);
    if (!session) return { provider: this.name, connected: false, detail: 'لا توجد جلسة لهذه المنشأة' };
    return { provider: this.name, connected: session.connected, qr: session.qr, detail: session.detail };
  }

  async sendText(tenantId: number, to: string, text: string): Promise<SendResult> {
    const session = this.sessions.get(tenantId);
    if (!session?.socket || !session.connected) {
      throw new Error(`رقم المنشأة ${tenantId} غير متصل بواتساب حالياً.`);
    }
    const result = await withRetry(
      async () => session.socket!.sendMessage(toJid(to), { text }),
      {
        onRetry: (attempt, error) =>
          this.logger.warn('فشل إرسال رسالة، إعادة المحاولة', {
            tenant: tenantId,
            محاولة: attempt,
            سبب: String(error),
          }),
      },
    );
    return { id: result?.key?.id ?? '' };
  }

  /* ---------------------------------------------------------------
     الاتصال
  --------------------------------------------------------------- */

  private async connect(tenant: TenantRow): Promise<void> {
    const dir = join(this.authDir, String(tenant.id));
    mkdirSync(dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();

    const session: Session = this.sessions.get(tenant.id) ?? {
      tenant,
      socket: null,
      connected: false,
      detail: 'جارٍ الاتصال…',
      stopping: false,
    };
    this.sessions.set(tenant.id, session);

    const socket = makeWASocket({
      version,
      auth: state,
      logger: QUIET_LOGGER as never,
      // نطبع QR بأنفسنا لأننا نحتاجه أيضاً في صفحة الأدمن لا في الطرفية فقط.
      printQRInTerminal: false,
      browser: ['منصة بوت واتساب', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    session.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.qr = qr;
        session.detail = 'امسحي رمز QR من واتساب › الأجهزة المرتبطة';
        this.logger.info(`رمز QR للمنشأة «${tenant.name}» — امسحيه من واتساب › الأجهزة المرتبطة`, {
          tenant: tenant.id,
        });
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        session.connected = true;
        session.qr = undefined;
        session.detail = 'متصل';
        this.logger.info(`اتصل رقم المنشأة «${tenant.name}» بواتساب`, { tenant: tenant.id });
        this.syncNumber(session, socket);
      }

      if (connection === 'close') {
        session.connected = false;
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const loggedOut = status === DisconnectReason.loggedOut;
        session.detail = loggedOut ? 'تم تسجيل الخروج — يلزم مسح QR من جديد' : 'انقطع الاتصال، إعادة المحاولة…';
        this.logger.warn('انقطع اتصال واتساب', { tenant: tenant.id, حالة: status ?? 'غير معروفة' });

        if (loggedOut) {
          // الجلسة باطلة: نحذفها من الذاكرة حتى يُنشئ الأدمن جلسة جديدة بـQR.
          this.sessions.delete(tenant.id);
          return;
        }
        if (!session.stopping) {
          setTimeout(() => {
            void this.connect(tenant).catch((error) =>
              this.logger.error('فشل إعادة الاتصال', error, { tenant: tenant.id }),
            );
          }, 3000);
        }
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        void this.handleRaw(tenant, message).catch((error) =>
          this.logger.error('فشل معالجة رسالة واردة', error, { tenant: tenant.id }),
        );
      }
    });
  }

  /**
   * يلتقط الرقم الحقيقي من الجلسة بعد المسح ويحدّث سجل المنشأة.
   *
   * بدون هذا يبقى في القاعدة الرقم الذي كُتب يدوياً عند الإنشاء — وهو غالباً
   * رقم مؤقت أو خاطئ. التوجيه يعمل رغم ذلك (الجلسة مربوطة برقم المنشأة لا
   * بالرقم نفسه)، لكن اللوحة تعرض رقماً كاذباً والانتقال لـCloud API ينكسر.
   */
  private syncNumber(session: Session, socket: WASocket): void {
    const raw = socket.user?.id;
    if (!raw) return;

    // معرّف Baileys قد يكون 9665…:12@s.whatsapp.net — نأخذ الأرقام قبل النقطتين.
    const actual = normalizeNumber((raw.split(':')[0] ?? '').split('@')[0] ?? '');
    if (!actual || actual === session.tenant.wa_number) return;

    try {
      this.db.prepare('UPDATE tenants SET wa_number = ? WHERE id = ?').run(actual, session.tenant.id);
      this.logger.info(
        `حُدّث رقم المنشأة «${session.tenant.name}» من ${session.tenant.wa_number} إلى ${actual} حسب الرقم الممسوح`,
        { tenant: session.tenant.id },
      );
      session.tenant.wa_number = actual;
    } catch (error) {
      // رقم مستعمل لمنشأة أخرى: لا ندهسه، ننبّه ونُبقي التوجيه عاملاً بالقديم.
      this.logger.error(
        `الرقم ${actual} مسجَّل لمنشأة أخرى — صحّحي الأرقام من لوحة الأدمن`,
        error,
        { tenant: session.tenant.id },
      );
      session.detail = `تحذير: الرقم ${actual} مسجَّل لمنشأة أخرى`;
    }
  }

  private async handleRaw(tenant: TenantRow, message: WAMessage): Promise<void> {
    if (!this.handler) return;
    const jid = message.key.remoteJid ?? '';
    // المجموعات والحالات والبثّ خارج نطاق المنتج — الرد عليها يُربك العملاء.
    if (!jid.endsWith('@s.whatsapp.net')) return;

    const audioMessage = message.message?.audioMessage;
    const text = extractText(message);
    if (!text && !audioMessage) return;

    const incoming: IncomingMessage = {
      toNumber: tenant.wa_number,
      from: fromJid(jid),
      pushName: message.pushName ?? undefined,
      text: text ?? undefined,
      waMessageId: message.key.id ?? undefined,
      fromMe: message.key.fromMe === true,
    };

    if (audioMessage) {
      incoming.audio = {
        mimeType: audioMessage.mimetype ?? 'audio/ogg',
        download: async () => {
          const buffer = await downloadMediaMessage(message, 'buffer', {});
          return buffer as Buffer;
        },
      };
    }

    await this.handler(incoming);
  }
}
