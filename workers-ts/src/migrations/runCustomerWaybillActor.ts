import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { CUSTOMER_WAYBILL_ACTOR_SQL } from './customerWaybillActor';
import { compositeCustomerWorkCatalogSql } from './customerWorkCatalog';
export const CUSTOMER_WAYBILL_ACTOR_CATALOG_SQL = compositeCustomerWorkCatalogSql({job:'order_waybill_job',action:'order_waybill_job_action'});
/** Filled only from native PG16 legacy 0091 and explicit forward measurements. */
export const CUSTOMER_WAYBILL_LEGACY_SHA256 = '8d005e7b3c6fbf5fbd20a975e5629236f10ef454af39a227707478af42f6af9d';
export const CUSTOMER_WAYBILL_ACTOR_SHA256 = '9f11872296dc1fa07e5853d572ab4d0786abc6e58199d5176da5e424a096e401';
export async function inspectCustomerWaybillActor(db:Pick<DbClient,'execute'>) {
  const rows=await db.execute<{shape:unknown}>(sql.raw(CUSTOMER_WAYBILL_ACTOR_CATALOG_SQL));
  if(rows.length!==1)throw Error('Customer waybill catalog unavailable');
  const fingerprint=await outRequestHash(rows[0].shape);
  return {ready:fingerprint===CUSTOMER_WAYBILL_ACTOR_SHA256,legacy:fingerprint===CUSTOMER_WAYBILL_LEGACY_SHA256,fingerprint};
}
export async function assertCustomerWaybillActorCatalog(db:Pick<DbClient,'execute'>) {
  if(!(await inspectCustomerWaybillActor(db)).ready)throw Error('Customer waybill actor upgrade requires explicit maintenance review');
}
/** Owner maintenance only, refuses absence, drift, partial upgrades and second
 * invocation. Runtime grants are an independently inspected prerequisite. */
export async function runCustomerWaybillActor(db:Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>) {
  if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Customer waybill upgrade requires root maintenance client');
  return db.transaction(async tx=>{
    const [gate]=await tx.execute(sql`SELECT current_setting('server_version_num')::int/10000=16
      AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
      AND current_setting('session_replication_role')='origin' AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
      AND pg_try_advisory_xact_lock(731634,1) AS ready`);
    if(gate?.ready!==true)throw Error('Customer waybill maintenance preflight unavailable');
    const before=await inspectCustomerWaybillActor(tx);
    if(!before.legacy||before.ready)throw Error('Customer waybill legacy catalog drift or already upgraded');
    await tx.execute(sql`LOCK TABLE public.order_waybill_job,public.order_waybill_job_action IN ACCESS EXCLUSIVE MODE NOWAIT`);
    if((await inspectCustomerWaybillActor(tx)).fingerprint!==before.fingerprint)throw Error('Customer waybill catalog changed while locking');
    await tx.execute(sql.raw(CUSTOMER_WAYBILL_ACTOR_SQL));
    const after=await inspectCustomerWaybillActor(tx);if(!after.ready)throw Error('Customer waybill actor upgrade verification failed');
    return {before,after};
  },{isolationLevel:'read committed',accessMode:'read write'});
}
