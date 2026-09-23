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

  /* --- المحادثات --- */
  app.get('/api/tenants/:tenantId/conversations', async (request) => {
    const id = tenantOf(request);
    return db
      .prepare(
        `SELECT c.*,
                CASE WHEN c.silent_until IS NOT NULL AND c.silent_until > ${SQL_NOW} THEN 1 ELSE 0 END AS silent,
                a.display_name AS assigned_name,
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
    const id = tenantOf(request);
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
  app.post('/api/tenants/:tenantId/conversations/:conversationId/bot', async (request) => {
    const id = tenantOf(request);
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
    const id = tenantOf(request);
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
        new Error('وضع «عرض فقط» مُفعَّل — لا يُرسل النظام أي رسالة. أزيلي READ_ONLY من .env للرد.'),
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
    const id = tenantOf(request);
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
    const id = adminOf(request);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    return reply.code(201).send(addKbEntry(db, id, body.question ?? '', body.answer ?? ''));
  });

  app.patch('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = adminOf(request);
    const entryId = Number((request.params as Params & { entryId: string }).entryId);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    updateKbEntry(db, id, entryId, body.question ?? '', body.answer ?? '');
    return { ok: true };
  });

  app.delete('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = adminOf(request);
    deleteKbEntry(db, id, Number((request.params as Params & { entryId: string }).entryId));
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
    return { staff: listStaff(db, id), roles: ROLE_AR, canManage: request.user?.role !== 'agent' };
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
