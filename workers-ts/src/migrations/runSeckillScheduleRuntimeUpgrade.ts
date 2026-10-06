import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RuntimeBusinessProfileVersion } from './runtimeBusinessPrivilegePlan';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { installRuntimeSeckillScheduleLockBoundaryInTransaction, lockRuntimeSeckillScheduleBoundary,
  type SeckillScheduleRuntimeNames } from './runtimeSeckillScheduleLockBoundary';

type Query=Pick<DbClient,'execute'>;
export interface SeckillScheduleRuntimeTarget extends SeckillScheduleRuntimeNames { database:string }
export const SECKILL_SCHEDULE_RUNTIME_UPGRADE='seckill-schedule-runtime-lock-only-v1';

/** Two-column forward only for existing, exact full profiles. No credentials,
 * role creation, general grant compiler, automatic repair or business writes. */
export async function installSeckillScheduleRuntimeUpgradeInTransaction(tx:Query,target:SeckillScheduleRuntimeTarget) {
  if(Object.hasOwn(tx,'$client'))throw Error('Schedule runtime upgrade requires an existing transaction');
  pricingIdentifier(target.database);
  const [database]=await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if(database?.same!==true)throw Error('Schedule runtime upgrade database requires review');
  await lockRuntimeSeckillScheduleBoundary(tx,target);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true)`);
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,3) AS locked`);
  if(gate?.locked!==true)throw Error('Schedule runtime upgrade is busy');
  const inspect=async(version:RuntimeBusinessProfileVersion)=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  });
  for(const stage of ['current','pre-agent-levels','pre-sign-day','pre-full-gifts','pre-coupon-templates'] as const) {
    const installed=await inspect(stage);
    if(installed.app.ready && installed.admin.ready)
      return {operation:SECKILL_SCHEDULE_RUNTIME_UPGRADE,applied:false as const,columnGrantsApplied:false as const,profileStage:stage};
  }
  const schedule=await inspect('seckill-schedule');
  if(schedule.app.ready && schedule.admin.ready)
    return {operation:SECKILL_SCHEDULE_RUNTIME_UPGRADE,applied:false as const,columnGrantsApplied:false as const,profileStage:'seckill-schedule' as const};
  const legacy=await inspect('legacy-seckill-schedule');
  if(!legacy.app.ready || !legacy.admin.ready)throw Error('Schedule runtime upgrade exact legacy profile or catalog required');
  await installRuntimeSeckillScheduleLockBoundaryInTransaction(tx,target);
  const app=pricingIdentifier(target.app);
  await tx.execute(sql.raw(`GRANT UPDATE(id) ON TABLE public.store_activity TO ${app}`));
  await tx.execute(sql.raw(`GRANT UPDATE(id) ON TABLE public.store_seckill_time TO ${app}`));
  const after=await inspect('seckill-schedule');
  if(!after.app.ready || !after.admin.ready)throw Error('Schedule runtime upgrade final profile verification failed');
  return {operation:SECKILL_SCHEDULE_RUNTIME_UPGRADE,applied:true as const,columnGrantsApplied:true as const,profileStage:'seckill-schedule' as const};
}

export async function runSeckillScheduleRuntimeUpgrade(db:DbClient,target:SeckillScheduleRuntimeTarget) {
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Schedule runtime upgrade requires a root maintenance connection');
  return db.transaction(tx=>installSeckillScheduleRuntimeUpgradeInTransaction(tx,target),
    {isolationLevel:'read committed',accessMode:'read write'});
}
