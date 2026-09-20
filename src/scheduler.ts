/**
 * النبضة الدورية.
 *
 * تنادي onTick لكل وحدة مفعّلة لكل منشأة. المحرّك لا يعرف ما تفعله —
 * التذكيرات اليوم، وربما تقارير أو متابعات لاحقاً، بلا لمس هذا الملف.
 */

import type { App } from './app.ts';
import { listTenants } from './db/index.ts';
import { tickTargets } from './modules/registry.ts';

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

  const tick = async (): Promise<void> => {
    // نبضة بطيئة يجب ألّا تتراكم فوق نفسها.
    if (running) return;
    running = true;
    try {
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
