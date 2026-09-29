/**
 * تدريب البوت من ثغرات المعرفة.
 * المحك: كل تحويل بسبب جهل يصير سؤالاً قابلاً للإجابة، والمتشابه يُجمَّع
 * فلا تُكتب الإجابة مرتين.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, seedTenant, silentLogger, mockClaude } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createEngine } from '../src/bot/engine.ts';
import { SimulatorProvider } from '../src/whatsapp/simulator.ts';
import {
  recordGap,
  listGaps,
  setGapStatus,
  gapSummary,
  similarity,
  similarGaps,
  normalize,
} from '../src/training.ts';
import type { Db, TenantRow } from '../src/db/index.ts';

let db: Db;
let tenant: TenantRow;

beforeEach(() => {
  db = freshDb();
  tenant = seedTenant(db, { name: 'وقودي' });
});
afterEach(() => db.close());

describe('التقاط الثغرة', () => {
  it('التحويل للموظف يسجّل سؤال العميل تلقائياً', async () => {
    const provider = new SimulatorProvider();
    const app = await buildApp({
      config: { ...loadConfig(), provider: 'simulator', anthropicApiKey: 'x', readOnly: false },
      db,
      provider,
      logger: silentLogger(),
    });
    provider.onMessage(
      createEngine({
        app,
        claude: mockClaude([
          { toolCalls: [{ name: 'handoff_to_human', input: { reason: 'سأل عن وسائل الدفع ولا توجد معرفة' } }] },
        ]),
      }),
    );

    await provider.receive({ toNumber: tenant.wa_number, from: '966555123456', text: 'تقبلون بطاقة مدى؟' });

    const gaps = listGaps(db, tenant.id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.question).toBe('تقبلون بطاقة مدى؟');
    expect(gaps[0]?.reason).toContain('وسائل الدفع');
  });

  it('نفس السؤال يزيد العدّاد لا يتكرر', () => {
    for (let i = 0; i < 3; i++) {
      recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'تقبلون بطاقة مدى؟' });
    }
    const gaps = listGaps(db, tenant.id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.occurrences).toBe(3);
  });

  it('اختلاف الترقيم والتشكيل لا يُنشئ سؤالاً جديداً', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'كم سعر البنزين؟' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'كم سعر البنزين' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'كم سعر البنزين!!' });
    expect(listGaps(db, tenant.id)).toHaveLength(1);
  });

  it('الرد القصير ليس ثغرة معرفة', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'طيب' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'نعم' });
    expect(listGaps(db, tenant.id)).toHaveLength(0);
  });

  it('الأكثر تكراراً أولاً — فتبدأ المالكة بما يوفّر أكثر', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال نادر جداً هنا' });
    for (let i = 0; i < 5; i++) {
      recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال متكرر كثيراً جداً' });
    }
    expect(listGaps(db, tenant.id)[0]?.question).toBe('سؤال متكرر كثيراً جداً');
  });

  it('معزول بين المنشآت', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال خاص بوقودي' });
    expect(listGaps(db, other.id)).toHaveLength(0);
  });
});

describe('التطبيع والتشابه', () => {
  it('التطبيع يوحّد الهمزات والتاء المربوطة', () => {
    expect(normalize('أسعاركم؟')).toBe(normalize('اسعاركم'));
    expect(normalize('المحطة')).toBe(normalize('المحطه'));
  });

  it('صيغتان لنفس السؤال تتشابهان', () => {
    expect(similarity('تقبلون بطاقة مدى؟', 'هل تقبلون الدفع بمدى في المحطة؟')).toBeGreaterThanOrEqual(0.4);
    expect(similarity('فيه مغسلة في محطة الربيع؟', 'عندكم مغسلة سيارات بالربيع')).toBeGreaterThanOrEqual(0.4);
  });

  it('سؤالان مختلفان لا يتشابهان', () => {
    expect(similarity('وين محطاتكم', 'متى تفتحون')).toBeLessThan(0.4);
    expect(similarity('تقبلون بطاقة مدى؟', 'فيه مغسلة سيارات في محطة الربيع؟')).toBeLessThan(0.4);
  });

  it('المتشابه يُقترح مع السؤال', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'تقبلون بطاقة مدى؟' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'هل تقبلون الدفع بمدى في المحطة؟' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'وين مواقع محطاتكم بالضبط' });

    const first = listGaps(db, tenant.id).find((g) => g.question.includes('بطاقة مدى'))!;
    const similar = similarGaps(db, tenant.id, first);
    expect(similar).toHaveLength(1);
    expect(similar[0]?.question).toContain('الدفع بمدى');
  });
});

describe('الحالات', () => {
  it('الإهمال يُخرجه من القائمة ولا يعود بتكراره', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال لا يستحق جواباً' });
    const gap = listGaps(db, tenant.id)[0]!;
    setGapStatus(db, tenant.id, gap.id, 'ignored');

    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال لا يستحق جواباً' });
    expect(listGaps(db, tenant.id, 'open')).toHaveLength(0);
    expect(listGaps(db, tenant.id, 'ignored')).toHaveLength(1);
  });

  it('سؤال أُجيب عنه ثم تكرر يعود مفتوحاً — الجواب لم يُغنِ عنه', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال أُجيب عنه سابقاً' });
    const gap = listGaps(db, tenant.id)[0]!;
    setGapStatus(db, tenant.id, gap.id, 'answered');
    expect(listGaps(db, tenant.id, 'open')).toHaveLength(0);

    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال أُجيب عنه سابقاً' });
    expect(listGaps(db, tenant.id, 'open')).toHaveLength(1);
  });

  it('الملخص يعدّ التحويلات لا الأسئلة', () => {
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال أول متكرر' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال أول متكرر' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال ثاني مختلف' });

    expect(gapSummary(db, tenant.id)).toEqual({ open: 2, missedAnswers: 3 });
  });

  it('سؤال منشأة أخرى لا يُعدَّل', () => {
    const other = seedTenant(db, { name: 'أخرى', waNumber: '966500000002' });
    recordGap(db, { tenantId: tenant.id, conversationId: null, question: 'سؤال يخص وقودي' });
    const gap = listGaps(db, tenant.id)[0]!;
    expect(() => setGapStatus(db, other.id, gap.id, 'ignored')).toThrow(/غير موجود/);
  });
});
