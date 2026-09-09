import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers, type FinancePeer } from './helpers/financePeers';
import { storeCart, storeProduct, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain pickup independent PG16 write boundaries',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
  f.config.store_func_status='1';f.config.store_self_mention='1';await f.db.update(systemStore).set({isStore:1});
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,details:await f.db.select().from(storeOrderCartInfo),prints:await f.db.select().from(printDocument)});
 const create=(buyer:FinancePeer)=>StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db),{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'pickup_race'},
  {uid:11,key:'pickup_race',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'});
 const mutations={
  update:"UPDATE system_config SET value='0' WHERE menu_name='store_self_mention'",
  insert:"INSERT INTO system_config(menu_name,value,sort) VALUES('store_self_mention','0',99)",
  delete:"DELETE FROM system_config WHERE menu_name='store_self_mention'",
  store:'UPDATE system_store SET is_store=0 WHERE id=1',
 };
 it.each(Object.entries(mutations))('fails fast behind an uncommitted %s editor without partial business writes',async(_,query)=>{
  const before=await state();await withFinancePeers(f.db,async([writer,buyer])=>{
   await writer.exec('BEGIN');await writer.exec(query);
   expect(await outcome(create(buyer))).toMatchObject({ok:false,error:{message:expect.stringContaining('自提规则正在更新')}});
   // Completion before releasing the writer proves fail-fast, not eventual waiting success.
   await writer.exec('ROLLBACK');
  });expect(await state()).toEqual(before);
 },15_000);
 it.each(Object.entries(mutations))('holds admission until order snapshot commit against a later %s editor',async(_,query)=>{
  await f.exec(`CREATE FUNCTION qa_pickup_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731637,40); RETURN NEW; END $$;
   CREATE TRIGGER qa_pickup_hold AFTER INSERT ON store_order_cart_info FOR EACH ROW EXECUTE FUNCTION qa_pickup_hold()`);
  await withFinancePeers(f.db,async([holder,buyer,writer])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731637,40)');const buying=outcome(create(buyer));
   await waitForFinanceBlock(f.db,buyer.pid,holder.pid);const editing=outcome(writer.exec(query));
   await waitForFinanceBlock(f.db,writer.pid,buyer.pid);await holder.exec('COMMIT');
   expect(await buying).toMatchObject({ok:true});expect(await editing).toMatchObject({ok:true});
  });expect((await state()).orders[0]).toMatchObject({shippingType:2,storeId:1,payPrice:'2.00'});
 },15_000);
 it.each(['owner','productType','hidden','retired','metadata'] as const)('atomically checks source eligibility at inventory UPDATE after an admission-time %s change',async kind=>{
  await f.exec(`CREATE FUNCTION qa_pickup_cart_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731638,40); RETURN NEW; END $$;
   CREATE TRIGGER qa_pickup_cart_hold BEFORE UPDATE ON store_cart FOR EACH ROW WHEN (NEW.is_pay=1) EXECUTE FUNCTION qa_pickup_cart_hold()`);
  await withFinancePeers(f.db,async([holder,buyer,writer])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731638,40)');const buying=outcome(create(buyer));
   await waitForFinanceBlock(f.db,buyer.pid,holder.pid);
   const changes={owner:{type:1,relationId:2},productType:{productType:1},hidden:{isShow:0},retired:{isDel:1},metadata:{storeName:'普通改名'}};
   await writer.db.update(storeProduct).set(changes[kind]).where(eq(storeProduct.id,70));
   await holder.exec('COMMIT');const result=await buying;expect(result.ok).toBe(kind==='metadata');
   if(!result.ok)expect(result.error.message).toContain('自提商品归属');
  });const after=await state();expect(after.orders).toHaveLength(kind==='metadata'?1:0);
  if(kind!=='metadata'){expect(after.carts[0].isPay).toBe(0);expect(after.bargains[0].stock).toBe(8);expect(after.skus[0].stock).toBe(8);expect(after.participations[0].status).toBe(3);expect(after.details).toHaveLength(0);}
 },15_000);
 it('preserves stricter transaction limits and restores connection settings',async()=>{
  await withFinancePeers(f.db,async([holder,buyer])=>{
   await buyer.exec("SET statement_timeout='3500ms'; SET lock_timeout='120ms'; SET idle_in_transaction_session_timeout='2500ms'");
   await holder.exec('BEGIN; SELECT id FROM store_bargain WHERE id=40 FOR NO KEY UPDATE');
   const result=await outcome(create(buyer));expect(result.ok).toBe(false);await holder.exec('ROLLBACK');
   const [settings]=await buyer.db.select({statement:sql<string>`current_setting('statement_timeout')`,lock:sql<string>`current_setting('lock_timeout')`,idle:sql<string>`current_setting('idle_in_transaction_session_timeout')`}).from(sql`(values(1)) p(n)`);
   expect(settings).toEqual({statement:'3500ms',lock:'120ms',idle:'2500ms'});
  });expect((await state()).orders).toHaveLength(0);
 },15_000);
});
