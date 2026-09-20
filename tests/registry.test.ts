/**
 * نظام الوحدات — الآلية بمعزل عن الوحدات الحقيقية.
 * نستعمل وحدات صورية عمداً: ما يُختبر هنا هو السجل نفسه، فلو تغيّر سلوك
 * وحدة الشكاوى غداً يجب ألّا تسقط هذه الاختبارات.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as registry from '../src/modules/registry.ts';
import type { BotModule } from '../src/modules/types.ts';
import { freshDb, seedTenant, makeFakeModule, baseContext } from './helpers.ts';
import type { Db } from '../src/db/index.ts';

const realModules = [...registry.MODULES];

function useModules(modules: BotModule[]): void {
  registry.MODULES.length = 0;
  registry.MODULES.push(...modules);
}

let db: Db;

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
  useModules(realModules);
});

describe('سجل الوحدات', () => {
  it('الوحدات الأساسية تُفعَّل تلقائياً للمنشأة الجديدة', () => {
    useModules([
      makeFakeModule('core_one', { core: true }),
      makeFakeModule('optional_one', { core: false }),
    ]);
    const tenant = seedTenant(db);

    const names = registry.enabledFor(db, tenant.id).map((e) => e.module.name);
    expect(names).toEqual(['core_one']);
  });

  it('أدوات الوحدة المعطّلة لا تصل للنموذج، وتظهر فور التفعيل', () => {
    useModules([
      makeFakeModule('inquiries_fake', { core: true }),
      makeFakeModule('bookings_fake', { core: false }),
    ]);
    const tenant = seedTenant(db);
    const base = baseContext(db, tenant);

    const before = registry.composeTools(registry.enabledFor(db, tenant.id), base).map((t) => t.name);
    expect(before).toEqual(['inquiries_fake_tool']);
    expect(before).not.toContain('bookings_fake_tool');

    registry.setEnabled(db, tenant.id, 'bookings_fake', true);
    const after = registry.composeTools(registry.enabledFor(db, tenant.id), base).map((t) => t.name);
    expect(after).toEqual(['inquiries_fake_tool', 'bookings_fake_tool']);

    registry.setEnabled(db, tenant.id, 'bookings_fake', false);
    const again = registry.composeTools(registry.enabledFor(db, tenant.id), base).map((t) => t.name);
    expect(again).not.toContain('bookings_fake_tool');
  });

  it('التفعيل معزول بين المنشآت', () => {
    useModules([makeFakeModule('core_one', { core: true }), makeFakeModule('bookings_fake')]);
    const a = seedTenant(db, { name: 'أ', waNumber: '966500000001' });
    const b = seedTenant(db, { name: 'ب', waNumber: '966500000002' });

    registry.setEnabled(db, a.id, 'bookings_fake', true);

    expect(registry.enabledFor(db, a.id).map((e) => e.module.name)).toContain('bookings_fake');
    expect(registry.enabledFor(db, b.id).map((e) => e.module.name)).not.toContain('bookings_fake');
  });

  it('الوحدة الأساسية لا يمكن تعطيلها', () => {
    useModules([makeFakeModule('core_one', { core: true })]);
    const tenant = seedTenant(db);
    expect(() => registry.setEnabled(db, tenant.id, 'core_one', false)).toThrow(/أساسية/);
  });

  it('الـsystem prompt يُجمَّع من المفعّلة فقط', () => {
    useModules([makeFakeModule('core_one', { core: true }), makeFakeModule('extra')]);
    const tenant = seedTenant(db);
    const base = baseContext(db, tenant);

    expect(registry.composePrompt(registry.enabledFor(db, tenant.id), base)).toBe('تعليمات core_one');

    registry.setEnabled(db, tenant.id, 'extra', true);
    expect(registry.composePrompt(registry.enabledFor(db, tenant.id), base)).toBe(
      'تعليمات core_one\n\nتعليمات extra',
    );
  });

  it('نداء الأداة يُوجَّه لصاحبها', async () => {
    useModules([makeFakeModule('alpha', { core: true }), makeFakeModule('beta', { core: true })]);
    const tenant = seedTenant(db);
    const base = baseContext(db, tenant);
    const enabled = registry.enabledFor(db, tenant.id);

    expect((await registry.dispatchTool(enabled, 'beta_tool', {}, base)).content).toBe('نُفِّذت beta');
  });

  it('نداء أداة غير مفعّلة يُعيد خطأ مفهوماً بدل أن يرمي', async () => {
    useModules([makeFakeModule('alpha', { core: true }), makeFakeModule('beta')]);
    const tenant = seedTenant(db);
    const base = baseContext(db, tenant);

    const result = await registry.dispatchTool(registry.enabledFor(db, tenant.id), 'beta_tool', {}, base);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('غير متاحة');
  });

  it('فشل الأداة يُلتقط ولا يُسقط المحادثة', async () => {
    useModules([
      makeFakeModule('alpha', {
        core: true,
        runTool: async () => {
          throw new Error('عطل داخلي');
        },
      }),
    ]);
    const tenant = seedTenant(db);
    const base = baseContext(db, tenant);

    const result = await registry.dispatchTool(registry.enabledFor(db, tenant.id), 'alpha_tool', {}, base);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('تعذّر');
  });

  it('الإعدادات تُدمج مع الافتراضي فلا تكسر إضافة مفتاح جديد المنشآت القائمة', () => {
    useModules([
      makeFakeModule('alpha', {
        core: true,
        defaultConfig: () => ({ greeting: 'أهلاً', limit: 5 }),
        validateConfig: (input) => input as Record<string, unknown>,
      }),
    ]);
    const tenant = seedTenant(db);

    // منشأة حفظت الإعداد قبل إضافة مفتاح limit
    db.prepare('UPDATE tenant_modules SET config = ? WHERE tenant_id = ? AND module = ?').run(
      JSON.stringify({ greeting: 'هلا' }),
      tenant.id,
      'alpha',
    );

    expect(registry.getConfig(db, tenant.id, 'alpha')).toEqual({ greeting: 'هلا', limit: 5 });
  });

  it('إعداد تالف في القاعدة يرجع للافتراضي بدل أن يُسقط المنشأة', () => {
    useModules([makeFakeModule('alpha', { core: true, defaultConfig: () => ({ a: 1 }) })]);
    const tenant = seedTenant(db);
    db.prepare('UPDATE tenant_modules SET config = ? WHERE tenant_id = ? AND module = ?').run(
      '{ليس JSON',
      tenant.id,
      'alpha',
    );
    expect(registry.getConfig(db, tenant.id, 'alpha')).toEqual({ a: 1 });
  });

  it('statusFor يعرض المعطّلة أيضاً — صفحة أدمن المنشأة تحتاجها', () => {
    useModules([makeFakeModule('core_one', { core: true }), makeFakeModule('bookings_fake')]);
    const tenant = seedTenant(db);

    const status = registry.statusFor(db, tenant.id);
    expect(status.map((s) => [s.name, s.enabled])).toEqual([
      ['core_one', true],
      ['bookings_fake', false],
    ]);
    expect(status[1]?.descriptionAr).toBe('وصف bookings_fake');
  });

  it('وحدة أُضيفت بعد إنشاء المنشأة تحصل على صفها عند التسوية', () => {
    useModules([makeFakeModule('core_one', { core: true })]);
    const tenant = seedTenant(db);

    useModules([makeFakeModule('core_one', { core: true }), makeFakeModule('late', { core: true })]);
    registry.ensureTenantModules(db, tenant.id);

    expect(registry.enabledFor(db, tenant.id).map((e) => e.module.name)).toEqual(['core_one', 'late']);
  });
});
