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
import { clearSession, login, readSession, registerAuthGuard, setSession } from './auth.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTenantRoutes } from './routes/tenant.ts';
import { MODULES } from '../modules/registry.ts';
import { errorMessage } from '../logger.ts';

export async function createServer(app: App): Promise<FastifyInstance> {
  const { db, config, logger, provider, notify } = app;

  const server = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  await server.register(cookie, { secret: config.sessionSecret });
  await server.register(formbody);
  await server.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/' });

  /* --- الأخطاء تُعاد كرسائل عربية مفهومة لا كـstack --- */
  server.setErrorHandler(async (error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) logger.error('خطأ في مسار', error, { مسار: request.url });
    else logger.debug('طلب مرفوض', { مسار: request.url, حالة: status });
    await reply.code(status).send({ error: errorMessage(error) });
  });

  /* --- webhook مزوّد Cloud API: قبل حارس المصادقة، فالمتصل هو Meta --- */
  if (provider.name === 'cloud') {
    const { registerCloudWebhook, CloudApiProvider } = await import('../whatsapp/cloud-api.ts');
    if (provider instanceof CloudApiProvider) {
      registerCloudWebhook(server, provider, config, logger);
    }
  }

  server.get('/api/health', async () => ({ ok: true, provider: provider.name }));

  /* --- الجلسة --- */
  server.post('/api/login', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    const user = login(db, body.username ?? '', body.password ?? '');
    setSession(reply, user, request.protocol === 'https');
    logger.info('تسجيل دخول', { مستخدم: user.username, دور: user.role });
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

  registerSystemRoutes(server, db, provider);
  registerTenantRoutes(server, db, config, provider);

  /* --- مسارات الوحدات: تُركَّب تلقائياً --- */
  for (const module of MODULES) {
    module.routes?.(server, { db, config, logger, provider, notify });
  }

  return server;
}
