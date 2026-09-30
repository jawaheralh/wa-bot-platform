/**
 * رصيد ميتا لكل منشأة: ما يُمنح من الاشتراك، وما يُستهلك، ومتى يتوقف.
 *
 * ## ما لا يفعله هذا الملف — وهو الأهم
 *
 * **لا يحوّل مالاً إلى حساب ميتا.** لا توجد واجهة برمجية لشحن رصيد
 * حساب شخصٍ آخر، ولا يجوز أصلاً أن يمرّ ببطاقة عميلٍ من عندنا: بطاقة
 * تمرّ بنظامنا تُدخلنا في التزامات PCI ومسؤوليةٍ لا نريدها.
 *
 * فالبطاقة تُضاف مرة واحدة في حساب العميل عند ميتا، **ولا نراها**.
 * وهذا الملف يقيس ما استهلكه ويقارنه بما منحناه، ويوقف ما يتجاوزه.
 *
 * ## لماذا القياس ضروري ولو كان العميل يدفع لميتا مباشرة
 *
 * المنشأة التي تنشر رقمها في إعلان قد تُنتج آلاف المحادثات في يوم.
 * فإن كانت هي الدافعة فوجئت بفاتورة تُنهي العلاقة، وإن كنّا نحن
 * فالخسارة علينا. والسقف يحمي الطرفين — وهو ما لم يكن موجوداً.
 *
 * ## الوحدة: الهللة لا الريال
 *
 * أسعار المحادثة كسورٌ صغيرة، وجمع الكسور العشرية مرةً بعد مرة يُراكم
 * خطأ الفاصلة العائمة حتى يظهر في الفاتورة. فالحساب كله بالهللات
 * الصحيحة، والقسمة على مئة عند العرض وحده.
 */

import { today } from './time.ts';
import type { Db } from './db/index.ts';

/**
 * تصنيفات ميتا للمحادثة — ولكلٍّ سعره.
 *
 * `service` هي محادثة يبدؤها العميل، وأكثر المنصات لا تُحاسَب عليها
 * اليوم. والثلاث الباقية تبدأ بقالب من عندنا فتُحاسَب.
 */
export const CATEGORIES = ['utility', 'marketing', 'authentication', 'service'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_AR: Record<Category, string> = {
  utility: 'خدمية',
  marketing: 'تسويقية',
  authentication: 'تحقق',
  service: 'يبدؤها العميل',
};

/**
 * الأسعار بالهللة لكل محادثة.
 *
 * تقديرية وتُضبط لكل منشأة: ميتا تغيّر أسعارها وتختلف بالدولة، ورقمٌ
 * مثبَّت في الشيفرة يصير خطأً صامتاً في الفاتورة بعد أول تحديث.
 */
export const DEFAULT_RATES: Record<Category, number> = {
  utility: 12,
  marketing: 44,
  authentication: 12,
  service: 0,
};

export interface TenantBilling {
  /** ما يُمنح شهرياً ضمن الاشتراك، بالهللة. */
  credit: number;
  /** سقف صارم بالهللة — الصفر يعني بلا سقف. */
  cap: number;
  rates: Record<Category, number>;
}

interface Row {
  meta_credit: number | null;
  meta_cap: number | null;
  meta_rates: string | null;
}

export function billingFor(db: Db, tenantId: number): TenantBilling {
  const row = db
    .prepare('SELECT meta_credit, meta_cap, meta_rates FROM tenants WHERE id = ?')
    .get(tenantId) as Row | undefined;

  let rates = { ...DEFAULT_RATES };
  if (row?.meta_rates) {
    try {
      const parsed = JSON.parse(row.meta_rates) as Partial<Record<Category, unknown>>;
      for (const category of CATEGORIES) {
        const value = Number(parsed[category]);
        if (Number.isFinite(value) && value >= 0) rates[category] = Math.round(value);
      }
    } catch {
      // إعداد تالف يعود للأسعار الافتراضية ولا يُسقط الإرسال.
      rates = { ...DEFAULT_RATES };
    }
  }

  return {
    credit: Math.max(0, Number(row?.meta_credit ?? 0)),
    cap: Math.max(0, Number(row?.meta_cap ?? 0)),
    rates,
  };
}

export function saveBilling(
  db: Db,
  tenantId: number,
  input: { credit?: unknown; cap?: unknown; rates?: unknown },
): TenantBilling {
  const asHalalas = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  };

  const current = billingFor(db, tenantId);
  const rates = { ...current.rates };
  if (input.rates && typeof input.rates === 'object') {
    for (const category of CATEGORIES) {
      const value = Number((input.rates as Record<string, unknown>)[category]);
      if (Number.isFinite(value) && value >= 0) rates[category] = Math.round(value);
    }
  }

  db.prepare('UPDATE tenants SET meta_credit = ?, meta_cap = ?, meta_rates = ? WHERE id = ?').run(
    asHalalas(input.credit, current.credit),
    asHalalas(input.cap, current.cap),
    JSON.stringify(rates),
    tenantId,
  );
  return billingFor(db, tenantId);
}

/* ---------------------------------------------------------------
   الاستهلاك
--------------------------------------------------------------- */

export interface MonthUsage {
  month: string;
  conversations: number;
  halalas: number;
}

export function monthUsage(db: Db, tenantId: number, month = today().slice(0, 7)): MonthUsage {
  const row = db
    .prepare('SELECT meta_conversations, meta_halalas FROM usage_log WHERE tenant_id = ? AND month = ?')
    .get(tenantId, month) as { meta_conversations?: number; meta_halalas?: number } | undefined;

  return {
    month,
    conversations: Number(row?.meta_conversations ?? 0),
    halalas: Number(row?.meta_halalas ?? 0),
  };
}

export interface Budget {
  credit: number;
  cap: number;
  used: number;
  /** المتبقي من المنحة — سالبٌ يعني تجاوزاً يُحاسَب عليه العميل. */
  remaining: number;
  /** هل يُسمح بمحادثة جديدة مدفوعة؟ */
  allowed: boolean;
  reason?: string;
}

/**
 * هل يُسمح بإرسال قالب الآن؟
 *
 * السقف يوقف، والمنحة لا توقف: تجاوزُ المنحة يعني أن ما بعدها يُحاسَب
 * على العميل — وهذا اتفاقٌ تجاري لا خطأ. أما السقف فحمايةٌ من فاتورة
 * لا أحد يتوقعها، فيوقف فعلاً.
 */
export function checkBudget(db: Db, tenantId: number, category: Category = 'utility'): Budget {
  const { credit, cap, rates } = billingFor(db, tenantId);
  const used = monthUsage(db, tenantId).halalas;
  const price = rates[category] ?? 0;

  const budget: Budget = {
    credit,
    cap,
    used,
    remaining: credit - used,
    allowed: true,
  };

  /**
   * ما لا سعر له لا يمنعه سقف الإنفاق.
   *
   * السقف يوقف المال لا الخدمة، والمحادثة التي يبدؤها العميل مجانية —
   * فمنعُها يُسكت النظام عن عملاءٍ يسألون بلا أن يوفّر هللة واحدة.
   */
  if (price > 0 && cap > 0 && used + price > cap) {
    budget.allowed = false;
    budget.reason =
      `بلغت المنشأة سقف استهلاك ميتا لهذا الشهر (${(cap / 100).toFixed(2)} ريالاً). ` +
      'يُرفع السقف من شاشة الاستهلاك أو يُنتظر الشهر القادم.';
  }

  return budget;
}

/**
 * يسجّل محادثة مدفوعة.
 *
 * يُنادى **بعد** نجاح الإرسال لا قبله: تسجيل ما لم يُرسل يُنقص رصيد
 * العميل بلا مقابل، وهو أسوأ من فقد قيدٍ واحد عند تعطّل نادر.
 */
export function recordConversation(db: Db, tenantId: number, category: Category = 'utility'): number {
  const price = billingFor(db, tenantId).rates[category] ?? 0;
  const month = today().slice(0, 7);

  db.prepare(
    `INSERT INTO usage_log (tenant_id, month, meta_conversations, meta_halalas) VALUES (?, ?, 1, ?)
     ON CONFLICT(tenant_id, month) DO UPDATE SET
       meta_conversations = meta_conversations + 1,
       meta_halalas = meta_halalas + ?`,
  ).run(tenantId, month, price, price);

  return price;
}

/* ---------------------------------------------------------------
   العرض
--------------------------------------------------------------- */

export interface BillingSummary extends Budget {
  conversations: number;
  month: string;
  rates: Record<Category, number>;
  /** ما يُحاسَب عليه العميل فوق المنحة، بالهللة. */
  overage: number;
}

export function summarize(db: Db, tenantId: number): BillingSummary {
  const usage = monthUsage(db, tenantId);
  const budget = checkBudget(db, tenantId);
  const { rates } = billingFor(db, tenantId);

  return {
    ...budget,
    conversations: usage.conversations,
    month: usage.month,
    rates,
    overage: Math.max(0, usage.halalas - budget.credit),
  };
}

/** ريالات بصيغة تُقرأ — الحساب بالهللة والعرض بالريال. */
export function riyals(halalas: number): string {
  return (halalas / 100).toFixed(2);
}
