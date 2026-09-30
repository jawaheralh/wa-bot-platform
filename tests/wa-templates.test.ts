/**
 * إنشاء قوالب واتساب.
 *
 * القالب يُرسل لمراجعة Meta، وأكثر ما يُرفض يُرفض لسببين يمكن كشفهما
 * قبل الإرسال: ترقيم متغيّرات فيه فجوة، ومتغيّر بلا مثال. ورسالة
 * Meta عنهما غامضة، فالفحص هنا حيث تُفهم.
 *
 * وMeta لا تُستدعى في الاختبار: نداء حقيقي ينشئ قالباً في حساب شركة.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  createTemplate,
  deleteTemplate,
  listAllTemplates,
  validateTemplate,
  normalizeName,
  variablesIn,
  SUGGESTED,
  type NewTemplate,
} from '../src/wa-templates.ts';
import { forgetWaba } from '../src/waba.ts';
import type { MetaCredentials } from '../src/tenant-meta.ts';

const config = loadConfig();
const creds: MetaCredentials = {
  accessToken: 'TOKEN',
  appSecret: 'S',
  appId: '111',
  businessId: '222',
  own: true,
};

let calls: { url: string; method: string; body: Record<string, unknown> }[] = [];

/**
 * نداء اشتقاق الـWABA يُجاب ولا يُحسب.
 *
 * القوالب حافّة على حساب واتساب للأعمال لا على النشاط التجاري، فكل
 * عملية تسبقها استعلامة اشتقاق. وحسابها في `calls` يجعل كل تأكيد
 * على «النداء الأول» يفحص الاشتقاق لا القالب.
 */
function stub(status: number, body: unknown = {}): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('owned_whatsapp_business_accounts')) {
      return new Response(JSON.stringify({ data: [{ id: 'WABA-1', name: 'منشأة' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const BASE: NewTemplate = {
  name: 'order_update',
  language: 'ar',
  category: 'UTILITY',
  body: 'تحديث على طلبك رقم {{1}}: {{2}}.',
  examples: ['TLB-2026-000042', 'قيد التنفيذ'],
};

beforeEach(() => {
  calls = [];
  // الاشتقاق يُخزَّن في الذاكرة، فيبقى بين الاختبارات لولا هذا.
  forgetWaba();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('الاسم', () => {
  it('يُطوّع لما تقبله Meta', () => {
    expect(normalizeName('Order Update')).toBe('order_update');
    expect(normalizeName('تحديث الطلب')).toBe('');
    expect(normalizeName('order-update!')).toBe('orderupdate');
  });
});

describe('التحقق قبل الإرسال', () => {
  it('القالب الصحيح يمرّ', () => {
    expect(validateTemplate(BASE)).toBeNull();
  });

  /** Meta ترفض الفجوة برسالة غامضة — فتُكشف هنا بالاسم. */
  it('وفجوة في ترقيم المتغيّرات تُرفض', () => {
    const error = validateTemplate({ ...BASE, body: 'رقم {{1}} والحالة {{3}}', examples: ['a', 'b'] });
    expect(error).toContain('{{3}}');
  });

  it('والبدء من غير {{1}} يُرفض', () => {
    expect(validateTemplate({ ...BASE, body: 'رقم {{2}}', examples: ['a'] })).toContain('{{1}}');
  });

  it('ومتغيّر بلا مثال يُرفض', () => {
    expect(validateTemplate({ ...BASE, examples: ['واحد فقط'] })).toContain('مثالاً لكل متغيّر');
  });

  it('وقالبٌ بلا متغيّرات لا يحتاج أمثلة', () => {
    expect(validateTemplate({ ...BASE, body: 'وصلنا طلبك، شكراً لك.', examples: [] })).toBeNull();
  });

  it('والنصّ الفارغ والاسم الفارغ يُرفضان', () => {
    expect(validateTemplate({ ...BASE, body: '  ' })).toContain('نصّ القالب');
    expect(validateTemplate({ ...BASE, name: 'عربي فقط' })).toContain('اسم القالب');
  });

  it('وقراءة المتغيّرات تُسقط التكرار وترتّب', () => {
    expect(variablesIn('{{2}} ثم {{1}} ثم {{2}}')).toEqual([1, 2]);
    expect(variablesIn('بلا متغيّرات')).toEqual([]);
  });
});

describe('الإنشاء', () => {
  it('يُرسل الشكل الذي تطلبه Meta', async () => {
    stub(200, { id: '999', status: 'PENDING' });
    const result = await createTemplate(config, creds, { ...BASE, header: 'خدمة العملاء', footer: 'شكراً' });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toContain('/WABA-1/message_templates');
    expect(calls[0]!.method).toBe('POST');

    const sent = calls[0]!.body as { components: Record<string, unknown>[]; category: string };
    expect(sent.category).toBe('UTILITY');
    expect(sent.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER']);

    // الأمثلة مصفوفة داخل مصفوفة — هكذا تطلبها Meta لا غير.
    const bodyPart = sent.components.find((c) => c.type === 'BODY') as {
      example: { body_text: string[][] };
    };
    expect(bodyPart.example.body_text).toEqual([['TLB-2026-000042', 'قيد التنفيذ']]);
  });

  /** «معلّق» لا «جاهز»: الوعد بالجاهزية يجعل المالك يرسل فيفشل. */
  it('ولا يَعِد بأن القالب جاهز', async () => {
    stub(200, { id: '999', status: 'PENDING' });
    const result = await createTemplate(config, creds, BASE);
    expect(result.message).toContain('مراجعة');
    expect(result.data?.status).toBe('PENDING');
  });

  it('والمرفوض قبل الإرسال لا يصل Meta', async () => {
    stub(200, {});
    const result = await createTemplate(config, creds, { ...BASE, body: 'رقم {{1}} وحالة {{3}}' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('ورفض Meta يُنقل بنصّه', async () => {
    stub(400, { error: { error_user_msg: 'Template name already exists' } });
    const result = await createTemplate(config, creds, BASE);
    expect(result.message).toContain('already exists');
  });

  it('وبلا معرّف نشاط تجاري لا نداء', async () => {
    stub(200, {});
    const result = await createTemplate(config, { ...creds, businessId: '' }, BASE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('معرّف نشاط تجاري');
    expect(calls).toHaveLength(0);
  });
});

describe('القراءة والحذف', () => {
  /** المعلّق والمرفوض يُعرضان: إخفاؤهما يجعل المالك يعيد الإنشاء. */
  it('تُعاد الحالات كلها لا المعتمد وحده', async () => {
    stub(200, {
      data: [
        { name: 'a', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'رقم {{1}}' }] },
        { name: 'b', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'عرض' }] },
        { name: 'c', status: 'PENDING', category: 'UTILITY', components: [] },
      ],
    });

    const result = await listAllTemplates(config, creds);
    expect(result.templates).toHaveLength(3);
    expect(result.templates[0]!.variables).toBe(1);
    expect(result.templates[1]!.status).toBe('REJECTED');
  });

  it('والحذف بالاسم', async () => {
    stub(200, { success: true });
    const result = await deleteTemplate(config, creds, 'Order Update');
    expect(result.ok).toBe(true);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('name=order_update');
  });
});

describe('القوالب الجاهزة', () => {
  /** تُعرض بزرّ واحد، فلو كان فيها خطأ لَوقع في كل منشأة. */
  it('كلها صالحة بلا تعديل', () => {
    expect(SUGGESTED.length).toBeGreaterThan(0);
    for (const template of SUGGESTED) {
      expect(validateTemplate(template)).toBeNull();
      expect(normalizeName(template.name)).toBe(template.name);
    }
  });

  it('وفيها ما يحتاجه الطلب: رقم مرجعي وتحديث وتقييم', () => {
    const names = SUGGESTED.map((t) => t.name);
    expect(names).toContain('request_reference');
    expect(names).toContain('request_update');
    expect(names).toContain('service_rating');
  });
});
