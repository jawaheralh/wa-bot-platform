/**
 * وحدة الاستقبال.
 * المحك: تُسأل البيانات مرة واحدة، وتُحفظ، ولا تُعاد على عميل معروف.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, baseContext, silentLogger, mockClaude } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import { intakeModule, saveIntake } from '../src/modules/intake.ts';
import { createEngine } from '../src/bot/engine.ts';
import { composeTools, composePrompt, enabledFor, setEnabled, setConfig } from '../src/modules/registry.ts';
import { getOrCreateConversation, type Db, type TenantRow } from '../src/db/index.ts';
import type { ModuleContext } from '../src/modules/types.ts';

let db: Db;
let tenant: TenantRow;

function ctx(overrides: Record<string, unknown> = {}): ModuleContext {
  return {
    ...baseContext(db, tenant),
    conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    config: { ...intakeModule.defaultConfig(), ...overrides },
  };
}

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db, { name: 'وقودي' });
  setEnabled(db, tenant.id, 'intake', true);
});
afterEach(() => db.close());

describe('الوحدة اختيارية', () => {
  it('أدواتها غائبة قبل التفعيل', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    const names = composeTools(enabledFor(db, other.id), baseContext(db, other)).map((t) => t.name);
    expect(names).not.toContain('save_customer_details');
  });
});

describe('الترحيب والسؤال', () => {
  it('عميل جديد: ترحيب وقائمة وسؤال عن الاسم والموقع في رسالة واحدة', () => {
    setConfig(db, tenant.id, 'intake', {
      ...intakeModule.defaultConfig(),
      greeting: 'حياك الله في {المنشأة}',
      locations: ['ينبع', 'أملج'],
    });
    const prompt = composePrompt(enabledFor(db, tenant.id), {
      ...baseContext(db, tenant),
      conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    });

    expect(prompt).toContain('حياك الله في وقودي');
    expect(prompt).toContain('اسمه');
    expect(prompt).toContain('ينبع');
    expect(prompt).toContain('رسالة واحدة لا ثلاث');
  });

  it('عميل عُرفت بياناته: لا ترحيب ولا سؤال، بل استعمال ما نعرفه', () => {
    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    saveIntake(db, conv.id, { name: 'خالد', location: 'أملج - الربيع' });

    const prompt = composePrompt(enabledFor(db, tenant.id), {
      ...baseContext(db, tenant),
      conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    });

    expect(prompt).toContain('خالد');
    expect(prompt).toContain('أملج - الربيع');
    expect(prompt).not.toContain('رسالة واحدة لا ثلاث');
    expect(prompt).toContain('لا تسأله عنه ثانيةً');
  });

  it('لا يُسأل عن رقم الجوال الذي يكاتبنا منه', () => {
    const prompt = composePrompt(enabledFor(db, tenant.id), {
      ...baseContext(db, tenant),
      conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    });
    expect(prompt).toContain('لا تسأله عن رقم جواله الذي يكاتبك منه');
  });

  it('بلا منع: العميل يُخدَم ولو لم يعطِ اسمه', () => {
    const prompt = composePrompt(enabledFor(db, tenant.id), {
      ...baseContext(db, tenant),
      conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    });
    expect(prompt).toContain('لا تعطّله');
  });

  it('مع المنع: الاسم أولاً', () => {
    setConfig(db, tenant.id, 'intake', { ...intakeModule.defaultConfig(), requireBeforeService: true });
    const prompt = composePrompt(enabledFor(db, tenant.id), {
      ...baseContext(db, tenant),
      conversation: getOrCreateConversation(db, tenant.id, '966555123456'),
    });
    expect(prompt).toContain('اطلب الاسم أولاً');
  });
});

describe('الحفظ', () => {
  it('الاسم والموقع يُحفظان ويظهران للموظف', async () => {
    const context = ctx();
    await intakeModule.runTool(
      'save_customer_details',
      { name: 'سعد المطيري', location: 'أملج - الربيع' },
      context,
    );

    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    expect(conv.customer_name).toBe('سعد المطيري');
    expect(conv.customer_city).toBe('أملج - الربيع');
    expect(conv.intake_done).toBe(1);
  });

  it('الرقم البديل يُطبَّع', async () => {
    await intakeModule.runTool('save_customer_details', { name: 'خالد', phone: '+966 50 111 2233' }, ctx());
    expect(getOrCreateConversation(db, tenant.id, '966555123456').contact_phone).toBe('966501112233');
  });

  it('بيانات فارغة تُرفض بلا إفساد المحفوظ', async () => {
    await intakeModule.runTool('save_customer_details', { name: 'خالد' }, ctx());
    const result = await intakeModule.runTool('save_customer_details', {}, ctx());

    expect(result.isError).toBe(true);
    expect(getOrCreateConversation(db, tenant.id, '966555123456').customer_name).toBe('خالد');
  });

  it('تحديث لاحق لا يمسح ما سبق', async () => {
    await intakeModule.runTool('save_customer_details', { name: 'خالد', location: 'ينبع' }, ctx());
    await intakeModule.runTool('save_customer_details', { name: 'خالد العتيبي' }, ctx());

    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    expect(conv.customer_name).toBe('خالد العتيبي');
    expect(conv.customer_city).toBe('ينبع');
  });
});

describe('من المحرّك', () => {
  it('الأداة متاحة للنموذج وتُنفَّذ فعلياً', async () => {
    const provider = new SimulatorProvider();
    const app = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', anthropicApiKey: 'x', readOnly: false },
      db,
      provider,
      logger: silentLogger(),
    });
    const claude = mockClaude([
      { toolCalls: [{ name: 'save_customer_details', input: { name: 'سعد', location: 'أملج - الربيع' } }] },
      { text: 'حياك أستاذ سعد، كيف نخدمك؟' },
    ]);
    provider.onMessage(createEngine({ app, claude }));

    await provider.receive({ toNumber: tenant.wa_number, from: '966555123456', text: 'سعد، أملج - الربيع' });

    expect(claude.requests[0]!.tools.map((t) => t.name)).toContain('save_customer_details');
    const conv = getOrCreateConversation(db, tenant.id, '966555123456');
    expect(conv.customer_name).toBe('سعد');
    expect(conv.customer_city).toBe('أملج - الربيع');
  });
});
