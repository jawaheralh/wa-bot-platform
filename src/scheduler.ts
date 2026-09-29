/**
 * النبضة الدورية.
 *
 * تنادي onTick لكل وحدة مفعّلة لكل منشأة. المحرّك لا يعرف ما تفعله —
 * التذكيرات اليوم، وربما تقارير أو متابعات لاحقاً، بلا لمس هذا الملف.
 */

import type { App } from './app.ts';
import { listTenants } from './db/index.ts';
import { tickTargets } from './modules/registry.ts';
import { purgeOldMessages, audit } from './compliance.ts';
import { runHealthCheck, alertIfChanged } from './health.ts';
import { backupIfDue } from './backup.ts';
import { watchTunnel } from './tunnel.ts';
import { today } from './time.ts';

const TICK_MS = 60_000;

export function startScheduler(app: App): () => void {
  const deps = {
    db: app.db,
    config: app.config,
    logger: app.logger.child({ مهمة: 'دورية' }),
    provider: app.provider,
    notify: app.notify,
  };

  let running = false;
  let lastPurgeDay = '';
  let lastHealthCheck = 0;

  const tick = async (): Promise<void> => {
    // نبضة بطيئة يجب ألّا تتراكم فوق نفسها.
    if (running) return;
    running = true;
    try {
      // الحذف بانتهاء مدة الاحتفاظ مرة يومياً لا كل دقيقة.
      const day = today();
      if (day !== lastPurgeDay) {
        lastPurgeDay = day;
        for (const tenant of listTenants(app.db)) {
          if (!tenant.retention_days) continue;
          try {
            const removed = purgeOldMessages(app.db, tenant.id, tenant.retention_days);
            if (removed > 0) {
              deps.logger.info('حُذفت رسائل بانتهاء مدة الاحتفاظ', {
                tenant: tenant.id,
                عدد: removed,
                مدة: tenant.retention_days,
              });
              audit(app.db, {
                tenantId: tenant.id,
                username: 'النظام',
                action: 'retention_purge',
                target: `${tenant.retention_days} يوماً`,
                detail: `حُذفت ${removed} رسالة`,
              });
            }
          } catch (error) {
            deps.logger.error('فشل الحذف بانتهاء مدة الاحتفاظ', error, { tenant: tenant.id });
          }
        }
      }

      /* --- نسخة احتياطية يومية --- */
      if (day !== lastPurgeDay || !lastHealthCheck) backupIfDue(app);

      /* --- مراقبة النفق كل نبضة: انقطاعه يوقف كل الرسائل --- */
      try {
        await watchTunnel(app);
      } catch (error) {
        deps.logger.error('فشلت مراقبة النفق', error);
      }

      /* --- فحص الصحة كل ١٥ دقيقة --- */
      if (Date.now() - lastHealthCheck > 15 * 60_000) {
        lastHealthCheck = Date.now();
        try {
          const checks = await runHealthCheck(app);
          await alertIfChanged(app, checks);
        } catch (error) {
          deps.logger.error('فشل فحص الصحة', error);
        }
      }

      for (const target of tickTargets(app.db, listTenants(app.db))) {
        try {
          await target.module.onTick?.(target.tenant, target.config, deps);
        } catch (error) {
          deps.logger.error('فشلت مهمة دورية لوحدة', error, {
            tenant: target.tenant.id,
            وحدة: target.module.name,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();

  return () => clearInterval(timer);
}
