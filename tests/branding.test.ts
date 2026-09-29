/**
 * هوية المنشأة.
 *
 * الاشتقاق هو ما يُختبَر هنا، لا الحفظ: العميل يُدخل لوناً واحداً،
 * فإن أخطأ الاشتقاق خرجت لوحةٌ لا تُقرأ — زرٌّ أبيض على أصفر، أو ظلٌّ
 * لا يتغيّر عند المرور فيبدو الزر معطّلاً.
 *
 * والشعار يُفحص نوعه من بايتاته لا من اسمه: ملف SVG باسم .png يصبح
 * سكربتاً يعمل في جلسة كل من يفتح اللوحة.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeHex,
  paletteFor,
  contrast,
  readableOn,
  readBranding,
  saveColors,
  storeLogo,
  removeLogo,
  readLogo,
  DEFAULT_COLOR,
  DEFAULT_DEEP,
  INK,
} from '../src/branding.ts';
import { freshDb, seedTenant } from './helpers.ts';
import type { Db } from '../src/db/index.ts';

let db: Db;
let dir = '';
let dbPath = '';
let tenantId = 0;

beforeEach(() => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'مطعم الركن', waNumber: '966500000002' }).id;
  dir = mkdtempSync(join(tmpdir(), 'branding-'));
  dbPath = join(dir, 'app.db');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** PNG صالح أصغر ما يكون — ترويسة حقيقية تكفي للفحص. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.alloc(32),
]);

const asPayload = (buffer: Buffer): string => `data:image/png;base64,${buffer.toString('base64')}`;

describe('قراءة اللون', () => {
  it('تقبل الصيغتين القصيرة والطويلة وأي حالة', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('1D6FA5')).toBe('#1d6fa5');
    expect(normalizeHex(' #1D6FA5 ')).toBe('#1d6fa5');
  });

  it('وترفض ما ليس لوناً', () => {
    for (const bad of ['', 'أزرق', '#12345', 'rgb(1,2,3)', '#gggggg', null, undefined, 12]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe('اشتقاق اللوحة', () => {
  it('اللون الفارغ يعطي ألوان المنصة', () => {
    expect(paletteFor(null).accent).toBe(DEFAULT_COLOR);
    expect(paletteFor('لا لون').accent).toBe(DEFAULT_COLOR);
  });

  /**
   * الظلّ يجب أن يُرى.
   *
   * فرق أقل من محسوس يجعل المرور فوق الزر بلا أثر، فيُظن معطّلاً
   * ويُضغط مرتين — وفي زر «إرسال» يعني ذلك رسالتين للعميل.
   */
  it('ظلّ المرور يختلف عن اللون بوضوح', () => {
    for (const color of ['#c9772b', '#1f7a53', '#0b0b0b', '#f7e96b', '#ffffff']) {
      const { accent, accentDark } = paletteFor(color);
      expect(accentDark).not.toBe(accent);
      expect(contrast(accent, accentDark)).toBeGreaterThan(1.3);
    }
  });

  it('واللون الداكن جداً يُفتَح ظلّه لا يُظلَم أكثر', () => {
    const { accent, accentDark } = paletteFor('#0d2b1e');
    // الأفتح يحمل لمعاناً أعلى — فلو أُظلم لصار أسود لا يُميَّز.
    expect(contrast(accentDark, '#ffffff')).toBeLessThan(contrast(accent, '#ffffff'));
  });

  it('والتظليل الخفيف فاتح دائماً مهما كان اللون', () => {
    for (const color of ['#0b0b0b', '#1d6fa5', '#f7e96b']) {
      expect(contrast(paletteFor(color).accentSoft, '#ffffff')).toBeLessThan(1.25);
    }
  });

  it('والشريط الجانبي داكن دائماً — النص عليه أبيض', () => {
    for (const color of ['#f7e96b', '#ffffff', '#1d6fa5']) {
      expect(contrast(paletteFor(color).deep, '#ffffff')).toBeGreaterThan(7);
    }
  });

  /** المنشأة التي لم تختر لوناً يجب ألّا تتغيّر شاشتها أصلاً. */
  it('ولون المنصة يبقي شريطها كما هو لا مشتقاً', () => {
    expect(paletteFor(null).deep).toBe(DEFAULT_DEEP);
    expect(paletteFor(DEFAULT_COLOR).deep).toBe(DEFAULT_DEEP);
  });

  it('والخلفية تأخذ لمسة من اللون لا اللون نفسه', () => {
    const { bg, accent } = paletteFor('#1f7a53');
    // قريبة من البياض: شاشةٌ تُفتح طول اليوم لا تُلوَّن.
    expect(contrast(bg, '#ffffff')).toBeLessThan(1.15);
    expect(bg).not.toBe(accent);
  });

  it('ولون الشريط المُدخَل يتقدّم على المشتقّ', () => {
    expect(paletteFor('#1d6fa5', '#101820').deep).toBe('#101820');
  });
});

describe('تباين النص فوق اللون', () => {
  /** أصفر فاتح مع أبيض = نص لا يُقرأ. هذا هو الاختبار الذي يمنعه. */
  it('اللون الفاتح يأخذ نصاً داكناً', () => {
    expect(readableOn('#f7e96b')).toBe(INK);
    expect(readableOn('#ffffff')).toBe(INK);
  });

  /**
   * لون المنصة يبقى بنصّ أبيض.
   *
   * تباينه مع الأبيض ٣٫٧ ومع الداكن ٣٫٩، فقاعدة «الأعلى تبايناً» تقلبه
   * إلى داكن لفارق لا يُرى — وتفصل اللوحة عن صفحة الهبوط التي جاء منها
   * العميل قبل دقيقة.
   */
  it('ولون المنصة يبقى بنصّ أبيض كما في صفحة الهبوط', () => {
    expect(readableOn(DEFAULT_COLOR)).toBe('#ffffff');
  });

  it('وأياً كان اللون يبقى النص مقروءاً على زرّ عريض', () => {
    for (const color of ['#ffffff', '#000000', '#f7e96b', '#c9772b', '#7a2f6d', '#0f766e', '#9a9a9a']) {
      expect(contrast(color, readableOn(color))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('الحفظ', () => {
  it('اللون يُحفظ ويُقرأ', () => {
    saveColors(db, tenantId, { color: '#1F7A53' });
    const branding = readBranding(db, tenantId);
    expect(branding.accent).toBe('#1f7a53');
    expect(branding.custom).toBe(true);
    expect(branding.deepCustom).toBe(false);
  });

  it('والفراغ يعيد ألوان المنصة', () => {
    saveColors(db, tenantId, { color: '#1f7a53' });
    saveColors(db, tenantId, { color: '', deep: '' });
    expect(readBranding(db, tenantId).custom).toBe(false);
    expect(readBranding(db, tenantId).accent).toBe(DEFAULT_COLOR);
  });

  it('واللون الخاطئ يُرفض ولا يمحو الصحيح قبله', () => {
    saveColors(db, tenantId, { color: '#1f7a53' });
    expect(() => saveColors(db, tenantId, { color: 'أخضر' })).toThrow();
    expect(readBranding(db, tenantId).accent).toBe('#1f7a53');
  });
});

describe('الشعار', () => {
  it('يُحفظ ويُقرأ بنوعه الحقيقي', () => {
    const stored = storeLogo(db, dbPath, tenantId, asPayload(PNG));
    expect(stored.mime).toBe('image/png');

    const read = readLogo(dbPath, readBranding(db, tenantId).logo!);
    expect(read?.mime).toBe('image/png');
  });

  /** الترويسة يكتبها المرسِل، والبايتات لا تكذب. */
  it('وSVG مرفوض ولو ادّعى أنه PNG', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => storeLogo(db, dbPath, tenantId, `data:image/png;base64,${svg.toString('base64')}`)).toThrow(
      /الصيغة غير مدعومة/,
    );
    expect(readBranding(db, tenantId).logo).toBeNull();
  });

  it('والملف الضخم مرفوض', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
    expect(() => storeLogo(db, dbPath, tenantId, asPayload(huge))).toThrow(/كيلوبايت/);
  });

  it('والحذف يمحو الملف لا السجل فقط', () => {
    storeLogo(db, dbPath, tenantId, asPayload(PNG));
    const path = join(dbPath.replace(/[^/]+$/, ''), 'media', readBranding(db, tenantId).logo!);
    expect(existsSync(path)).toBe(true);

    removeLogo(db, dbPath, tenantId);
    expect(existsSync(path)).toBe(false);
    expect(readBranding(db, tenantId).logo).toBeNull();
  });

  /** مسار قادم من الطلب لا يخرج من مجلد الوسائط. */
  it('ولا يُقرأ ملف خارج مجلد الوسائط', () => {
    expect(readLogo(dbPath, '../../../etc/passwd')).toBeUndefined();
    expect(readLogo(dbPath, '/etc/passwd')).toBeUndefined();
  });
});
