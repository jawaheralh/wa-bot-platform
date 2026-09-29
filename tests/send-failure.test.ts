/**
 * ترجمة رفض Meta.
 *
 * كان الرفض يظهر للموظفة JSON خاماً، فأشهر حالاته — انقضاء نافذة
 * الأربع والعشرين ساعة — تبدو عطلاً في النظام: يُفتَح بلاغ، ويُبحث
 * عن خلل، والسبب قاعدة من Meta لا إصلاح لها إلا قالب معتمد.
 */

import { describe, it, expect } from 'vitest';
import { explainSendFailure } from '../src/whatsapp/cloud-api.ts';

function metaError(code: number, message = 'x', details?: string): string {
  return JSON.stringify({
    error: { code, message, ...(details ? { error_data: { details } } : {}) },
  });
}

describe('نافذة الأربع والعشرين ساعة', () => {
  it('تُشرح بلغة الموظفة لا برمز خطأ', () => {
    const text = explainSendFailure(400, metaError(131047, 'Re-engagement message'));

    expect(text).toContain('٢٤ ساعة');
    expect(text).toContain('قالب');
    expect(text).not.toContain('131047');
    expect(text).not.toContain('{');
  });
});

describe('بقية الأسباب الشائعة', () => {
  it('رقم لا يستقبل واتساب', () => {
    expect(explainSendFailure(400, metaError(131026))).toContain('لا يستقبل');
  });

  it('إرسال كثيف لنفس الرقم', () => {
    expect(explainSendFailure(400, metaError(131056))).toContain('انتظري');
  });

  it('توكن منتهٍ يُرشد لمكان تجديده', () => {
    const text = explainSendFailure(401, metaError(190));
    expect(text).toContain('توكن');
    expect(text).toContain('إعدادات هذه المنشأة');
  });
});

describe('ما لا نعرفه', () => {
  it('يُعاد بتفصيل Meta لا يُبتلع', () => {
    const text = explainSendFailure(400, metaError(999, 'Something odd', 'تفصيل دقيق'));
    expect(text).toContain('تفصيل دقيق');
    expect(text).toContain('400');
  });

  it('ورد ليس JSON لا يُسقط الترجمة', () => {
    const text = explainSendFailure(502, '<html>Bad Gateway</html>');
    expect(text).toContain('502');
    expect(text.length).toBeLessThan(300);
  });

  it('ورد فارغ كذلك', () => {
    expect(explainSendFailure(500, '')).toContain('500');
  });
});
