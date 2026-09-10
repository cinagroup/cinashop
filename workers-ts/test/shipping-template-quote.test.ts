import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { shippingTemplates,shippingTemplatesRegion,shippingTemplatesFree,shippingTemplatesNoDelivery,cityArea,storeOrderCartInfo,storeOrderStatus,printDocument,storeProduct,storeProductAttrValue,storeCart } from '../src/models/schema';

describe('shipping template authoritative quote and actual order',()=>{
 let f:Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
 const params:CreateOrderParams={uid:11,key:'template_quote',cartIds:[1],shippingType:1,addressId:11,cityId:101,province:'本地省',userAddress:'隔离地址',realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'};
 beforeEach(async()=>{f=await createPcCheckoutQuoteFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));},30_000);
 afterEach(async()=>{await f?.close();});
 const quote=()=>new StoreOrderCreateService(f.container,f.env).quoteOrder(params);
 const create=(change?:()=>Promise<unknown>)=>StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>{await change?.();return 'template_quote';}},params);
 it('does not let whole-order free shipping bypass no-delivery',async()=>{
  await f.setConfig({ whole_free_shipping: '1' });await f.setConfig({ store_free_postage: '1' });
  await f.db.update(shippingTemplates).set({noDelivery:1}).where(eq(shippingTemplates.id,10));
  await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:101});
  const before=await f.snapshot();await expect(quote()).rejects.toThrow('不支持配送');await expect(create()).rejects.toThrow('不支持配送');expect(await f.snapshot()).toEqual(before);
 });
 it('rejects a template belonging to another supplier in quote and create',async()=>{
  await f.db.update(shippingTemplates).set({ownerType:2,relationId:5});const before=await f.snapshot();
  await expect(quote()).rejects.toThrow('所属');await expect(create()).rejects.toThrow('所属');expect(await f.snapshot()).toEqual(before);
 });
 it.each(['fee','status','deleted','owner','free','noDelivery','city'] as const)('rejects %s changed after actual pricing without consuming business resources',async kind=>{
  expect((await quote()).payPostageCents).toBe(600);const before=await f.snapshot();
  await expect(create(async()=>{
   if(kind==='fee')return f.db.update(shippingTemplatesRegion).set({firstPrice:'9.00'});
   if(kind==='status')return f.db.update(shippingTemplates).set({status:0});
   if(kind==='deleted')return f.db.update(shippingTemplates).set({isDel:1});
   if(kind==='owner')return f.db.update(shippingTemplates).set({ownerType:2,relationId:5});
   if(kind==='free'){await f.db.update(shippingTemplates).set({appoint:1});return f.db.insert(shippingTemplatesFree).values({tempId:10,cityId:101,number:'1',price:'1'});}
   if(kind==='noDelivery'){await f.db.update(shippingTemplates).set({noDelivery:1});return f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:101});}
   return f.db.update(cityArea).set({path:'/102/'}).where(eq(cityArea.id,101));
  })).rejects.toThrow(kind==='city'?'收货地址区域':'配送');expect(await f.snapshot()).toEqual(before);
 });
 it('preserves zero raw/pay postage for allowed whole-order waivers',async()=>{
  await f.setConfig({ whole_free_shipping: '1' });await f.setConfig({ store_free_postage: '1' });expect(await quote()).toMatchObject({totalPostageCents:0,payPostageCents:0,payCents:2000});
  await create();expect((await f.snapshot()).orders[0]).toMatchObject({totalPostage:'0.00',payPostage:'0.00',payPrice:'20.00'});
 });
 it.each([1,2,3])('enforces nationwide no-delivery for freight=%i even with a known city',async freight=>{
  await f.db.update(storeProduct).set({freight});await f.db.update(shippingTemplates).set({noDelivery:1});
  await f.db.insert(shippingTemplatesNoDelivery).values({tempId:10,cityId:0,provinceId:0,value:'[0]'});await expect(quote()).rejects.toThrow('不支持配送');
 });
 it('checks no-delivery on the legacy default template 1',async()=>{
  await f.db.update(storeProduct).set({tempId:0});await f.db.insert(shippingTemplates).values({id:1,noDelivery:1});
  await f.db.insert(shippingTemplatesNoDelivery).values({tempId:1,cityId:101});await expect(quote()).rejects.toThrow('不支持配送');
 });
 it('rejects missing template and unknown city rather than using an unprotected fallback',async()=>{
  await f.db.update(storeProduct).set({tempId:99});await expect(quote()).rejects.toThrow('模板');
  await f.db.update(storeProduct).set({tempId:10});await f.db.delete(cityArea).where(eq(cityArea.id,101));await expect(quote()).rejects.toThrow('收货地址区域不存在');
 });
 it('accepts same-owner supplier templates',async()=>{
  await f.db.update(storeProduct).set({type:2,relationId:5});await f.db.update(shippingTemplates).set({ownerType:2,relationId:5});
  expect((await quote()).payPostageCents).toBe(600);
 });
 it('allows harmless metadata changes and preserves existing-order idempotency',async()=>{
  await create(async()=>{await f.db.update(shippingTemplates).set({name:'新名称',sort:9});});
  await f.db.update(shippingTemplates).set({status:0});const before=await f.snapshot();expect(await create()).toEqual({orderId:'template_quote',key:params.key});expect(await f.snapshot()).toEqual(before);
 });
 it.each(['owner','binding','weight','quantity'] as const)('atomically guards changed %s inputs at existing inventory/cart writes',async kind=>{
  let expected:Awaited<ReturnType<typeof f.snapshot>>|undefined;
  await expect(create(async()=>{
   if(kind==='owner')await f.db.update(storeProduct).set({type:2,relationId:5});
   if(kind==='binding')await f.db.update(storeProduct).set({tempId:11});
   if(kind==='weight')await f.db.update(storeProductAttrValue).set({weight:'3.00'});
   if(kind==='quantity')await f.db.update(storeCart).set({cartNum:3});
   expected=await f.snapshot();
  })).rejects.toThrow('配送');expect(await f.snapshot()).toEqual(expected);
 });
 it('fails closed when a template child set exceeds the bounded snapshot',async()=>{
  await f.exec("INSERT INTO shipping_templates_region(id,template_id,region_name) SELECT n+100,10,'isolated' FROM generate_series(1,10001) n");
  await expect(quote()).rejects.toThrow('规则过多');
 });
 it('guards an initially unbound fixed-price product being rebound after quote',async()=>{
  await f.db.update(storeProduct).set({freight:2,tempId:0,postage:'2.00'});expect((await quote()).payPostageCents).toBe(400);
  let expected:Awaited<ReturnType<typeof f.snapshot>>|undefined;
  await expect(create(async()=>{await f.db.update(storeProduct).set({freight:3,tempId:10});expected=await f.snapshot();})).rejects.toThrow('配送');
  expect(await f.snapshot()).toEqual(expected);
 });
 it('preserves explicitly unbound fixed/free postage without requiring a nonexistent default template',async()=>{
  await f.db.update(storeProduct).set({freight:2,tempId:0,postage:'2.00'});await create();expect((await f.snapshot()).orders[0].payPostage).toBe('4.00');
 });
});
