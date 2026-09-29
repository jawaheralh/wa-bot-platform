/**
 * ملف تأسيس المنشأة.
 *
 * تأسيس عميل جديد كان يعني جلسة طويلة نستخرج فيها منه ما يعرفه بالفعل:
 * أسعاره وفروعه وسياساته. فصار يأخذ ملف اكسل يملؤه على مهله، ويُرفع
 * بضغطة زر.
 *
 * وثلاث أوراق لا واحدة:
 *   المعرفة — ما يجيب عنه البوت.
 *   الحدود  — ما لا يجيب عنه أبداً، وهذا أهمّها.
 *   الفروع  — مواقع وأوقات، وهي أكثر ما يُسأل عنه.
 *
 * ورقة الحدود هي الفرق بين بوت يُطمأنّ إليه وبوت يَعِد بما لا تملكه
 * المنشأة. وتركها فارغة قرار، لا سهو.
 */

import { buildWorkbook, readWorkbook, type Sheet } from './xlsx.ts';
import { addKbEntry, listKb } from './modules/inquiries.ts';
import type { Db, TenantRow } from './db/index.ts';

export const SHEET_KB = 'المعرفة';
export const SHEET_LIMITS = 'الحدود';
export const SHEET_BRANCHES = 'الفروع';

/** أول صف تعليمات، والثاني عناوين، ثم أمثلة تُحذف. */
const KB_HEADERS = ['السؤال كما يكتبه العميل', 'الجواب', 'كلمات بديلة (اختياري)'];
const LIMITS_HEADERS = ['الموضوع', 'ماذا يقول البوت', 'ملاحظة'];
const BRANCH_HEADERS = ['اسم الفرع', 'المدينة', 'الموقع', 'أوقات العمل', 'الخدمات'];

/** ينشئ الملف الفارغ بالتعليمات والأمثلة. */
export function buildTemplate(tenant: TenantRow): Buffer {
  const sheets: Sheet[] = [
    {
      name: SHEET_KB,
      rows: [
        ['تعليمات: سؤال في كل صف كما يكتبه العميل فعلاً، والجواب بجانبه. تُحذف صفوف الأمثلة قبل الإرسال.'],
        KB_HEADERS,
        ['مثال — متى تفتحون؟', 'مثال — نعمل ٢٤ ساعة طوال أيام الأسبوع.', 'الدوام، ساعات العمل'],
        ['مثال — وش أنواع الوقود عندكم؟', 'مثال — بنزين ٩١ و٩٥ وديزل.', 'البنزين، السولار'],
        ['', '', ''],
      ],
    },
    {
      name: SHEET_LIMITS,
      rows: [
        ['تعليمات: ما لا يُراد أن يجيب عنه البوت — الموضوع، وماذا يقول بدل الإجابة.'],
        LIMITS_HEADERS,
        ['مثال — الشكاوى القانونية', 'مثال — يحوّل للموظف مباشرة ولا يناقش.', 'حسّاس'],
        ['مثال — الخصومات والعروض', 'مثال — العروض تتغيّر، يحوّل للمبيعات.', ''],
        ['', '', ''],
      ],
    },
    {
      name: SHEET_BRANCHES,
      rows: [
        ['تعليمات: فرع في كل صف. «الموقع» يقبل رابط خرائط أو وصفاً.'],
        BRANCH_HEADERS,
        ['مثال — فرع الصريف', 'ينبع', 'طريق الملك عبدالعزيز', '٢٤ ساعة', 'بنزين، مغسلة، سوبرماركت'],
        ['', '', '', '', ''],
      ],
    },
  ];

  void tenant;
  return buildWorkbook(sheets);
}

export interface ImportResult {
  added: number;
  skipped: number;
  /** أسباب التخطّي، ليصحّحها من رفع الملف بدل أن يخمّن. */
  notes: string[];
}

/** صفّ تعليمات أو عنوان أو مثال — لا يُستورد. */
function isTemplateRow(cells: string[]): boolean {
  const first = (cells[0] ?? '').trim();
  if (!first) return true;
  if (first.startsWith('تعليمات')) return true;
  if (first.startsWith('مثال')) return true;
  return KB_HEADERS.includes(first) || LIMITS_HEADERS.includes(first) || BRANCH_HEADERS.includes(first);
}

/**
 * يستورد الملف إلى قاعدة المعرفة.
 *
 * الحدود والفروع تُحوَّل إلى مدخلات معرفة أيضاً: البوت لا يقرأ جداول،
 * بل يقرأ معرفة المنشأة. وصياغتها سؤالاً وجواباً تجعلها تعمل بلا
 * آلية ثانية.
 */
export function importWorkbook(db: Db, tenantId: number, buffer: Buffer): ImportResult {
  const sheets = readWorkbook(buffer);
  const result: ImportResult = { added: 0, skipped: 0, notes: [] };

  // ما هو موجود لا يُكرَّر: الرفع مرتين شائع، ولا يجوز أن يُضاعف المعرفة.
  const existing = new Set(listKb(db, tenantId).map((e) => e.question.trim()));

  /**
   * الكلمات البديلة تُلحق بالجواب لا بحقل مستقل.
   *
   * قاعدة المعرفة سؤال وجواب فقط، والبوت يقرأها نصاً. فإلحاقها سطراً
   * يجعل «السولار» تُطابق سؤالاً عن الديزل بلا حقل جديد ولا هجرة.
   */
  const add = (question: string, answer: string, keywords?: string): void => {
    const q = question.trim();
    const a = answer.trim();
    if (!q || !a) {
      result.skipped += 1;
      return;
    }
    if (existing.has(q)) {
      result.skipped += 1;
      return;
    }
    const alt = keywords?.trim();
    addKbEntry(db, tenantId, q, alt ? `${a}\n(كلمات مرادفة: ${alt})` : a);
    existing.add(q);
    result.added += 1;
  };

  for (const sheet of sheets) {
    const name = sheet.name.trim();

    for (const cells of sheet.rows) {
      if (isTemplateRow(cells)) continue;

      if (name === SHEET_KB) {
        add(cells[0] ?? '', cells[1] ?? '', cells[2]);
        continue;
      }

      if (name === SHEET_LIMITS) {
        const topic = (cells[0] ?? '').trim();
        const behaviour = (cells[1] ?? '').trim();
        if (!topic || !behaviour) {
          result.skipped += 1;
          continue;
        }
        add(`سياسة المنشأة في: ${topic}`, behaviour, topic);
        continue;
      }

      if (name === SHEET_BRANCHES) {
        const branch = (cells[0] ?? '').trim();
        if (!branch) {
          result.skipped += 1;
          continue;
        }
        const parts = [
          cells[1] ? `المدينة: ${cells[1].trim()}` : '',
          cells[2] ? `الموقع: ${cells[2].trim()}` : '',
          cells[3] ? `أوقات العمل: ${cells[3].trim()}` : '',
          cells[4] ? `الخدمات: ${cells[4].trim()}` : '',
        ].filter(Boolean);

        if (parts.length === 0) {
          result.skipped += 1;
          result.notes.push(`الفرع «${branch}» بلا أي تفاصيل.`);
          continue;
        }
        add(`أين ${branch} وما تفاصيله؟`, parts.join('\n'), `${branch}، ${cells[1] ?? ''}`);
        continue;
      }

      // ورقة لا نعرفها: تُتجاهل بصمت لا تُستورد خطأً.
      result.skipped += 1;
    }
  }

  if (result.added === 0 && result.skipped > 0) {
    result.notes.push('لم يُضَف شيء — يلزم ملء الأعمدة وحذف صفوف الأمثلة.');
  }
  return result;
}
