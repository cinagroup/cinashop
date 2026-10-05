import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { lockRuntimeSeckillScheduleBoundary } from './runtimeSeckillScheduleLockBoundary';
import { upgradePromotionGiftLockBoundaryInTransaction } from './runtimeLockOnlyBoundary';
import { inspectOrderPromotionGiftReceiptCatalog } from './orderPromotionGiftReceipt';
import { inspectPromotionManagementRuntimeSequences } from './promotionManagementRuntimeCatalog';
import { inspectRuntimePurchaseGiftEvidence } from './runtimePurchaseEvidence';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

export const PROMOTION_GIFT_RUNTIME_UPGRADE='promotion-gift-runtime-v1';
/** Explicit fixed forward from the frozen coupon-era profile. No schema/role
 * installation, revocation, guessed object grants, data writes or drift repair. */
export async function installPromotionGiftRuntimeUpgradeInTransaction(tx:Pick<DbClient,'execute'>,target:SeckillScheduleRuntimeTarget) {
  if(Object.hasOwn(tx,'$client'))throw Error('Promotion gift upgrade requires an existing transaction');
  pricingIdentifier(target.database);
  const [database]=await tx.execute(sql`SELECT current_database()=${target.database} AS same`);
  if(database?.same!==true)throw Error('Promotion gift runtime database requires review');
  await lockRuntimeSeckillScheduleBoundary(tx,target);
  const [gate]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731627,4) AS locked`);
  if(gate?.locked!==true)throw Error('Promotion gift runtime upgrade is busy');
  if(!(await inspectOrderPromotionGiftReceiptCatalog(tx,target.maintenance,target)).ready)throw Error('Promotion gift exact catalog required');
  if(!(await inspectPromotionManagementRuntimeSequences(tx,target.maintenance)).ready)throw Error('Promotion management exact serial sequences required');
  if(!(await inspectRuntimePurchaseGiftEvidence(tx,target.maintenance)).ready)throw Error('Promotion gift cancellation protocol required');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.user_bill, ONLY public.store_order_promotion_gift_coupon_reward IN SHARE ROW EXCLUSIVE MODE'));
  if(!(await inspectOrderPromotionGiftReceiptCatalog(tx,target.maintenance,target)).ready)throw Error('Promotion gift exact catalog required');
  const inspect=async(version:'pre-full-gifts'|'pre-sign-day'|'pre-agent-levels'|'current')=>({
    app:await inspectRuntimeBusinessProfileInTransaction(tx,'app',target,version),
    admin:await inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,version),
  });
  const current=await inspect('current');
  if(current.app.ready && current.admin.ready)return {operation:PROMOTION_GIFT_RUNTIME_UPGRADE,applied:false as const,profileStage:'current' as const};
  const signDay=await inspect('pre-agent-levels');
  if(signDay.app.ready && signDay.admin.ready)return {operation:PROMOTION_GIFT_RUNTIME_UPGRADE,applied:false as const,profileStage:'pre-agent-levels' as const};
  const installed=await inspect('pre-sign-day');
  if(installed.app.ready && installed.admin.ready)return {operation:PROMOTION_GIFT_RUNTIME_UPGRADE,applied:false as const,profileStage:'pre-sign-day' as const};
  const prior=await inspect('pre-full-gifts');
  if(!prior.app.ready || !prior.admin.ready)throw Error('Promotion gift exact pre-full-gifts profile required');
  await upgradePromotionGiftLockBoundaryInTransaction(tx,target.app,target.admin,target.maintenance);
  if(!(await inspectPromotionManagementRuntimeSequences(tx,target.maintenance)).ready)throw Error('Promotion management exact serial sequences required');
  const admin=pricingIdentifier(target.admin),app=pricingIdentifier(target.app);
  await tx.execute(sql.raw(`GRANT INSERT ON TABLE public.store_promotions TO ${admin}`));
  await tx.execute(sql.raw(`GRANT INSERT,DELETE ON TABLE public.store_promotions_auxiliary TO ${admin}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.store_promotions_id_seq,public.store_promotions_auxiliary_id_seq TO ${admin}`));
  await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.store_order_promotion_gift_coupon_reward TO ${admin}`));
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.store_order_promotion_gift_coupon_reward TO ${app}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq TO ${app}`));
  const after=await inspect('pre-sign-day');
  if(!after.app.ready || !after.admin.ready)throw Error('Promotion gift final runtime verification failed');
  return {operation:PROMOTION_GIFT_RUNTIME_UPGRADE,applied:true as const,profileStage:'pre-sign-day' as const};
}
export async function runPromotionGiftRuntimeUpgrade(db:DbClient,target:SeckillScheduleRuntimeTarget) {
  if(!Object.hasOwn(db,'$client') || !db.$client)throw Error('Promotion gift runtime requires a root maintenance connection');
  return db.transaction(tx=>installPromotionGiftRuntimeUpgradeInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
