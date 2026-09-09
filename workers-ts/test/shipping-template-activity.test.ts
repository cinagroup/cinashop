import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { StoreOrderCreateService,type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { storeBargain,storeCombination,storeIntegral,storePink,storeDiscounts,storeDiscountsProducts,storeProduct,storeProductAttrValue,storeCart,shippingTemplates,shippingTemplatesRegion,shippingTemplatesNoDelivery,storeOrderCartInfo,storeOrderStatus,printDocument } from '../src/models/schema';

describe('activity checkout consumes authoritative shipping template rules',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{
  f=await createBargainSelectionFixture([storeCombination,storeIntegral,storePink,storeDiscounts,storeDiscountsProducts,storeOrderCartInfo,storeOrderStatus,printDocument]);
  await f.db.update(storeBargain).set({freight:3,tempId:10,deliveryType:'1'});
  await f.db.insert(storeCombination).values({id:50,productId:70,freight:3,tempId:10,stock:8,quota:8,onceNum:5,num:10});
  await f.db.insert(storeIntegral).values({id:60,productId:70,freight:3,tempId:10,stock:8,quota:8});
  await f.db.insert(storeProduct).values({id:71,storeName:'套餐第二件',stock:8,isShow:1,freight:3,tempId:10});
  await f.db.insert(storeDiscounts).values({id:90,freeShipping:1});
  await f.db.insert(storeDiscountsProducts).values([{id:100,discountId:90,productId:70,tempId:10},{id:101,discountId:90,productId:71,tempId:10}]);
  await f.db.insert(storeProductAttrValue).values([
   {id:20,productId:50,type:3,unique:'ship0050',suk:'红色,大号',price:'3.00',stock:8,quota:8},
   {id:21,productId:60,type:4,unique:'ship0060',suk:'红色,大号',price:'4.00',stock:8,quota:8},
   {id:22,productId:71,type:0,unique:'ship0071',suk:'第二件',price:'5.00',stock:8},
   {id:23,productId:100,type:5,unique:'ship0100',suk:'红色,大号',price:'3.00',stock:8},
   {id:24,productId:101,type:5,unique:'ship0101',suk:'第二件',price:'4.00',stock:8},
  ]);
 },30_000);
 afterEach(async()=>{await f?.close();});
 const prepare=async(type:number):Promise<CreateOrderParams>=>{
  const activityId=type===2?40:type===3?50:type===4?60:90;
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type,activityId,bargainUserId:type===2?80:0,isNew:1,status:1});
  if(type===5)await f.db.insert(storeCart).values({id:11,uid:11,productId:71,productAttrUnique:'ship0071',cartNum:1,type,activityId,isNew:1,status:1});
  return {uid:11,key:'activity_template',cartIds:type===5?[10,11]:[10],type,...(type===2?{bargainUserId:80}:{}),...(type===3?{combinationId:50}:{}),shippingType:1,cityId:101,userAddress:'隔离地址',realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'};
 };
 const create=(params:CreateOrderParams,change?:()=>Promise<unknown>)=>StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>{await change?.();return params.key;}},params);
 const state=async()=>({...await f.snapshot(),sequences:undefined,details:await f.db.select().from(storeOrderCartInfo),combination:await f.db.select().from(storeCombination),integral:await f.db.select().from(storeIntegral)});
 it.each([2,3,4,5])('preserves real type=%i checkout including package free postage',async type=>{
  const p=await prepare(type);expect((await new StoreOrderCreateService(f.container,f.env).quoteOrder(p)).payPostageCents).toBe(type===5?0:600);
  await create(p);expect((await state()).orders[0]).toMatchObject({type,payPostage:type===5?'0.00':'6.00'});
 });
 it.each([2,3,4,5])('rolls back actual type=%i order if the template changed after quote',async type=>{
  const p=await prepare(type),before=await state();await expect(create(p,async()=>{await f.db.update(shippingTemplatesRegion).set({firstPrice:'9.00'});})).rejects.toThrow('配送');expect(await state()).toEqual(before);
 });
 it.each([3,4])('guards activity-specific template rebinding at type=%i inventory admission',async type=>{
  const p=await prepare(type);let expected:Awaited<ReturnType<typeof state>>|undefined;
  await expect(create(p,async()=>{
   if(type===3)await f.db.update(storeCombination).set({tempId:11});else await f.db.update(storeIntegral).set({tempId:11});expected=await state();
  })).rejects.toThrow();expect(await state()).toEqual(expected);
 });
 it('does not let package free shipping bypass a component no-delivery region',async()=>{
  const p=await prepare(5);await f.db.update(shippingTemplates).set({noDelivery:1});await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:101});
  const before=await state();await expect(create(p)).rejects.toThrow('不支持配送');expect(await state()).toEqual(before);
 });
 it('enforces no-delivery in actual bargain HTTP confirmation and recalculation',async()=>{
  const p=await prepare(2),before=await state();
  const request=async(path:string)=>{const response=await f.app.request(path,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':'11'},body:JSON.stringify({...p,addressId:11})},f.env);return response.json() as Promise<{status:number;msg:string;data:{orderKey:string}}>;};
  const confirmed=await request('/api/order/confirm');expect(confirmed.status).toBe(200);
  await f.db.update(shippingTemplates).set({noDelivery:1}).where(eq(shippingTemplates.id,10));await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:101});
  expect(await request('/api/order/computed/'+confirmed.data.orderKey)).toMatchObject({status:400,msg:expect.stringContaining('不支持配送')});
  const after=await state();expect(after.orders).toEqual(before.orders);expect(after.carts).toEqual(before.carts);
 });
});
