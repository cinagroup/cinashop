import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { storeCart, storeBargain, storeProduct, systemStore, systemConfig, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';
import { readBargainShippingSelection } from '../src/services/activity/BargainShippingSelection';

describe('bargain pickup authoritative quote and creation admission',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 const params:CreateOrderParams={uid:11,key:'pickup_admission',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离自提',userPhone:'00000000000',userIp:'127.0.0.1'};
 beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
  f.config.store_func_status='1';f.config.store_self_mention='1';
  await f.db.update(systemStore).set({isStore:1});
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,details:await f.db.select().from(storeOrderCartInfo),statuses:await f.db.select().from(storeOrderStatus),prints:await f.db.select().from(printDocument)});
 const create=(afterQuote?:()=>Promise<void>)=>StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>{await afterQuote?.();return 'pickup_admission';}},params);
 const quote=()=>new StoreOrderCreateService(f.container,f.env).quoteOrder(params);
 it.each(['0','"0"','', 'invalid'])('selector and quote do not use stale enabled KV over SQL value %j',async value=>{
  await f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,'store_self_mention'));
  await expect(quote()).rejects.toThrow('自提');
  if(value==='invalid')await expect(readBargainShippingSelection(f.container,f.env,11,[10])).rejects.toThrow('自提');
  else expect((await readBargainShippingSelection(f.container,f.env,11,[10])).shippingTypes).toEqual([1]);
 });
 it('uses duplicate sort/id priority and ignores store-only config and admin visibility',async()=>{
  await f.db.insert(systemConfig).values({menuName:'store_self_mention',value:'0',isStore:1,sort:999});
  await f.db.update(systemConfig).set({status:0});expect((await quote()).payCents).toBe(200);
  await f.db.insert(systemConfig).values({menuName:'store_self_mention',value:'0',sort:1});await expect(quote()).rejects.toThrow('自提');
  await f.db.insert(systemConfig).values({menuName:'store_self_mention',value:'"1"',sort:1});expect((await quote()).payCents).toBe(200);
 });
 it('applies PHP missing-key defaults without confusing explicit empty with absent',async()=>{
  await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'store_func_status'));expect((await quote()).payCents).toBe(200);
  await f.db.insert(systemConfig).values({menuName:'store_func_status',value:''});await expect(quote()).rejects.toThrow('自提');
  await f.db.delete(systemConfig);await expect(quote()).rejects.toThrow('自提');
 });
 it.each(['store_func_status','store_self_mention'])('rejects authoritative %s disabled despite enabled stale KV',async name=>{
  await f.db.update(systemConfig).set({value:'"0"'}).where(eq(systemConfig.menuName,name));const before=await state();
  await expect(quote()).rejects.toThrow('自提');await expect(create()).rejects.toThrow('自提');expect(await state()).toEqual(before);
 });
 it.each([0,1,2,3])('does not apply pickup switches to shippingType=1 product type %i',async productType=>{
  await f.db.update(systemConfig).set({value:'0'});
  await f.db.update(storeProduct).set({productType});await f.db.update(storeCart).set({productType});
  await f.db.update(storeBargain).set({productType,deliveryType:productType===0?'1':'2'});
  expect((await new StoreOrderCreateService(f.container,f.env).quoteOrder({...params,shippingType:1})).payCents).toBe(200);
  expect((await readBargainShippingSelection(f.container,f.env,11,[10])).shippingTypes).toEqual([1]);
 });
 it.each([{isStore:0},{isShow:0},{isDel:1}])('rejects unavailable pickup store already during quote %j',async patch=>{
  await f.db.update(systemStore).set(patch);const before=await state();
  await expect(quote()).rejects.toThrow('自提');await expect(create()).rejects.toThrow('自提');expect(await state()).toEqual(before);
 });
 it.each([{type:1,relationId:2},{type:0,relationId:99},{type:2,relationId:0},{type:7,relationId:0}])('rejects foreign or malformed source owner %j',async patch=>{
  await f.db.update(storeProduct).set(patch);const before=await state();
  await expect(quote()).rejects.toThrow('自提');await expect(create()).rejects.toThrow('自提');expect(await state()).toEqual(before);
 });
 it.each(['config','store','owner'])('rechecks %s changed after the real pricing path and leaves no partial order',async change=>{
  const before=await state();let changed:typeof before;
  await expect(create(async()=>{
   if(change==='config')await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'store_self_mention'));
   if(change==='store')await f.db.update(systemStore).set({isStore:0});
   if(change==='owner')await f.db.update(storeProduct).set({type:1,relationId:2});
   changed=await state();
  })).rejects.toThrow('自提');expect(await state()).toEqual(changed!);
 });
 it('allows its own eligible store, preserves idempotence after disabling, and cancellation restores inventory',async()=>{
  await f.db.update(storeProduct).set({type:1,relationId:1});expect((await quote()).payCents).toBe(200);
  await create();await f.db.update(systemConfig).set({value:'0'});const before=await state();
  expect(await create()).toEqual({key:params.key,orderId:'pickup_admission'});expect(await state()).toEqual(before);
  await cancelStoreOrder(f.container,{uid:11,orderId:'pickup_admission'});expect((await state()).bargains[0].stock).toBe(8);
 });
 it('revalidates global pickup settings through actual HTTP confirmation and recomputation',async()=>{
  const request=async(path:string)=>{const r=await f.app.request(path,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':'11'},body:JSON.stringify(params)},f.env);return r.json() as Promise<{status:number;msg:string;data:{orderKey:string}}>;};
  const accepted=await request('/api/order/confirm');expect(accepted.status).toBe(200);
  await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'store_func_status'));
  const rejected=await request('/api/order/computed/'+accepted.data.orderKey);expect(rejected.status).not.toBe(200);expect(rejected.msg).toContain('自提');
  expect((await state()).orders).toHaveLength(0);
 });
});
