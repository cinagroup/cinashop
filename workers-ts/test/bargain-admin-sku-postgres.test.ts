import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';
import { storeBargain, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeCart,
  systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('single-SKU admin save on independent PG16 backends',()=>{
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async()=>{
    f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
    await f.db.update(systemStore).set({isStore:1}).where(eq(systemStore.id,1));
    await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
  },30_000);
  afterEach(async()=>{await f?.close();});
  const body=()=>({productId:70,storeName:'独立连接创建',stock:6,quota:5,price:'10.00',minPrice:'2.00',people:2,
    startTime:f.startTime.toISOString(),stopTime:f.stopTime.toISOString(),sku:{baseUnique:'qared001'}});
  const snapshot=async()=>({...await f.snapshot(),sequences:undefined,
    attrs:await f.db.select().from(storeProductAttr).orderBy(storeProductAttr.id),
    results:await f.db.select().from(storeProductAttrResult).orderBy(storeProductAttrResult.id)});
  const create=(container:Container)=>StoreOrderCreateService.createWithRuntime(container,
    {CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>'sku_concurrent_order'},
    {uid:11,key:'sku_concurrent_order',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'});
  const sku=async(id:number)=>(await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId,id),eq(storeProductAttrValue.type,2))))[0];

  it.each([
    ['SELECT pg_advisory_xact_lock(731602,0)','规格正在更新'],
    ['SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE','规格库存正在变化'],
  ])('fails fast and rolls back while a secondary lock is held: %s',async(lock,message)=>{
    const before=await snapshot();
    await withFinancePeers(f.db,async([holder,editor])=>{
      await holder.exec('BEGIN; '+lock);
      const start=performance.now();await expect(saveBargain(createContainerFromDb(editor.db),body())).rejects.toThrow(message);
      expect(performance.now()-start).toBeLessThan(1500);expect(await snapshot()).toEqual(before);
      await holder.exec('COMMIT');await expect(saveBargain(createContainerFromDb(editor.db),body())).resolves.toBeGreaterThan(0);
    });
  },15_000);

  it('fails fast on an activity SKU row lock without leaking the main edit',async()=>{
    const id=await saveBargain(f.container,body()),original=await sku(id),before=await snapshot();
    await withFinancePeers(f.db,async([holder,editor])=>{
      await holder.exec(`BEGIN; SELECT id FROM store_product_attr_value WHERE id=${original.id} FOR UPDATE`);
      await expect(saveBargain(createContainerFromDb(editor.db),{id,price:'11.00',sku:{baseUnique:'qared001',expected:{id:original.id,unique:original.unique,stock:6,quota:5}}})).rejects.toThrow('规格库存正在变化');
      expect(await snapshot()).toEqual(before);await holder.exec('COMMIT');
    });
  },15_000);

  it('does not deadlock a real checkout holding the source SKU before source product stock is updated',async()=>{
    await f.exec(`CREATE FUNCTION qa_sku_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=1 THEN PERFORM pg_advisory_xact_lock(731633,40); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_sku_hold AFTER UPDATE OF stock ON store_product_attr_value FOR EACH ROW EXECUTE FUNCTION qa_sku_hold()`);
    await withFinancePeers(f.db,async([holder,buyer,editor])=>{
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731633,40)');
      const buying=outcome(create(createContainerFromDb(buyer.db)));await waitForFinanceBlock(f.db,buyer.pid,holder.pid);
      const before=await snapshot();
      await expect(saveBargain(createContainerFromDb(editor.db),body())).rejects.toThrow('规格库存正在变化');
      expect(await snapshot()).toEqual(before);await holder.exec('COMMIT');expect(await buying).toMatchObject({ok:true});
    });
    expect((await snapshot()).orders).toHaveLength(1);
    await cancelStoreOrder(f.container,{uid:11,orderId:'sku_concurrent_order'});
    expect((await snapshot()).skus.find(row=>row.id===1)).toMatchObject({stock:8});
    await expect(saveBargain(f.container,body())).resolves.toBeGreaterThan(0);
  },15_000);

  it('rechecks SKU originals after waiting behind another real admin SKU save',async()=>{
    const id=await saveBargain(f.container,body()),original=await sku(id);
    const patch={id,stock:7,quota:6,expected:{stock:6,quota:5},sku:{baseUnique:'qared001',expected:{id:original.id,unique:original.unique,stock:6,quota:5}}};
    await f.exec(`CREATE FUNCTION qa_sku_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type=2 THEN PERFORM pg_advisory_xact_lock(731633,40); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_sku_hold AFTER UPDATE OF stock ON store_product_attr_value FOR EACH ROW EXECUTE FUNCTION qa_sku_hold()`);
    await withFinancePeers(f.db,async([holder,first,second])=>{
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731633,40)');
      const saving=outcome(saveBargain(createContainerFromDb(first.db),patch));await waitForFinanceBlock(f.db,first.pid,holder.pid);
      const stale=outcome(saveBargain(createContainerFromDb(second.db),{id,price:'11.00',sku:patch.sku}));
      await waitForFinanceBlock(f.db,second.pid,first.pid);await holder.exec('COMMIT');
      expect(await saving).toMatchObject({ok:true,value:id});const result=await stale;expect(result.ok).toBe(false);
      if(!result.ok)expect(result.error.message).toContain('规格已变化');
    });
    expect(await sku(id)).toMatchObject({unique:original.unique,stock:7,quota:6,price:'10.00'});
  },15_000);

  it('rolls back SKU, dimensions and snapshot when the deadline passes after the actual snapshot insert',async()=>{
    await f.exec(`CREATE FUNCTION qa_sku_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731633,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_sku_hold AFTER INSERT ON store_product_attr_result FOR EACH ROW EXECUTE FUNCTION qa_sku_hold()`);
    const before=await snapshot();
    await withFinancePeers(f.db,async([holder,editor])=>{
      const [clock]=await f.db.select({deadline:sql<number>`floor(extract(epoch from clock_timestamp())*1000)+1000`}).from(sql`(VALUES(1)) AS p(n)`);
      const deadline=Number(clock.deadline);await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731633,40)');
      const saving=outcome(saveBargain(createContainerFromDb(editor.db),{...body(),stopTime:new Date(deadline).toISOString()}));
      await waitForFinanceBlock(f.db,editor.pid,holder.pid);await waitForFinanceClock(f.db,deadline);await holder.exec('COMMIT');
      const result=await saving;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('时间');
    });
    expect(await snapshot()).toEqual(before);
  },15_000);

  it('rejects a source SKU retired before save and keeps committed source changes',async()=>{
    await withFinancePeers(f.db,async([writer,editor])=>{
      await writer.exec('UPDATE store_product_attr_value SET is_retired=1 WHERE id=1');
      const before=await snapshot();await expect(saveBargain(createContainerFromDb(editor.db),body())).rejects.toThrow('退役');
      expect(await snapshot()).toEqual(before);
    });
    expect(await f.db.select().from(storeBargain)).toHaveLength(1);
  },15_000);
});
