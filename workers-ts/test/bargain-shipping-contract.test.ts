import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { storeCart, storeBargain, storeProduct, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe('bargain shipping quote and actual creation contract',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 const params:CreateOrderParams={uid:11,key:'shipping_contract',cartIds:[10],type:2,bargainUserId:80,shippingType:2,storeId:1,realName:'隔离配送',userPhone:'00000000000',userIp:'127.0.0.1'};
 beforeEach(async()=>{f=await createBargainSelectionFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);
  await f.db.update(systemStore).set({isStore:1}).where(eq(systemStore.id,1));
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,details:await f.db.select().from(storeOrderCartInfo),statuses:await f.db.select().from(storeOrderStatus),prints:await f.db.select().from(printDocument)});
 const create=(input=params,afterQuote?:()=>Promise<void>)=>StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>{await afterQuote?.();return 'shipping_contract';}},input);
 it.each([['1',2],['3',2],['1,3',2],['2',1]] as const)('rejects delivery_type=%s / shippingType=%i in quote and create without writes',async(deliveryType,shippingType)=>{
  await f.db.update(storeBargain).set({deliveryType}).where(eq(storeBargain.id,40));
  const before=await state(),input={...params,shippingType};
  await expect(new StoreOrderCreateService(f.container,f.env).quoteOrder(input)).rejects.toThrow('配送');
  await expect(create(input)).rejects.toThrow('配送');expect(await state()).toEqual(before);
 });
 it.each([['1',1],['3',1],['2',2],['1,2',1],['1,2',2],['',1],['',2]] as const)('allows delivery_type=%s / shippingType=%i and cancellation restores inventory',async(deliveryType,shippingType)=>{
  await f.db.update(storeBargain).set({deliveryType});
  // Activity delivery methods override the base-product methods, not their intersection.
  await f.db.update(storeProduct).set({deliveryType:shippingType===2?'1':'2'});
  const input={...params,shippingType};expect((await new StoreOrderCreateService(f.container,f.env).quoteOrder(input)).payCents).toBe(200);
  await create(input);expect((await state()).orders[0]).toMatchObject({shippingType,payPrice:'2.00'});
  await cancelStoreOrder(f.container,{uid:11,orderId:'shipping_contract'});expect((await state()).bargains[0]).toMatchObject({stock:8,quota:8,sales:0});
 });
 it.each(['4','0','1,x','1,,2','[1,2]'])('rejects malformed nonempty delivery configuration %s',async deliveryType=>{
  await f.db.update(storeBargain).set({deliveryType});const before=await state();
  await expect(create()).rejects.toThrow('配送');expect(await state()).toEqual(before);
 });
 it.each([{deliveryType:'1'},{freight:2},{postage:'8.00'},{tempId:10}])('rejects a shipping rule changed after the real pricing path: %j',async patch=>{
  await f.db.update(storeBargain).set({deliveryType:'1,2'});const before=await state();
  await expect(create(params,async()=>{await f.db.update(storeBargain).set(patch);})).rejects.toThrow('配送');
  const after=await state();expect(after).toEqual({...before,bargains:before.bargains.map(r=>({...r,...patch}))});
 });
 it('allows an unrelated title edit after quote and keeps an existing idempotent order after later rule changes',async()=>{
  await f.db.update(storeBargain).set({deliveryType:'2'});
  await create(params,async()=>{await f.db.update(storeBargain).set({title:'不改配送'});});
  await f.db.update(storeBargain).set({deliveryType:'1'});const before=await state();
  expect(await create()).toEqual({orderId:'shipping_contract',key:params.key});expect(await state()).toEqual(before);
 });
 it('enforces the rule in actual HTTP confirmation and recalculation without consuming carts',async()=>{
  const request=async(path:string,body:object)=>{
   const response=await f.app.request(path,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':'11'},body:JSON.stringify(body)},f.env);
   return response.json() as Promise<{status:number;msg:string;data:{orderKey:string}}>;
  };
  await f.db.update(storeBargain).set({deliveryType:'1'});
  const rejected=await request('/api/order/confirm',params);expect(rejected.status).not.toBe(200);expect(rejected.msg).toContain('配送');
  await f.db.update(storeBargain).set({deliveryType:'2'});
  const confirmed=await request('/api/order/confirm',params);expect(confirmed.status).toBe(200);expect(confirmed.data.orderKey).toBeTruthy();
  await f.db.update(storeBargain).set({deliveryType:'1'});
  const computed=await request('/api/order/computed/'+confirmed.data.orderKey,params);expect(computed.status).not.toBe(200);expect(computed.msg).toContain('配送');
  const after=await state();expect(after.orders).toHaveLength(0);expect(after.carts[0].isPay).toBe(0);expect(after.bargains[0].stock).toBe(8);
 });
 it.each([1,2,3])('preserves non-logistics product type %i semantics despite inherited delivery_type=2',async productType=>{
  await f.db.update(storeProduct).set({productType});await f.db.update(storeCart).set({productType});await f.db.update(storeBargain).set({productType,deliveryType:'2'});
  const input={...params,shippingType:1};expect((await new StoreOrderCreateService(f.container,f.env).quoteOrder(input)).payCents).toBe(200);
  await expect(new StoreOrderCreateService(f.container,f.env).quoteOrder(params)).rejects.toThrow('虚拟商品无需到店自提');
 });
});
