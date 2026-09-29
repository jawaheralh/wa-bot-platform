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
import type { Role } from '../staff.ts';
import { findUser, verifyPassword } from '../tenants.ts';
import type { Db, UserRow } from '../db/index.ts';

const COOKIE = 'wabot_session';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
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
  reply.clearCookie(PENDING, { path: '/' });
}

/* ---------------------------------------------------------------
   الخطوة الوسطى: كلمة المرور صحّت ويبقى رمز التحقق
--------------------------------------------------------------- */

/**
 * كوكي منفصلة قصيرة العمر لا تمنح أي صلاحية.
 *
 * الفصل عن كوكي الجلسة هو الأساس: لو حملت الجلسة نفسها راية «ينقصه
 * التحقق» لكفى خطأ واحد في حارس لاحق ليصير نصف الدخول دخولاً كاملاً.
 * هذه الكوكي لا يقرأها readSession إطلاقاً، فلا تفتح باباً.
 */
const PENDING = 'wabot_pending';
const PENDING_SECONDS = 5 * 60;

export function setPending(reply: FastifyReply, user: UserRow, secure: boolean): void {
  reply.setCookie(PENDING, String(user.id), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    signed: true,
    maxAge: PENDING_SECONDS,
  });
}

export function readPending(db: Db, request: FastifyRequest): UserRow | undefined {
  const raw = request.cookies[PENDING];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return undefined;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(unsigned.value)) as
    | UserRow
    | undefined;
  if (!user || user.active === 0) return undefined;
  return user;
}

export function clearPending(reply: FastifyReply): void {
  reply.clearCookie(PENDING, { path: '/' });
}

export function readSession(db: Db, request: FastifyRequest): SessionUser | undefined {
  const raw = request.cookies[COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return undefined;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(unsigned.value)) as UserRow | undefined;
  // حساب عُطّل أثناء جلسة مفتوحة يجب أن يسقط فوراً لا عند انتهاء الكوكي.
  if (!user || user.active === 0) return undefined;
  return toSession(user);
}

export function login(db: Db, username: string, password: string): UserRow {
  const user = findUser(db, username);
  // نفس الرسالة في الحالتين حتى لا نكشف أي أسماء مستخدمين موجودة.
  // و401 لا 500: فشل الدخول حدث متوقع، ولو عاد 500 لاختلط بأعطال الخادم
  // في السجل والمراقبة، ولتعذّر بناء تحديد معدّل عليه لاحقاً.
  const invalid = Object.assign(new Error('اسم المستخدم أو كلمة المرور غير صحيحة.'), { statusCode: 401 });
  if (!user) throw invalid;
  if (!verifyPassword(password, user.password_hash)) throw invalid;
  if (user.active === 0) {
    throw Object.assign(new Error('هذا الحساب معطَّل — المراجعة مع مالك المنشأة.'), { statusCode: 403 });
  }
  return user;
}

/** يُركّب الحارس على كل مسارات /api عدا الدخول والفحص. */
export function registerAuthGuard(app: FastifyInstance, db: Db): void {
  /**
   * خطوة رمز التحقق مفتوحة بالضرورة: صاحبها لم يحصل على جلسة بعد.
   * ترتيب التسجيل لا يُغني — خطاف preHandler يسري على كل المسارات
   * في هذا السياق مهما سُجّلت قبله.
   */
  const open = new Set(['/api/login', '/api/login/totp', '/api/health', '/api/brand', '/api/demo-request']);

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


/**
 * إدارة الموظفين وقاعدة المعرفة وإعدادات الوحدات لمالك المنشأة فقط.
 * الموظف (agent) يمرّ من requireTenantAccess لكنه يُمنع هنا.
 */
export function requireTenantAdmin(request: FastifyRequest, tenantId: number): number {
  const user = request.user;
  if (!user) throw Object.assign(new Error('يلزم تسجيل الدخول.'), { statusCode: 401 });
  if (user.role === 'system') return tenantId;
  if (user.role === 'tenant' && user.tenantId === tenantId) return tenantId;
  throw Object.assign(new Error('هذه الصلاحية لمالك المنشأة فقط.'), { statusCode: 403 });
}


/* ---------------------------------------------------------------
   تحديد معدّل محاولات الدخول
--------------------------------------------------------------- */

/**
 * صفحة دخول مكشوفة على الإنترنت بلا حدّ للمحاولات تُخمَّن كلمتها بالقوة.
 * عدّاد في الذاكرة يكفي: التشغيل عملية واحدة، وإعادة التشغيل تمسح العدّاد
 * وهذا مقبول لأن المهاجم لا يتحكم بإعادة التشغيل.
 */
const attempts = new Map<string, { count: number; until: number }>();

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60_000;

export function checkLoginRate(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && entry.until > now && entry.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((entry.until - now) / 60_000);
    throw Object.assign(
      new Error(`محاولات كثيرة — المحاولة بعد ${minutes} دقيقة.`),
      { statusCode: 429 },
    );
  }

  if (!entry || entry.until <= now) attempts.set(key, { count: 0, until: now + WINDOW_MS });
}

export function recordLoginFailure(key: string): void {
  const entry = attempts.get(key);
  if (entry) entry.count += 1;
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/**
 * العدّاد حالة على مستوى الوحدة، فملفات الاختبار في العملية الواحدة
 * ترث محاولات بعضها الفاشلة ويسقط ملف سليم بـ٤٢٩ لذنب غيره.
 */
export function resetLoginRate(): void {
  attempts.clear();
}
