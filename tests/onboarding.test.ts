/**
 * ملف تأسيس المنشأة: يُنزَّل فارغاً، ويُملأ، ويُرفع.
 *
 * الخطر هنا صامت: صفّ مثال يُستورد فيصير جواباً يقوله البوت لعميل
 * («مثال — نعمل ٢٤ ساعة») — أو رفعٌ ثانٍ يُضاعف المعرفة فيتناقض
 * البوت مع نفسه. وكلاهما لا يُكتشف إلا من عميل يشتكي.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant } from './helpers.ts';
import { getTenant, type Db } from '../src/db/index.ts';
import { buildTemplate, importWorkbook, SHEET_KB, SHEET_LIMITS, SHEET_BRANCHES } from '../src/onboarding.ts';
import { buildWorkbook, readWorkbook } from '../src/xlsx.ts';
import { listKb } from '../src/modules/inquiries.ts';

let db: Db;
let tenantId = 0;

beforeEach(() => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'وقودي', waNumber: '966500000001' }).id;
});
afterEach(() => db.close());

describe('الملف الفارغ', () => {
  it('فيه الأوراق الثلاث بأسمائها', () => {
    const sheets = readWorkbook(buildTemplate(getTenant(db, tenantId)!));
    expect(sheets.map((s) => s.name)).toEqual([SHEET_KB, SHEET_LIMITS, SHEET_BRANCHES]);
  });

  it('وكل ورقة تبدأ بتعليمات ثم عناوين', () => {
    const sheets = readWorkbook(buildTemplate(getTenant(db, tenantId)!));
    for (const sheet of sheets) {
      expect(sheet.rows[0]![0]).toContain('تعليمات');
      expect((sheet.rows[1] ?? []).length).toBeGreaterThan(1);
    }
  });

  /** أخطر ما في الملف: مثال يُستورد فيصير جواباً يقوله البوت. */
  it('ورفعه كما هو لا يُضيف شيئاً', () => {
    const result = importWorkbook(db, tenantId, buildTemplate(getTenant(db, tenantId)!));

    expect(result.added).toBe(0);
    expect(listKb(db, tenantId)).toHaveLength(0);
  });
});

function filled(): Buffer {
  return buildWorkbook([
    {
      name: SHEET_KB,
      rows: [
        ['تعليمات: …'],
        ['السؤال كما يكتبه العميل', 'الجواب', 'كلمات بديلة (اختياري)'],
        ['متى تفتحون؟', 'نعمل ٢٤ ساعة.', 'الدوام'],
        ['وش أنواع الوقود؟', 'بنزين ٩١ و٩٥ وديزل.', 'السولار'],
        ['', '', ''],
      ],
    },
    {
      name: SHEET_LIMITS,
      rows: [
        ['تعليمات: …'],
        ['الموضوع', 'ماذا يقول البوت', 'ملاحظة'],
        ['الخصومات', 'العروض تتغيّر — يحوّل للمبيعات ولا يذكر نسبة.', ''],
      ],
    },
    {
      name: SHEET_BRANCHES,
      rows: [
        ['تعليمات: …'],
        ['اسم الفرع', 'المدينة', 'الموقع', 'أوقات العمل', 'الخدمات'],
        ['فرع الصريف', 'ينبع', 'طريق الملك عبدالعزيز', '٢٤ ساعة', 'بنزين، مغسلة'],
        ['فرع بلا تفاصيل', '', '', '', ''],
      ],
    },
  ]);
}

describe('الملف الممتلئ', () => {
  it('يستورد الأسئلة', () => {
    const result = importWorkbook(db, tenantId, filled());
    expect(result.added).toBeGreaterThanOrEqual(4);

    const questions = listKb(db, tenantId).map((e) => e.question);
    expect(questions).toContain('متى تفتحون؟');
    expect(questions).toContain('وش أنواع الوقود؟');
  });

  it('والكلمات البديلة تلحق بالجواب فتُطابقها أسئلة العملاء', () => {
    importWorkbook(db, tenantId, filled());
    const fuel = listKb(db, tenantId).find((e) => e.question === 'وش أنواع الوقود؟')!;
    expect(fuel.answer).toContain('السولار');
  });

  /** الحدود هي الفرق بين بوت يُطمأنّ إليه وبوت يَعِد بما لا تملكه المنشأة. */
  it('والحدود تصير سياسة يقرؤها البوت', () => {
    importWorkbook(db, tenantId, filled());
    const policy = listKb(db, tenantId).find((e) => e.question.includes('الخصومات'))!;

    expect(policy.question).toContain('سياسة المنشأة');
    expect(policy.answer).toContain('يحوّل للمبيعات');
  });

  it('والفرع يصير سؤالاً عن موقعه بتفاصيله', () => {
    importWorkbook(db, tenantId, filled());
    const branch = listKb(db, tenantId).find((e) => e.question.includes('فرع الصريف'))!;

    expect(branch.answer).toContain('ينبع');
    expect(branch.answer).toContain('٢٤ ساعة');
    expect(branch.answer).toContain('مغسلة');
  });

  it('والفرع بلا تفاصيل يُتخطّى بسبب مذكور', () => {
    const result = importWorkbook(db, tenantId, filled());
    expect(result.notes.join(' ')).toContain('فرع بلا تفاصيل');
  });
});

describe('الرفع مرتين', () => {
  /** الرفع مرتين شائع — نسخة محدَّثة، أو ضغطة مكرّرة. */
  it('لا يضاعف المعرفة', () => {
    importWorkbook(db, tenantId, filled());
    const after = listKb(db, tenantId).length;

    const second = importWorkbook(db, tenantId, filled());
    expect(second.added).toBe(0);
    expect(listKb(db, tenantId)).toHaveLength(after);
  });

  it('ويُضيف الجديد وحده', () => {
    importWorkbook(db, tenantId, filled());
    const before = listKb(db, tenantId).length;

    const extra = buildWorkbook([
      {
        name: SHEET_KB,
        rows: [
          ['السؤال كما يكتبه العميل', 'الجواب', ''],
          ['متى تفتحون؟', 'نعمل ٢٤ ساعة.', ''],
          ['هل عندكم مغاسل؟', 'نعم في فرع الصريف.', ''],
        ],
      },
    ]);

    const result = importWorkbook(db, tenantId, extra);
    expect(result.added).toBe(1);
    expect(listKb(db, tenantId)).toHaveLength(before + 1);
  });
});

describe('الأخطاء', () => {
  it('صف بسؤال بلا جواب يُتخطّى', () => {
    const file = buildWorkbook([
      { name: SHEET_KB, rows: [['السؤال كما يكتبه العميل', 'الجواب'], ['سؤال بلا جواب', '']] },
    ]);
    const result = importWorkbook(db, tenantId, file);

    expect(result.added).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toContain('لم يُضَف شيء');
  });

  it('ورقة باسم غريب لا تُستورد خطأً', () => {
    const file = buildWorkbook([{ name: 'ورقة عشوائية', rows: [['أ', 'ب']] }]);
    expect(importWorkbook(db, tenantId, file).added).toBe(0);
  });

  it('وملف ليس اكسل يُرفض برسالة عربية', () => {
    expect(() => importWorkbook(db, tenantId, Buffer.from('نص عادي'))).toThrow(/صالحة/);
  });
});

describe('العزل بين المنشآت', () => {
  it('الاستيراد يمسّ منشأته وحدها', () => {
    const other = seedTenant(db, { name: 'جيران', waNumber: '966500000002' }).id;
    importWorkbook(db, tenantId, filled());

    expect(listKb(db, other)).toHaveLength(0);
    expect(listKb(db, tenantId).length).toBeGreaterThan(0);
  });
});
