/**
 * حفظ ما يرسله العميل من ملفات.
 *
 * الملف يُنزَّل مرة ويُحفظ على القرص، ويُشار إليه من صف الرسالة. ما يصل
 * العميل لا يُسقَط أبداً: صورة عطل قد تكون أوضح من وصفه، وفاتورة مصوَّرة
 * دليل شكوى.
 *
 * الحد الأقصى يحمي القرص من مقطع فيديو طويل يُرسله عميل بلا قصد.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMedia } from './whatsapp/provider.ts';
import type { Logger } from './logger.ts';

/** ٢٥ ميجا — أكبر من أي صورة أو مستند معقول، وأصغر من مقاطع الفيديو الطويلة. */
export const MAX_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export function extensionFor(mimeType: string, filename?: string): string {
  const fromName = filename ? extname(filename).toLowerCase() : '';
  if (fromName && fromName.length <= 6) return fromName;
  return EXTENSIONS[mimeType] ?? '.bin';
}

export interface StoredMedia {
  path: string;
  relativePath: string;
  bytes: number;
  mimeType: string;
  filename: string;
}

export function mediaRoot(dbPath: string): string {
  return join(dbPath.replace(/[^/]+$/, ''), 'media');
}

/**
 * يُنزّل الملف ويحفظه. يُعيد undefined إن تعذّر — ولا يرمي: فشل حفظ ملف
 * لا يجوز أن يمنع تسجيل رسالة العميل ولا الرد عليه.
 */
export async function storeMedia(
  dbPath: string,
  tenantId: number,
  media: IncomingMedia,
  logger: Logger,
): Promise<StoredMedia | undefined> {
  if (!media.download) return undefined;

  try {
    const buffer = await media.download();

    if (buffer.length > MAX_BYTES) {
      logger.warn('ملف تجاوز الحد فلم يُحفظ', {
        tenant: tenantId,
        نوع: media.kind,
        ميجا: Math.round(buffer.length / 1024 / 1024),
      });
      return undefined;
    }

    const dir = join(mediaRoot(dbPath), String(tenantId));
    mkdirSync(dir, { recursive: true });

    // اسم عشوائي لا اسم العميل: اسم ملفه قد يحمل مسارات أو حروفاً تكسر النظام.
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}${extensionFor(media.mimeType, media.filename)}`;
    const path = join(dir, name);
    writeFileSync(path, buffer);

    return {
      path,
      relativePath: `${tenantId}/${name}`,
      bytes: buffer.length,
      mimeType: media.mimeType,
      filename: media.filename ?? name,
    };
  } catch (error) {
    logger.error('تعذّر حفظ ملف العميل', error, { tenant: tenantId, نوع: media.kind });
    return undefined;
  }
}

/** الصور التي يستطيع النموذج رؤيتها فعلاً. */
export function isVisionImage(mimeType: string, bytes: number): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType) && bytes <= 5 * 1024 * 1024;
}

export function readStored(dbPath: string, relativePath: string): { path: string; bytes: number } | undefined {
  // منع الخروج من المجلد عبر ../ في مسار قادم من الطلب.
  if (relativePath.includes('..') || relativePath.startsWith('/')) return undefined;
  const path = join(mediaRoot(dbPath), relativePath);
  if (!existsSync(path)) return undefined;
  return { path, bytes: statSync(path).size };
}
