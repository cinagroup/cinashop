import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { storeOrderOutbox, systemLog } from '@/models/schema';
import { withTx } from '@/lib/di';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { clearProductRecycleTags, deliverProductRecycleEffects, enqueueProductRecycleEffects, parseProductRecycleEffectsPayload,
  productRecycleTagKeys, PRODUCT_RECYCLE_TAG_CLEAR_LUA } from '@/services/product/ProductRecycleEffects';
import { PRODUCT_RECYCLE_EFFECTS_SQL } from '@/migrations/productRecycleEffects';
import * as cache from '@/utils/cache';
import { stockFixture, seedStocks, resetStockSequences, stockSnapshot } from './helpers/adminProductStocks';
const env = { UPSTASH_REDIS_URL: 'https://owned-fixture.invalid', UPSTASH_REDIS_TOKEN: 'local-provider-fixture' };
describe('dedicated durable recycle cache effects, source identity and Queue lease recovery', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f=await stockFixture(); },30000);
  beforeEach(async () => {
    await f.reset();await seedStocks(f.db);await resetStockSequences(f.exec);
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external provider I/O'));
  });
  afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();});
  afterAll(async()=>{await f?.close();});
  async function event(operation='recycle') {
    return withTx(f.container,async tx=>{
      const [audit]=await tx.insert(systemLog).values({adminId:101,type:'product_recycle',method:'DELETE',path:'product/product/10',action:JSON.stringify({operation,productId:10,affectedProductIds:[10,100]})}).returning();
      return enqueueProductRecycleEffects(tx,{productId:10,auditId:audit.id,affectedProductIds:[10,100]},Math.floor(Date.now()/1000));
    });
  }
  function provider() { const evaluate=vi.fn().mockResolvedValue(4);vi.spyOn(cache,'getRedis').mockReturnValue({eval:evaluate} as unknown as NonNullable<ReturnType<typeof cache.getRedis>>);return evaluate; }
  it('matches the external maintenance artifact and rejects malformed or unsorted identities',()=>{
    expect(readFileSync('migrations/0177_product_recycle_effects.sql','utf8').trim()).toBe(PRODUCT_RECYCLE_EFFECTS_SQL.trim());
    for(const value of [null,[],{}, {productId:10,auditId:1,affectedProductIds:[]},{productId:10,auditId:1,affectedProductIds:[100,10]},
      {productId:10,auditId:1,affectedProductIds:[100]},{productId:10,auditId:1,affectedProductIds:[10,10]}, {productId:10,auditId:1,affectedProductIds:[10],token:'x'}]) expect(()=>parseProductRecycleEffectsPayload(value)).toThrow();
  });
  it('uses PHP physical tag set and member prefixes, with no duplicated Redis prefix', async()=>{
    const evaluate=provider(),configured={...env,REDIS_PREFIX:'tenant:',CACHE_TAG_PREFIX:'cache:'};await clearProductRecycleTags(configured);
    expect(productRecycleTagKeys(configured)).toEqual({keys:['tenant:cache:CRMEB:19ebc6b9c156e99ca987fba0feabe5f9','tenant:cache:CRMEB:87e6f0d8c14295287d6239d77f69c1fb'],prefixes:['tenant:mc:store_product:tag','tenant:mc:store_product_attr:tag']});
    expect(evaluate).toHaveBeenCalledWith(PRODUCT_RECYCLE_TAG_CLEAR_LUA,productRecycleTagKeys(configured).keys,productRecycleTagKeys(configured).prefixes);
    expect(()=>productRecycleTagKeys({REDIS_PREFIX:'\u0000'})).toThrow('prefix invalid');
  });
  it('commits an exact pending intent with its audit and validates both restore and recycle delivery without changing business rows',async()=>{
    const evaluate=provider();
    for(const operation of ['recycle','restore']) {const row=await event(operation),before=await stockSnapshot(f.db);
      expect(row).toMatchObject({eventType:'product.recycle.effects',aggregateType:'product',aggregateId:10,status:'PENDING',payload:{productId:10,affectedProductIds:[10,100]}});
      expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:row.id,eventKey:row.eventKey})).toBe(true);
      await deliverProductRecycleEffects(f.container,env,row);expect(await stockSnapshot(f.db)).toEqual(before);
    } expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it('rejects forged domain, event key, audit method, path, operation or family before invoking Redis',async()=>{
    const evaluate=provider(),row=await event();
    for(const patch of [{eventKey:row.eventKey.replace('recycle','stock')},{aggregateType:'order'},{aggregateId:20},{payload:{...row.payload,affectedProductIds:[10,200]}}]) await expect(deliverProductRecycleEffects(f.container,env,{...row,...patch})).rejects.toThrow();
    for(const patch of [{method:'PUT'},{path:'product/product/11'},{type:'product_stock_adjustment'},{action:JSON.stringify({operation:'saveStocks',productId:10,affectedProductIds:[10,100]})}]) {
      const [before]=await f.db.select().from(systemLog).where(eq(systemLog.id,(row.payload as {auditId:number}).auditId));
      await f.db.update(systemLog).set(patch).where(eq(systemLog.id,before.id));await expect(deliverProductRecycleEffects(f.container,env,row)).rejects.toThrow();
      await f.db.update(systemLog).set(before).where(eq(systemLog.id,before.id));
    } expect(evaluate).not.toHaveBeenCalled();
  });
  it('requires configured cache bindings even outside production and validates the provider receipt',async()=>{
    const evaluate=provider();await expect(clearProductRecycleTags({UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''})).rejects.toThrow('binding unavailable');expect(evaluate).not.toHaveBeenCalled();
    for(const receipt of [null,true,'2',-1,10001]) {evaluate.mockResolvedValueOnce(receipt);await expect(clearProductRecycleTags(env)).rejects.toThrow('receipt invalid');}
    evaluate.mockRejectedValueOnce(Error('provider outcome unknown'));await expect(clearProductRecycleTags(env)).rejects.toThrow('outcome unknown');
  });
  it('replays only the failed cache intent, completes under its lease and treats duplicate messages as already completed',async()=>{
    const evaluate=provider(),row=await event(),messages:any[]=[];
    evaluate.mockRejectedValueOnce(Error('cache temporarily unavailable'));
    const queue={sendBatch:async(batch:any[])=>{messages.push(...batch.map(item=>item.body));return{};}} as unknown as Queue<any>;
    const service=new OrderOutboxService(f.container,{...env,ORDER_QUEUE:queue}),before=await stockSnapshot(f.db);
    await service.dispatchEventKey(row.eventKey);await expect(service.processMessage(messages[0])).rejects.toThrow('cache temporarily unavailable');
    expect((await f.db.select().from(storeOrderOutbox))[0].status).toBe('FAILED');await service.replay(row.id);await service.dispatchEventKey(row.eventKey);
    expect(await service.processMessage(messages.at(-1))).toBe('completed');expect(await service.processMessage(messages[0])).toBe('already-completed');
    const after=await stockSnapshot(f.db);for(const key of Object.keys(before).filter(key=>key!=='storeOrderOutbox'))expect(after[key]).toEqual(before[key]);
    expect(evaluate).toHaveBeenCalledTimes(2);expect((await f.db.select().from(storeOrderOutbox))[0]).toMatchObject({status:'COMPLETED',leaseToken:'',leaseUntil:0});
  });
});
