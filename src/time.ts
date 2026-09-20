/**
 * التوقيت.
 *
 * دوال SQLite الزمنية تعمل بتوقيت UTC، بينما النظام كله — المواعيد، وساعات
 * العمل، ونافذة الوضع الصامت، والتذكيرات — يعمل بتوقيت الرياض. خلط الاثنين
 * يُنتج فرق ثلاث ساعات صامت لا يظهر إلا في الإنتاج، لذلك تُستخدم هذه الثوابت
 * في كل استعلام بدل datetime('now') المجرّدة.
 *
 * الرياض UTC+3 ثابتة بلا توقيت صيفي، فالإزاحة ثابتة ولا تحتاج مكتبة مناطق.
 */

export const TZ = 'Asia/Riyadh';
export const TZ_OFFSET_HOURS = 3;

/** يُستعمل داخل نصوص SQL: WHERE silent_until > ${SQL_NOW} */
export const SQL_NOW = `datetime('now', '+3 hours')`;
export const SQL_TODAY = `date('now', '+3 hours')`;

/** نفس الصيغة التي تخزّنها SQLite: YYYY-MM-DD HH:MM:SS بلا T ولا Z. */
const SQL_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function parts(date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of SQL_FORMAT.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** الوقت الحالي بتوقيت الرياض بصيغة SQLite. */
export function now(date: Date = new Date()): string {
  const p = parts(date);
  // 'en-CA' يُخرج الساعة 24 بدل 00 في منتصف الليل على بعض الإصدارات.
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}:${p.second}`;
}

/** تاريخ اليوم بتوقيت الرياض: YYYY-MM-DD. */
export function today(offsetDays = 0, date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + offsetDays * 86_400_000);
  return now(shifted).slice(0, 10);
}

/** يحوّل نص SQLite (بتوقيت الرياض) إلى Date حقيقي. */
export function fromSql(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}+03:00`);
}

/** يضيف دقائق إلى طابع SQLite ويُعيد طابعاً مثله. */
export function addMinutes(sqlTime: string, minutes: number): string {
  return now(new Date(fromSql(sqlTime).getTime() + minutes * 60_000));
}

export function addHours(sqlTime: string, hours: number): string {
  return addMinutes(sqlTime, hours * 60);
}

/** الفرق بالدقائق بين طابعين (b - a). */
export function diffMinutes(a: string, b: string): number {
  return Math.round((fromSql(b).getTime() - fromSql(a).getTime()) / 60_000);
}

/* ---------------------------------------------------------------
   العرض بالعربي — يُحقن في الـsystem prompt وفي رسائل التأكيد
--------------------------------------------------------------- */

const DAYS_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/** اسم اليوم بالعربي لتاريخ YYYY-MM-DD. */
export function dayNameAr(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00+03:00`);
  return DAYS_AR[d.getUTCDay()] ?? '';
}

/** «الخميس ٢١ سبتمبر ٢٠٢٦» — الأرقام تبقى لاتينية عمداً لسهولة القراءة. */
export function formatDateAr(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  const month = MONTHS_AR[Number(m) - 1] ?? m;
  return `${dayNameAr(isoDate)} ${Number(d)} ${month} ${y}`;
}

/** «09:35 صباحاً» من HH:MM أو من طابع كامل. */
export function formatTimeAr(value: string): string {
  const hhmm = value.length > 5 ? value.slice(11, 16) : value;
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const suffix = h < 12 ? 'صباحاً' : h < 17 ? 'ظهراً' : h < 20 ? 'مساءً' : 'ليلاً';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${mStr} ${suffix}`;
}

/** «الخميس ٢١ سبتمبر ٢٠٢٦، 09:35 صباحاً» */
export function formatDateTimeAr(sqlTime: string): string {
  return `${formatDateAr(sqlTime.slice(0, 10))}، ${formatTimeAr(sqlTime)}`;
}

/* ---------------------------------------------------------------
   فهم التعبيرات العامية — «بكرة»، «بعد بكرة»، «الأحد الجاي»
   النموذج يفهمها بنفسه غالباً، لكن هذه الدالة تُستخدم في أدوات
   الحجز لتطبيع ما يرسله النموذج قبل الاستعلام.
--------------------------------------------------------------- */

const RELATIVE_DAYS: Record<string, number> = {
  'اليوم': 0,
  'بكرة': 1,
  'بكره': 1,
  'غدا': 1,
  'غداً': 1,
  'بعد بكرة': 2,
  'بعد بكره': 2,
  'بعد غد': 2,
};

/**
 * يُعيد YYYY-MM-DD من نص عربي عامي أو من تاريخ صريح، أو null إذا لم يُفهم.
 * تعمّدنا ألّا نخمّن: الغموض يُعاد للنموذج ليسأل العميل بدل أن نحجز يوماً خاطئاً.
 */
export function parseArabicDate(input: string, ref: string = today()): string | null {
  const text = input.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const relative = RELATIVE_DAYS[text];
  if (relative !== undefined) return today(relative, fromSql(`${ref} 12:00:00`));

  // «الأحد الجاي» / «يوم الثلاثاء» → أقرب يوم قادم بهذا الاسم.
  const dayIndex = DAYS_AR.findIndex((d) => text.includes(d));
  if (dayIndex >= 0) {
    const base = new Date(`${ref}T12:00:00+03:00`);
    for (let i = 1; i <= 7; i++) {
      const candidate = new Date(base.getTime() + i * 86_400_000);
      if (candidate.getUTCDay() === dayIndex) return now(candidate).slice(0, 10);
    }
  }

  return null;
}
