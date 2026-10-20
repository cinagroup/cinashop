import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectRuntimePurchasePhysicalEvidence,lockRuntimePurchaseEvidenceForGrants } from './runtimePurchaseEvidence';
import { lockRuntimeSeckillScheduleBoundary } from './runtimeSeckillScheduleLockBoundary';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const PURCHASE_PHYSICAL_ORIGIN_RUNTIME_UPGRADE='purchase-physical-origin-runtime-v1';
/** Fixed forward from the exact frozen former current profile. Only the app
 * gains SELECT/INSERT on this one append-only table. No source grants, roles,
 * function EXECUTE, runtime DDL, history adoption or automatic drift repair. */
export async function installPurchasePhysicalOriginRuntimeUpgradeInTransaction(
  tx:Pick<DbClient,'execute'>,target:SeckillScheduleRuntimeTarget,
){
  if(Object.hasOwn(tx,'$client'))throw Error('Physical origin runtime forward requires an existing transaction');
  [target.database,target.maintenance,target.app,target.admin].forEach(pricingIdentifier);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true)`);
  const [database]=await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if(database?.same!==true)throw Error('Physical origin runtime database requires review');
  await lockRuntimeSeckillScheduleBoundary(tx,target);
  await lockRuntimePurchaseEvidenceForGrants(tx,target.maintenance);
  const inspect=async(version:'pre-physical-origin'|'current')=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  });
  const current=await inspect('current');
  if(current.app.ready && current.admin.ready)return {operation:PURCHASE_PHYSICAL_ORIGIN_RUNTIME_UPGRADE,applied:false as const,profileStage:'current' as const};
  const previous=await inspect('pre-physical-origin');
  if(!previous.app.ready || !previous.admin.ready)throw Error('Physical origin requires exact pre-physical-origin runtime profile');
  if(!(await inspectRuntimePurchasePhysicalEvidence(tx,target.maintenance)).ready)throw Error('Physical origin canonical protocols required');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.store_order_purchase_physical_origin IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if(!(await inspectRuntimePurchasePhysicalEvidence(tx,target.maintenance)).ready)throw Error('Physical origin canonical catalog changed');
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.store_order_purchase_physical_origin TO ${pricingIdentifier(target.app)}`));
  const after=await inspect('current');
  if(!after.app.ready || !after.admin.ready)throw Error('Physical origin runtime final verification failed');
  return {operation:PURCHASE_PHYSICAL_ORIGIN_RUNTIME_UPGRADE,applied:true as const,profileStage:'current' as const};
}
export async function runPurchasePhysicalOriginRuntimeUpgrade(db:DbClient,target:SeckillScheduleRuntimeTarget){
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Physical origin runtime upgrade requires root maintenance connection');
  return db.transaction(tx=>installPurchasePhysicalOriginRuntimeUpgradeInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
