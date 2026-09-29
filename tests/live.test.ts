/**
 * البث المباشر.
 *
 * الخطر الأول أن تفوت الموظفةَ رسالةٌ لأن البصمة لم تتغيّر — وهو
 * صامت تماماً: لا خطأ ولا تحذير، فقط لوحة لا تتحرّك.
 *
 * والثاني أن يبقى مؤقّت يعمل لمنشأة لا أحد يشاهدها: استعلام كل
 * ثانيتين إلى الأبد لا يُلاحَظ إلا حين يمتلئ سجل الخادم.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type App } from '../src/app.ts';
import { createServer } from '../src/web/server.ts';
import { loadConfig } from '../src/config.ts';
import { freshDb, seedTenant, silentLogger } from './helpers.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { createUser } from '../src/tenants.ts';
import { resetLoginRate } from '../src/web/auth.ts';
import { getOrCreateConversation, saveMessage, type Db } from '../src/db/index.ts';
import { signatureOf, subscribe, stopAll, watchCount } from '../src/live.ts';
import { createComplaint, updateComplaintStatus } from '../src/modules/complaints.ts';

let app: App;
let server: FastifyInstance;
let db: Db;
let mine = 0;
let theirs = 0;
let owner = '';

beforeEach(async () => {
  db = freshDb();
  const a = seedTenant(db, { name: 'وقودي', waNumber: '966500000001' });
  const b = seedTenant(db, { name: 'جيران', waNumber: '966500000002' });
  mine = a.id;
  theirs = b.id;

  createUser(db, { tenantId: a.id, username: 'owner', password: 'owner12345', role: 'tenant' });

  app = await buildApp({
    config: { ...loadConfig(), provider: 'simulator', sessionSecret: 'test-secret-for-cookies' },
    db,
    provider: new SimulatorProvider(),
    logger: silentLogger(),
  });
  server = await createServer(app);
  await server.ready();
  resetLoginRate();

  const login = await server.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password: 'owner12345' },
  });
  owner = String(login.headers['set-cookie']).split(';')[0]!;
});

afterEach(async () => {
  stopAll();
  await server.close();
  db.close();
});

describe('البصمة تلتقط كل ما تعرضه اللوحة', () => {
  it('رسالة جديدة تغيّرها', () => {
    const before = signatureOf(db, mine);
    const conversation = getOrCreateConversation(db, mine, '966555000001');
    saveMessage(db, conversation.id, 'customer', 'مرحبا');
    expect(signatureOf(db, mine)).not.toBe(before);
  });

  it('محادثة جديدة تغيّرها ولو بلا رسائل', () => {
    const before = signatureOf(db, mine);
    getOrCreateConversation(db, mine, '966555000002');
    expect(signatureOf(db, mine)).not.toBe(before);
  });

  it('شكوى جديدة تغيّرها', () => {
    const conversation = getOrCreateConversation(db, mine, '966555000003');
    const before = signatureOf(db, mine);
    createComplaint(db, {
      tenantId: mine,
      conversationId: conversation.id,
      customerWa: '966555000003',
      summary: 'شكوى',
      category: 'service',
      severity: 'low',
    });
    expect(signatureOf(db, mine)).not.toBe(before);
  });

  /** تغيير الحالة لا يضيف صفاً، فلو اعتُمد على العدد وحده لفات. */
  it('وتغيير حالة شكوى قائمة يغيّرها أيضاً', () => {
    const conversation = getOrCreateConversation(db, mine, '966555000004');
    const complaint = createComplaint(db, {
      tenantId: mine,
      conversationId: conversation.id,
      customerWa: '966555000004',
      summary: 'شكوى',
      category: 'service',
      severity: 'low',
    });
    const before = signatureOf(db, mine);
    updateComplaintStatus(db, mine, complaint.id, 'closed');
    expect(signatureOf(db, mine)).not.toBe(before);
  });

  it('ولا شيء يتغيّر بلا كتابة', () => {
    expect(signatureOf(db, mine)).toBe(signatureOf(db, mine));
  });
});

describe('العزل بين المنشآت', () => {
  it('نشاط الجيران لا يغيّر بصمتي', () => {
    const before = signatureOf(db, mine);
    const conversation = getOrCreateConversation(db, theirs, '966555999999');
    saveMessage(db, conversation.id, 'customer', 'رسالة الجيران');
    expect(signatureOf(db, mine)).toBe(before);
  });
});

describe('الاشتراك', () => {
  it('يُبلَّغ المشترك عند التغيّر', async () => {
    const seen: string[] = [];
    const stop = subscribe(db, mine, (event) => seen.push(event.signature));

    const conversation = getOrCreateConversation(db, mine, '966555000005');
    saveMessage(db, conversation.id, 'customer', 'رسالة');

    await new Promise((resolve) => setTimeout(resolve, 2600));
    stop();

    expect(seen.length).toBeGreaterThan(0);
  });

  it('مؤقّت واحد مهما تعدّد المشتركون', () => {
    const a = subscribe(db, mine, () => {});
    const b = subscribe(db, mine, () => {});
    expect(watchCount()).toBe(1);
    a();
    b();
  });

  /** مؤقّت بلا مشاهدين استعلام كل ثانيتين إلى الأبد. */
  it('ويتوقف المؤقّت حين يغادر آخر مشترك', () => {
    const a = subscribe(db, mine, () => {});
    const b = subscribe(db, mine, () => {});
    a();
    expect(watchCount()).toBe(1);
    b();
    expect(watchCount()).toBe(0);
  });
});

describe('المسار محروس كبقية المسارات', () => {
  it('بلا جلسة يُرفض', async () => {
    const response = await server.inject({ method: 'GET', url: `/api/tenants/${mine}/stream` });
    expect(response.statusCode).toBe(401);
  });

  it('وبث منشأة أخرى يُرفض', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/tenants/${theirs}/stream`,
      headers: { cookie: owner },
    });
    expect(response.statusCode).toBe(403);
  });
});
