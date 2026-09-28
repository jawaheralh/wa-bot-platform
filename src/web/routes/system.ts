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
import type { AppConfig } from '../../config.ts';
import { setEnabled, statusFor } from '../../modules/registry.ts';
import { readEnvFile, writeEnvFile, maskSecret } from '../../env-file.ts';
import { randomBytes } from 'node:crypto';
import type { WhatsAppProvider } from '../../whatsapp/provider.ts';

export function registerSystemRoutes(
  app: FastifyInstance,
  db: Db,
  provider: WhatsAppProvider,
  config: AppConfig,
): void {
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

  /* ---------------------------------------------------------------
     إعدادات التشغيل — لصق المفاتيح من اللوحة بدل تحرير .env يدوياً
  --------------------------------------------------------------- */

  /** الحقول التي تُحرَّر من اللوحة. الأسرار تُعاد محجوبة أبداً. */
  const EDITABLE = [
    { key: 'WA_PROVIDER', label: 'طريقة الربط', secret: false },
    { key: 'READ_ONLY', label: 'وضع عرض فقط', secret: false },
    { key: 'SILENT_ON_FAILURE', label: 'الصمت عند فشل البوت', secret: false },
    { key: 'WA_ACCESS_TOKEN', label: 'توكن Meta الدائم', secret: true },
    { key: 'WA_APP_SECRET', label: 'المفتاح السري للتطبيق', secret: true },
    { key: 'WA_APP_ID', label: 'معرّف التطبيق', secret: false },
    { key: 'WA_BUSINESS_ID', label: 'معرّف النشاط التجاري', secret: false },
    { key: 'WA_VERIFY_TOKEN', label: 'رمز تحقق webhook', secret: false },
    { key: 'ANTHROPIC_API_KEY', label: 'مفتاح Claude', secret: true },
    { key: 'OPENAI_API_KEY', label: 'مفتاح OpenAI (للرسائل الصوتية)', secret: true },
    { key: 'SUPPORT_WHATSAPP', label: 'رقم الدعم', secret: false },
    { key: 'PUBLIC_URL', label: 'العنوان العام (للـwebhook)', secret: false },
  ] as const;

  app.get('/api/system/settings', async (request) => {
    requireSystemAdmin(request);
    const env = readEnvFile();
    return {
      fields: EDITABLE.map((f) => ({
        ...f,
        value: f.secret ? maskSecret(env.get(f.key) ?? '') : (env.get(f.key) ?? ''),
        isSet: Boolean(env.get(f.key)),
      })),
      // الجاري فعلياً في العملية — قد يخالف الملف حتى يُعاد التشغيل
      running: { provider: provider.name, readOnly: String(process.env.READ_ONLY ?? '0') === '1' },
    };
  });

  app.put('/api/system/settings', async (request) => {
    requireSystemAdmin(request);
    const body = (request.body ?? {}) as Record<string, string>;
    const updates = new Map<string, string>();

    for (const field of EDITABLE) {
      const value = body[field.key];
      if (value === undefined) continue;
      const trimmed = String(value).trim();
      // الحقل السري الذي أُعيد محجوباً ولم يُلمس لا يُدهس بقيمة النجوم.
      if (field.secret && (trimmed === '' || trimmed.includes('…') || trimmed.includes('•'))) continue;
      updates.set(field.key, trimmed);
    }

    if (updates.get('WA_PROVIDER') && !['baileys', 'cloud', 'simulator'].includes(updates.get('WA_PROVIDER')!)) {
      throw Object.assign(new Error('طريقة الربط: baileys أو cloud أو simulator.'), { statusCode: 400 });
    }
    const secret = updates.get('WA_APP_SECRET');
    if (secret && !/^[a-f0-9]{32}$/i.test(secret)) {
      throw Object.assign(
        new Error('المفتاح السري ٣٢ خانة ست عشرية. تأكدي من نسخه كاملاً بلا مسافات.'),
        { statusCode: 400 },
      );
    }

    // رمز التحقق نص يختاره المالك؛ نولّده إن كان فارغاً ليكتمل إعداد الـwebhook.
    if (!readEnvFile().get('WA_VERIFY_TOKEN') && !updates.get('WA_VERIFY_TOKEN')) {
      updates.set('WA_VERIFY_TOKEN', randomBytes(16).toString('hex'));
    }

    if (updates.size === 0) return { saved: 0, restartNeeded: false };
    writeEnvFile(updates);
    return { saved: updates.size, restartNeeded: true, keys: [...updates.keys()] };
  });

  /** يختبر توكن Meta الحالي مقابل Graph API. */
  app.post('/api/system/settings/test-meta', async (request) => {
    requireSystemAdmin(request);
    const token = readEnvFile().get('WA_ACCESS_TOKEN');
    if (!token) return { ok: false, message: 'التوكن غير مضبوط.' };

    try {
      const response = await fetch(`https://graph.facebook.com/v23.0/me?access_token=${encodeURIComponent(token)}`);
      const data = (await response.json().catch(() => ({}))) as { name?: string; id?: string; error?: { message?: string } };
      if (response.ok) return { ok: true, message: `التوكن يعمل — ${data.name ?? data.id ?? ''}` };
      return { ok: false, message: data.error?.message ?? `رفضت Meta (${response.status})` };
    } catch (error) {
      return { ok: false, message: `تعذّر الاتصال: ${(error as Error).message}` };
    }
  });

  /* ---------------------------------------------------------------
     حالة الربط مع Meta وضبطه برمجياً
  --------------------------------------------------------------- */

  /** قائمة فحص حيّة: كل بند يُسأل عنه مصدره الحقيقي لا الملف. */
  app.get('/api/system/meta/status', async (request) => {
    requireSystemAdmin(request);
    const meta = await import('../../meta-setup.ts');
    const env = readEnvFile();
    const publicUrl = env.get('PUBLIC_URL') ?? '';

    const tenants = listTenants(db).filter((t) => t.wa_phone_number_id && t.status === 'active');

    const [token, secret, webhook] = await Promise.all([
      meta.checkToken(config),
      meta.checkAppSecret(config),
      config.publicUrl ? meta.checkWebhook(config) : Promise.resolve({ ok: false, message: 'لا يوجد عنوان عام بعد.' }),
    ]);

    const numbers = await Promise.all(
      tenants.map(async (t) => ({
        tenant: t.name,
        ...(await meta.checkPhoneNumber(config, t.wa_phone_number_id!)),
      })),
    );

    return {
      publicUrl,
      verifyToken: env.get('WA_VERIFY_TOKEN') ?? '',
      webhookUrl: publicUrl ? `${publicUrl}/webhook/whatsapp` : '',
      running: { provider: provider.name },
      checks: [
        { key: 'provider', label: 'طريقة الربط', ok: env.get('WA_PROVIDER') === 'cloud',
          message: env.get('WA_PROVIDER') === 'cloud' ? 'cloud ✓' : `الحالي: ${env.get('WA_PROVIDER') ?? 'غير مضبوط'} — يجب cloud` },
        { key: 'token', label: 'توكن Meta', ...token },
        { key: 'secret', label: 'المفتاح السري', ...secret },
        { key: 'publicUrl', label: 'العنوان العام', ok: Boolean(publicUrl),
          message: publicUrl || 'لا يوجد — Cloud API لا يستقبل بدونه.' },
        { key: 'webhook', label: 'الـwebhook لدى Meta', ...webhook },
      ],
      numbers,
    };
  });

  /** يضبط الـwebhook ويشترك حساب واتساب — بديل واجهة Meta. */
  app.post('/api/system/meta/configure-webhook', async (request) => {
    requireSystemAdmin(request);
    const meta = await import('../../meta-setup.ts');
    return meta.configureWebhook(config);
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
