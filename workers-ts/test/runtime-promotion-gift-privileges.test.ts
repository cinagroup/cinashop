import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { removePromotionGiftFixtureGrants } from './helpers/runtimeHistoricalProfile';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { inspectRuntimeBusinessCommissioning, runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { installPromotionGiftRuntimeUpgradeInTransaction, runPromotionGiftRuntimeUpgrade } from '../src/migrations/runPromotionGiftRuntimeUpgrade';
import type { SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { OFFLINE_STATE_SQL } from '../src/migrations/offlineOrderCatalog';
import { inspectReviewedOfflineGiftCatalog } from '../src/migrations/reviewedOfflineGiftCatalog';
import { reviewedOfflinePricingOid } from '../src/migrations/reviewedOfflinePricingCapability';

const native=process.env.TEST_FINANCE_POSTGRES_URL?describe:describe.skip;
type Peer=SequenceRunnerPeer & {role:string};
type Target={app:string;admin:string;maintenance:string;database:string};
native('promotion gift explicit forward and real PG16 LOGIN boundaries',()=>{
  let f:Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{f=await refundRuntimeFixture();},60_000);
  afterEach(async()=>{await f?.close();},30_000);
  async function roles(run:(app:Peer,admin:Peer,target:Target)=>Promise<void>) {
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [r]=await f.exec('SELECT current_database() AS database');
      const target={app:app.role,admin:admin.role,maintenance:'finance_test',database:String(r.database)};
      const preflight=await inspectRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      expect(preflight).toMatchObject({roles:[{restricted:true,empty:true,no_definer:true,no_default_grants:true},
        {restricted:true,empty:true,no_definer:true,no_default_grants:true}],tablesReady:true,sequencesReady:true,
        pricingReady:true,offlineReady:true,refundProtocolsReady:true,shippingReplay:{complete:true},
        purchaseEvidence:{ready:true},seckillTimeReferenceLockReady:true,couponTemplateCatalogReady:true,
        promotionGiftCatalogReady:true,promotionGiftCancellationReady:true});
      await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
      await removePromotionGiftFixtureGrants(f.exec,target);
      for(const kind of ['app','admin'] as const)expect(await f.db.transaction(tx=>
        inspectRuntimeBusinessProfileInTransaction(tx,kind,target,'pre-full-gifts'))).toMatchObject({ready:true,failures:[]});
      await run(app,admin,target);
    }));
  }
  const catalog=()=>f.exec(`SELECT 'relation' AS kind,oid::text AS key,relacl::text AS acl FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,prosrc||coalesce(proacl::text,'') FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,key`);
  it('reviews only the exact 0176 user_bill index without changing the frozen offline v1 catalog',async()=>{
    const [legacy]=await f.db.execute(sql.raw(OFFLINE_STATE_SQL));
    expect(legacy?.state).toBe('drift');
    expect(await inspectReviewedOfflineGiftCatalog(f.db,{requireOwner:true,maintenance:'finance_test'}))
      .toMatchObject({state:'v1-gift-index'});
    expect(await reviewedOfflinePricingOid(f.db,'public')).toMatch(/^\d+$/);
    await f.exec('ALTER INDEX public.ub_uid_idx RENAME TO ub_uid_drift');
    expect(await inspectReviewedOfflineGiftCatalog(f.db,{requireOwner:true,maintenance:'finance_test'}))
      .toMatchObject({state:'drift'});
    expect(await reviewedOfflinePricingOid(f.db,'public')).toBeNull();
    await f.exec('ALTER INDEX public.ub_uid_drift RENAME TO ub_uid_idx');
    await f.exec('DROP INDEX public.ub_order_promotion_gift_uq');
    expect(await inspectReviewedOfflineGiftCatalog(f.db,{requireOwner:true,maintenance:'finance_test'}))
      .toMatchObject({state:'drift'});
    expect(await reviewedOfflinePricingOid(f.db,'public')).toBeNull();
  },60_000);
  it('forwards the exact receipt/management capabilities, preserves rows, and repeats without churn',async()=>{
    await roles(async(app,admin,target)=>{
      await f.exec("INSERT INTO store_promotions(id,promotions_type,name) VALUES(61,4,'gift fixture');INSERT INTO store_promotions_auxiliary(id,promotions_id,type,limit_num,surplus_num) VALUES(71,61,2,10,8)");
      const before=await f.state();
      await expect(app.exec('UPDATE store_promotions_auxiliary SET surplus_num=7 WHERE id=71')).rejects.toMatchObject({code:'42501'});
      await expect(admin.exec("UPDATE store_promotions SET name='changed' WHERE id=61")).rejects.toMatchObject({code:'42501'});
      expect(await runPromotionGiftRuntimeUpgrade(f.db,target)).toMatchObject({applied:true,profileStage:'pre-sign-day'});
      expect(await f.state()).toEqual(before);
      expect(await app.db.transaction(tx=>inspectRuntimeBusinessProfileInTransaction(tx,'app',target,'pre-sign-day'))).toMatchObject({ready:true,failures:[]});
      expect(await auditRuntimeBusinessPrivileges(app.db,'app',target)).toMatchObject({ready:false});
      expect(await admin.db.transaction(tx=>inspectRuntimeBusinessProfileInTransaction(tx,'admin',target,'pre-sign-day'))).toMatchObject({ready:true,failures:[]});
      expect(await auditRuntimeBusinessPrivileges(admin.db,'admin',target)).toMatchObject({ready:false});
      const installed=await catalog();expect(await runPromotionGiftRuntimeUpgrade(f.db,target)).toMatchObject({applied:false});
      expect(await catalog()).toEqual(installed);
      await app.exec('UPDATE store_promotions_auxiliary SET surplus_num=7 WHERE id=71');
      await admin.exec("UPDATE store_promotions SET name='changed' WHERE id=61");
      await admin.exec("INSERT INTO store_promotions(name,promotions_type) VALUES('new gift',4)");
      await app.exec('INSERT INTO store_order_promotion_gift_coupon_reward(order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id) VALUES(30,11,61,62,71,21,41)');
      expect(await admin.exec('SELECT order_id,coupon_user_id FROM store_order_promotion_gift_coupon_reward')).toEqual([{order_id:30,coupon_user_id:41}]);
      for(const statement of ['UPDATE store_promotions SET name=name||\'x\' WHERE id=61',
        'UPDATE store_promotions_auxiliary SET limit_num=20 WHERE id=71','UPDATE store_promotions_auxiliary SET id=72 WHERE id=71',
        'UPDATE store_promotions_auxiliary SET promotions_id=62 WHERE id=71','DELETE FROM store_promotions_auxiliary WHERE id=71',
        'UPDATE store_order_promotion_gift_coupon_reward SET uid=12','DELETE FROM store_order_promotion_gift_coupon_reward',
        "SELECT setval('store_order_promotion_gift_coupon_reward_id_seq',1)"])
        await expect(app.exec(statement)).rejects.toMatchObject({code:'42501'});
      for(const statement of ['DELETE FROM store_promotions WHERE id=61',
        'INSERT INTO store_order_promotion_gift_coupon_reward(order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id) VALUES(31,11,61,62,72,21,42)',
        'UPDATE store_order_promotion_gift_coupon_reward SET uid=12','DELETE FROM store_order_promotion_gift_coupon_reward'])
        await expect(admin.exec(statement)).rejects.toMatchObject({code:'42501'});
    });
  },60_000);
  it('rolls back every grant and the boundary replacement on a late transaction failure',async()=>{
    await roles(async(_app,_admin,target)=>{
      const before=await catalog(),data=await f.state();
      await expect(f.db.transaction(async tx=>{await installPromotionGiftRuntimeUpgradeInTransaction(tx,target);throw Error('late gift fixture failure');})).rejects.toThrow('late gift fixture failure');
      expect(await catalog()).toEqual(before);expect(await f.state()).toEqual(data);
    });
  },60_000);
  it('refuses an unreviewed third role receipt grant without revoking it',async()=>{
    await roles(async(_app,_admin,target)=>{
      await f.exec(`GRANT SELECT ON store_order_promotion_gift_coupon_reward TO "${f.pricingOwner}"`);
      const before=await catalog();await expect(runPromotionGiftRuntimeUpgrade(f.db,target)).rejects.toThrow('exact catalog required');
      expect(await catalog()).toEqual(before);
    });
  },60_000);
  it.each([
    'ALTER SEQUENCE store_promotions_id_seq OWNED BY NONE',
    'ALTER FUNCTION public.cinashop_runtime_lock_only_v1() RESET search_path',
    "DROP INDEX ub_order_promotion_gift_uq;CREATE UNIQUE INDEX ub_order_promotion_gift_uq ON user_bill(uid,link_id,event_key) WHERE event_key='pay_give_integral'",
  ])('refuses drift without repairing %s',async mutation=>{
    await roles(async(_app,_admin,target)=>{
      await f.exec(mutation);const drift=await catalog();await expect(runPromotionGiftRuntimeUpgrade(f.db,target)).rejects.toBeTruthy();
      expect(await catalog()).toEqual(drift);
    });
  },60_000);
});
