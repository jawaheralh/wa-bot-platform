/**
 * مسارات أدمن المنشأة.
 *
 * كل مسار هنا يبدأ بـrequireTenantAccess، فلا يوجد طريق يقرأ بيانات منشأة
 * بلا تحقق. أدمن النظام يمر من نفس المسارات لأي منشأة.
 */

import type { FastifyInstance } from 'fastify';
import { requireTenantAccess, requireTenantAdmin } from '../auth.ts';
import {
  getTenant,
  getConversation,
  recentMessages,
  saveMessage,
  normalizeNumber,
  toInternational,
  getOrCreateConversation,
  silenceConversation,
  assignConversation,
  markViewing,
  type Db,
} from '../../db/index.ts';
import { listStaff, addStaff, updateStaff, ROLE_AR } from '../../staff.ts';
import { statusFor, setConfig, getModule } from '../../modules/registry.ts';
import {
  listComplaints,
  updateComplaintStatus,
  complaintUpdateText,
  STATUSES,
  type Status,
} from '../../modules/complaints.ts';
import { audit, listAudit, deleteCustomerData, exportCustomerData, ACTION_AR } from '../../compliance.ts';
import { getConfig } from '../../modules/registry.ts';
import { listKb, addKbEntry, updateKbEntry, deleteKbEntry } from '../../modules/inquiries.ts';
import { listHandoffs, resolveHandoffs } from '../../modules/handoff.ts';
import type { AppConfig } from '../../config.ts';
import type { WhatsAppProvider } from '../../whatsapp/provider.ts';
import { SQL_NOW } from '../../time.ts';
import { requirePermission } from '../auth.ts';
import { PERMISSIONS } from '../../permissions.ts';
import { readBranding, saveColors, storeLogo, removeLogo, readLogo, paletteFor } from '../../branding.ts';
import { readProfile, updateProfile, setPhoto, VERTICALS } from '../../wa-profile.ts';
import { credentialsFor } from '../../tenant-meta.ts';

interface Params {
  tenantId: string;
}

export function registerTenantRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
  provider: WhatsAppProvider,
): void {
  /** أي مستخدم في هذه المنشأة — موظفاً كان أو مالكاً. */
  const tenantOf = (request: { params: unknown; user?: { role: string } }): number => {
    const id = Number((request.params as Params).tenantId);
    if (!Number.isFinite(id)) throw Object.assign(new Error('رقم منشأة غير صالح.'), { statusCode: 400 });
    return requireTenantAccess(request as never, id);
  };

  /** فعلٌ يحتاج صلاحية بعينها — المالك يمرّ دائماً. */
  const allowed = (key: string) => (request: { params: unknown; user?: { role: string } }): number => {
    const id = Number((request.params as Params).tenantId);
    if (!Number.isFinite(id)) throw Object.assign(new Error('رقم منشأة غير صالح.'), { statusCode: 400 });
    return requirePermission(request as never, id, key);
  };

  /** المالك وحده: الموظفون وقاعدة المعرفة وإعدادات الوحدات. */
  const adminOf = (request: { params: unknown; user?: { role: string } }): number => {
    const id = Number((request.params as Params).tenantId);
    if (!Number.isFinite(id)) throw Object.assign(new Error('رقم منشأة غير صالح.'), { statusCode: 400 });
    return requireTenantAdmin(request as never, id);
  };

  /* --- نظرة عامة --- */
  app.get('/api/tenants/:tenantId', async (request) => {
    const id = tenantOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    return {
      tenant,
      connection: provider.status(id),
      readOnly: config.readOnly,
      supportWhatsApp: config.supportWhatsApp,
      modules: statusFor(db, id),
      stats: db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?) AS conversations,
             (SELECT COUNT(*) FROM complaints WHERE tenant_id = ? AND status = 'new') AS newComplaints,
             (SELECT COUNT(*) FROM handoffs WHERE tenant_id = ? AND resolved_at IS NULL) AS openHandoffs,
             (SELECT COUNT(*) FROM alerts WHERE tenant_id = ? AND seen = 0) AS unseenAlerts`,
        )
        .get(id, id, id, id),
    };
  });

  /**
   * رمز QR مرسوماً SVG ليُمسح من المتصفح مباشرة.
   * عرضه كنص خام في اللوحة لا يُمسح، وإجبار المستخدم على الطرفية لمجرد
   * رؤية مربع أبيض وأسود عائق بلا سبب.
   */
  app.get('/api/tenants/:tenantId/qr', async (request, reply) => {
    const id = tenantOf(request);
    const status = provider.status(id);
    if (!status.qr) {
      return reply.code(404).send({ error: status.connected ? 'الرقم متصل بالفعل.' : 'لا يوجد رمز حالياً.' });
    }
    const { toString } = await import('qrcode');
    const svg = await toString(status.qr, { type: 'svg', margin: 1, width: 320 });
    return reply.type('image/svg+xml').header('cache-control', 'no-store').send(svg);
  });

  /**
   * ملف أرسله عميل — يُقدَّم للموظف المصرَّح له وحده.
   * المسار يُتحقق منه مقابل قاعدة البيانات لا من الطلب، فلا يستطيع أحد
   * قراءة ملف منشأة أخرى بتخمين المسار.
   */
  app.get('/api/tenants/:tenantId/media/:messageId', async (request, reply) => {
    const id = tenantOf(request);
    const messageId = Number((request.params as Params & { messageId: string }).messageId);

    const row = db
      .prepare(
        `SELECT m.media_path, m.media_mime, m.media_name
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND c.tenant_id = ?`,
      )
      .get(messageId, id) as { media_path: string | null; media_mime: string | null; media_name: string | null } | undefined;

    if (!row?.media_path) throw Object.assign(new Error('الملف غير موجود.'), { statusCode: 404 });

    const { readStored } = await import('../../media.ts');
    const file = readStored(config.dbPath, row.media_path);
    if (!file) throw Object.assign(new Error('الملف لم يعد موجوداً على القرص.'), { statusCode: 404 });

    const { createReadStream } = await import('node:fs');
    return reply
      .type(row.media_mime ?? 'application/octet-stream')
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.media_name ?? 'file')}`)
      .header('cache-control', 'private, max-age=300')
      .send(createReadStream(file.path));
  });

  /* --- المحادثات --- */
  app.get('/api/tenants/:tenantId/conversations', async (request) => {
    const id = tenantOf(request);
    return db
      .prepare(
        `SELECT c.*,
                CASE WHEN c.silent_until IS NOT NULL AND c.silent_until > ${SQL_NOW} THEN 1 ELSE 0 END AS silent,
                a.display_name AS assigned_name,
                c.customer_city, c.contact_phone,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
         FROM conversations c
         LEFT JOIN users a ON a.id = c.assigned_to
         WHERE c.tenant_id = ?
         ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
         LIMIT 100`,
      )
      .all(id);
  });

  app.get('/api/tenants/:tenantId/conversations/:conversationId', async (request) => {
    const id = tenantOf(request);
    const conversationId = Number((request.params as Params & { conversationId: string }).conversationId);
    const conversation = getConversation(db, conversationId);
    if (!conversation || conversation.tenant_id !== id) {
      throw Object.assign(new Error('المحادثة غير موجودة.'), { statusCode: 404 });
    }
    // نلتقط مَن كان يعرضها **قبل** أن نسجّل فتحنا نحن، وإلا رأى كل موظف اسمه هو.
    const previousViewer =
      conversation.viewing_user_id && conversation.viewing_user_id !== request.user?.id
        ? (db
            .prepare(
              `SELECT u.display_name,
                      CAST((julianday(${SQL_NOW}) - julianday(?)) * 86400 AS INTEGER) AS seconds
               FROM users u WHERE u.id = ?`,
            )
            .get(conversation.viewing_at, conversation.viewing_user_id) as
            | { display_name: string; seconds: number }
            | undefined)
        : undefined;

    if (request.user) markViewing(db, conversationId, request.user.id);

    const messages = db
      .prepare(
        `SELECT m.*, u.display_name AS author_name
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 200`,
      )
      .all(conversationId)
      .reverse();

    const assignee = conversation.assigned_to
      ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(conversation.assigned_to) as
          | { display_name: string }
          | undefined)
      : undefined;

    return {
      conversation,
      messages,
      assigneeName: assignee?.display_name ?? null,
      // خلال دقيقتين فقط — تحذير من رد مزدوج على نفس العميل.
      viewer: previousViewer && previousViewer.seconds < 120 ? previousViewer : null,
    };
  });

  /* --- إسناد المحادثة لموظف --- */
  app.post('/api/tenants/:tenantId/conversations/:conversationId/assign', async (request) => {
    const id = allowed('assign')(request);
    const conversationId = Number((request.params as Params & { conversationId: string }).conversationId);
    const conversation = getConversation(db, conversationId);
    if (!conversation || conversation.tenant_id !== id) {
      throw Object.assign(new Error('المحادثة غير موجودة.'), { statusCode: 404 });
    }

    const raw = (request.body as { userId?: number | null })?.userId;
    const userId = raw === null || raw === undefined ? null : Number(raw);

    if (userId !== null) {
      const staff = listStaff(db, id).find((s) => s.id === userId && s.active);
      if (!staff) throw Object.assign(new Error('الموظف غير موجود أو معطَّل.'), { statusCode: 400 });
    }

    assignConversation(db, conversationId, userId);
    return getConversation(db, conversationId);
  });

  /** إيقاف أو تشغيل البوت لمحادثة بعينها. */
  /**
   * وسم المحادثة كتجربة — أو رفع الوسم.
   *
   * الوسم هو الشرط الوحيد لحذفها لاحقاً بزر «حذف بيانات التجربة».
   * جعله يدوياً مقصود: تخمين النظام «هذه تبدو تجريبية» يخطئ يوماً على
   * عميل حقيقي، والحذف لا يُسترجع.
   */
  app.post('/api/tenants/:tenantId/conversations/:conversationId/test', async (request) => {
    const id = tenantOf(request);
    const conversationId = Number((request.params as Params & { conversationId: string }).conversationId);
    const isTest = (request.body as { isTest?: boolean })?.isTest === true;

    const { markConversation } = await import('../../test-data.ts');
    markConversation(db, id, conversationId, isTest);

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'mark_test',
      ip: request.ip,
    });
    return getConversation(db, conversationId);
  });

  app.post('/api/tenants/:tenantId/conversations/:conversationId/bot', async (request) => {
    const id = allowed('bot')(request);
    const conversationId = Number((request.params as Params & { conversationId: string }).conversationId);
    const conversation = getConversation(db, conversationId);
    if (!conversation || conversation.tenant_id !== id) {
      throw Object.assign(new Error('المحادثة غير موجودة.'), { statusCode: 404 });
    }

    const enabled = (request.body as { enabled?: boolean })?.enabled === true;
    // التشغيل يرفع الصمت المؤقت أيضاً، وإلا بدا الزر معطّلاً بلا سبب ظاهر.
    db.prepare('UPDATE conversations SET bot_enabled = ?, silent_until = ? WHERE id = ?').run(
      enabled ? 1 : 0,
      enabled ? null : conversation.silent_until,
      conversationId,
    );
    if (enabled) resolveHandoffs(db, id, conversationId);
    return getConversation(db, conversationId);
  });

  /** الموظف يرسل رسالة يدوية من اللوحة — يُسكت البوت تلقائياً. */
  app.post('/api/tenants/:tenantId/conversations/:conversationId/reply', async (request) => {
    const id = allowed('reply')(request);
    const conversationId = Number((request.params as Params & { conversationId: string }).conversationId);
    const conversation = getConversation(db, conversationId);
    if (!conversation || conversation.tenant_id !== id) {
      throw Object.assign(new Error('المحادثة غير موجودة.'), { statusCode: 404 });
    }

    const text = String((request.body as { text?: string })?.text ?? '').trim();
    if (!text) throw Object.assign(new Error('نص الرسالة مطلوب.'), { statusCode: 400 });

    // الغلاف يحجب الإرسال على أي حال، لكن السكوت هنا يوهم الموظف أن رده وصل.
    if (config.readOnly) {
      throw Object.assign(
        new Error('وضع «عرض فقط» مُفعَّل — لا يُرسل النظام أي رسالة. تُحذف READ_ONLY من .env للرد.'),
        { statusCode: 409 },
      );
    }

    const sent = await provider.sendText(id, conversation.customer_wa, text);
    saveMessage(db, conversationId, 'staff', text, { waMessageId: sent.id, userId: request.user?.id ?? null });
    silenceConversation(db, conversationId, config.silentMinutes);
    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'manual_reply',
      target: conversation.customer_wa,
      ip: request.ip,
    });

    // من يرد يصبح مسؤولاً عنها ما لم تكن مُسندة لغيره صراحةً.
    if (!conversation.assigned_to && request.user) {
      assignConversation(db, conversationId, request.user.id);
    }
    return { ok: true };
  });

  /* --- الشكاوى --- */
  app.get('/api/tenants/:tenantId/complaints', async (request) => {
    const id = tenantOf(request);
    const status = (request.query as { status?: string })?.status;
    return listComplaints(db, id, STATUSES.includes(status as Status) ? (status as Status) : undefined);
  });

  app.patch('/api/tenants/:tenantId/complaints/:complaintId', async (request) => {
    const id = allowed('cases')(request);
    const complaintId = Number((request.params as Params & { complaintId: string }).complaintId);
    const body = (request.body ?? {}) as { status?: Status; resolution?: string };
    if (!body.status) throw Object.assign(new Error('الحالة مطلوبة.'), { statusCode: 400 });

    const before = db.prepare('SELECT status FROM complaints WHERE id = ? AND tenant_id = ?').get(complaintId, id) as
      | { status: Status }
      | undefined;
    const complaint = updateComplaintStatus(db, id, complaintId, body.status, body.resolution);

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'status_change',
      target: complaint.reference,
      detail: `${before?.status ?? '؟'} ← ${complaint.status}`,
      ip: request.ip,
    });

    /* --- إبلاغ العميل على واتساب بتغيير حالة شكواه --- */
    let notice: { sent: boolean; reason?: string } = { sent: false, reason: 'الحالة لم تتغير.' };
    const notifyEnabled = (getConfig(db, id, 'complaints') as { notifyCustomer?: boolean }).notifyCustomer !== false;

    if (!notifyEnabled) {
      notice = { sent: false, reason: 'إبلاغ العميل معطَّل لهذه المنشأة.' };
    } else if (before?.status !== complaint.status && complaint.notified_status !== complaint.status) {
      const tenant = getTenant(db, id)!;
      try {
        await provider.sendText(id, complaint.customer_wa, complaintUpdateText(complaint, tenant.name));
        db.prepare('UPDATE complaints SET notified_status = ? WHERE id = ?').run(complaint.status, complaint.id);
        notice = { sent: true };
      } catch (error) {
        // الفشل وارد على Cloud API خارج نافذة ٢٤ ساعة — لا نوهم الموظف أن العميل عَلِم.
        notice = { sent: false, reason: (error as Error).message };
      }
    }

    return { complaint, notice };
  });

  /* --- التحويلات --- */
  app.get('/api/tenants/:tenantId/handoffs', async (request) => {
    const id = tenantOf(request);
    return listHandoffs(db, id, (request.query as { open?: string })?.open === '1');
  });

  /* --- قاعدة المعرفة --- */
  app.get('/api/tenants/:tenantId/kb', async (request) => {
    return listKb(db, tenantOf(request));
  });

  app.post('/api/tenants/:tenantId/kb', async (request, reply) => {
    const id = allowed('knowledge')(request);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    return reply.code(201).send(addKbEntry(db, id, body.question ?? '', body.answer ?? ''));
  });

  app.patch('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = allowed('knowledge')(request);
    const entryId = Number((request.params as Params & { entryId: string }).entryId);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    updateKbEntry(db, id, entryId, body.question ?? '', body.answer ?? '');
    return { ok: true };
  });

  app.delete('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = allowed('knowledge')(request);
    deleteKbEntry(db, id, Number((request.params as Params & { entryId: string }).entryId));
    return { ok: true };
  });

  /* --- تدريب البوت: أسئلة عجز عنها --- */
  app.get('/api/tenants/:tenantId/gaps', async (request) => {
    const id = tenantOf(request);
    const { listGaps, gapSummary, similarGaps } = await import('../../training.ts');
    const status = (request.query as { status?: string })?.status ?? 'open';
    const gaps = listGaps(db, id, status as never);
    return {
      gaps: gaps.map((gap) => ({
        ...gap,
        similar: status === 'open' ? similarGaps(db, id, gap).map((g) => ({ id: g.id, question: g.question })) : [],
      })),
      summary: gapSummary(db, id),
    };
  });

  /** جواب لسؤال ناقص: يُضاف للمعرفة ويُغلق السؤال في خطوة واحدة. */
  app.post('/api/tenants/:tenantId/gaps/:gapId/answer', async (request) => {
    const id = allowed('knowledge')(request);
    const gapId = Number((request.params as Params & { gapId: string }).gapId);
    const body = (request.body ?? {}) as { question?: string; answer?: string };

    const { listGaps, setGapStatus } = await import('../../training.ts');
    const gap = listGaps(db, id, 'all').find((g) => g.id === gapId);
    if (!gap) throw Object.assign(new Error('السؤال غير موجود.'), { statusCode: 404 });

    const entry = addKbEntry(db, id, (body.question ?? gap.question).trim(), (body.answer ?? '').trim());
    setGapStatus(db, id, gapId, 'answered');

    // الأسئلة المتشابهة يكفيها نفس الجواب — إغلاقها يوفّر كتابته مرات.
    const { similarGaps } = await import('../../training.ts');
    const closed: string[] = [];
    for (const similar of similarGaps(db, id, gap)) {
      setGapStatus(db, id, similar.id, 'answered');
      closed.push(similar.question);
    }

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'kb_change',
      target: 'تدريب',
      detail: `أُجيب عن: ${gap.question.slice(0, 60)}`,
      ip: request.ip,
    });
    return { entry, gapId, closed };
  });

  app.patch('/api/tenants/:tenantId/gaps/:gapId', async (request) => {
    const id = allowed('knowledge')(request);
    const gapId = Number((request.params as Params & { gapId: string }).gapId);
    const status = (request.body as { status?: string })?.status;
    if (status !== 'open' && status !== 'ignored' && status !== 'answered') {
      throw Object.assign(new Error('حالة غير معروفة.'), { statusCode: 400 });
    }
    const { setGapStatus } = await import('../../training.ts');
    setGapStatus(db, id, gapId, status);
    return { ok: true };
  });

  /* --- إعدادات الوحدات --- */
  app.get('/api/tenants/:tenantId/modules', async (request) => {
    const id = tenantOf(request);
    return { modules: statusFor(db, id), supportWhatsApp: config.supportWhatsApp };
  });

  app.put('/api/tenants/:tenantId/modules/:module/config', async (request) => {
    const id = adminOf(request);
    const name = (request.params as Params & { module: string }).module;
    const module = getModule(name);
    if (!module) throw Object.assign(new Error('وحدة غير معروفة.'), { statusCode: 404 });

    // إعداد وحدة معطّلة لا يُحفظ: يوهم أدمن المنشأة أنها تعمل.
    const state = statusFor(db, id).find((m) => m.name === name);
    if (!state?.enabled) {
      throw Object.assign(new Error('الوحدة غير مفعّلة لهذه المنشأة.'), { statusCode: 409 });
    }
    return setConfig(db, id, name, request.body);
  });

  /* --- الموظفون (مالك المنشأة فقط) --- */
  app.get('/api/tenants/:tenantId/staff', async (request) => {
    const id = tenantOf(request);
    // القائمة مرئية للجميع لأن الإسناد يحتاجها؛ التعديل وحده محصور بالمالك.
    return {
      staff: listStaff(db, id),
      roles: ROLE_AR,
      canManage: request.user?.role !== 'agent',
      permissions: PERMISSIONS,
    };
  });

  app.post('/api/tenants/:tenantId/staff', async (request, reply) => {
    const id = adminOf(request);
    const body = (request.body ?? {}) as Record<string, string>;
    const staff = addStaff(db, {
      tenantId: id,
      username: body.username ?? '',
      password: body.password ?? '',
      displayName: body.displayName,
      waNumber: body.waNumber,
      role: body.role === 'tenant' ? 'tenant' : 'agent',
      permissions: Array.isArray((request.body as { permissions?: unknown }).permissions)
        ? ((request.body as { permissions: string[] }).permissions)
        : undefined,
    });
    return reply.code(201).send(staff);
  });

  app.patch('/api/tenants/:tenantId/staff/:userId', async (request) => {
    const id = adminOf(request);
    const userId = Number((request.params as Params & { userId: string }).userId);
    const body = (request.body ?? {}) as Record<string, unknown>;

    // المالك لا يعطّل نفسه بالخطأ فيُقفل على نفسه الباب.
    if (userId === request.user?.id && body.active === false) {
      throw Object.assign(new Error('لا يمكنك تعطيل حسابك أنت.'), { statusCode: 400 });
    }

    return updateStaff(db, id, userId, {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      waNumber: body.waNumber === undefined ? undefined : String(body.waNumber ?? ''),
      role: body.role === 'tenant' || body.role === 'agent' ? body.role : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
      password: typeof body.password === 'string' && body.password ? body.password : undefined,
      permissions: Array.isArray(body.permissions) ? (body.permissions as string[]) : undefined,
    });
  });

  /* --- سجل التدقيق وحقوق أصحاب البيانات (مالك المنشأة فقط) --- */
  app.get('/api/tenants/:tenantId/audit', async (request) => {
    const id = adminOf(request);
    return { entries: listAudit(db, id), actions: ACTION_AR };
  });

  /** حق الاطلاع: كل ما لدينا عن عميل. */
  app.get('/api/tenants/:tenantId/customers/:number/export', async (request) => {
    const id = adminOf(request);
    const number = (request.params as Params & { number: string }).number;
    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'export_customer',
      target: number,
      ip: request.ip,
    });
    return exportCustomerData(db, id, number);
  });

  /** حق المحو: حذف فعلي لكل بيانات عميل في هذه المنشأة. */
  app.delete('/api/tenants/:tenantId/customers/:number', async (request) => {
    const id = adminOf(request);
    const number = (request.params as Params & { number: string }).number;
    const report = deleteCustomerData(db, id, number);
    // يُسجَّل بعد الحذف: السجل نفسه لا يحتوي محتوى، والرقم ضروري لإثبات الاستجابة.
    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'delete_customer',
      target: report.customerWa,
      detail: `محادثات ${report.conversations} · رسائل ${report.messages} · شكاوى ${report.complaints} · طلبات ${report.requests} · مواعيد ${report.bookings}`,
      ip: request.ip,
    });
    return report;
  });

  /** مدة الاحتفاظ بالرسائل. */
  app.put('/api/tenants/:tenantId/retention', async (request) => {
    const id = adminOf(request);
    const days = Number((request.body as { days?: number })?.days ?? 0);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      throw Object.assign(new Error('المدة بين ٠ و٣٦٥٠ يوماً. صفر = بلا حذف.'), { statusCode: 400 });
    }
    db.prepare('UPDATE tenants SET retention_days = ? WHERE id = ?').run(Math.round(days), id);
    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username,
      action: 'module_config',
      target: 'retention_days',
      detail: String(Math.round(days)),
      ip: request.ip,
    });
    return getTenant(db, id);
  });

  /**
   * بث مباشر لتغيّرات هذه المنشأة (SSE).
   *
   * SSE لا WebSocket: الاتجاه واحد — الخادم يُعلم المتصفح أن شيئاً
   * تغيّر — و EventSource مدمج في المتصفح بلا مكتبة، ويعيد الاتصال
   * وحده إن انقطع، ويمرّ عبر Caddy كأي استجابة HTTP.
   *
   * ولا تُرسَل البيانات في البث، بل إشارة «تغيّر شيء» فقط. فالمتصفح
   * يطلب ما يعرضه بمساراته المحمية المعتادة — ولا يصير البث قناة
   * ثانية للبيانات تحتاج حراسة مستقلة.
   */
  app.get('/api/tenants/:tenantId/stream', async (request, reply) => {
    const id = tenantOf(request);
    const { subscribe, signatureOf } = await import('../../live.ts');

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Caddy لا يخزّن، لكن وسيطاً آخر قد يفعل فيبتلع البث كله.
      'x-accel-buffering': 'no',
    });

    const write = (event: string, data: unknown): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    write('ready', { signature: signatureOf(db, id) });

    const unsubscribe = subscribe(db, id, (event) => write('change', event));

    /**
     * نبضة كل ٢٥ ثانية.
     *
     * الوسطاء يقطعون اتصالاً صامتاً بعد دقيقة عادةً، فينقطع البث بلا
     * أن يلاحظ أحد — والموظفة تظنّ أن لا جديد.
     */
    const beat = setInterval(() => write('ping', Date.now()), 25_000);
    beat.unref?.();

    const close = (): void => {
      clearInterval(beat);
      unsubscribe();
    };
    request.raw.on('close', close);
    request.raw.on('error', close);

    // لا نُنهي الرد: الاتصال يبقى مفتوحاً حتى يغلقه المتصفح.
    return reply;
  });

  /* ---------------------------------------------------------------
     ملف التأسيس — يملؤه العميل ويُرفع بضغطة
  --------------------------------------------------------------- */

  /** تنزيل الملف الفارغ بالتعليمات والأمثلة. */
  app.get('/api/tenants/:tenantId/onboarding/template', async (request, reply) => {
    const id = tenantOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const { buildTemplate } = await import('../../onboarding.ts');
    const file = buildTemplate(tenant);

    // الاسم يحمل اسم المنشأة: ملفات عدة عملاء تجتمع في مجلد التنزيلات.
    const safe = tenant.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'المنشأة';
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`تأسيس-${safe}.xlsx`)}`)
      .send(file);
  });

  /**
   * رفع الملف بعد ملئه.
   *
   * الحمولة base64 لا multipart: الأخير يحتاج ملحقاً إضافياً لمسار
   * واحد، والملفات هنا كيلوبايتات — نصوص لا صور.
   */
  app.post('/api/tenants/:tenantId/onboarding/import', async (request) => {
    const id = adminOf(request);
    const body = (request.body ?? {}) as { file?: string };
    const raw = String(body.file ?? '');
    if (!raw) throw Object.assign(new Error('لم يصل أي ملف.'), { statusCode: 400 });

    const buffer = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
    if (buffer.length === 0) throw Object.assign(new Error('الملف فارغ.'), { statusCode: 400 });
    if (buffer.length > 5_000_000) {
      throw Object.assign(new Error('الملف أكبر من ٥ ميجا — يلزم أن يكون ملف التأسيس.'), { statusCode: 400 });
    }

    const { importWorkbook } = await import('../../onboarding.ts');
    const result = importWorkbook(db, id, buffer);

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'kb_change',
      ip: request.ip,
    });
    return result;
  });

  /* ---------------------------------------------------------------
     الهوية: اللون والشعار
  --------------------------------------------------------------- */

  /**
   * القراءة لكل من في المنشأة لا للمالك وحده.
   *
   * اللوحة تلبس الهوية عند كل إقلاع، فلو كانت القراءة للمالك لرآها
   * وحده ورأى الموظفون ألوان المنصة — وهم من يفتح الشاشة طول اليوم.
   */
  app.get('/api/tenants/:tenantId/branding', async (request) => {
    const id = tenantOf(request);
    const branding = readBranding(db, id);
    // الاسم معها: مالك المنشأة لا يملك قائمة المنشآت ليقرأ اسمه منها.
    return {
      ...branding,
      name: getTenant(db, id)?.name ?? '',
      logoUrl: branding.logo ? `/api/tenants/${id}/logo` : null,
    };
  });

  /**
   * معاينة بلا حفظ.
   *
   * الاشتقاق يجري في الخادم، فلولا هذا المسار لَلزم تكراره في
   * الجافاسكربت — ونسختان من حسابٍ واحد تفترقان عند أول تعديل،
   * فيرى العميل لوناً في المعاينة وآخر بعد الحفظ.
   */
  app.get('/api/tenants/:tenantId/branding/preview', async (request) => {
    tenantOf(request);
    const query = (request.query ?? {}) as { color?: string; deep?: string };
    return paletteFor(query.color, query.deep);
  });

  app.put('/api/tenants/:tenantId/branding', async (request) => {
    const id = adminOf(request);
    const body = (request.body ?? {}) as { color?: unknown; deep?: unknown };
    const branding = saveColors(db, id, body);

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'branding_change',
      ip: request.ip,
    });
    return { ...branding, logoUrl: branding.logo ? `/api/tenants/${id}/logo` : null };
  });

  /** الحمولة base64 كملف التأسيس — الشعار كيلوبايتات لا ميجابايتات. */
  app.post('/api/tenants/:tenantId/logo', async (request) => {
    const id = adminOf(request);
    const body = (request.body ?? {}) as { file?: string };
    if (!body.file) throw Object.assign(new Error('لم يصل أي ملف.'), { statusCode: 400 });

    const stored = storeLogo(db, config.dbPath, id, body.file);
    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'branding_change',
      ip: request.ip,
    });
    return { ok: true, logoUrl: `/api/tenants/${id}/logo`, bytes: stored.bytes };
  });

  app.delete('/api/tenants/:tenantId/logo', async (request) => {
    const id = adminOf(request);
    removeLogo(db, config.dbPath, id);
    return { ok: true };
  });

  app.get('/api/tenants/:tenantId/logo', async (request, reply) => {
    const id = tenantOf(request);
    const { logo } = readBranding(db, id);
    if (!logo) throw Object.assign(new Error('لا شعار لهذه المنشأة.'), { statusCode: 404 });

    const file = readLogo(config.dbPath, logo);
    if (!file) throw Object.assign(new Error('الشعار غير موجود.'), { statusCode: 404 });

    return reply
      .header('content-type', file.mime)
      // الشعار يتغيّر نادراً، لكنه إن تغيّر وجب أن يُرى فوراً.
      .header('cache-control', 'private, max-age=60')
      .send(file.body);
  });

  /* ---------------------------------------------------------------
     ملفّ واتساب: صورة الرقم ونبذته
  --------------------------------------------------------------- */

  /**
   * هذا ملفّ عام يراه كل من يفتح المحادثة، لا إعداد داخلي.
   *
   * ولذلك هو للمالك وحده حتى في القراءة: بيانات الاتصال والعنوان
   * والبريد ليست مما يراه كل موظف، ولا يحتاجها ليرد على عميل.
   */
  app.get('/api/tenants/:tenantId/wa-profile', async (request) => {
    const id = adminOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const result = await readProfile(
      config,
      credentialsFor(config, tenant),
      tenant.wa_phone_number_id ?? '',
    );
    return { ...result, verticals: VERTICALS };
  });

  app.put('/api/tenants/:tenantId/wa-profile', async (request) => {
    const id = adminOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await updateProfile(config, credentialsFor(config, tenant), tenant.wa_phone_number_id ?? '', {
      about: body.about === undefined ? undefined : String(body.about),
      description: body.description === undefined ? undefined : String(body.description),
      address: body.address === undefined ? undefined : String(body.address),
      email: body.email === undefined ? undefined : String(body.email),
      vertical: body.vertical === undefined ? undefined : String(body.vertical),
      websites: Array.isArray(body.websites) ? body.websites.map(String).filter(Boolean) : undefined,
    });

    if (!result.ok) throw Object.assign(new Error(result.message), { statusCode: 400 });

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'wa_profile_change',
      ip: request.ip,
    });
    return result;
  });

  /**
   * تغيير الصورة فعلٌ ظاهر للعملاء فور تنفيذه.
   *
   * لا يُنفَّذ إلا بطلب صريح من المالك، ويُسجَّل في سجل التدقيق باسمه —
   * فمن غيّر وجه الرقم أمام كل عملائه معروف.
   */
  app.post('/api/tenants/:tenantId/wa-profile/photo', async (request) => {
    const id = adminOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const body = (request.body ?? {}) as { file?: string; useLogo?: boolean };

    /**
     * «استعمل الشعار» يقرأ الملف من القرص لا من المتصفح.
     *
     * الشعار مرفوع عندنا أصلاً، فإعادته إلى المتصفح ليعيده إلينا رحلةٌ
     * بلا فائدة — وتفشل حين يكون كبيراً أو بطيء الشبكة.
     */
    let image: Buffer;
    if (body.useLogo) {
      const { logo } = readBranding(db, id);
      const file = logo ? readLogo(config.dbPath, logo) : undefined;
      if (!file) throw Object.assign(new Error('لا شعار مرفوع لهذه المنشأة.'), { statusCode: 400 });
      image = file.body;
    } else {
      if (!body.file) throw Object.assign(new Error('لم تصل أي صورة.'), { statusCode: 400 });
      image = Buffer.from(String(body.file).replace(/^data:[^,]*,/, ''), 'base64');
    }
    const result = await setPhoto(config, credentialsFor(config, tenant), tenant.wa_phone_number_id ?? '', image);
    if (!result.ok) throw Object.assign(new Error(result.message), { statusCode: 400 });

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'wa_profile_photo',
      ip: request.ip,
    });
    return result;
  });

  /* ---------------------------------------------------------------
     القوالب — مراسلة من لم يراسلنا، أو من انقضت نافذته
  --------------------------------------------------------------- */

  /** القوالب المعتمدة لهذه المنشأة، تُقرأ من Meta مباشرة. */
  app.get('/api/tenants/:tenantId/templates', async (request) => {
    const id = tenantOf(request);
    if (!provider.listTemplates) {
      throw Object.assign(new Error('المزوّد الحالي لا يدعم القوالب.'), { statusCode: 400 });
    }
    return { templates: await provider.listTemplates(id) };
  });

  /**
   * إرسال بقالب — لمحادثة قائمة أو لرقم جديد.
   *
   * الرقم يُقبل مباشرة لأن هذا هو الغرض: مراسلة من لم يراسلنا. وتُنشأ
   * له محادثة لتُحفظ الرسالة في مكانها بدل أن تضيع بلا أثر.
   */
  app.post('/api/tenants/:tenantId/templates/send', async (request) => {
    const id = allowed('templates')(request);
    if (!provider.sendTemplate) {
      throw Object.assign(new Error('المزوّد الحالي لا يدعم القوالب.'), { statusCode: 400 });
    }

    const body = (request.body ?? {}) as {
      to?: string;
      name?: string;
      language?: string;
      variables?: unknown;
    };

    // الموظفة تكتب الرقم كما في دفترها؛ Meta تريده دولياً.
    const to = toInternational(String(body.to ?? ''));
    const name = String(body.name ?? '').trim();
    if (!to) throw Object.assign(new Error('رقم العميل مطلوب.'), { statusCode: 400 });
    if (!name) throw Object.assign(new Error('القالب مطلوب.'), { statusCode: 400 });

    const variables = Array.isArray(body.variables) ? body.variables.map((v) => String(v ?? '').trim()) : [];
    if (variables.some((v) => !v)) {
      throw Object.assign(new Error('متغيّرات القالب غير مكتملة.'), { statusCode: 400 });
    }

    const sent = await provider.sendTemplate(id, to, {
      name,
      language: String(body.language ?? 'ar'),
      variables,
    });

    // تُحفظ باسم الموظفة: رسالة خرجت باسم المنشأة يجب أن يُعرف مرسلها.
    const conversation = getOrCreateConversation(db, id, to);
    const text = variables.length ? `(قالب ${name}) ${variables.join(' · ')}` : `(قالب ${name})`;
    saveMessage(db, conversation.id, 'staff', text, {
      waMessageId: sent.id,
      userId: request.user?.id ?? null,
    });

    audit(db, {
      tenantId: id,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'manual_reply',
      ip: request.ip,
    });

    return { ok: true, conversationId: conversation.id };
  });

  /* --- التنبيهات --- */
  app.get('/api/tenants/:tenantId/alerts', async (request) => {
    const id = tenantOf(request);
    return db.prepare('SELECT * FROM alerts WHERE tenant_id = ? ORDER BY id DESC LIMIT 50').all(id);
  });

  app.post('/api/tenants/:tenantId/alerts/seen', async (request) => {
    const id = tenantOf(request);
    db.prepare('UPDATE alerts SET seen = 1 WHERE tenant_id = ?').run(id);
    return { ok: true };
  });
}
