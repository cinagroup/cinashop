import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { lockRuntimeSeckillScheduleBoundary } from './runtimeSeckillScheduleLockBoundary';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';
import { inspectSeckillParentRuntimeSequence } from './seckillParentRuntimeCatalog';
import type { RuntimeBusinessProfileVersion } from './runtimeBusinessPrivilegePlan';

type Query=Pick<DbClient,'execute'>;
export const SECKILL_PARENT_RUNTIME_UPGRADE='seckill-parent-admin-runtime-v1';
/** Fixed second forward after schedule installation: Admin INSERT/UPDATE and
 * one serial sequence USAGE. Soft deletion requires no DELETE authority. */
export async function installSeckillParentRuntimeUpgradeInTransaction(tx:Query,target:SeckillScheduleRuntimeTarget) {
  if(Object.hasOwn(tx,'$client'))throw Error('Parent runtime upgrade requires an existing transaction');
  pricingIdentifier(target.database);
  const [database]=await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if(database?.same!==true)throw Error('Parent runtime upgrade database requires review');
  await lockRuntimeSeckillScheduleBoundary(tx,target);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true)`);
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,4) AS locked`);
  if(gate?.locked!==true)throw Error('Parent runtime upgrade is busy');
  if(!(await inspectSeckillParentRuntimeSequence(tx,target.maintenance)).ready)
    throw Error('Parent runtime upgrade exact serial sequence required');
  const inspect=async(version:RuntimeBusinessProfileVersion)=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  });
  for(const stage of ['current','pre-agent-levels','pre-sign-day','pre-full-gifts','pre-coupon-templates'] as const) {
    const installed=await inspect(stage);
    if(installed.app.ready && installed.admin.ready)
      return {operation:SECKILL_PARENT_RUNTIME_UPGRADE,applied:false as const,parentGrantsApplied:false as const,profileStage:stage};
  }
  const schedule=await inspect('seckill-schedule');
  if(!schedule.app.ready || !schedule.admin.ready)throw Error('Parent runtime upgrade exact schedule profile required');
  const admin=pricingIdentifier(target.admin);
  await tx.execute(sql.raw(`GRANT INSERT,UPDATE ON TABLE public.store_activity TO ${admin}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.store_activity_id_seq TO ${admin}`));
  const after=await inspect('pre-coupon-templates');
  if(!after.app.ready || !after.admin.ready)throw Error('Parent runtime upgrade final profile verification failed');
  return {operation:SECKILL_PARENT_RUNTIME_UPGRADE,applied:true as const,parentGrantsApplied:true as const,profileStage:'pre-coupon-templates' as const};
}
export async function runSeckillParentRuntimeUpgrade(db:DbClient,target:SeckillScheduleRuntimeTarget) {
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Parent runtime upgrade requires a root maintenance connection');
  return db.transaction(tx=>installSeckillParentRuntimeUpgradeInTransaction(tx,target),
    {isolationLevel:'read committed',accessMode:'read write'});
}
