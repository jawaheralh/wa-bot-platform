/**
 * هوية المنشأة: لونها وشعارها.
 *
 * المنشأة تدفع لتدير خدمة عملائها، لا لترى اسم منصةٍ أخرى على شاشة
 * موظفيها كل صباح. فاللوحة تلبس لون العميل وشعاره، ويبقى النظام واحداً
 * تحتها.
 *
 * واللون المُدخَل واحد لا خمسة: العميل يعرف لون علامته ولا يعرف ما
 * يليق به كظلّ ولا كخلفية شريط. فتُشتق البقية منه حسابياً، فتبقى
 * متناسقة مهما كان اللون — ويبقى للعميل حرية تجاوز لون الشريط وحده
 * حين تكون هويته لونين لا لوناً.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaRoot } from './media.ts';
import type { Db } from './db/index.ts';

/** لون النصّ الداكن — هو نفسه `--ink` في ورقة الأنماط. */
export const INK = '#2c1b20';

export interface Palette {
  /** اللون الأساسي كما أدخله العميل. */
  accent: string;
  /** ظلّه عند المرور — يختلف عنه بوضوح مهما كان فاتحاً أو داكناً. */
  accentDark: string;
  /** تظليل خفيف جداً للصفوف والشارات. */
  accentSoft: string;
  /** خلفية الشريط الجانبي. */
  deep: string;
  /** لون النص فوق اللون الأساسي: أبيض أو داكن، أيّهما أوضح. */
  accentInk: string;
  /** خلفية الصفحة — مشبعة بلمسة من لون العميل فلا تبقى محايدة تحته. */
  bg: string;
  /** لون الحدود والفواصل. */
  line: string;
}

export interface Branding extends Palette {
  /** المسار النسبي للشعار داخل مجلد الوسائط، أو فارغ. */
  logo: string | null;
  /** هل اللون مضبوط فعلاً أم هو لون المنصة الافتراضي؟ */
  custom: boolean;
  /** هل اختار العميل لون الشريط بنفسه، أم اشتُقّ من اللون الأساسي؟ */
  deepCustom: boolean;
}

/** ألوان المنصة حين لا تضبط المنشأة لوناً. */
export const DEFAULT_COLOR = '#c9772b';
/** شريط المنصة الجانبي — بنّي لا مشتقّ من البرتقالي. */
export const DEFAULT_DEEP = '#3b2229';
const DEFAULT_BG = '#f8f3f0';
const DEFAULT_LINE = '#e6dcd8';

/* ---------------------------------------------------------------
   اللون: تحقق وتحويل
--------------------------------------------------------------- */

/** يقبل `#abc` و`#aabbcc` بأي حالة، ويعيد الصيغة الطويلة الصغيرة. */
export function normalizeHex(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#?([0-9a-f]{6})$/i.exec(value);
  return long ? `#${long[1]!.toLowerCase()}` : null;
}

function toRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHsl(hex: string): [h: number, s: number, l: number] {
  const [r, g, b] = toRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): string {
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lum = Math.min(100, Math.max(0, l)) / 100;
  const k = (n: number): number => (n + ((h % 360) + 360) / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const f = (n: number): number => lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/* ---------------------------------------------------------------
   التباين
--------------------------------------------------------------- */

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** نسبة التباين بين لونين حسب WCAG — من ١ إلى ٢١. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** أدنى تباين يُقبل لنصّ عريض على زر. دونه يُقلَب النص. */
const BUTTON_CONTRAST = 3;

/**
 * لون النص فوق خلفية.
 *
 * الأبيض هو الأصل ما دام مقروءاً، لا «الأعلى تبايناً»: لغة المنتج كلها
 * — من صفحة الهبوط إلى اللوحة — نصٌّ أبيض على اللون. واختيار الأعلى
 * تبايناً دائماً يقلب زرّ المنصة البرتقالي إلى نصّ داكن لفارق يسير،
 * فتفترق اللوحة عن الصفحة التي جاء منها العميل.
 *
 * أما الألوان الفاتحة — أصفر أو أبيض — فالأبيض عليها لا يُقرأ أصلاً،
 * فيُقلَب النص. والعتبة ٣ لا ٤٫٥ لأن نصّ الزر عريض، ولأن ٤٫٥ ترفض
 * لون المنصة نفسه.
 */
export function readableOn(background: string): string {
  if (contrast(background, '#ffffff') >= BUTTON_CONTRAST) return '#ffffff';
  return contrast(background, '#ffffff') >= contrast(background, INK) ? '#ffffff' : INK;
}

/* ---------------------------------------------------------------
   اشتقاق اللوحة
--------------------------------------------------------------- */

/** أدنى فرق يُحَسّ بين الزر وظلّه. دونه يبدو المرور بلا أثر. */
const HOVER_CONTRAST = 1.35;

/**
 * ظلّ المرور: يُقاس لا يُقدَّر.
 *
 * إنقاص الإضاءة بمقدار ثابت لا يكفي، لأن الإضاءة في HSL ليست السطوع
 * المُدرَك: الأصفر الفاتح عند ٦٩٪ إضاءة يبقى أصفر فاتحاً عند ٥٧٪،
 * فيبدو الزر عند المرور كما هو. فنزيد الفرق حتى يُحَسّ فعلاً.
 *
 * والاتجاه حسب اللون: اللون الداكن يُفتَح لا يُظلَم، وإلا صار أسود
 * فبدا الزر معطّلاً لا مضغوطاً.
 */
function hoverShade(h: number, s: number, l: number, accent: string): string {
  const darken = l > 30;
  for (let step = 8; step <= 45; step += 4) {
    const candidate = fromHsl(h, s, darken ? l - step : l + step);
    if (contrast(accent, candidate) >= HOVER_CONTRAST) return candidate;
  }
  return fromHsl(h, s, darken ? Math.max(l - 45, 4) : Math.min(l + 45, 96));
}

export function paletteFor(color?: string | null, deep?: string | null): Palette {
  const accent = normalizeHex(color) ?? DEFAULT_COLOR;
  const [h, s, l] = toHsl(accent);
  const isPlatform = accent === DEFAULT_COLOR;

  return {
    accent,
    accentDark: hoverShade(h, s, l, accent),
    accentSoft: fromHsl(h, Math.min(45, Math.max(10, s * 0.5)), 94),
    /**
     * الشريط: لون العميل إن حدّده، وإلا نسخة داكنة من لونه.
     *
     * إلا لون المنصة نفسه فله شريطه المعروف: اشتقاقه منه يُنتج بنّياً
     * آخر قريباً، فتتغيّر شاشة كل منشأة لم تختر لوناً بلا سبب.
     */
    deep:
      normalizeHex(deep) ??
      (isPlatform ? DEFAULT_DEEP : fromHsl(h, Math.min(45, Math.max(18, s * 0.6)), 15)),
    accentInk: readableOn(accent),
    /**
     * الخلفية والحدود تأخذان لمسة من اللون لا اللون نفسه.
     *
     * خلفية محايدة تحت هوية خضراء تبدو بقيّةً من هوية أخرى، وخلفية
     * ملوّنة فعلاً تُتعب العين في شاشة تُفتح طول اليوم. فالإشباع
     * محدود بعشرة في المئة: يُحَسّ ولا يُلاحَظ.
     */
    bg: isPlatform ? DEFAULT_BG : fromHsl(h, Math.min(10, s * 0.15), 97),
    line: isPlatform ? DEFAULT_LINE : fromHsl(h, Math.min(14, s * 0.2), 90),
  };
}

/* ---------------------------------------------------------------
   القراءة والحفظ
--------------------------------------------------------------- */

interface Row {
  brand_color: string | null;
  brand_deep: string | null;
  brand_logo: string | null;
}

export function readBranding(db: Db, tenantId: number): Branding {
  const row = db
    .prepare('SELECT brand_color, brand_deep, brand_logo FROM tenants WHERE id = ?')
    .get(tenantId) as Row | undefined;

  return {
    ...paletteFor(row?.brand_color, row?.brand_deep),
    logo: row?.brand_logo ?? null,
    custom: Boolean(row?.brand_color),
    deepCustom: Boolean(row?.brand_deep),
  };
}

/** يحفظ اللونين. القيمة الفارغة تعني «عُد للون المنصة». */
export function saveColors(db: Db, tenantId: number, input: { color?: unknown; deep?: unknown }): Branding {
  const color = input.color === '' || input.color === null ? null : normalizeHex(input.color);
  const deep = input.deep === '' || input.deep === null ? null : normalizeHex(input.deep);

  if (input.color !== undefined && input.color !== '' && input.color !== null && !color) {
    throw Object.assign(new Error('اللون غير صالح — الصيغة #a1b2c3.'), { statusCode: 400 });
  }
  if (input.deep !== undefined && input.deep !== '' && input.deep !== null && !deep) {
    throw Object.assign(new Error('لون الشريط غير صالح — الصيغة #a1b2c3.'), { statusCode: 400 });
  }

  db.prepare('UPDATE tenants SET brand_color = ?, brand_deep = ? WHERE id = ?').run(color, deep, tenantId);
  return readBranding(db, tenantId);
}

/* ---------------------------------------------------------------
   الشعار
--------------------------------------------------------------- */

const MAX_LOGO_BYTES = 512 * 1024;

/**
 * النوع من بايتات الملف لا من ترويسة data: — الترويسة يكتبها المرسِل.
 *
 * وSVG مرفوض عمداً: ملف SVG قد يحمل سكربتاً، وعرضه من نفس أصل اللوحة
 * يجعله يقرأ جلسة كل من يفتح الصفحة. لا شعار يستحق ذلك.
 */
function sniff(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12).toString('hex');
  const ascii = buffer.subarray(0, 12).toString('latin1');

  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', ext: '.png' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: '.jpg' };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { mime: 'image/gif', ext: '.gif' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

export interface StoredLogo {
  relativePath: string;
  mime: string;
  bytes: number;
}

/** يحفظ الشعار من حمولة base64 ويُرجع مساره النسبي. */
export function storeLogo(db: Db, dbPath: string, tenantId: number, payload: string): StoredLogo {
  const buffer = Buffer.from(String(payload).replace(/^data:[^,]*,/, ''), 'base64');
  if (buffer.length === 0) throw Object.assign(new Error('لم يصل أي ملف.'), { statusCode: 400 });
  if (buffer.length > MAX_LOGO_BYTES) {
    throw Object.assign(new Error('الشعار أكبر من ٥١٢ كيلوبايت.'), { statusCode: 400 });
  }

  const kind = sniff(buffer);
  if (!kind) {
    throw Object.assign(new Error('الصيغة غير مدعومة — PNG أو JPG أو WEBP أو GIF.'), { statusCode: 400 });
  }

  const dir = join(mediaRoot(dbPath), String(tenantId), 'branding');
  mkdirSync(dir, { recursive: true });

  // اسم ثابت باللاحقة: الشعار واحد لكل منشأة، فلا تتراكم الملفات المهجورة.
  const name = `logo${kind.ext}`;
  writeFileSync(join(dir, name), buffer);

  const relativePath = `${tenantId}/branding/${name}`;
  // الصيغة قد تتغيّر، فتُحذف السابقة المختلفة حتى لا يبقى ملف لا يشير إليه شيء.
  const previous = (db.prepare('SELECT brand_logo FROM tenants WHERE id = ?').get(tenantId) as Row | undefined)
    ?.brand_logo;
  if (previous && previous !== relativePath) removeFile(dbPath, previous);

  db.prepare('UPDATE tenants SET brand_logo = ? WHERE id = ?').run(relativePath, tenantId);
  return { relativePath, mime: kind.mime, bytes: buffer.length };
}

function removeFile(dbPath: string, relativePath: string): void {
  if (relativePath.includes('..') || relativePath.startsWith('/')) return;
  rmSync(join(mediaRoot(dbPath), relativePath), { force: true });
}

export function removeLogo(db: Db, dbPath: string, tenantId: number): void {
  const row = db.prepare('SELECT brand_logo FROM tenants WHERE id = ?').get(tenantId) as Row | undefined;
  if (row?.brand_logo) removeFile(dbPath, row.brand_logo);
  db.prepare('UPDATE tenants SET brand_logo = NULL WHERE id = ?').run(tenantId);
}

/** يقرأ الشعار للعرض. يعيد undefined إن لم يعد الملف موجوداً. */
export function readLogo(
  dbPath: string,
  relativePath: string,
): { body: Buffer; mime: string; bytes: number } | undefined {
  if (relativePath.includes('..') || relativePath.startsWith('/')) return undefined;
  const path = join(mediaRoot(dbPath), relativePath);
  if (!existsSync(path)) return undefined;

  const body = readFileSync(path);
  const kind = sniff(body);
  if (!kind) return undefined;
  return { body, mime: kind.mime, bytes: statSync(path).size };
}
