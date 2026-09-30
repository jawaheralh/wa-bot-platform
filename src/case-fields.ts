/**
 * الحقول الإضافية للطلبات والشكاوى.
 *
 * ما تحتاجه محطة وقود ليس ما يحتاجه مطعم: الأولى تسأل عن نوع السيارة
 * ورقم المضخة، والثاني عن رقم الطاولة ووقت الحضور. وإضافة عمودٍ في
 * القاعدة لكل منهما يعني تعديل النظام كلما بِيع لقطاع جديد — وهو
 * نقيض الوعد المعماري للمشروع.
 *
 * فالحقول تُعرَّف لكل منشأة في إعداد الوحدة، وتُحفظ قيمها في عمود
 * واحد بصيغة JSON.
 *
 * ## لماذا نصّ لا JSON في شاشة الإعداد
 *
 * من يعرّف الحقول مالكُ منشأةٍ لا مبرمج. وسطرٌ مثل
 * «نوع السيارة | اختيار | سيدان، دباب» يكتبه ويقرأه، أما قوسٌ ناقص
 * في JSON فيمنعه من الحفظ ولا يعرف لماذا.
 */

export const FIELD_TYPES = ['نص', 'رقم', 'تاريخ', 'وقت', 'اختيار'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDef {
  /** مفتاح ثابت يُشتق من التسمية — هو ما يُحفظ في القاعدة. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** خيارات حقل الاختيار. */
  options: string[];
}

/** حدٌّ يمنع نموذجاً لا ينتهي، ويمنع حمولةً ضخمة في كل صف. */
const MAX_FIELDS = 12;

/**
 * المفتاح من التسمية.
 *
 * التسمية عربية، والمفتاح يجب أن يثبت حين تُصحَّح التسمية إملائياً —
 * ولهذا يُشتق مرة عند التعريف ولا يُعاد اشتقاقه عند كل قراءة... غير
 * أن الاشتقاق هنا حتمي من النصّ نفسه، فتغيير التسمية تغييرُ مفتاح.
 * وهذا مقبول: القيم القديمة تبقى محفوظة وتظهر تحت اسمها القديم بدل
 * أن تُنسب خطأً لحقل جديد.
 */
function keyOf(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, 40);
}

/**
 * يقرأ تعريف الحقول من نصّ الإعداد.
 *
 * سطرٌ لكل حقل: `التسمية | النوع | الخيارات`. النوع والخيارات
 * اختياران، والافتراضي «نص». والنجمة بعد التسمية تعني إلزامياً.
 *
 * والسطر المعطوب يُتجاهَل ولا يُسقط البقية: خطأ مطبعي في حقلٍ واحد
 * لا يجوز أن يُفرغ نموذج الطلبات كله.
 */
export function parseFields(text: unknown): FieldDef[] {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: FieldDef[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const [rawLabel = '', rawType = '', rawOptions = ''] = line.split('|').map((p) => p.trim());
    const required = rawLabel.endsWith('*');
    const label = (required ? rawLabel.slice(0, -1) : rawLabel).trim();
    if (!label) continue;

    const key = keyOf(label);
    if (!key || seen.has(key)) continue;

    const type = (FIELD_TYPES as readonly string[]).includes(rawType) ? (rawType as FieldType) : 'نص';
    const options =
      type === 'اختيار'
        ? rawOptions
            .split(/[،,]/)
            .map((o) => o.trim())
            .filter(Boolean)
        : [];

    // حقل اختيار بلا خيارات نصٌّ حرّ — أرحم من رفضه أو عرض قائمة فارغة.
    fields.push({ key, label, type: type === 'اختيار' && !options.length ? 'نص' : type, required, options });
    seen.add(key);
    if (fields.length >= MAX_FIELDS) break;
  }

  return fields;
}

/** النصّ كما يُعرض في شاشة الإعداد — لتدوير القيمة بلا تشويه. */
export function fieldsToText(fields: FieldDef[]): string {
  return fields
    .map((f) => {
      const head = `${f.label}${f.required ? '*' : ''}`;
      if (f.type === 'اختيار') return `${head} | اختيار | ${f.options.join('، ')}`;
      return f.type === 'نص' ? head : `${head} | ${f.type}`;
    })
    .join('\n');
}

/* ---------------------------------------------------------------
   القيم
--------------------------------------------------------------- */

export type FieldValues = Record<string, string>;

export function readValues(stored: unknown): FieldValues {
  try {
    const parsed = JSON.parse(String(stored ?? '{}')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FieldValues = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

export interface ValidationResult {
  values: FieldValues;
  /** أول خطأ يمنع الحفظ، أو لا شيء. */
  error?: string;
}

/**
 * يتحقق من القيم الواردة ويُبقي ما يخصّ الحقول المعرَّفة وحدها.
 *
 * الحقل المحذوف من التعريف تُحذف قيمته الجديدة ولا تُحذف القديمة —
 * سجلٌّ كُتب فيه «نوع السيارة» لا يجوز أن يفقده لأن المالك ألغى
 * الحقل اليوم.
 */
export function validateValues(fields: FieldDef[], input: unknown, previous: FieldValues = {}): ValidationResult {
  const incoming = readValues(typeof input === 'string' ? input : JSON.stringify(input ?? {}));
  const values: FieldValues = { ...previous };

  for (const field of fields) {
    const raw = (incoming[field.key] ?? '').trim();

    if (!raw) {
      if (field.required) return { values, error: `«${field.label}» مطلوب.` };
      delete values[field.key];
      continue;
    }

    if (field.type === 'رقم' && !/^-?\d+(\.\d+)?$/.test(raw)) {
      return { values, error: `«${field.label}» يجب أن يكون رقماً.` };
    }
    if (field.type === 'تاريخ' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { values, error: `«${field.label}» يجب أن يكون تاريخاً (سنة-شهر-يوم).` };
    }
    if (field.type === 'وقت' && !/^\d{1,2}:\d{2}$/.test(raw)) {
      return { values, error: `«${field.label}» يجب أن يكون وقتاً (٥:٣٠).` };
    }
    if (field.type === 'اختيار' && !field.options.includes(raw)) {
      return { values, error: `«${field.label}» يجب أن يكون أحد: ${field.options.join('، ')}.` };
    }

    values[field.key] = raw.slice(0, 500);
  }

  return { values };
}

/** يُسطّر القيم للعرض في اللوحة وفي نصّ يُرسل للموظف. */
export function describeValues(fields: FieldDef[], values: FieldValues): string {
  const known = new Map(fields.map((f) => [f.key, f.label]));
  return Object.entries(values)
    .map(([key, value]) => `${known.get(key) ?? key}: ${value}`)
    .join(' · ');
}

/**
 * يحوّل التعريف إلى خصائص أداة يفهمها النموذج.
 *
 * بهذا يجمع البوت نفس ما يجمعه الموظف: المالك يعرّف «نوع السيارة»
 * مرة، فيسأل عنها البوت في المحادثة ويعرضها النموذج في اللوحة — بلا
 * سطر واحد إضافي في أيٍّ منهما.
 */
export function toolProperties(fields: FieldDef[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    properties[field.key] = {
      type: 'string',
      description:
        field.type === 'اختيار'
          ? `${field.label} — أحد: ${field.options.join('، ')}`
          : field.type === 'وقت'
            ? `${field.label} — بصيغة ٥:٣٠`
            : field.type === 'تاريخ'
              ? `${field.label} — بصيغة سنة-شهر-يوم`
              : field.label,
      ...(field.type === 'اختيار' ? { enum: field.options } : {}),
    };
  }
  return properties;
}
