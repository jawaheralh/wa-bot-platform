/**
 * إخفاء بيانات العميل قبل إرسالها خارج السعودية.
 *
 * الخطر الذي يمسكه هذا الملف: رقم يمرّ ولا يُخفى. عطل صامت تماماً —
 * البوت يرد رداً سليماً، والاختبارات الأخرى كلها خضراء، والرقم في
 * طريقه إلى خادم في قارة أخرى.
 *
 * ولذلك آخر وصف هنا يفحص نصوصاً واقعية كاملة: لا يكفي أن ينجح كل
 * نمط وحده، المهم ألّا ينجو رقم من جملة يكتبها عميل فعلاً.
 */

import { describe, it, expect } from 'vitest';
import { redact, restore, restoreDeep, hasPii, mergeMaps } from '../src/redact.ts';

describe('أرقام الجوال', () => {
  const numbers = [
    '0551234567',
    '966551234567',
    '+966551234567',
    '00966551234567',
    '+966 55 123 4567',
    '055-123-4567',
  ];

  for (const number of numbers) {
    it(`يُخفي ${number}`, () => {
      const { text, map } = redact(`رقمي ${number} تواصلوا معي`);
      expect(text).not.toContain('1234567');
      expect(text).toContain('﴿جوال-1﴾');
      expect(map.get('﴿جوال-1﴾')).toBe(number);
    });
  }

  it('الرقم المتكرر يأخذ الرمز نفسه — وإلا ظنّه النموذج رقمين', () => {
    const { text } = redact('جوالي 0551234567 وكرّرها 0551234567');
    expect(text.match(/﴿جوال-1﴾/g)).toHaveLength(2);
    expect(text).not.toContain('﴿جوال-2﴾');
  });

  it('رقمان مختلفان يأخذان رمزين', () => {
    const { text, map } = redact('رقمي 0551234567 ورقم أخي 0509876543');
    expect(text).toContain('﴿جوال-1﴾');
    expect(text).toContain('﴿جوال-2﴾');
    expect(map.size).toBe(2);
  });
});

describe('الهوية والإقامة', () => {
  it('يُخفي رقم هوية يبدأ بـ١', () => {
    const { text } = redact('هويتي 1012345678');
    expect(text).toBe('هويتي ﴿هوية-1﴾');
  });

  it('يُخفي رقم إقامة يبدأ بـ٢', () => {
    const { text } = redact('الإقامة 2098765432');
    expect(text).toBe('الإقامة ﴿هوية-1﴾');
  });

  it('لا يلتهم رقماً من عشر خانات يبدأ بغيرهما', () => {
    const { text } = redact('الطلب رقم 9012345678');
    expect(text).toContain('9012345678');
  });
});

describe('الآيبان والبطاقات', () => {
  it('يُخفي الآيبان السعودي', () => {
    const { text, map } = redact('حوّلوا على SA0380000000608010167519');
    expect(text).toBe('حوّلوا على ﴿آيبان-1﴾');
    expect(map.size).toBe(1);
  });

  it('يُخفي الآيبان بمسافات', () => {
    const { text } = redact('SA03 8000 0000 6080 1016 7519');
    expect(text).toBe('﴿آيبان-1﴾');
  });

  /**
   * الترتيب هو الاختبار الحقيقي: الآيبان يحوي بداخله ما يشبه رقم
   * هوية. لو سبق نمط الهوية لالتهم جزءاً وترك البقية مكشوفة.
   */
  it('الآيبان يُخفى كاملاً ولا يُقطَّع', () => {
    const { text, map } = redact('SA0380000000608010167519');
    expect(map.size).toBe(1);
    // لا بقية مكشوفة: الرمز وحده، بلا أي جزء من الأصل
    expect(text).toBe('﴿آيبان-1﴾');
    expect(text).not.toContain('8000');
    expect(text).not.toContain('167519');
  });

  it('يُخفي رقم بطاقة صالح', () => {
    const { text } = redact('البطاقة 4539578763621486');
    expect(text).toBe('البطاقة ﴿بطاقة-1﴾');
  });

  it('لا يُخفي سلسلة أرقام طويلة ليست بطاقة', () => {
    // رقم فاتورة من ١٦ خانة يسقط في فحص لون
    const { text } = redact('رقم الفاتورة 1234567812345678');
    expect(text).toContain('1234567812345678');
  });
});

describe('البريد', () => {
  it('يُخفى', () => {
    const { text, map } = redact('راسلوني على ahmed.ali@example.com');
    expect(text).toBe('راسلوني على ﴿بريد-1﴾');
    expect(map.get('﴿بريد-1﴾')).toBe('ahmed.ali@example.com');
  });
});

describe('ما لا يُخفى', () => {
  it('الاسم يبقى — بلا اسم يصير البوت بارداً، والاسم وحده لا يُعرّف', () => {
    const { text, map } = redact('أنا محمد العتيبي');
    expect(text).toBe('أنا محمد العتيبي');
    expect(map.size).toBe(0);
  });

  it('النص العادي لا يُمَس', () => {
    const { text, map } = redact('متى تفتحون؟ وكم سعر بنزين ٩١؟');
    expect(text).toBe('متى تفتحون؟ وكم سعر بنزين ٩١؟');
    expect(map.size).toBe(0);
  });

  it('المبالغ والكميات تبقى', () => {
    const { text } = redact('عبّيت بـ150 ريال و40 لتر');
    expect(text).toContain('150');
    expect(text).toContain('40');
  });

  it('النص الفارغ لا ينهار', () => {
    expect(redact('').map.size).toBe(0);
    expect(restore('', new Map())).toBe('');
  });
});

describe('الاسترجاع', () => {
  it('يعيد النص كما كان', () => {
    const original = 'جوالي 0551234567 وهويتي 1012345678';
    const { text, map } = redact(original);
    expect(restore(text, map)).toBe(original);
  });

  it('يعيد القيم داخل مدخلات أداة مهما عمقت', () => {
    const { map } = redact('رقمي 0551234567 وبريدي a@b.com');
    const input = {
      name: 'محمد',
      phone: '﴿جوال-1﴾',
      nested: { contact: { email: '﴿بريد-1﴾' }, tags: ['﴿جوال-1﴾', 'عادي'] },
      count: 3,
      flag: true,
    };

    const restored = restoreDeep(input, map) as typeof input;
    expect(restored.phone).toBe('0551234567');
    expect(restored.nested.contact.email).toBe('a@b.com');
    expect(restored.nested.tags[0]).toBe('0551234567');
    expect(restored.nested.tags[1]).toBe('عادي');
    // ما ليس نصاً يمرّ كما هو
    expect(restored.count).toBe(3);
    expect(restored.flag).toBe(true);
  });

  it('خريطة فارغة تعيد المدخل نفسه', () => {
    const input = { a: 1 };
    expect(restoreDeep(input, new Map())).toBe(input);
  });

  it('دمج خرائط عدة رسائل', () => {
    const a = redact('رقمي 0551234567').map;
    const b = redact('بريدي x@y.com').map;
    expect(mergeMaps([a, b]).size).toBe(2);
  });
});

/**
 * الفحص الحاسم: جمل كما يكتبها العملاء فعلاً.
 *
 * نجاح كل نمط وحده لا يكفي — الأنماط تتداخل، والجملة الواقعية هي
 * التي تكشف ما ينجو منها.
 */
describe('نصوص واقعية لا يبقى فيها رقم', () => {
  const samples = [
    'السلام عليكم أنا محمد العتيبي جوالي 0551234567 وأبغى أرفع شكوى',
    'رقمي ٠٥٥١٢٣٤٥٦٧'.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))),
    'حوّلت المبلغ على SA0380000000608010167519 من بطاقتي 4539578763621486',
    'هويتي 1012345678 وجوالي +966 55 123 4567 وإيميلي ali@test.sa',
    'اتصلوا على 0509876543 أو 0551112222 بأي وقت',
  ];

  for (const [index, sample] of samples.entries()) {
    it(`المثال ${index + 1}`, () => {
      const { text, map } = redact(sample);
      expect(map.size).toBeGreaterThan(0);
      // لم يبقَ ما يُخفى
      expect(hasPii(text)).toBe(false);
      // والاسترجاع يعيد الأصل حرفياً
      expect(restore(text, map)).toBe(sample);
    });
  }
});
