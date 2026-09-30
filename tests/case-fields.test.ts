/**
 * الحقول الإضافية للطلبات والشكاوى.
 *
 * ما تحتاجه محطة وقود ليس ما يحتاجه مطعم. وإضافة عمودٍ في القاعدة لكل
 * قطاع يعني تعديل النظام كلما بِيع لقطاع جديد — فالحقول تُعرَّف لكل
 * منشأة وتُحفظ في عمود واحد.
 *
 * وأهم ما هنا أن التعريف **مصدرٌ واحد** للبوت وللموظف معاً: المالك
 * يكتب «نوع السيارة» مرة، فيسأل عنها البوت في المحادثة ويعرضها
 * النموذج في اللوحة. تعريفان منفصلان يفترقان عند أول تعديل.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFields,
  fieldsToText,
  validateValues,
  readValues,
  describeValues,
  toolProperties,
} from '../src/case-fields.ts';

const TEXT = `
نوع السيارة* | اختيار | سيدان، دباب، شاحنة
وقت الحضور | وقت
الكيلومترات | رقم
تاريخ الشراء | تاريخ
ملاحظة الفني
`;

describe('قراءة التعريف', () => {
  it('السطر يُفكّ إلى تسمية ونوع وخيارات', () => {
    const fields = parseFields(TEXT);
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatchObject({
      label: 'نوع السيارة',
      type: 'اختيار',
      required: true,
      options: ['سيدان', 'دباب', 'شاحنة'],
    });
    // بلا نوع = نصّ حرّ، وبلا نجمة = اختياري.
    expect(fields[4]).toMatchObject({ label: 'ملاحظة الفني', type: 'نص', required: false });
  });

  /** خطأ مطبعي في حقلٍ واحد لا يجوز أن يُفرغ النموذج كله. */
  it('والسطر المعطوب يُتجاهل ولا يُسقط البقية', () => {
    const fields = parseFields('| | \n\nنوع السيارة | اختيار | سيدان\n   \n| رقم');
    expect(fields).toHaveLength(1);
    expect(fields[0]!.label).toBe('نوع السيارة');
  });

  it('والمكرر يُسقط فلا يتصادم مفتاحان', () => {
    expect(parseFields('اللون | نص\nاللون | رقم')).toHaveLength(1);
  });

  /** «اختيار» بلا خيارات قائمةٌ فارغة — فتصير نصاً حراً بدل أن تُرفض. */
  it('واختيارٌ بلا خيارات يصير نصاً', () => {
    expect(parseFields('الفرع | اختيار')[0]).toMatchObject({ type: 'نص' });
  });

  it('والتدوير يحفظ المعنى', () => {
    const once = parseFields(TEXT);
    expect(parseFields(fieldsToText(once))).toEqual(once);
  });
});

describe('التحقق من القيم', () => {
  const fields = parseFields(TEXT);

  it('القيم الصحيحة تمرّ', () => {
    const result = validateValues(fields, {
      نوع_السيارة: 'دباب',
      وقت_الحضور: '5:30',
      الكيلومترات: '120000',
      تاريخ_الشراء: '2024-03-01',
    });
    expect(result.error).toBeUndefined();
    expect(result.values.نوع_السيارة).toBe('دباب');
  });

  it('والإلزامي الناقص يمنع الحفظ', () => {
    expect(validateValues(fields, { وقت_الحضور: '5:30' }).error).toContain('نوع السيارة');
  });

  it('وخيارٌ خارج القائمة يُرفض', () => {
    expect(validateValues(fields, { نوع_السيارة: 'طائرة' }).error).toContain('أحد');
  });

  it('والأنواع تُفحص', () => {
    expect(validateValues(fields, { نوع_السيارة: 'دباب', الكيلومترات: 'كثير' }).error).toContain('رقماً');
    expect(validateValues(fields, { نوع_السيارة: 'دباب', وقت_الحضور: 'الصبح' }).error).toContain('وقتاً');
    expect(validateValues(fields, { نوع_السيارة: 'دباب', تاريخ_الشراء: 'أمس' }).error).toContain('تاريخاً');
  });

  /**
   * التعديل الجزئي لا يمحو ما لم يُرسل.
   *
   * شاشة تعدّل الوصف وحده ترسل الوصف وحده — ولو مُحيت الحقول لفقد
   * السجلُّ «نوع السيارة» لأن الموظف صحّح جملةً فيه.
   */
  it('والقيم السابقة تبقى حين لا تُرسل', () => {
    const previous = { نوع_السيارة: 'شاحنة', ملاحظة_الفني: 'تحتاج فحصاً' };
    const result = validateValues(fields, { نوع_السيارة: 'شاحنة' }, previous);
    expect(result.error).toBeUndefined();
    expect(result.values.ملاحظة_الفني).toBeUndefined();
    expect(result.values.نوع_السيارة).toBe('شاحنة');
  });

  /** حقلٌ ألغاه المالك اليوم لا يمحو ما كُتب قبل إلغائه. */
  it('وقيمة حقلٍ حُذف تعريفه تبقى محفوظة', () => {
    const result = validateValues(parseFields('اللون | نص'), { اللون: 'أبيض' }, { رقم_المضخة: '3' });
    expect(result.values.رقم_المضخة).toBe('3');
  });

  it('والقراءة تتحمّل نصاً تالفاً', () => {
    expect(readValues('{ليس JSON')).toEqual({});
    expect(readValues('[1,2]')).toEqual({});
    expect(readValues(null)).toEqual({});
  });
});

describe('ما يراه النموذج', () => {
  const fields = parseFields(TEXT);

  /** المالك يعرّف الحقل مرة، فيسأل عنه البوت بلا سطر إضافي في الوحدة. */
  it('التعريف يصير خصائص أداة', () => {
    const properties = toolProperties(fields) as Record<string, { enum?: string[]; description: string }>;
    expect(properties.نوع_السيارة!.enum).toEqual(['سيدان', 'دباب', 'شاحنة']);
    expect(properties.وقت_الحضور!.description).toContain('٥:٣٠');
    expect(Object.keys(properties)).toHaveLength(5);
  });

  it('والعرض يسمّي الحقل لا مفتاحه', () => {
    expect(describeValues(fields, { نوع_السيارة: 'دباب' })).toBe('نوع السيارة: دباب');
  });
});
