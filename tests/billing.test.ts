/**
 * رصيد ميتا وسقفه.
 *
 * النظام لا يحوّل مالاً إلى ميتا ولا يمسّ بطاقة عميل — بطاقة تمرّ
 * بنظامنا تُدخلنا في التزامات لا نريدها. وهذا الملف يقيس ما استُهلك
 * ويقارنه بما مُنح، ويوقف ما يتجاوز السقف.
 *
 * والفرق بين المنحة والسقف هو جوهر ما يُختبَر: **المنحة لا توقف**
 * لأن تجاوزها اتفاقٌ تجاري (يُحاسَب العميل على الزائد)، **والسقف
 * يوقف** لأنه حمايةٌ من فاتورة لا أحد يتوقعها.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  billingFor,
  saveBilling,
  checkBudget,
  recordConversation,
  monthUsage,
  summarize,
  riyals,
  DEFAULT_RATES,
} from '../src/billing.ts';
import { freshDb, seedTenant } from './helpers.ts';
import type { Db } from '../src/db/index.ts';

let db: Db;
let tenantId = 0;

beforeEach(() => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
});

afterEach(() => {
  db.close();
});

describe('الإعداد', () => {
  it('المنشأة الجديدة بلا منحة ولا سقف', () => {
    const billing = billingFor(db, tenantId);
    expect(billing.credit).toBe(0);
    expect(billing.cap).toBe(0);
    expect(billing.rates).toEqual(DEFAULT_RATES);
  });

  it('والمنحة والسقف والأسعار تُحفظ', () => {
    const saved = saveBilling(db, tenantId, { credit: 5000, cap: 20000, rates: { marketing: 50 } });
    expect(saved.credit).toBe(5000);
    expect(saved.cap).toBe(20000);
    expect(saved.rates.marketing).toBe(50);
    // ما لم يُرسل يبقى على قيمته.
    expect(saved.rates.utility).toBe(DEFAULT_RATES.utility);
  });

  it('والقيم السالبة والنصوص تُتجاهل', () => {
    saveBilling(db, tenantId, { credit: 5000 });
    const saved = saveBilling(db, tenantId, { credit: -1, cap: 'كثير' });
    expect(saved.credit).toBe(5000);
    expect(saved.cap).toBe(0);
  });

  /** إعدادٌ تالف لا يوقف الإرسال — يعود للأسعار الافتراضية. */
  it('وأسعار تالفة في القاعدة تعود للافتراضي', () => {
    db.prepare(`UPDATE tenants SET meta_rates = '{ليس JSON' WHERE id = ?`).run(tenantId);
    expect(billingFor(db, tenantId).rates).toEqual(DEFAULT_RATES);
  });
});

describe('التسجيل', () => {
  it('كل محادثة تُضيف عددها وسعرها', () => {
    saveBilling(db, tenantId, { rates: { utility: 12, marketing: 44 } });

    expect(recordConversation(db, tenantId, 'utility')).toBe(12);
    expect(recordConversation(db, tenantId, 'marketing')).toBe(44);

    const usage = monthUsage(db, tenantId);
    expect(usage.conversations).toBe(2);
    expect(usage.halalas).toBe(56);
  });

  /** الحساب بالهللات الصحيحة لا بالكسور العشرية. */
  it('ومئة محادثة لا تُراكم خطأ كسور', () => {
    saveBilling(db, tenantId, { rates: { utility: 12 } });
    for (let i = 0; i < 100; i += 1) recordConversation(db, tenantId, 'utility');

    expect(monthUsage(db, tenantId).halalas).toBe(1200);
    expect(riyals(1200)).toBe('12.00');
  });

  it('ومنشأة لا ترى استهلاك غيرها', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000003' }).id;
    recordConversation(db, tenantId, 'utility');
    expect(monthUsage(db, other).halalas).toBe(0);
  });
});

describe('المنحة لا توقف', () => {
  /**
   * تجاوز المنحة اتفاقٌ تجاري: ما بعدها يُحاسَب على العميل.
   * ولو أوقفه النظام لتوقفت خدمة عميلٍ مستعدٍّ للدفع.
   */
  it('تجاوز المنحة بلا سقف يبقى مسموحاً', () => {
    saveBilling(db, tenantId, { credit: 100, cap: 0, rates: { utility: 12 } });
    for (let i = 0; i < 20; i += 1) recordConversation(db, tenantId, 'utility');

    const budget = checkBudget(db, tenantId, 'utility');
    expect(budget.used).toBe(240);
    expect(budget.remaining).toBeLessThan(0);
    expect(budget.allowed).toBe(true);
  });

  it('والزائد يظهر صريحاً في الملخّص', () => {
    saveBilling(db, tenantId, { credit: 100, rates: { utility: 12 } });
    for (let i = 0; i < 20; i += 1) recordConversation(db, tenantId, 'utility');

    const summary = summarize(db, tenantId);
    expect(summary.overage).toBe(140);
    expect(summary.conversations).toBe(20);
  });
});

describe('السقف يوقف', () => {
  it('بلوغ السقف يمنع محادثة جديدة', () => {
    saveBilling(db, tenantId, { credit: 0, cap: 100, rates: { utility: 12 } });

    for (let i = 0; i < 8; i += 1) {
      expect(checkBudget(db, tenantId, 'utility').allowed).toBe(true);
      recordConversation(db, tenantId, 'utility');
    }

    // ٨ × ١٢ = ٩٦، والتاسعة تتجاوز المئة فتُمنع قبل أن تقع.
    const budget = checkBudget(db, tenantId, 'utility');
    expect(budget.used).toBe(96);
    expect(budget.allowed).toBe(false);
    expect(budget.reason).toContain('سقف');
  });

  /** الفحص قبل الإرسال: المنع يقع قبل أن يُنفق المال لا بعده. */
  it('والمنع يحسب سعر المحادثة القادمة لا الماضية', () => {
    saveBilling(db, tenantId, { cap: 50, rates: { utility: 12, marketing: 44 } });
    recordConversation(db, tenantId, 'utility'); // ١٢

    // التسويقية بـ٤٤ تتجاوز الخمسين، والخدمية بـ١٢ لا تتجاوزها.
    expect(checkBudget(db, tenantId, 'marketing').allowed).toBe(false);
    expect(checkBudget(db, tenantId, 'utility').allowed).toBe(true);
  });

  it('وبلا سقف لا منع مهما بلغ الاستهلاك', () => {
    saveBilling(db, tenantId, { cap: 0, rates: { utility: 12 } });
    for (let i = 0; i < 500; i += 1) recordConversation(db, tenantId, 'utility');
    expect(checkBudget(db, tenantId, 'utility').allowed).toBe(true);
  });

  /** المحادثة التي يبدؤها العميل مجانية، فلا يحدّها سقف. */
  it('وما لا سعر له لا يمنعه السقف', () => {
    saveBilling(db, tenantId, { cap: 10, rates: { utility: 12, service: 0 } });
    recordConversation(db, tenantId, 'utility');
    expect(checkBudget(db, tenantId, 'service').allowed).toBe(true);
  });
});
