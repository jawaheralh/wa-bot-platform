/**
 * تحويل الرسائل الصوتية لنص.
 *
 * واجهة مستقلة لأن المزوّد قرار قابل للتغيير: اليوم Whisper من OpenAI،
 * وغداً قد يكون غيره. المحرّك يعرف `transcribe` فقط.
 * بلا مفتاح تُعطَّل الميزة كلياً ويطلب البوت رسالة نصية بلطف.
 */

import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim() ?? '';
  return EXTENSIONS[base] ?? 'ogg';
}

export function createTranscriber(config: AppConfig, logger: Logger): Transcriber | undefined {
  if (!config.transcription.enabled) {
    logger.info('تحويل الرسائل الصوتية معطّل (لا يوجد OPENAI_API_KEY أو ENABLE_VOICE=0)');
    return undefined;
  }

  const { apiKey, model, baseUrl } = config.transcription;

  return {
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${extensionFor(mimeType)}`);
      form.append('model', model);
      // تثبيت اللغة يرفع الدقة كثيراً مع اللهجة السعودية ويمنع الترجمة للإنجليزية.
      form.append('language', 'ar');

      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!response.ok) {
        throw new Error(`فشل تحويل الصوت (${response.status}): ${await response.text()}`);
      }

      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? '').trim();
      if (!text) throw new Error('نتيجة التحويل فارغة.');
      return text;
    },
  };
}
