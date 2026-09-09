import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers, type FinancePeer } from './helpers/financePeers';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { storeCart, storeBargain, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain shipping independent PostgreSQL transactions',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
  await f.db.update(systemStore).set({isStore:1}).where(eq(systemStore.id,1));
  await f.db.update(storeBargain).set({deliveryType:'1,2'});
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,details:await f.db.select().from(storeOrderCartInfo),prints:await f.db.select().from(printDocument)});
 const create=(peer:FinancePeer)=>StoreOrderCreateService.createWithRuntime(createContainerFromDb(peer.db),{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'shipping_race'},
  {uid:11,key:'shipping_race',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离配送',userPhone:'00000000000',userIp:'127.0.0.1'});
 it.each([{deliveryType:'1'},{deliveryType:'1,2,3'},{freight:2},{postage:'9.00'},{tempId:10}])('rejects the real committed change after waiting behind an activity writer: %j',async patch=>{
  const before=await state();await withFinancePeers(f.db,async([editor,buyer])=>{
   await editor.exec('BEGIN');await editor.db.update(storeBargain).set(patch).where(eq(storeBargain.id,40));
   const buying=outcome(create(buyer));await waitForFinanceBlock(f.db,buyer.pid,editor.pid);await editor.exec('COMMIT');
   expect(await buying).toMatchObject({ok:false,error:{message:expect.stringContaining('配送或运费规则已变化')}});
  });expect(await state()).toEqual({...before,bargains:before.bargains.map(r=>({...r,...patch}))});
 },15_000);
 it.each(['rollback','metadata'] as const)('accepts an unchanged shipping quote after a verified %s wait',async mode=>{
  await withFinancePeers(f.db,async([editor,buyer])=>{
   await editor.exec('BEGIN');await editor.db.update(storeBargain).set(mode==='rollback'?{deliveryType:'1'}:{title:'普通内容变更'});
   const buying=outcome(create(buyer));await waitForFinanceBlock(f.db,buyer.pid,editor.pid);await editor.exec(mode==='rollback'?'ROLLBACK':'COMMIT');
   expect(await buying).toMatchObject({ok:true});
  });expect((await state()).orders).toHaveLength(1);
 },15_000);
 it('holds the shipping rule boundary through actual order snapshot writes so a later editor cannot overtake checkout',async()=>{
  await f.exec(`CREATE FUNCTION qa_shipping_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731635,40); RETURN NEW; END $$;
   CREATE TRIGGER qa_shipping_hold AFTER INSERT ON store_order_cart_info FOR EACH ROW EXECUTE FUNCTION qa_shipping_hold()`);
  await withFinancePeers(f.db,async([holder,buyer,editor])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,40)');
   const buying=outcome(create(buyer));await waitForFinanceBlock(f.db,buyer.pid,holder.pid);
   const editing=outcome(editor.db.update(storeBargain).set({deliveryType:'1'}).where(eq(storeBargain.id,40)));
   await waitForFinanceBlock(f.db,editor.pid,buyer.pid);await holder.exec('COMMIT');
   expect(await buying).toMatchObject({ok:true});expect(await editing).toMatchObject({ok:true});
  });const after=await state();expect(after.orders[0]).toMatchObject({shippingType:2,payPrice:'2.00'});expect(after.bargains[0].deliveryType).toBe('1');
 },15_000);
});
