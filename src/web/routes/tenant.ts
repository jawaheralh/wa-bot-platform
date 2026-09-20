/**
 * مسارات أدمن المنشأة.
 *
 * كل مسار هنا يبدأ بـrequireTenantAccess، فلا يوجد طريق يقرأ بيانات منشأة
 * بلا تحقق. أدمن النظام يمر من نفس المسارات لأي منشأة.
 */

import type { FastifyInstance } from 'fastify';
import { requireTenantAccess } from '../auth.ts';
import {
  getTenant,
  getConversation,
  recentMessages,
  saveMessage,
  silenceConversation,
  type Db,
} from '../../db/index.ts';
import { statusFor, setConfig, getModule } from '../../modules/registry.ts';
import { listComplaints, updateComplaintStatus, STATUSES, type Status } from '../../modules/complaints.ts';
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
  const tenantOf = (request: { params: unknown; user?: { role: string } }): number => {
    const id = Number((request.params as Params).tenantId);
    if (!Number.isFinite(id)) throw Object.assign(new Error('رقم منشأة غير صالح.'), { statusCode: 400 });
    return requireTenantAccess(request as never, id);
  };

  /* --- نظرة عامة --- */
  app.get('/api/tenants/:tenantId', async (request) => {
    const id = tenantOf(request);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    return {
      tenant,
      connection: provider.status(id),
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

  /* --- المحادثات --- */
  app.get('/api/tenants/:tenantId/conversations', async (request) => {
    const id = tenantOf(request);
    return db
      .prepare(
        `SELECT c.*,
                CASE WHEN c.silent_until IS NOT NULL AND c.silent_until > ${SQL_NOW} THEN 1 ELSE 0 END AS silent,
                (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
         FROM conversations c
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
    return { conversation, messages: recentMessages(db, conversationId, 200) };
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

    const sent = await provider.sendText(id, conversation.customer_wa, text);
    saveMessage(db, conversationId, 'staff', text, { waMessageId: sent.id });
    silenceConversation(db, conversationId, config.silentMinutes);
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
    return updateComplaintStatus(db, id, complaintId, body.status, body.resolution);
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
    const id = tenantOf(request);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    return reply.code(201).send(addKbEntry(db, id, body.question ?? '', body.answer ?? ''));
  });

  app.patch('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = tenantOf(request);
    const entryId = Number((request.params as Params & { entryId: string }).entryId);
    const body = (request.body ?? {}) as { question?: string; answer?: string };
    updateKbEntry(db, id, entryId, body.question ?? '', body.answer ?? '');
    return { ok: true };
  });

  app.delete('/api/tenants/:tenantId/kb/:entryId', async (request) => {
    const id = tenantOf(request);
    deleteKbEntry(db, id, Number((request.params as Params & { entryId: string }).entryId));
    return { ok: true };
  });

  /* --- إعدادات الوحدات --- */
  app.get('/api/tenants/:tenantId/modules', async (request) => {
    const id = tenantOf(request);
    return { modules: statusFor(db, id), supportWhatsApp: config.supportWhatsApp };
  });

  app.put('/api/tenants/:tenantId/modules/:module/config', async (request) => {
    const id = tenantOf(request);
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
