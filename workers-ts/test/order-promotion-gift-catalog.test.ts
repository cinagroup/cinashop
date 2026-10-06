import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { userBill } from '../src/models/schema';
import { financePostgres } from './helpers/financePostgres';
import { inspectOrderPromotionGiftReceiptCatalog, ORDER_PROMOTION_GIFT_RECEIPT_SQL }
  from '../src/migrations/orderPromotionGiftReceipt';

describe('explicit exact order gift receipt catalog',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async()=>{f=await financePostgres([userBill],{namespace:'public'});});
  afterEach(async()=>{await f?.close();});
  const install=async()=>{
    if(process.env.TEST_FINANCE_POSTGRES_URL) {
      try {return await f.db.transaction(tx=>tx.execute(sql.raw(ORDER_PROMOTION_GIFT_RECEIPT_SQL)));}
      catch(error){throw error && typeof error==='object' && 'cause' in error?error.cause:error;}
    }
    try {await f.exec('BEGIN;'+ORDER_PROMOTION_GIFT_RECEIPT_SQL+'COMMIT');}
    catch(error){await f.exec('ROLLBACK');throw error;}
  };
  const catalog=()=>f.db.execute(sql`SELECT c.relname,c.relowner,c.relacl,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`);
  it('creates immutable attribution and a source points replay fence without changing business rows',async()=>{
    await f.db.insert(userBill).values({uid:11,linkId:'30',eventKey:'pay_give_integral',number:'20'});
    const before=await f.db.select().from(userBill);
    await install();expect(await inspectOrderPromotionGiftReceiptCatalog(f.db)).toMatchObject({ready:true});
    expect(await f.db.select().from(userBill)).toEqual(before);
    const installed=await catalog();await install();expect(await catalog()).toEqual(installed);
    await f.db.execute(sql`INSERT INTO store_order_promotion_gift_coupon_reward(order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id)
      VALUES(30,11,61,62,71,21,41)`);
    await expect(f.db.execute(sql`INSERT INTO store_order_promotion_gift_coupon_reward(order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id)
      VALUES(30,11,61,62,71,21,42)`)).rejects.toBeTruthy();
    await expect(f.db.execute(sql`INSERT INTO store_order_promotion_gift_coupon_reward(order_id,uid,root_id,tier_id,auxiliary_id,issue_coupon_id,coupon_user_id)
      VALUES(31,11,61,62,72,21,41)`)).rejects.toBeTruthy();
    await f.db.insert(userBill).values({uid:11,linkId:'30',eventKey:'order_promotions_give_integral',number:'20'});
    await expect(f.db.insert(userBill).values({uid:11,linkId:'30',eventKey:'order_promotions_give_integral',number:'20'})).rejects.toBeTruthy();
  });
  it.each([
    'DROP INDEX sopgcr_order_aux_uq;CREATE UNIQUE INDEX sopgcr_order_aux_uq ON store_order_promotion_gift_coupon_reward(order_id,tier_id)',
    'ALTER TABLE store_order_promotion_gift_coupon_reward DROP CONSTRAINT sopgcr_positive_ids_ck;ALTER TABLE store_order_promotion_gift_coupon_reward ADD CONSTRAINT sopgcr_positive_ids_ck CHECK(order_id>0)',
    'ALTER TABLE store_order_promotion_gift_coupon_reward ALTER COLUMN auxiliary_id DROP NOT NULL',
    'ALTER SEQUENCE store_order_promotion_gift_coupon_reward_id_seq OWNED BY NONE',
    "DROP INDEX ub_order_promotion_gift_uq;CREATE UNIQUE INDEX ub_order_promotion_gift_uq ON user_bill(uid,link_id,event_key) WHERE event_key='pay_give_integral'",
    'GRANT SELECT ON store_order_promotion_gift_coupon_reward TO PUBLIC',
    'GRANT SELECT(uid) ON store_order_promotion_gift_coupon_reward TO PUBLIC',
    'GRANT USAGE ON SEQUENCE store_order_promotion_gift_coupon_reward_id_seq TO PUBLIC',
  ])('refuses drift instead of adopting or repairing %s',async mutation=>{
    await install();await f.exec(mutation);const drift=await catalog();
    expect(await inspectOrderPromotionGiftReceiptCatalog(f.db)).toMatchObject({ready:false});
    await expect(install()).rejects.toThrow('exact catalog drift');expect(await catalog()).toEqual(drift);
  });
});
