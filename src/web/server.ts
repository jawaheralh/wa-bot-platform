/**
 * خادم الويب.
 *
 * مسارات الوحدات تُركَّب هنا تلقائياً من السجل: وحدة تصدّر routes() تحصل
 * على مساراتها بلا تعديل هذا الملف.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { ROOT } from '../config.ts';
import {
  clearSession,
  login,
  readSession,
  registerAuthGuard,
  setSession,
  checkLoginRate,
  recordLoginFailure,
  clearLoginFailures,
} from './auth.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTenantRoutes } from './routes/tenant.ts';
import { MODULES } from '../modules/registry.ts';
import { unwrapProvider } from '../whatsapp/provider.ts';
import { errorMessage } from '../logger.ts';
import { audit } from '../compliance.ts';
import { hashPassword } from '../tenants.ts';

export async function createServer(app: App): Promise<FastifyInstance> {
  const { db, config, logger, provider, notify } = app;

  /**
   * الثقة بالوكيل المحلي وحده.
   *
   * Caddy يتصل من 127.0.0.1، فبدون هذا يصير عنوان كل زائر 127.0.0.1:
   * حدّ محاولات الدخول يتحول إلى عدّاد واحد للعالم كله — يقفله مهاجم
   * فيُمنع كل الموظفين — و request.protocol يصير http فتُرسل كوكي
   * الجلسة بلا علامة secure. والثقة مقصورة على الحلقة المحلية حتى لا
   * ينتحل زائر عنواناً برأس X-Forwarded-For.
   */
  const server = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: '127.0.0.1',
  });
  // فحص الصحة يحتاج التطبيق كاملاً (المزوّد والإعدادات)، لا القاعدة وحدها.
  server.decorate('appRef', app);

  await server.register(cookie, { secret: config.sessionSecret });
  await server.register(formbody);
  await server.register(fastifyStatic, {
    root: join(ROOT, 'public'),
    prefix: '/',
    /**
     * لا تخزين للواجهة.
     *
     * المتصفح يُبقي app.js القديم بعد كل تحديث، فتختفي شاشات أُضيفت
     * للتو ويظن المستخدم أن الميزة لم تُبنَ. الملفات كيلوبايتات قليلة
     * من القرص المحلي، فالتخزين لا يوفّر شيئاً يُذكر مقابل هذا الالتباس.
     */
    setHeaders(reply, path) {
      if (/\.(js|css|html)$/.test(path)) reply.header('cache-control', 'no-cache, must-revalidate');
    },
  });

  /* --- الأخطاء تُعاد كرسائل عربية مفهومة لا كـstack --- */
  server.setErrorHandler(async (error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) logger.error('خطأ في مسار', error, { مسار: request.url });
    else logger.debug('طلب مرفوض', { مسار: request.url, حالة: status });
    await reply.code(status).send({ error: errorMessage(error) });
  });

  /* --- webhook مزوّد Cloud API: قبل حارس المصادقة، فالمتصل هو Meta --- */
  const base = unwrapProvider(provider);
  if (base.name === 'cloud') {
    const { registerCloudWebhook, CloudApiProvider } = await import('../whatsapp/cloud-api.ts');
    if (base instanceof CloudApiProvider) {
      registerCloudWebhook(server, base, config, logger);
      logger.info('سُجّل مسار webhook على /webhook/whatsapp');
    }
  }

  /**
   * العنوان العام لا يُقدّم إلا الـwebhook.
   *
   * النفق يعرّض المنفذ كله، فتصبح لوحة التحكم على الإنترنت لمن يعرف
   * العنوان — وكلمة مرور واحدة كل ما يفصله عن بيانات عملائك. Meta لا
   * تحتاج إلا /webhook/whatsapp، فلا سبب لكشف ما عداه.
   *
   * التمييز بترويسة Host: الطلب من النفق يحملها باسم النطاق العام،
   * ومن جهازك يحملها localhost.
   */
  if (config.publicUrl) {
    const publicHost = new URL(config.publicUrl).host.toLowerCase();

    server.addHook('onRequest', async (request, reply) => {
      const host = String(request.headers.host ?? '').toLowerCase();
      if (host !== publicHost) return;

      const path = (request.url.split('?')[0] ?? '').toLowerCase();
      if (path.startsWith('/webhook/')) return;
      // فتح اللوحة على الإنترنت قرار صريح بمتغيّر مستقل: بدونه لا يصلها
      // الموظفون إلا عبر نفق، ومعه تحرسها كلمة المرور وحدّ المحاولات
      // والكوكي الموقّعة. المتغيّر يجعل الفتح فعلاً مقصوداً لا سهواً.
      if (config.publicPanel) return;

      logger.warn('طلب مرفوض من العنوان العام', { مسار: path, مصدر: request.ip });
      await reply.code(404).send({ error: 'غير موجود.' });
    });

    logger.info(
      config.publicPanel
        ? `اللوحة مفتوحة على ${config.publicUrl} — تحرسها كلمة المرور وحدّ المحاولات`
        : `العنوان العام مقصور على /webhook — لوحة التحكم على ${config.host}:${config.port} فقط`,
    );
  }

  server.get('/api/health', async () => ({ ok: true, provider: provider.name }));

  /* --- الجلسة --- */
  server.post('/api/login', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    // الحدّ على عنوان المصدر لا على اسم المستخدم، وإلا عطّل المهاجم حساب غيره.
    const key = request.ip;
    checkLoginRate(key);

    let user;
    try {
      user = login(db, body.username ?? '', body.password ?? '');
    } catch (error) {
      recordLoginFailure(key);
      logger.warn('محاولة دخول فاشلة', { مصدر: key, مستخدم: body.username ?? '' });
      audit(db, { tenantId: null, action: 'login_failed', username: body.username ?? '', ip: key });
      throw error;
    }

    clearLoginFailures(key);
    setSession(reply, user, request.protocol === 'https');
    logger.info('تسجيل دخول', { مستخدم: user.username, دور: user.role });
    audit(db, {
      tenantId: user.tenant_id,
      userId: user.id,
      username: user.username,
      action: 'login',
      ip: key,
    });
    return { username: user.username, displayName: user.display_name, role: user.role, tenantId: user.tenant_id };
  });

  server.post('/api/logout', async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  registerAuthGuard(server, db);

  server.get('/api/me', async (request) => {
    const user = readSession(db, request);
    if (!user) throw Object.assign(new Error('يلزم تسجيل الدخول.'), { statusCode: 401 });
    return user;
  });

  /**
   * تغيير كلمة مروري أنا.
   *
   * شاشة الفريق تغيّر كلمة الموظف لا كلمة صاحبها، وأدمن النظام ليس
   * موظفاً في أي منشأة فلا تطاله أصلاً — فكان من سلّمناه كلمة مؤقتة
   * محكوماً بها إلى الأبد. وتغيير المالك لكلمة موظفه لا يُغني: من حقّ
   * كلٍّ أن تكون كلمته لا يعرفها سواه.
   *
   * الكلمة الحالية مطلوبة: جهاز مفتوح بلا صاحبه يكفي لاختطاف الحساب.
   */
  server.post('/api/me/password', async (request, reply) => {
    const session = readSession(db, request);
    if (!session) throw Object.assign(new Error('يلزم تسجيل الدخول.'), { statusCode: 401 });

    const body = (request.body ?? {}) as { current?: string; next?: string };
    const current = String(body.current ?? '');
    const next = String(body.next ?? '');

    if (next.length < 10) {
      throw Object.assign(new Error('كلمة المرور يجب ألّا تقل عن ١٠ أحرف.'), { statusCode: 400 });
    }
    if (next === current) {
      throw Object.assign(new Error('الكلمة الجديدة مطابقة للحالية.'), { statusCode: 400 });
    }

    // حدّ المحاولات نفسه: وإلا صار هذا المسار باباً خلفياً لتخمين الكلمة.
    const key = `pw:${request.ip}`;
    checkLoginRate(key);
    try {
      login(db, session.username, current);
    } catch {
      recordLoginFailure(key);
      logger.warn('محاولة تغيير كلمة مرور بكلمة حالية خاطئة', { مستخدم: session.username, مصدر: request.ip });
      throw Object.assign(new Error('كلمة المرور الحالية غير صحيحة.'), { statusCode: 401 });
    }
    clearLoginFailures(key);

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), session.id);
    logger.info('غُيّرت كلمة المرور', { مستخدم: session.username });
    audit(db, {
      tenantId: session.tenantId,
      userId: session.id,
      username: session.username,
      action: 'password_changed',
      ip: request.ip,
    });

    // الجلسة القائمة تسقط: تغيير الكلمة يعني عادةً شكاً في تسرّبها،
    // فالدخول من جديد يثبت أن صاحبها هو من بيده الكلمة الجديدة.
    clearSession(reply);
    return { ok: true };
  });

  registerSystemRoutes(server, db, provider, config);
  registerTenantRoutes(server, db, config, provider);

  /* --- مسارات الوحدات: تُركَّب تلقائياً --- */
  for (const module of MODULES) {
    module.routes?.(server, { db, config, logger, provider, notify });
  }

  return server;
}
