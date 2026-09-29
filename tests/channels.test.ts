/**
 * استعداد النظام لقنوات أخرى — بلا بناء أي قناة.
 *
 * الخطر الذي يمسكه هذا الملف صامت ويقع مرة واحدة: القيد القائم
 * UNIQUE (tenant_id, customer_wa) يجعل «محمد ٥٥٥ على واتساب»
 * و«الحساب ٥٥٥ على إنستغرام» محادثة واحدة. فتظهر رسائل عميل في
 * محادثة عميل آخر — تسريب لا يُكتشف إلا من شكوى.
 *
 * ولا يُعاد بناء الجدول لأجل قناة لم تُبنَ: المفتاح المُسبَق بالقناة
 * يكفي، وبيانات واتساب القائمة لا تُهاجَر.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant } from './helpers.ts';
import {
  channelKey,
  getOrCreateConversation,
  saveMessage,
  recentMessages,
  DEFAULT_CHANNEL,
  type Db,
} from '../src/db/index.ts';

let db: Db;
let tenantId = 0;

beforeEach(() => {
  db = freshDb();
  tenantId = seedTenant(db, { name: 'وقودي', waNumber: '966500000001' }).id;
});
afterEach(() => db.close());

describe('مفتاح القناة', () => {
  it('واتساب يبقى رقماً مجرّداً — فلا تُهاجَر بيانات قائمة', () => {
    expect(channelKey('whatsapp', '966555000111')).toBe('966555000111');
    expect(channelKey('whatsapp', '+966 555 000 111')).toBe('966555000111');
  });

  it('وغيره يُسبَق باسم قناته', () => {
    expect(channelKey('instagram', 'user_123')).toBe('instagram:user_123');
    expect(channelKey('email', 'a@b.com')).toBe('email:a@b.com');
  });
});

describe('العزل بين القنوات', () => {
  /** جوهر الاستعداد. */
  it('نفس المعرّف على قناتين = محادثتان لا واحدة', () => {
    const whatsapp = getOrCreateConversation(db, tenantId, '966555000111');
    const instagram = getOrCreateConversation(db, tenantId, '966555000111', undefined, 'instagram');

    expect(instagram.id).not.toBe(whatsapp.id);
    expect(whatsapp.channel).toBe('whatsapp');
    expect(instagram.channel).toBe('instagram');
  });

  it('ورسائل إحداهما لا تظهر في الأخرى', () => {
    const whatsapp = getOrCreateConversation(db, tenantId, '966555000111');
    const instagram = getOrCreateConversation(db, tenantId, '966555000111', undefined, 'instagram');

    saveMessage(db, whatsapp.id, 'customer', 'رسالة واتساب');
    saveMessage(db, instagram.id, 'customer', 'رسالة إنستغرام');

    expect(recentMessages(db, whatsapp.id, 10).map((m) => m.body)).toEqual(['رسالة واتساب']);
    expect(recentMessages(db, instagram.id, 10).map((m) => m.body)).toEqual(['رسالة إنستغرام']);
  });

  it('والعودة لنفس القناة تُعيد المحادثة نفسها', () => {
    const first = getOrCreateConversation(db, tenantId, 'user_9', undefined, 'instagram');
    const again = getOrCreateConversation(db, tenantId, 'user_9', undefined, 'instagram');
    expect(again.id).toBe(first.id);
  });
});

describe('التوافق مع ما هو قائم', () => {
  it('المحادثات القديمة تُقرأ قناتها whatsapp', () => {
    // صفّ كُتب قبل إضافة العمود — القيمة الافتراضية تتكفّل به
    db.prepare('INSERT INTO conversations (tenant_id, customer_wa) VALUES (?, ?)').run(tenantId, '966555000222');
    const row = db
      .prepare('SELECT * FROM conversations WHERE customer_wa = ?')
      .get('966555000222') as { channel: string };

    expect(row.channel).toBe('whatsapp');
  });

  it('واستدعاء بلا قناة يبقى واتساب', () => {
    const conversation = getOrCreateConversation(db, tenantId, '966555000333');
    expect(conversation.channel).toBe(DEFAULT_CHANNEL);
  });

  it('والمحادثة القديمة تُلتقط بلا تكرار بعد إضافة العمود', () => {
    db.prepare('INSERT INTO conversations (tenant_id, customer_wa) VALUES (?, ?)').run(tenantId, '966555000444');
    const found = getOrCreateConversation(db, tenantId, '966555000444');

    const count = db
      .prepare('SELECT COUNT(*) n FROM conversations WHERE tenant_id = ?')
      .get(tenantId) as { n: number };
    expect(count.n).toBe(1);
    expect(found.customer_wa).toBe('966555000444');
  });
});
