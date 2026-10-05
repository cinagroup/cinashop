import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { lockRuntimeSeckillScheduleBoundary } from './runtimeSeckillScheduleLockBoundary';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';
import { inspectCouponTemplateCatalog } from './couponTemplateCatalog';

export const COUPON_TEMPLATE_RUNTIME_UPGRADE = 'coupon-template-admin-runtime-v1';

/** Fixed explicit forward for previously commissioned identities. No object or
 * grant list from callers, role creation, schema installation, or drift repair. */
export async function installCouponTemplateRuntimeUpgradeInTransaction(
  tx: Pick<DbClient, 'execute'>, target: SeckillScheduleRuntimeTarget,
) {
  if (Object.hasOwn(tx, '$client')) throw Error('Coupon template runtime upgrade requires an existing transaction');
  pricingIdentifier(target.database);
  const [database] = await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if (database?.same !== true) throw Error('Coupon template runtime database requires review');
  await lockRuntimeSeckillScheduleBoundary(tx, target);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true)`);
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,5) AS locked`);
  if (gate?.locked !== true) throw Error('Coupon template runtime upgrade is busy');
  if (!(await inspectCouponTemplateCatalog(tx, target.maintenance)).ready) throw Error('Coupon template runtime exact catalog required');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.store_coupon_template, ONLY public.store_coupon_template_issue IN SHARE ROW EXCLUSIVE MODE'));
  // Inspect again after the locks; a concurrent DDL owner may have won first.
  if (!(await inspectCouponTemplateCatalog(tx, target.maintenance)).ready) throw Error('Coupon template runtime exact catalog required');
  const inspect = async (version: 'pre-coupon-templates' | 'pre-full-gifts' | 'pre-sign-day' | 'pre-agent-levels' | 'current') => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, version),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, version),
  });
  const current = await inspect('current');
  if (current.app.ready && current.admin.ready) return { operation: COUPON_TEMPLATE_RUNTIME_UPGRADE, applied: false as const, profileStage: 'current' as const };
  const signDay = await inspect('pre-agent-levels');
  if (signDay.app.ready && signDay.admin.ready) return { operation: COUPON_TEMPLATE_RUNTIME_UPGRADE, applied: false as const, profileStage: 'pre-agent-levels' as const };
  const gift = await inspect('pre-sign-day');
  if (gift.app.ready && gift.admin.ready) return { operation: COUPON_TEMPLATE_RUNTIME_UPGRADE, applied: false as const, profileStage: 'pre-sign-day' as const };
  const installed = await inspect('pre-full-gifts');
  if (installed.app.ready && installed.admin.ready) return { operation: COUPON_TEMPLATE_RUNTIME_UPGRADE, applied: false as const, profileStage: 'pre-full-gifts' as const };
  const previous = await inspect('pre-coupon-templates');
  if (!previous.app.ready || !previous.admin.ready) throw Error('Coupon template runtime exact pre-coupon-templates profile required');
  const admin = pricingIdentifier(target.admin);
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.store_coupon_template,public.store_coupon_template_issue TO ${admin}`));
  await tx.execute(sql.raw(`GRANT UPDATE(status,is_del) ON TABLE public.store_coupon_template TO ${admin}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.store_coupon_template_id_seq TO ${admin}`));
  const after = await inspect('pre-full-gifts');
  if (!after.app.ready || !after.admin.ready) throw Error('Coupon template runtime final profile verification failed');
  return { operation: COUPON_TEMPLATE_RUNTIME_UPGRADE, applied: true as const, profileStage: 'pre-full-gifts' as const };
}

export async function runCouponTemplateRuntimeUpgrade(db: DbClient, target: SeckillScheduleRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Coupon template runtime upgrade requires a root maintenance connection');
  return db.transaction(tx => installCouponTemplateRuntimeUpgradeInTransaction(tx, target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
