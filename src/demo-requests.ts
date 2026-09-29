/**
 * طلبات التجربة من صفحة الهبوط.
 *
 * نموذج مفتوح للإنترنت بلا تسجيل دخول — وهذا يعني أنه سيُملأ آلياً.
 * فالحماية ثلاث طبقات لا واحدة: حقل خفي لا يملؤه إلا الآلة، وحدّ
 * لكل عنوان، وحدّ لكل بريد. والرفض صامت في حالة الفخّ: إخبار الآلة
 * بأنها كُشفت يجعلها تجرّب حتى تنجح.
 */

import { SQL_NOW } from './time.ts';
import type { Db } from './db/index.ts';

export interface DemoRequestInput {
  firstName: string;
  lastName?: string;
  email: string;
  company: string;
  phone: string;
  country?: string;
  role?: string;
  teamSize?: string;
  marketingOk?: boolean;
  lang?: string;
  /** الحقل الخفي — أي قيمة فيه تعني آلة. */
  website?: string;
}

export interface DemoRequestRow {
  id: number;
  first_name: string;
  last_name: string | null;
  email: string;
  company: string;
  phone: string;
  country: string | null;
  role: string | null;
  team_size: string | null;
  marketing_ok: number;
  lang: string;
  status: string;
  note: string | null;
  created_at: string;
}

/** بريد صالح شكلاً — لا نتحقق من وجوده، فالتحقق يتم بالتواصل. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function tooMany(db: Db, column: 'source_ip' | 'email', value: string, withinHours: number, limit: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM demo_requests
        WHERE ${column} = ? AND created_at > datetime(${SQL_NOW}, '-${withinHours} hours')`,
    )
    .get(value) as { n: number };
  return row.n >= limit;
}

export interface SubmitResult {
  ok: boolean;
  /** فخّ الآلة: نُظهر النجاح ولا نحفظ. */
  trapped?: boolean;
  id?: number;
}

export function submitDemoRequest(db: Db, input: DemoRequestInput, ip: string): SubmitResult {
  // الفخّ أولاً: لا داعي للتحقق من بيانات آلة.
  if ((input.website ?? '').trim()) return { ok: true, trapped: true };

  const firstName = (input.firstName ?? '').trim();
  const email = (input.email ?? '').trim().toLowerCase();
  const company = (input.company ?? '').trim();
  const phone = (input.phone ?? '').trim();

  if (!firstName) throw Object.assign(new Error('الاسم الأول مطلوب.'), { statusCode: 400 });
  if (!looksLikeEmail(email)) throw Object.assign(new Error('البريد غير صحيح.'), { statusCode: 400 });
  if (!company) throw Object.assign(new Error('اسم المنشأة مطلوب.'), { statusCode: 400 });
  if (phone.replace(/\D/g, '').length < 8) {
    throw Object.assign(new Error('رقم الجوال غير صحيح.'), { statusCode: 400 });
  }

  // الحدّان مقصودان معاً: العنوان يُبدَّل بسهولة، والبريد يُكرَّر بسهولة.
  if (tooMany(db, 'source_ip', ip, 24, 5)) {
    throw Object.assign(new Error('طلبات كثيرة من هذا الجهاز. جرّبي لاحقاً.'), { statusCode: 429 });
  }
  if (tooMany(db, 'email', email, 24, 2)) {
    throw Object.assign(new Error('وصلنا طلبك وسنتواصل معك قريباً.'), { statusCode: 429 });
  }

  const info = db
    .prepare(
      `INSERT INTO demo_requests
         (first_name, last_name, email, company, phone, country, role, team_size, marketing_ok, lang, source_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      firstName,
      (input.lastName ?? '').trim() || null,
      email,
      company,
      phone,
      (input.country ?? '').trim() || null,
      (input.role ?? '').trim() || null,
      (input.teamSize ?? '').trim() || null,
      input.marketingOk ? 1 : 0,
      input.lang === 'en' ? 'en' : 'ar',
      ip,
    );

  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function listDemoRequests(db: Db, limit = 200): DemoRequestRow[] {
  return db
    .prepare(
      `SELECT id, first_name, last_name, email, company, phone, country, role, team_size,
              marketing_ok, lang, status, note, created_at
         FROM demo_requests ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as DemoRequestRow[];
}

const STATUSES = ['new', 'contacted', 'done', 'spam'] as const;

export function updateDemoRequest(db: Db, id: number, status: string, note?: string): void {
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw Object.assign(new Error('حالة غير معروفة.'), { statusCode: 400 });
  }
  const info = db
    .prepare('UPDATE demo_requests SET status = ?, note = COALESCE(?, note) WHERE id = ?')
    .run(status, note?.trim() || null, id);
  if (info.changes === 0) throw Object.assign(new Error('الطلب غير موجود.'), { statusCode: 404 });
}
