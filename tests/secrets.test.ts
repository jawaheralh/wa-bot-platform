/**
 * تشفير أسرار المنشآت.
 *
 * توكن ميتا يُرسل باسم صاحبه لكل من يملكه. وكان نصّاً صريحاً في ملف
 * القاعدة: نسخةٌ احتياطية مسروقة تكفي للإرسال باسم كل عميل.
 *
 * وأخطر ما في إضافة التشفير ليس ضعفه بل **كسر ما يعمل**: قاعدةٌ فيها
 * توكنات نصّية تُقرأ اليوم، فلو رفضها النظام غداً لصمت بوت كل منشأة.
 * ولهذا أول ما يُختبَر هنا قراءةُ النصّ القديم لا كتابةُ الجديد.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  newKey,
  sealExistingSecrets,
  currentKey,
  rotateKey,
} from '../src/secrets.ts';
import { freshDb, seedTenant } from './helpers.ts';
import { getTenant, listTenants, sealSecret, type Db } from '../src/db/index.ts';

const KEY = newKey();
let db: Db;
let tenantId = 0;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = KEY;
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
});

afterEach(() => {
  db.close();
  if (previous === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previous;
});

describe('التشفير نفسه', () => {
  it('ما شُفّر يُفكّ كما كان', () => {
    const secret = 'EAAG_token_طويل_جداً_123';
    const sealed = encryptSecret(secret, KEY)!;

    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed, KEY)).toBe(secret);
  });

  /** نفس القيمة تُنتج نصّين مختلفين — وإلا دلّ التكرار على تطابق الأسرار. */
  it('ونفس القيمة تُشفَّر مرتين بشكلين', () => {
    expect(encryptSecret('نفسه', KEY)).not.toBe(encryptSecret('نفسه', KEY));
  });

  /** GCM يوثّق: بايتٌ معدَّل يُفشل الفكّ بدل أن يُنتج توكناً مشوّهاً. */
  it('والتعديل يُكتشف ولا يمرّ', () => {
    const sealed = encryptSecret('سرّ', KEY)!;
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('ومفتاح آخر لا يفكّ', () => {
    const sealed = encryptSecret('سرّ', KEY)!;
    expect(() => decryptSecret(sealed, newKey())).toThrow();
  });

  it('والفارغ يبقى فارغاً', () => {
    expect(encryptSecret('', KEY)).toBeNull();
    expect(encryptSecret(null, KEY)).toBeNull();
    expect(decryptSecret(null, KEY)).toBeNull();
  });

  it('والمشفَّر لا يُشفَّر مرتين', () => {
    const once = encryptSecret('سرّ', KEY)!;
    expect(encryptSecret(once, KEY)).toBe(once);
  });
});

describe('القديم لا ينكسر', () => {
  /**
   * صفوفٌ كُتبت قبل الميزة نصّ صريح بلا بادئة.
   * ولو رُفضت لصمت بوت كل منشأة لحظة الترقية.
   */
  it('النصّ الصريح يُقرأ كما هو', () => {
    expect(decryptSecret('EAAG_plain_token', KEY)).toBe('EAAG_plain_token');
  });

  it('والقراءة من القاعدة تُظهره مفكوكاً', () => {
    db.prepare(`UPDATE tenants SET wa_access_token = 'plain-token' WHERE id = ?`).run(tenantId);
    expect(getTenant(db, tenantId)?.wa_access_token).toBe('plain-token');
  });
});

describe('الكتابة والقراءة عبر القاعدة', () => {
  it('ما يُكتب مختوماً يُقرأ مفكوكاً', () => {
    db.prepare('UPDATE tenants SET wa_access_token = ? WHERE id = ?').run(sealSecret('EAAG_secret'), tenantId);

    // في القرص: مشفَّر.
    const raw = db.prepare('SELECT wa_access_token FROM tenants WHERE id = ?').get(tenantId) as {
      wa_access_token: string;
    };
    expect(isEncrypted(raw.wa_access_token)).toBe(true);

    // في النظام: صريح.
    expect(getTenant(db, tenantId)?.wa_access_token).toBe('EAAG_secret');
  });

  it('والقائمة تفكّ كل صفوفها', () => {
    db.prepare('UPDATE tenants SET anthropic_api_key = ? WHERE id = ?').run(sealSecret('sk-ant-123'), tenantId);
    expect(listTenants(db).find((t) => t.id === tenantId)?.anthropic_api_key).toBe('sk-ant-123');
  });
});

describe('الهجرة', () => {
  it('تشفّر ما بقي صريحاً وتترك المشفَّر', () => {
    db.prepare(
      `UPDATE tenants SET wa_access_token = 'plain-1', wa_app_secret = ?, anthropic_api_key = NULL WHERE id = ?`,
    ).run(sealSecret('already-sealed'), tenantId);

    expect(sealExistingSecrets(db as never)).toBe(1);

    const raw = db
      .prepare('SELECT wa_access_token, wa_app_secret FROM tenants WHERE id = ?')
      .get(tenantId) as { wa_access_token: string; wa_app_secret: string };

    expect(isEncrypted(raw.wa_access_token)).toBe(true);
    expect(decryptSecret(raw.wa_access_token, KEY)).toBe('plain-1');
    expect(decryptSecret(raw.wa_app_secret, KEY)).toBe('already-sealed');
  });

  /** تُنادى عند كل إقلاع، فلا يجوز أن تكتب بعد أول مرة. */
  it('ولا تفعل شيئاً في المرة الثانية', () => {
    db.prepare(`UPDATE tenants SET wa_access_token = 'plain-1' WHERE id = ?`).run(tenantId);
    expect(sealExistingSecrets(db as never)).toBe(1);
    expect(sealExistingSecrets(db as never)).toBe(0);
  });

  it('وبلا مفتاح لا تلمس شيئاً', () => {
    delete process.env.ENCRYPTION_KEY;
    db.prepare(`UPDATE tenants SET wa_access_token = 'plain-1' WHERE id = ?`).run(tenantId);

    expect(currentKey()).toBe('');
    expect(sealExistingSecrets(db as never)).toBe(0);
    expect(getTenant(db, tenantId)?.wa_access_token).toBe('plain-1');
  });
});

describe('تبديل المفتاح', () => {
  /**
   * يلزم حين يتسرّب المفتاح — إلى سجلّ أو نسخة احتياطية.
   * وبلا هذه الدالة يكون البديل إعادة إدخال توكن كل عميل يدوياً.
   */
  it('ما شُفّر بالقديم يُقرأ بالجديد', () => {
    db.prepare('UPDATE tenants SET wa_access_token = ?, anthropic_api_key = ? WHERE id = ?').run(
      sealSecret('EAAG_token'),
      sealSecret('sk-ant-123'),
      tenantId,
    );

    const fresh = newKey();
    expect(rotateKey(db as never, KEY, fresh)).toBe(1);

    process.env.ENCRYPTION_KEY = fresh;
    const tenant = getTenant(db, tenantId)!;
    expect(tenant.wa_access_token).toBe('EAAG_token');
    expect(tenant.anthropic_api_key).toBe('sk-ant-123');
  });

  it('والمفتاح القديم لم يعد يفكّ', () => {
    db.prepare('UPDATE tenants SET wa_access_token = ? WHERE id = ?').run(sealSecret('EAAG_token'), tenantId);

    const fresh = newKey();
    rotateKey(db as never, KEY, fresh);

    // المفتاح القديم ما زال في البيئة — والفكّ يفشل لا يُنتج قيمة خاطئة.
    expect(() => getTenant(db, tenantId)).toThrow();
  });

  /** صفٌّ بقي نصّاً صريحاً يُختم بالجديد ولا يُفقد. */
  it('والنصّ الصريح يُختم بالجديد', () => {
    db.prepare(`UPDATE tenants SET wa_app_secret = 'plain' WHERE id = ?`).run(tenantId);

    const fresh = newKey();
    rotateKey(db as never, KEY, fresh);
    process.env.ENCRYPTION_KEY = fresh;

    expect(getTenant(db, tenantId)?.wa_app_secret).toBe('plain');
  });
});
