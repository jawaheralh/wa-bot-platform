/**
 * قراءة اكسل وكتابته.
 *
 * هذا محلّل يستقبل ملفاً من خارج النظام — يملؤه عميل ويرفعه موظف —
 * فالخطر ليس أن يعجز عن القراءة (ذلك يظهر فوراً)، بل أن يقرأ خطأً:
 * صفّاً يزيحه عمود فارغ فيصير السؤال جواباً، أو نصاً عربياً يعود
 * مشوّهاً بعد أن حفظه اكسل.
 */

import { describe, it, expect } from 'vitest';
import { buildWorkbook, readWorkbook, packForTest, type Sheet } from '../src/xlsx.ts';

function roundTrip(sheets: Sheet[]): Sheet[] {
  return readWorkbook(buildWorkbook(sheets));
}

describe('ذهاباً وإياباً', () => {
  it('ورقة بسيطة تعود كما هي', () => {
    const out = roundTrip([{ name: 'الأسئلة', rows: [['السؤال', 'الجواب'], ['متى تفتحون؟', '٢٤ ساعة']] }]);

    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('الأسئلة');
    expect(out[0]!.rows[0]).toEqual(['السؤال', 'الجواب']);
    expect(out[0]!.rows[1]).toEqual(['متى تفتحون؟', '٢٤ ساعة']);
  });

  it('عدة أوراق بأسمائها وترتيبها', () => {
    const out = roundTrip([
      { name: 'المعرفة', rows: [['أ']] },
      { name: 'الحدود', rows: [['ب']] },
      { name: 'الفروع', rows: [['ج']] },
    ]);

    expect(out.map((s) => s.name)).toEqual(['المعرفة', 'الحدود', 'الفروع']);
    expect(out[2]!.rows[0]).toEqual(['ج']);
  });

  it('العربية والرموز تعود سليمة', () => {
    const tricky = 'سعر ٩١ & ٩٥ <لتر> "مهم" ونسبة ١٥٪';
    const out = roundTrip([{ name: 'ورقة', rows: [[tricky]] }]);
    expect(out[0]!.rows[0]![0]).toBe(tricky);
  });

  /**
   * الخلية الفارغة لا تُكتب في XML أصلاً.
   *
   * لو اعتُمد على ترتيب الخلايا بدل مراجعها لانزاح الصف كله: يصير
   * «الجواب» في موضع «الملاحظات» — ويُستورد خطأ بلا أي رسالة.
   */
  it('العمود الفارغ في الوسط لا يزيح ما بعده', () => {
    const out = roundTrip([{ name: 'ورقة', rows: [['سؤال', '', 'ملاحظة']] }]);
    const row = out[0]!.rows[0]!;

    expect(row[0]).toBe('سؤال');
    expect(row[1] ?? '').toBe('');
    expect(row[2]).toBe('ملاحظة');
  });

  it('وصف فارغ تماماً لا ينهار', () => {
    const out = roundTrip([{ name: 'ورقة', rows: [[]] }]);
    expect(out[0]!.rows).toHaveLength(1);
  });

  it('نص طويل بأسطر متعددة', () => {
    const long = 'سطر أول\nسطر ثانٍ\nسطر ثالث';
    const out = roundTrip([{ name: 'ورقة', rows: [[long]] }]);
    expect(out[0]!.rows[0]![0]).toBe(long);
  });

  it('أعمدة كثيرة تتجاوز Z', () => {
    const row = Array.from({ length: 30 }, (_, i) => `ع${i}`);
    const out = roundTrip([{ name: 'ورقة', rows: [row] }]);
    expect(out[0]!.rows[0]).toEqual(row);
  });
});

/**
 * ما يكتبه اكسل بعد أن يحفظ العميل الملف: نصوص في سلاسل مشتركة،
 * ومحتوى مضغوط. لو لم يُقرأ هذا لعاد الملف فارغاً بعد أول حفظ —
 * وهو ما يفعله كل عميل، فتبقى أهم حالة بلا تغطية.
 */
describe('صيغة اكسل نفسه', () => {
  const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row>
</sheetData></worksheet>`;

  const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>السؤال</t></si><si><t>الجواب</t></si><si><t>متى تفتحون؟</t></si><si><r><t>٢٤ </t></r><r><t>ساعة</t></r></si>
</sst>`;

  const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="الأسئلة" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  function excelFile(): Buffer {
    return packForTest([
      ['xl/workbook.xml', WORKBOOK],
      ['xl/worksheets/sheet1.xml', SHEET],
      ['xl/sharedStrings.xml', SHARED],
    ]);
  }

  it('يقرأ السلاسل المشتركة والمحتوى المضغوط', () => {
    const sheets = readWorkbook(excelFile());

    expect(sheets[0]!.name).toBe('الأسئلة');
    expect(sheets[0]!.rows[0]).toEqual(['السؤال', 'الجواب']);
  });

  /** اكسل يجزّئ النص على عدة <t> حين يختلف تنسيق أجزائه. */
  it('ويجمع أجزاء النص المجزّأ', () => {
    const sheets = readWorkbook(excelFile());
    expect(sheets[0]!.rows[1]![2]).toBe('٢٤ ساعة');
  });

  /** B2 غائبة تماماً من الـXML — لو أُهمل المرجع لانزاح الصف. */
  it('والخلية الغائبة تُترك فارغة في موضعها', () => {
    const sheets = readWorkbook(excelFile());
    const row = sheets[0]!.rows[1]!;

    expect(row[0]).toBe('متى تفتحون؟');
    expect(row[1] ?? '').toBe('');
    expect(row[2]).toBe('٢٤ ساعة');
  });
});

describe('الملف التالف', () => {
  it('ملف ليس ZIP يُرفض برسالة عربية', () => {
    expect(() => readWorkbook(Buffer.from('هذا ليس ملف اكسل', 'utf8'))).toThrow(/صالحة/);
  });

  it('أرشيف صالح بلا أوراق يُرفض', () => {
    const noSheets = packForTest([['docProps/core.xml', '<x/>']]);
    expect(() => readWorkbook(noSheets)).toThrow(/ورقة/);
  });
});
