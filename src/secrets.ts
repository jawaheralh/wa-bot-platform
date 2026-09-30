/**
 * تشفير أسرار المنشآت في قاعدة البيانات.
 *
 * توكن ميتا لعميلٍ يُرسل باسمه لكل من يملكه، ومفتاح Claude يُنفق من
 * رصيده. وكانا نصّاً صريحاً في ملف القاعدة: من يصل للملف — بنسخةٍ
 * احتياطية مسروقة أو بخطأ صلاحيات — يرسل باسم كل عميل عندنا.
 *
 * ## AES-256-GCM لا CBC
 *
 * GCM يوثّق النصّ المشفَّر: تعديل بايت واحد في القاعدة يُفشل الفكّ
 * بدل أن يُنتج توكناً مشوّهاً يُرسل إلى Meta فتُرفض العملية برسالة
 * غامضة.
 *
 * ## الهجرة كسولة لا دفعة واحدة
 *
 * المخزَّن سابقاً نصّ صريح بلا بادئة، والمشفَّر يبدأ بـ`enc:v1:`.
 * فالقراءة تُميّز بينهما، والكتابة تشفّر دائماً. وبهذا يعمل النظام
 * على قاعدةٍ نصفُها مشفَّر — وهي حالته أثناء الترقية بالضبط.
 *
 * ## فقد المفتاح = فقد الأسرار
 *
 * لا باب خلفي. ولهذا يُولَّد مرة ويُكتب في `.env` بجانب بقية
 * الأسرار، والنسخة الاحتياطية للقاعدة وحدها لا تكفي لاستعادتها —
 * وهذا مذكور في اقرأني.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { writeEnvFile } from './env-file.ts';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * الملح ثابت عمداً.
 *
 * وظيفته هنا اشتقاق مفتاح من نصّ المفتاح لا منع جداول قوس قزح: المفتاح
 * عشوائيٌّ من ٣٢ بايت أصلاً، لا كلمة مرور يحزرها أحد. وملحٌ متغيّر
 * يعني حفظه مع كل قيمة بلا فائدة.
 */
const SALT = 'wa-bot-platform.secrets.v1';

let cached: { source: string; key: Buffer } | null = null;

function keyFrom(secret: string): Buffer {
  if (cached && cached.source === secret) return cached.key;
  const key = scryptSync(secret, SALT, 32);
  cached = { source: secret, key };
  return key;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** مفتاح جديد يُكتب في .env — ٣٢ بايت بالست عشري. */
export function newKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * يشفّر قيمة. الفارغ يبقى فارغاً — «لا توكن» حالةٌ لها معنى في النظام.
 */
export function encryptSecret(value: string | null | undefined, secret: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isEncrypted(value)) return value;
  if (!secret) return value;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * يفكّ التشفير.
 *
 * وما ليس مشفَّراً يُعاد كما هو: صفوفٌ كُتبت قبل الميزة، والفشل هنا
 * لا يُستبدل بقيمة فارغة — قيمةٌ فارغة تجعل النظام يظنّ أن المنشأة
 * بلا توكن فيصمت بوتها بلا أن يعرف أحد السبب.
 */
export function decryptSecret(value: string | null | undefined, secret: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncrypted(value)) return value;
  if (!secret) throw new Error('ENCRYPTION_KEY مفقود — لا يمكن فكّ أسرار المنشآت.');

  const [iv, tag, payload] = value.slice(PREFIX.length).split(':');
  if (!iv || !tag || !payload) throw new Error('قيمة مشفَّرة تالفة الشكل.');

  const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

/* ---------------------------------------------------------------
   المفتاح الجاري
--------------------------------------------------------------- */

/**
 * المفتاح من البيئة مباشرة لا من الإعداد.
 *
 * طبقة التخزين هي من يشفّر ويفكّ، وتمرير الإعداد إليها يعني تمريره
 * عبر كل دالة تقرأ منشأة — وهي عشرات.
 */
export function currentKey(): string {
  return (process.env.ENCRYPTION_KEY ?? '').trim();
}

/* ---------------------------------------------------------------
   الهجرة
--------------------------------------------------------------- */

/** أسماء الأعمدة المشفَّرة في جدول المنشآت. */
export const SEALED_COLUMNS = ['wa_access_token', 'wa_app_secret', 'anthropic_api_key'] as const;

interface PlainRow {
  id: number;
  wa_access_token: string | null;
  wa_app_secret: string | null;
  anthropic_api_key: string | null;
}

/**
 * يشفّر ما بقي نصّاً صريحاً من قاعدة سابقة.
 *
 * تُنادى عند كل إقلاع وهي رخيصة: لا تكتب شيئاً بعد أول مرة لأن القيم
 * تصير مسبوقة بالبادئة. والقراءة هنا خام (بلا `reveal`) عمداً —
 * المطلوب معرفة ما هو مخزَّن لا ما يُعرض.
 */
export function sealExistingSecrets(db: {
  prepare: (sql: string) => { all: () => unknown[]; run: (...args: unknown[]) => unknown };
}): number {
  const key = currentKey();
  if (!key) return 0;

  const rows = db
    .prepare(`SELECT id, ${SEALED_COLUMNS.join(', ')} FROM tenants`)
    .all() as PlainRow[];

  let changed = 0;
  for (const row of rows) {
    const updates: string[] = [];
    const values: (string | null)[] = [];

    for (const column of SEALED_COLUMNS) {
      const value = row[column];
      if (value && !isEncrypted(value)) {
        updates.push(`${column} = ?`);
        values.push(encryptSecret(value, key));
      }
    }

    if (!updates.length) continue;
    db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...values, row.id);
    changed += 1;
  }

  return changed;
}

/**
 * مفتاح تشفير أسرار المنشآت — يُولَّد مرة ويُكتب في .env.
 *
 * ولا يُشتقّ من SESSION_SECRET: تدوير سرّ الجلسات عملٌ روتيني آمن،
 * ولو اشتُقّ منه لَمحا تدويرُه توكنات كل العملاء بلا رجعة.
 *
 * ويُنادى قبل فتح القاعدة: أول قراءة لمنشأة تحتاجه.
 */
export function ensureEncryptionKey(): string {
  const existing = (process.env.ENCRYPTION_KEY ?? '').trim();
  if (existing) return existing;

  const fresh = newKey();
  process.env.ENCRYPTION_KEY = fresh;

  try {
    writeEnvFile(new Map([['ENCRYPTION_KEY', fresh]]));
  } catch {
    /**
     * تعذّرت الكتابة — صلاحيات المجلد غالباً.
     *
     * ويُرمى خطأ هنا ولا يُكتفى بتحذير: لو مضى التشغيل لَشُفّرت أسرار
     * العملاء بمفتاحٍ في الذاكرة وحدها، فتُفقد كلها عند أول إعادة
     * تشغيل. إيقاف الإقلاع أرحم من فقدٍ لا رجعة فيه.
     *
     * **ولا يُطبع المفتاح في الرسالة**: سجلّ الخدمة يُقرأ بصلاحيات
     * أوسع من ملف .env، فطباعته فيه تُفرّغ التشفير من معناه.
     */
    throw new Error(
      'تعذّر حفظ ENCRYPTION_KEY في .env — تحقّق من صلاحيات الكتابة على مجلد التطبيق. ' +
        'التشغيل بلا مفتاح محفوظ يعني فقد أسرار العملاء عند إعادة التشغيل.',
    );
  }

  return fresh;
}

/**
 * يبدّل مفتاح التشفير: يفكّ بالقديم ويشفّر بالجديد.
 *
 * يلزم حين يتسرّب المفتاح — إلى سجلّ أو نسخة احتياطية أو شاشة. وبلا
 * هذه الدالة يكون البديل إعادة إدخال توكن كل عميل يدوياً.
 */
export function rotateKey(
  db: { prepare: (sql: string) => { all: () => unknown[]; run: (...args: unknown[]) => unknown } },
  oldKey: string,
  freshKey: string,
): number {
  const rows = db.prepare(`SELECT id, ${SEALED_COLUMNS.join(', ')} FROM tenants`).all() as Record<
    string,
    string | number | null
  >[];

  let changed = 0;
  for (const row of rows) {
    const updates: string[] = [];
    const values: (string | null)[] = [];

    for (const column of SEALED_COLUMNS) {
      const value = row[column] as string | null;
      if (!value) continue;
      // يُفكّ بالقديم ثم يُختم بالجديد — والنصّ الصريح يُختم كما هو.
      updates.push(`${column} = ?`);
      values.push(encryptSecret(decryptSecret(value, oldKey), freshKey));
    }

    if (!updates.length) continue;
    db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...values, row.id);
    changed += 1;
  }

  return changed;
}

