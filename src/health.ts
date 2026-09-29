/**
 * فحص صحة النظام.
 *
 * ضرورته من خيار الصمت عند الفشل: حين يتعطّل البوت لا يرى العميل شيئاً،
 * فبلا فحص دوري قد يمضي النظام أياماً صامتاً بلا أن يلاحظ أحد. الفحص
 * يكشف العطل ويُنبّه الموظف على واتساب قبل أن يكتشفه العملاء.
 *
 * يفحص ما يتعطّل فعلاً في التشغيل: مفتاح Claude، وتوكن Meta، واشتراك
 * الـwebhook، ومعرفة المنشأة — لا ما لا يتغيّر.
 */

import type { App } from './app.ts';
import { listTenants, type Db } from './db/index.ts';
import { enabledFor } from './modules/registry.ts';
import { renderKnowledge } from './modules/inquiries.ts';
import { audit } from './compliance.ts';

export type Severity = 'ok' | 'warn' | 'down';

export interface HealthCheck {
  key: string;
  label: string;
  severity: Severity;
  message: string;
  /** يُذكر في التنبيه: ماذا تفعل المالكة لإصلاحه. */
  fix?: string;
}

/* ---------------------------------------------------------------
   الفحوص
--------------------------------------------------------------- */

async function checkClaude(app: App): Promise<HealthCheck> {
  const base = { key: 'claude', label: 'مفتاح Claude' };

  if (!app.config.anthropicApiKey) {
    return { ...base, severity: 'down', message: 'غير مضبوط — البوت لا يرد إطلاقاً.', fix: 'صفحة الإعداد ← مفتاح Claude' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': app.config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: app.config.anthropicModel,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    if (response.ok) return { ...base, severity: 'ok', message: 'يعمل' };

    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string; type?: string } };
    const detail = data.error?.message ?? `خطأ ${response.status}`;

    if (response.status === 401) {
      return {
        ...base,
        severity: 'down',
        message: `مرفوض: ${detail}`,
        // السبب الأشيع بعد الخطأ الكتابي: مفتاح بنطاق Organization
        fix: 'يلزم أن يكون نطاق المفتاح Default لا Organization، وأن يكون صالحاً. ثم يُلصق في صفحة الإعداد.',
      };
    }
    if (response.status === 429) {
      return { ...base, severity: 'down', message: `تجاوز الحد أو نفد الرصيد: ${detail}`, fix: 'الرصيد في console.anthropic.com ← Billing' };
    }
    return { ...base, severity: 'warn', message: detail };
  } catch (error) {
    return { ...base, severity: 'warn', message: `تعذّر الاتصال: ${(error as Error).message}` };
  }
}

async function checkMeta(app: App): Promise<HealthCheck[]> {
  if (app.config.provider !== 'cloud') return [];
  const meta = await import('./meta-setup.ts');
  const checks: HealthCheck[] = [];

  const token = await meta.checkToken(app.config);
  checks.push({
    key: 'meta_token',
    label: 'توكن Meta',
    severity: token.ok ? 'ok' : 'down',
    message: token.message,
    fix: token.ok ? undefined : 'التوكن الدائم يُولَّد من Business settings ← مستخدمو النظام، ثم يُلصق في صفحة الإعداد.',
  });

  if (app.config.publicUrl) {
    const webhook = await meta.checkWebhook(app.config);
    checks.push({
      key: 'webhook',
      label: 'الـwebhook',
      severity: webhook.ok ? 'ok' : 'down',
      message: webhook.message,
      fix: webhook.ok ? undefined : 'صفحة الإعداد ← زر «اضبط الـwebhook في Meta تلقائياً».',
    });
  } else {
    checks.push({
      key: 'webhook',
      label: 'الـwebhook',
      severity: 'down',
      message: 'لا يوجد عنوان عام — لا تصل رسائل العملاء.',
      fix: 'يلزم تشغيل نفق أو النشر على خادم، ثم ضبط الـwebhook.',
    });
  }
  return checks;
}

/** منشأة بلا معرفة = بوت يحوّل كل سؤال للموظف. عطل صامت آخر. */
function checkKnowledge(db: Db): HealthCheck[] {
  return listTenants(db)
    .filter((t) => t.status === 'active')
    .filter((t) => enabledFor(db, t.id).some((e) => e.module.name === 'inquiries'))
    .map((tenant) => {
      const config = enabledFor(db, tenant.id).find((e) => e.module.name === 'inquiries')!.config;
      const knowledge = renderKnowledge(db, tenant.id, config as never);
      return {
        key: `kb_${tenant.id}`,
        label: `معرفة «${tenant.name}»`,
        severity: knowledge.trim().length > 50 ? ('ok' as Severity) : ('warn' as Severity),
        message: knowledge.trim() ? `${knowledge.length} حرف` : 'فارغة — البوت يحوّل كل سؤال للموظف.',
        fix: knowledge.trim() ? undefined : 'اللوحة ← قاعدة المعرفة.',
      };
    });
}

/* ---------------------------------------------------------------
   التشغيل
--------------------------------------------------------------- */

export async function runHealthCheck(app: App): Promise<HealthCheck[]> {
  const [claude, meta] = await Promise.all([checkClaude(app), checkMeta(app)]);
  return [claude, ...meta, ...checkKnowledge(app.db), checkBackup(app)];
}

/**
 * نسخة احتياطية حديثة.
 *
 * منع الحذف لا يحمي من تلف الملف ولا من ضياع الجهاز. النسخة هي الحماية
 * الحقيقية، وغيابها عطل صامت مثل غيره.
 */
function checkBackup(app: App): HealthCheck {
  const base = { key: 'backup', label: 'النسخة الاحتياطية' };
  const row = app.db
    .prepare(`SELECT created_at FROM health_log WHERE summary = 'backup' ORDER BY id DESC LIMIT 1`)
    .get() as { created_at: string } | undefined;

  if (!row) return { ...base, severity: 'warn', message: 'لم تُؤخذ نسخة بعد.' };

  const hours = Math.round((Date.now() - new Date(`${row.created_at.replace(' ', 'T')}+03:00`).getTime()) / 3_600_000);
  if (hours > 48) {
    return { ...base, severity: 'warn', message: `آخر نسخة قبل ${hours} ساعة.`, fix: 'تحقّقي أن النظام يعمل باستمرار.' };
  }
  return { ...base, severity: 'ok', message: `آخر نسخة قبل ${hours} ساعة` };
}

export function worstOf(checks: HealthCheck[]): Severity {
  if (checks.some((c) => c.severity === 'down')) return 'down';
  if (checks.some((c) => c.severity === 'warn')) return 'warn';
  return 'ok';
}

/* ---------------------------------------------------------------
   التنبيه
--------------------------------------------------------------- */

/**
 * يُنبّه عند تغيّر الحالة فقط.
 *
 * التنبيه كل ساعة على نفس العطل يُدرّب الموظف على تجاهله، فيفوته العطل
 * التالي. نُنبّه عند السقوط، ومرة عند التعافي، ولا شيء بينهما.
 */
export async function alertIfChanged(app: App, checks: HealthCheck[]): Promise<boolean> {
  const broken = checks.filter((c) => c.severity === 'down');
  const fingerprint = broken.map((c) => c.key).sort().join(',') || 'ok';

  const previous = app.db
    .prepare('SELECT detail FROM health_log ORDER BY id DESC LIMIT 1')
    .get() as { detail: string } | undefined;

  app.db
    .prepare('INSERT INTO health_log (severity, summary, detail) VALUES (?, ?, ?)')
    .run(
      worstOf(checks),
      broken.length ? broken.map((c) => c.label).join('، ') : 'سليم',
      fingerprint,
    );

  if (previous?.detail === fingerprint) return false;

  audit(app.db, {
    tenantId: null,
    username: 'النظام',
    action: 'health',
    target: broken.length ? 'عطل' : 'سليم',
    detail: broken.map((c) => `${c.label}: ${c.message}`).join(' · ') || 'عاد سليماً',
  });

  const tenants = listTenants(app.db).filter((t) => t.status === 'active' && t.staff_wa_number);

  const text = broken.length
    ? [
        '⚠️ تنبيه: النظام متعطّل',
        '',
        ...broken.map((c) => `• ${c.label}: ${c.message}${c.fix ? `\n  الحل: ${c.fix}` : ''}`),
        '',
        'العملاء لا يتلقون رداً الآن.',
      ].join('\n')
    : '✅ عاد النظام للعمل الطبيعي.';

  for (const tenant of tenants) {
    try {
      await app.provider.sendText(tenant.id, tenant.staff_wa_number!, text);
    } catch (error) {
      app.logger.error('تعذّر إرسال تنبيه الصحة', error, { tenant: tenant.id });
    }
  }

  if (broken.length) {
    app.logger.error(`فحص الصحة: ${broken.length} عطل — ${broken.map((c) => c.label).join('، ')}`);
  } else {
    app.logger.info('فحص الصحة: عاد النظام سليماً');
  }
  return true;
}
