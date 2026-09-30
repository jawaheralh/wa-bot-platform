/**
 * مسارات أدمن النظام — إدارة المنشآت وتفعيل وحداتها.
 *
 * هذه الصلاحيات لي وحدي: أدمن المنشأة لا يستطيع تفعيل وحدة لنفسه، وهذا
 * قرار تجاري لا تقني — التفعيل يعني اشتراكاً جديداً.
 */

import type { FastifyInstance } from 'fastify';
import { requireSystemAdmin } from '../auth.ts';
import { createTenant, createUser } from '../../tenants.ts';
import { listTenants, getTenant, normalizeNumber, sealSecret, type Db } from '../../db/index.ts';
import type { AppConfig } from '../../config.ts';
import { setEnabled, statusFor } from '../../modules/registry.ts';
import { readEnvFile, writeEnvFile, maskSecret } from '../../env-file.ts';
import { usageThisMonth, usageFor, forgetClaudeCache, estimateInputCost } from '../../tenant-claude.ts';
import { randomBytes } from 'node:crypto';
import type { WhatsAppProvider } from '../../whatsapp/provider.ts';
import { audit } from '../../compliance.ts';

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

      const { wa_access_token, wa_app_secret, anthropic_api_key, ...safe } = tenant;
      return {
        ...safe,
        hasOwnMeta: Boolean(wa_access_token && wa_app_secret),
        hasOwnClaude: Boolean(anthropic_api_key),
        waAccessTokenMasked: maskSecret(wa_access_token ?? ''),
        waAppSecretMasked: maskSecret(wa_app_secret ?? ''),
        anthropicKeyMasked: maskSecret(anthropic_api_key ?? ''),
        usage: usageThisMonth(db, tenant.id),
        cost: estimateInputCost(usageThisMonth(db, tenant.id)),
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
      brandColor: body.brandColor,
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
         wa_access_token = CASE WHEN ? THEN ? ELSE wa_access_token END,
         wa_app_secret   = CASE WHEN ? THEN ? ELSE wa_app_secret END,
         wa_app_id       = CASE WHEN ? THEN ? ELSE wa_app_id END,
         wa_business_id  = CASE WHEN ? THEN ? ELSE wa_business_id END,
         anthropic_api_key = CASE WHEN ? THEN ? ELSE anthropic_api_key END,
         name = COALESCE(?, name),
         wa_number = COALESCE(?, wa_number),
         wa_phone_number_id = COALESCE(?, wa_phone_number_id),
         tone = COALESCE(?, tone),
         staff_wa_number = COALESCE(?, staff_wa_number),
         status = COALESCE(?, status),
         notes = COALESCE(?, notes)
       WHERE id = ?`,
    ).run(
      // السرّ المحجوب المُعاد كما هو لا يُكتب فوق الأصل.
      body.waAccessToken !== undefined && !body.waAccessToken.includes('…') ? 1 : 0,
      // يُشفَّر قبل أن يلمس القرص — القاعدة لا ترى نصّاً صريحاً.
      sealSecret(body.waAccessToken?.trim()),
      body.waAppSecret !== undefined && !body.waAppSecret.includes('…') ? 1 : 0,
      sealSecret(body.waAppSecret?.trim()),
      body.waAppId !== undefined ? 1 : 0,
      body.waAppId?.trim() || null,
      body.waBusinessId !== undefined ? 1 : 0,
      body.waBusinessId?.trim() || null,
      body.anthropicApiKey !== undefined && !body.anthropicApiKey.includes('…') ? 1 : 0,
      sealSecret(body.anthropicApiKey?.trim()),
      body.name?.trim() || null,
      body.waNumber ? normalizeNumber(body.waNumber) : null,
      body.waPhoneNumberId?.trim() || null,
      body.tone === 'formal' || body.tone === 'friendly' ? body.tone : null,
      body.staffWaNumber ? normalizeNumber(body.staffWaNumber) : null,
      body.status === 'active' || body.status === 'suspended' ? body.status : null,
      body.notes ?? null,
      id,
    );
    // المفتاح تغيّر ⇐ العميل المخزَّن لم يعد صالحاً.
    forgetClaudeCache();
    return getTenant(db, id);
  });

  /** استهلاك منشأة عبر الأشهر — للفوترة. */
  app.get('/api/system/tenants/:id/usage', async (request) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const usage = usageFor(db, id);
    return { usage: usage.map((u) => ({ ...u, cost: estimateInputCost(u) })) };
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

    const current = readEnvFile();

    for (const field of EDITABLE) {
      const value = body[field.key];
      if (value === undefined) continue;
      const trimmed = String(value).trim();
      // الحقل السري الذي أُعيد محجوباً ولم يُلمس لا يُدهس بقيمة النجوم.
      if (field.secret && (trimmed === '' || trimmed.includes('…') || trimmed.includes('•'))) continue;
      // القيمة التي لم تتغيّر لا تُحسب: «حُفظت ٨ قيمة» بلا تغيير تُوهم
      // بأن شيئاً جرى وتطلب إعادة تشغيل بلا داعٍ.
      if ((current.get(field.key) ?? '') === trimmed) continue;
      updates.set(field.key, trimmed);
    }

    if (updates.get('WA_PROVIDER') && !['baileys', 'cloud', 'simulator'].includes(updates.get('WA_PROVIDER')!)) {
      throw Object.assign(new Error('طريقة الربط: baileys أو cloud أو simulator.'), { statusCode: 400 });
    }
    const secret = updates.get('WA_APP_SECRET');
    if (secret && !/^[a-f0-9]{32}$/i.test(secret)) {
      throw Object.assign(
        new Error('المفتاح السري ٣٢ خانة ست عشرية. يلزم نسخه كاملاً بلا مسافات.'),
        { statusCode: 400 },
      );
    }

    // رمز التحقق نص يختاره المالك؛ نولّده إن كان فارغاً ليكتمل إعداد الـwebhook.
    if (!current.get('WA_VERIFY_TOKEN') && !updates.get('WA_VERIFY_TOKEN')) {
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

    const { credentialsFor } = await import('../../tenant-meta.ts');

    const [token, secret, webhook] = await Promise.all([
      meta.checkToken(config),
      meta.checkAppSecret(config),
      config.publicUrl ? meta.checkWebhook(config) : Promise.resolve({ ok: false, message: 'لا يوجد عنوان عام بعد.' }),
    ]);

    // كل منشأة تُفحص ببيانات حسابها هي — لا بالحساب العام.
    const numbers = await Promise.all(
      tenants.map(async (t) => {
        const credentials = credentialsFor(config, t);
        const result = await meta.checkPhoneNumberFor(config, credentials, t.wa_phone_number_id!);
        return { tenant: t.name, own: credentials.own, ...result };
      }),
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
  /**
   * إعداد منشأة بعينها — حالتها هي لا حالة النظام.
   *
   * كانت شاشة الإعداد تعرض بيانات النظام العام أياً كانت المنشأة
   * المفتوحة، فيفتح أدمن النظام «مطعم الركن» ويرى توكن «وقودي» —
   * ويظنّ أن المطعم مضبوط وهو لم يُربط بعد.
   *
   * كل فحص هنا يجري ببيانات هذه المنشأة وحدها.
   */
  app.get('/api/system/tenants/:id/setup', async (request) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const meta = await import('../../meta-setup.ts');
    const { credentialsFor } = await import('../../tenant-meta.ts');
    const credentials = credentialsFor(config, tenant);

    const mask = (value: string | null): string => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');

    const checks: { key: string; label: string; ok: boolean; message: string }[] = [];

    if (!credentials.accessToken || !credentials.appSecret) {
      checks.push({
        key: 'credentials',
        label: 'بيانات Meta',
        ok: false,
        message: 'لم تُدخَل بعد — هذه المنشأة لا ترسل ولا تستقبل شيئاً.',
      });
    } else {
      const [token, secret] = await Promise.all([
        meta.checkTokenFor(config, credentials),
        meta.checkAppSecretFor(config, credentials),
      ]);
      checks.push({ key: 'token', label: 'توكن Meta', ok: token.ok, message: token.message });
      checks.push({ key: 'secret', label: 'المفتاح السري', ok: secret.ok, message: secret.message });

      if (tenant.wa_phone_number_id) {
        const number = await meta.checkPhoneNumberFor(config, credentials, tenant.wa_phone_number_id);
        checks.push({ key: 'number', label: 'الرقم لدى Meta', ok: number.ok, message: number.message });
      } else {
        checks.push({
          key: 'number',
          label: 'الرقم لدى Meta',
          ok: false,
          message: 'لا يوجد معرّف رقم (Phone number ID).',
        });
      }
    }

    checks.push({
      key: 'claude',
      label: 'مفتاح Claude',
      ok: Boolean(tenant.anthropic_api_key || config.anthropicApiKey),
      message: tenant.anthropic_api_key
        ? 'مفتاح خاص بهذه المنشأة — مصروفها منفصل.'
        : config.anthropicApiKey
          ? 'تستعمل المفتاح العام — مصروفها على حسابك أنت.'
          : 'لا يوجد مفتاح — البوت لن يرد.',
    });

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        waNumber: tenant.wa_number,
        waPhoneNumberId: tenant.wa_phone_number_id ?? '',
        waAppId: tenant.wa_app_id ?? '',
        waBusinessId: tenant.wa_business_id ?? '',
        tone: tenant.tone,
        staffWaNumber: tenant.staff_wa_number ?? '',
        status: tenant.status,
      },
      secrets: {
        waAccessToken: mask(tenant.wa_access_token),
        waAppSecret: mask(tenant.wa_app_secret),
        anthropicApiKey: mask(tenant.anthropic_api_key),
      },
      own: credentials.own,
      ownClaude: Boolean(tenant.anthropic_api_key),
      publicUrl: config.publicUrl,
      webhookUrl: config.publicUrl ? `${config.publicUrl}/webhook/whatsapp` : '',
      checks,
    };
  });

  /** يسجّل الـwebhook لتطبيق هذه المنشأة وحدها. */
  app.post('/api/system/tenants/:id/configure-webhook', async (request) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const tenant = getTenant(db, id);
    if (!tenant) throw Object.assign(new Error('المنشأة غير موجودة.'), { statusCode: 404 });

    const meta = await import('../../meta-setup.ts');
    const { credentialsFor } = await import('../../tenant-meta.ts');
    const credentials = credentialsFor(config, tenant);

    if (!credentials.appId || !credentials.appSecret) {
      throw Object.assign(
        new Error('يلزم إدخال توكن المنشأة ومفتاحها السري ومعرّف تطبيقها أولاً.'),
        { statusCode: 400 },
      );
    }
    return meta.configureWebhook({ ...config, cloud: { ...config.cloud, ...credentials } });
  });

  /* --- طلبات التجربة من صفحة الهبوط --- */

  app.get('/api/system/demo-requests', async (request) => {
    requireSystemAdmin(request);
    const { listDemoRequests } = await import('../../demo-requests.ts');
    return { requests: listDemoRequests(db) };
  });

  app.patch('/api/system/demo-requests/:id', async (request) => {
    requireSystemAdmin(request);
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { status?: string; note?: string };
    const { updateDemoRequest, listDemoRequests } = await import('../../demo-requests.ts');
    updateDemoRequest(db, id, String(body.status ?? ''), body.note);
    return { requests: listDemoRequests(db) };
  });

  /* ---------------------------------------------------------------
     بيانات التجربة — الحذف الوحيد المسموح في النظام
  --------------------------------------------------------------- */

  /**
   * ما سيُحذف، قبل الحذف.
   *
   * لا يُحذف شيء بلا أن يُرى أولاً: زر حذف لا يُظهر ما يمسّه يُضغط
   * يوماً على بيانات لم يقصدها صاحبه.
   */
  app.get('/api/system/test-data', async (request) => {
    requireSystemAdmin(request);
    const { summarizeTestData } = await import('../../test-data.ts');
    return summarizeTestData(db);
  });

  /**
   * الحذف — للموسوم تجريبياً وحده.
   *
   * ولا يوجد في النظام أي مسار آخر يحذف محادثة أو طلباً. ما لا يحمل
   * الوسم لا سبيل لحذفه من اللوحة إطلاقاً، وهذا قيد مقصود.
   */
  app.delete('/api/system/test-data', async (request) => {
    requireSystemAdmin(request);
    const { deleteTestData } = await import('../../test-data.ts');
    const removed = deleteTestData(db);

    audit(db, {
      tenantId: null,
      userId: request.user?.id,
      username: request.user?.username ?? '',
      action: 'purge_test_data',
      ip: request.ip,
    });
    return removed;
  });

  app.post('/api/system/meta/configure-webhook', async (request) => {
    requireSystemAdmin(request);
    const meta = await import('../../meta-setup.ts');
    const { tenantsByApp } = await import('../../tenant-meta.ts');
    const groups = tenantsByApp(db, config);
    // بلا منشآت مضبوطة: نرجع للتطبيق العام حتى لا يبقى الزر بلا أثر.
    if (groups.size === 0) return meta.configureWebhook(config);
    return meta.configureAllWebhooks(config, groups);
  });

  /** فحص الصحة الآن — لا ينتظر النبضة. */
  app.get('/api/system/health', async (request) => {
    requireSystemAdmin(request);
    const { runHealthCheck, worstOf } = await import('../../health.ts');
    const app_ = (request.server as unknown as { appRef: Parameters<typeof runHealthCheck>[0] }).appRef;
    const checks = await runHealthCheck(app_);
    const history = db.prepare('SELECT * FROM health_log ORDER BY id DESC LIMIT 20').all();
    return { checks, severity: worstOf(checks), history };
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
