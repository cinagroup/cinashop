import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { readBargainSkuOptions } from '../src/services/activity/BargainAdminSkuService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { storeBargain, storeProductDescription, storeCart, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain content transactions on independent PG16 backends',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
  await f.exec(`CREATE FUNCTION qa_content_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731634,40); RETURN NEW; END $$;
   CREATE TRIGGER qa_content_hold AFTER INSERT ON store_product_description FOR EACH ROW EXECUTE FUNCTION qa_content_hold()`);
 },30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,descriptions:await f.db.select().from(storeProductDescription)});
 it('holds the activity boundary through description writes and lets actual checkout complete afterwards',async()=>{
  await f.db.update(systemStore).set({isStore:1}).where(eq(systemStore.id,1));
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
  await withFinancePeers(f.db,async([holder,editor,buyer])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731634,40)');
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,title:'新标题',description:'<p>新正文</p>'}));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);
   const buying=outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db),{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'content_order'},
    {uid:11,key:'content_order',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'}));
   await waitForFinanceBlock(f.db,buyer.pid,editor.pid);await holder.exec('COMMIT');
   expect(await editing).toMatchObject({ok:true});expect(await buying).toMatchObject({ok:true});
  });
  expect((await state()).bargains[0]).toMatchObject({title:'新标题',stock:7,quota:7,sales:1});
  await cancelStoreOrder(f.container,{uid:11,orderId:'content_order'});expect((await state()).bargains[0]).toMatchObject({stock:8,quota:8,sales:0,title:'新标题'});
 },15_000);
 it('returns the coherent old content while a real save has uncommitted new metadata and description',async()=>{
  await saveBargain(f.container,{id:40,title:'旧标题',description:'<p>旧正文</p>'});
  await withFinancePeers(f.db,async([holder,editor,reader])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731634,40)');
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,title:'新标题',description:'<p>新正文</p>'}));await waitForFinanceBlock(f.db,editor.pid,holder.pid);
   const before=await readBargainSkuOptions(createContainerFromDb(reader.db),'70','40');expect(before.content).toMatchObject({title:'旧标题',description:'<p>旧正文</p>'});
   await holder.exec('COMMIT');expect(await editing).toMatchObject({ok:true});
   expect((await readBargainSkuOptions(createContainerFromDb(reader.db),'70','40')).content).toMatchObject({title:'新标题',description:'<p>新正文</p>'});
  });
 },15_000);
 it('rolls back metadata and description when the original deadline passes after the actual content write',async()=>{
  await withFinancePeers(f.db,async([holder,editor])=>{
   const [row]=await f.db.update(storeBargain).set({stopTime:sql`(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 second'`}).where(eq(storeBargain.id,40)).returning({stop:storeBargain.stopTime});
   const before=await state();await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731634,40)');
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,title:'过期改名',description:'<p>过期正文</p>',stopTime:f.stopTime.toISOString()}));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);await waitForFinanceClock(f.db,row.stop!.getTime());await holder.exec('COMMIT');
   const result=await editing;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('活动已结束');expect(await state()).toEqual(before);
  });
 },15_000);
});
