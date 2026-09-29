/**
 * قراءة ملفات اكسل وكتابتها — بلا مكتبة خارجية.
 *
 * الملف الذي يملؤه العميل يمرّ على هذا المحلّل، ومكتبة خارجية هنا
 * سطح هجوم لا نتحكم فيه: محلّل ملفات هو أول ما يُستهدف، ومكتبات
 * اكسل تاريخها حافل بثغرات فكّ الضغط وXML. وما نكتبه نقرؤه ونختبره،
 * ولا يقبل إلا ما نحتاجه فعلاً.
 *
 * ملف xlsx هو أرشيف ZIP يحوي XML. نكتب بلا ضغط (أبسط وصالح تماماً)،
 * ونقرأ المضغوط لأن اكسل يعيد كتابة الملف مضغوطاً بعد أن يحفظه العميل.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

/* ---------------------------------------------------------------
   CRC32 — يلزم ترويسة ZIP
--------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------------------------------------------------------
   كتابة ZIP
--------------------------------------------------------------- */

interface Entry {
  name: string;
  data: Buffer;
  /** يُضغط عند الكتابة — يُستعمل لمحاكاة مخرجات اكسل في الاختبار. */
  deflate?: boolean;
}

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const stored = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // النسخة المطلوبة
    local.writeUInt16LE(0x0800, 6); // علم UTF-8 للأسماء
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + stored.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ---------------------------------------------------------------
   قراءة ZIP
--------------------------------------------------------------- */

function unzip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  // نهاية الدليل المركزي تُبحث من الخلف: التعليق في آخر الملف متغيّر الطول.
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('الملف ليس بصيغة اكسل صالحة.');

  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    // الترويسة المحلية تحمل أطوالاً قد تخالف المركزية — نقرأ منها.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    try {
      files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    } catch {
      // إدخال تالف لا يُسقط بقية الملف
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/* ---------------------------------------------------------------
   XML
--------------------------------------------------------------- */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // محارف التحكّم ممنوعة في XML 1.0 وتُسقط الملف كله عند فتحه.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** A1 → 0، B1 → 1، AA1 → 26. العمود قد يُحذف حين تكون الخلية فارغة. */
function columnIndex(reference: string): number {
  const letters = reference.replace(/\d+/g, '');
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/* ---------------------------------------------------------------
   الواجهة
--------------------------------------------------------------- */

export interface Sheet {
  name: string;
  rows: string[][];
}

/** ينشئ ملف اكسل من أوراق نصية. */
export function buildWorkbook(sheets: Sheet[]): Buffer {
  if (sheets.length === 0) throw new Error('لا أوراق.');

  const sheetXml = (sheet: Sheet): string => {
    const rows = sheet.rows
      .map((cells, r) => {
        const body = cells
          .map((value, c) => {
            const text = String(value ?? '');
            if (!text) return '';
            const ref = `${columnName(c)}${r + 1}`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${body}</row>`;
      })
      .join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };

  const entries: Entry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('')}</Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        'utf8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
        'utf8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('')}</Relationships>`,
        'utf8',
      ),
    },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(sheet), 'utf8'),
    })),
  ];

  return zip(entries);
}

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * يقرأ ملف اكسل ويُعيد أوراقه نصاً.
 *
 * يقبل ما يكتبه اكسل بعد حفظ العميل — بالسلاسل المشتركة والضغط —
 * وما نكتبه نحن بالسلاسل المضمّنة.
 */
export function readWorkbook(buffer: Buffer): Sheet[] {
  const files = unzip(buffer);

  /* --- السلاسل المشتركة: اكسل يكتب النصوص هنا ويشير إليها برقم --- */
  const shared: string[] = [];
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sharedXml) {
    for (const item of sharedXml.split('<si>').slice(1)) {
      // النص قد يتجزّأ على عدة <t> حين يختلف تنسيق أجزائه.
      const parts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1] ?? ''));
      shared.push(parts.join(''));
    }
  }

  /* --- أسماء الأوراق بترتيب الكتاب --- */
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const names = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1] ?? ''));

  const sheets: Sheet[] = [];

  for (let i = 0; i < Math.max(names.length, 1); i += 1) {
    const xml = files.get(`xl/worksheets/sheet${i + 1}.xml`)?.toString('utf8');
    if (!xml) continue;

    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = cellMatch[1] ?? '';
        const body = cellMatch[2] ?? '';
        const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
        const type = /t="([^"]+)"/.exec(attributes)?.[1];

        let value = '';
        if (type === 's') {
          const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
          value = shared[index] ?? '';
        } else if (type === 'inlineStr') {
          const parts = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1] ?? ''));
          value = parts.join('');
        } else {
          const raw = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
          value = unescapeXml(raw);
        }

        // الخلية الفارغة لا تُكتب أصلاً، فنضعها في موضعها بالمرجع.
        const at = reference ? columnIndex(reference) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      rows.push(cells);
    }

    sheets.push({ name: names[i] ?? `ورقة${i + 1}`, rows });
  }

  if (sheets.length === 0) throw new Error('لم نجد أي ورقة في الملف.');
  return sheets;
}

/**
 * للاختبار: يبني أرشيفاً من ملفات خام، مضغوطة أو لا.
 *
 * يلزم لمحاكاة ما يكتبه اكسل بالضبط — سلاسل مشتركة ومحتوى مضغوط —
 * وهو المسار الذي يمرّ به كل ملف بعد أن يحفظه العميل. اختباره
 * بمخرجاتنا نحن وحدها يترك أهم حالة بلا تغطية.
 */
export function packForTest(files: [name: string, content: string][], compress = true): Buffer {
  return zip(
    files.map(([name, content]) => {
      const raw = Buffer.from(content, 'utf8');
      return compress ? deflatedEntry(name, raw) : { name, data: raw };
    }),
  );
}

/** ZIP يدعم إدخالاً مضغوطاً واحداً — يُستعمل في الاختبار فقط. */
function deflatedEntry(name: string, raw: Buffer): Entry {
  // نُبقي البنية كما هي: الكاتب لا يضغط، فنمرّر المضغوط بوسم الطريقة
  // عبر مسار منفصل في zip() أدناه.
  return { name, data: raw, deflate: true } as Entry;
}
