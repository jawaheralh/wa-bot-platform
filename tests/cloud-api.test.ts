/**
 * مزوّد Cloud API: التوقيع، والتوجيه حسب phone_number_id، وتطبيع الحمولة.
 * الإرسال يُختبر بـfetch وهمي؛ لا شبكة في الاختبارات.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { CloudApiProvider } from '../src/whatsapp/cloud-api.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import type { Db } from '../src/db/index.ts';
import type { IncomingMessage } from '../src/whatsapp/provider.ts';

const APP_SECRET = 'test-app-secret';

function cloudConfig(): AppConfig {
  const config = loadConfig();
  return {
    ...config,
    provider: 'cloud',
    cloud: {
      verifyToken: 'verify-me',
      appSecret: APP_SECRET,
      accessToken: 'test-token',
      graphVersion: 'v23.0',
    },
  };
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function payload(phoneNumberId: string, text: string, from = '966555555555'): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '966500000001', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'سارة' }, wa_id: from }],
              messages: [{ from, id: 'wamid.TEST', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

let db: Db;
let provider: CloudApiProvider;
let received: IncomingMessage[];

beforeEach(() => {
  db = freshDb();
  seedTenant(db, { name: 'عيادة', waNumber: '966500000001', waPhoneNumberId: 'PNID_1' });
  provider = new CloudApiProvider(db, cloudConfig(), silentLogger());
  received = [];
  provider.onMessage(async (message) => void received.push(message));
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('التوقيع', () => {
  it('التوقيع الصحيح يُقبل', () => {
    const body = JSON.stringify(payload('PNID_1', 'سلام'));
    expect(provider.verifySignature(body, sign(body))).toBe(true);
  });

  it('التوقيع الخاطئ يُرفض', () => {
    const body = JSON.stringify(payload('PNID_1', 'سلام'));
    expect(provider.verifySignature(body, sign('حمولة أخرى'))).toBe(false);
  });

  it('غياب الترويسة أو صيغة غريبة تُرفض بلا استثناء', () => {
    const body = '{}';
    expect(provider.verifySignature(body, undefined)).toBe(false);
    expect(provider.verifySignature(body, 'md5=abc')).toBe(false);
    expect(provider.verifySignature(body, 'sha256=قصير')).toBe(false);
  });

  it('أي تعديل على الجسم يُبطل التوقيع', () => {
    const body = JSON.stringify(payload('PNID_1', 'سلام'));
    const signature = sign(body);
    expect(provider.verifySignature(body.replace('سلام', 'سلاام'), signature)).toBe(false);
  });
});

describe('تطبيع الحمولة والتوجيه', () => {
  it('الرسالة النصية تصل للمحرّك بمعرّف الرقم واسم العميل', async () => {
    await provider.handlePayload(payload('PNID_1', 'كم سعر الكشف؟') as never);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      toPhoneNumberId: 'PNID_1',
      toNumber: '966500000001',
      from: '966555555555',
      pushName: 'سارة',
      text: 'كم سعر الكشف؟',
      waMessageId: 'wamid.TEST',
    });
  });

  it('التوجيه يعتمد phone_number_id فيميّز منشأتين', () => {
    seedTenant(db, { name: 'مطعم', waNumber: '966500000002', waPhoneNumberId: 'PNID_2' });
    expect(provider.knowsPhoneNumberId('PNID_1')).toBe(true);
    expect(provider.knowsPhoneNumberId('PNID_2')).toBe(true);
    expect(provider.knowsPhoneNumberId('PNID_MISSING')).toBe(false);
  });

  it('تحديثات الحالة (تم التسليم) ليست رسائل ولا تُوقظ المحرّك', async () => {
    const handled = await provider.handlePayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PNID_1' },
                statuses: [{ status: 'delivered' }],
              },
            },
          ],
        },
      ],
    } as never);
    expect(handled).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('عدة رسائل في حمولة واحدة تُعالَج كلها', async () => {
    await provider.handlePayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '966500000001', phone_number_id: 'PNID_1' },
                messages: [
                  { from: '966555555551', id: 'a', type: 'text', text: { body: 'أول' } },
                  { from: '966555555552', id: 'b', type: 'text', text: { body: 'ثاني' } },
                ],
              },
            },
          ],
        },
      ],
    } as never);
    expect(received.map((m) => m.text)).toEqual(['أول', 'ثاني']);
  });

  it('الرسالة الصوتية تصل بدالة تحميل كسولة', async () => {
    await provider.handlePayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '966500000001', phone_number_id: 'PNID_1' },
                messages: [{ from: '966555555555', id: 'v1', type: 'audio', audio: { id: 'MEDIA_1', mime_type: 'audio/ogg' } }],
              },
            },
          ],
        },
      ],
    } as never);

    expect(received[0]?.audio?.mimeType).toBe('audio/ogg');
    expect(typeof received[0]?.audio?.download).toBe('function');
  });

  it('النوع غير المدعوم (ملصق) يُتجاهل بلا خطأ', async () => {
    const handled = await provider.handlePayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PNID_1' },
                messages: [{ from: '966555555555', id: 's1', type: 'sticker' }],
              },
            },
          ],
        },
      ],
    } as never);
    expect(handled).toBe(0);
  });

  it('فشل معالجة رسالة لا يمنع معالجة التي بعدها', async () => {
    let calls = 0;
    provider.onMessage(async () => {
      calls += 1;
      if (calls === 1) throw new Error('عطل');
    });

    await provider.handlePayload({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PNID_1' },
                messages: [
                  { from: '966555555551', id: 'a', type: 'text', text: { body: 'أول' } },
                  { from: '966555555552', id: 'b', type: 'text', text: { body: 'ثاني' } },
                ],
              },
            },
          ],
        },
      ],
    } as never);

    expect(calls).toBe(2);
  });
});

describe('الإرسال', () => {
  it('يستعمل phone_number_id للمنشأة ويُعيد معرّف الرسالة', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.sendText(1, '+966 55 555 5555', 'أهلاً');

    expect(result.id).toBe('wamid.OUT');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/PNID_1/messages');
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe('966555555555');
    expect(body.text.body).toBe('أهلاً');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('منشأة بلا معرّف رقم تفشل برسالة عربية واضحة', async () => {
    const other = seedTenant(db, { name: 'بلا معرّف', waNumber: '966500000003' });
    await expect(provider.sendText(other.id, '966555555555', 'س')).rejects.toThrow(/wa_phone_number_id/);
  });

  it('خطأ ٤٠٠ لا يُعاد ثلاث مرات', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"bad"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.sendText(1, '966555555555', 'س')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('خطأ ٥٠٠ يُعاد ثم ينجح', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1
        ? new Response('boom', { status: 503 })
        : new Response(JSON.stringify({ messages: [{ id: 'wamid.RETRY' }] }), { status: 200 });
    });

    const result = await provider.sendText(1, '966555555555', 'س');
    expect(result.id).toBe('wamid.RETRY');
    expect(calls).toBe(2);
  });
});
