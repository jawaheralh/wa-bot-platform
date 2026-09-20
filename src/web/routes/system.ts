/**
 * مسارات أدمن النظام — إدارة المنشآت وتفعيل وحداتها.
 *
 * هذه الصلاحيات لي وحدي: أدمن المنشأة لا يستطيع تفعيل وحدة لنفسه، وهذا
 * قرار تجاري لا تقني — التفعيل يعني اشتراكاً جديداً.
 */

import type { FastifyInstance } from 'fastify';
import { requireSystemAdmin } from '../auth.ts';
import { createTenant, createUser } from '../../tenants.ts';
import { listTenants, getTenant, normalizeNumber, type Db } from '../../db/index.ts';
import { setEnabled, statusFor } from '../../modules/registry.ts';
import type { WhatsAppProvider } from '../../whatsapp/provider.ts';

export function registerSystemRoutes(app: FastifyInstance, db: Db, provider: WhatsAppProvider): void {
  /** كل المنشآت مع ملخص حالتها. */
  app.get('/api/system/tenants', async (request) => {
    requireSystemAdmin(request);
    return listTenants(db).map((tenant) => {
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM conversations WHERE tenant_id = t.id) AS conversations,
             (SELECT COUNT(*) FROM complaints    WHERE tenant_id = t.id AND status != 'closed') AS openComplaints,
             (SELECT COUNT(*) FROM alerts        WHERE tenant_id = t.id AND seen = 0) AS unseenAlerts
           FROM tenants t WHERE t.id = ?`,
        )
        .get(tenant.id) as { conversations: number; openComplaints: number; unseenAlerts: number };

      return {
        ...tenant,
        ...counts,
        modules: statusFor(db, tenant.id).map((m) => ({ name: m.name, titleAr: m.titleAr, core: m.core, enabled: m.enabled })),
        connection: provider.status(tenant.id),
      };
    });
  });

  app.post('/api/system/tenants', async (request, reply) => {
    requireSystemAdmin(request);
    const body = (request.body ?? {}) as Record<string, string>;

    const tenant = createTenant(db, {
      name: body.name ?? '',
      waNumber: body.waNumber ?? '',
      waPhoneNumberId: body.waPhoneNumberId,
      tone: body.tone === 'formal' ? 'formal' : 'friendly',
      staffWaNumber: body.staffWaNumber,
      notes: body.notes,
      admin:
        body.adminUsername && body.adminPassword
          ? { username: body.adminUsername, password: body.adminPassword, displayName: body.name }
          : undefined,
    });

    // المزوّد يحتاج أن يفتح جلسة للرقم الجديد بلا إعادة تشغيل.
    await provider.refreshTenant?.(tenant.id);

    return reply.code(201).send(tenant);
  });

  app.patch('/api/system/tenants/:id', async (request) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as Record<string, string>;
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    db.prepare(
      `UPDATE tenants SET
         name = COALESCE(?, name),
         wa_number = COALESCE(?, wa_number),
         wa_phone_number_id = COALESCE(?, wa_phone_number_id),
         tone = COALESCE(?, tone),
         staff_wa_number = COALESCE(?, staff_wa_number),
         status = COALESCE(?, status),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
    ).run(
      body.name?.trim() || null,
      body.waNumber ? normalizeNumber(body.waNumber) : null,
      body.waPhoneNumberId?.trim() || null,
      body.tone === 'formal' || body.tone === 'friendly' ? body.tone : null,
      body.staffWaNumber ? normalizeNumber(body.staffWaNumber) : null,
      body.status === 'active' || body.status === 'suspended' ? body.status : null,
      body.notes ?? null,
      id,
    );
    return getTenant(db, id);
  });

  /** تفعيل أو تعطيل وحدة لمنشأة — أدمن النظام فقط. */
  app.post('/api/system/tenants/:id/modules/:module', async (request) => {
    requireSystemAdmin(request);
    const { id, module } = request.params as { id: string; module: string };
    const body = (request.body ?? {}) as { enabled?: boolean };
    setEnabled(db, Number(id), module, body.enabled === true);
    return statusFor(db, Number(id));
  });

  /** مستخدم إضافي لمنشأة. */
  app.post('/api/system/tenants/:id/users', async (request, reply) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as Record<string, string>;
    const user = createUser(db, {
      tenantId: id,
      username: body.username ?? '',
      password: body.password ?? '',
      displayName: body.displayName,
      role: 'tenant',
    });
    return reply.code(201).send({ id: user.id, username: user.username, role: user.role });
  });
}
