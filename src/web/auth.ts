/**
 * المصادقة والصلاحيات.
 *
 * دوران فقط: أدمن النظام (أنا، أرى كل المنشآت) وأدمن المنشأة (يرى منشأته).
 * كل مسار تحت /api/tenants/:tenantId يمرّ على requireTenantAccess، فمنع
 * التسريب بين المنشآت قرار مركزي لا يُنسى في مسار جديد.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// الاستيراد لازم لأنواع الكوكي التي يضيفها الملحق لـrequest و reply.
import '@fastify/cookie';
import { findUser, verifyPassword } from '../tenants.ts';
import type { Db, UserRow } from '../db/index.ts';

const COOKIE = 'wabot_session';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: 'system' | 'tenant';
  tenantId: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

function toSession(user: UserRow): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    tenantId: user.tenant_id,
  };
}

export function setSession(reply: FastifyReply, user: UserRow, secure: boolean): void {
  reply.setCookie(COOKIE, String(user.id), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    signed: true,
    maxAge: 60 * 60 * 12,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function readSession(db: Db, request: FastifyRequest): SessionUser | undefined {
  const raw = request.cookies[COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return undefined;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(unsigned.value)) as UserRow | undefined;
  return user ? toSession(user) : undefined;
}

export function login(db: Db, username: string, password: string): UserRow {
  const user = findUser(db, username);
  // نفس الرسالة في الحالتين حتى لا نكشف أي أسماء مستخدمين موجودة.
  const invalid = new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  if (!user) throw invalid;
  if (!verifyPassword(password, user.password_hash)) throw invalid;
  return user;
}

/** يُركّب الحارس على كل مسارات /api عدا الدخول والفحص. */
export function registerAuthGuard(app: FastifyInstance, db: Db): void {
  const open = new Set(['/api/login', '/api/health']);

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0] ?? '';
    if (open.has(path)) return;

    const user = readSession(db, request);
    if (!user) {
      await reply.code(401).send({ error: 'يلزم تسجيل الدخول.' });
      return;
    }
    request.user = user;
  });
}

export function requireSystemAdmin(request: FastifyRequest): SessionUser {
  const user = request.user;
  if (!user || user.role !== 'system') {
    throw Object.assign(new Error('هذه الصفحة لأدمن النظام فقط.'), { statusCode: 403 });
  }
  return user;
}

/**
 * يتحقق أن المستخدم يملك الوصول لهذه المنشأة ويُعيد رقمها.
 * أدمن النظام يصل للكل؛ أدمن المنشأة لمنشأته فقط.
 */
export function requireTenantAccess(request: FastifyRequest, tenantId: number): number {
  const user = request.user;
  if (!user) throw Object.assign(new Error('يلزم تسجيل الدخول.'), { statusCode: 401 });
  if (user.role === 'system') return tenantId;
  if (user.tenantId !== tenantId) {
    throw Object.assign(new Error('لا تملك صلاحية على هذه المنشأة.'), { statusCode: 403 });
  }
  return tenantId;
}
