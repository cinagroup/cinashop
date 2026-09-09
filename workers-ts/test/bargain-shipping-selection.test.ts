import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { orderCheckShipping } from '../src/controllers/api/v1/OrderController';
import { storeBargain, storeCart, storeProduct, systemStore, systemConfig } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { readBargainShippingSelection } from '../src/services/activity/BargainShippingSelection';
import { normalizeBargainShipping } from '../../view/common/bargainShipping';

describe('bargain owned checkout shipping selector',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture();f.app.post('/api/order/check_shipping',orderCheckShipping);
  f.config.store_func_status='1';f.config.store_self_mention='1';await f.db.update(systemStore).set({isStore:1});
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 const read=()=>readBargainShippingSelection(f.container,f.env,11,[10]);
 const state=async()=>({...await f.snapshot(),sequences:undefined,stores:await f.db.select().from(systemStore)});
 it.each(['UTC','Asia/Singapore','America/New_York'])('compares UTC activity dates independently of SQL session timezone %s',async timezone=>{
  await f.exec(`SET TIME ZONE '${timezone}'`);expect((await read()).shippingTypes).toEqual([1,2]);
  await f.db.update(storeBargain).set({stopTime:new Date(Date.now()-60_000)});await expect(read()).rejects.toThrow('失效');
 });
 it('preserves nullable legacy activity windows',async()=>{
  await f.db.update(storeBargain).set({startTime:null,stopTime:null});expect((await read()).shippingTypes).toEqual([1,2]);
 });
 it.each([1,2,3])('real HTTP quote omits a default address for non-logistics type %i',async productType=>{
  await f.db.update(storeProduct).set({productType});await f.db.update(storeCart).set({productType});
  const response=await f.app.request('/api/order/confirm',{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':'11'},body:JSON.stringify({cartIds:[10],type:2,bargainUserId:80,shippingType:1,addressId:0})},f.env);
  const body=await response.json() as {status:number;msg?:string;data:{addressInfo:unknown}};
  expect(body.status,body.msg).toBe(200);expect(body.data.addressInfo).toBeNull();
 });
 it.each([['1',[1]],['2',[2]],['3',[1]],['1,3',[1]],['1,2',[1,2]],['',[1,2]]] as const)('reads activity delivery=%s instead of opposite base rule',async(deliveryType,shippingTypes)=>{
  await f.db.update(storeBargain).set({deliveryType});await f.db.update(storeProduct).set({deliveryType:'wrong'});
  const before=await state();const r=await f.app.request('/api/order/check_shipping',{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':'11'},body:JSON.stringify({cartIds:[10],view:'bargain'})},f.env);
  expect(r.headers.get('cache-control')).toBe('private, no-store');const body=await r.json() as {status:number;data:unknown};expect(body.status).toBe(200);
  const parsed=normalizeBargainShipping(body.data,[10]);expect(parsed.shippingTypes).toEqual(shippingTypes);expect(parsed.requiresAddress).toBe(true);
  expect(parsed.stores).toHaveLength(shippingTypes.includes(2 as never)?1:0);expect(await state()).toEqual(before);
 });
 it.each(['store_func_status','store_self_mention'])('removes pickup when global flag %s is off without enabling delivery for pickup-only activity',async key=>{
  await f.db.update(storeBargain).set({deliveryType:'2'});await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,key));expect(await read()).toMatchObject({methods:[],shippingTypes:[],stores:[],type:0});
 });
 it.each([{isStore:0},{isDel:1},{isShow:0}])('does not expose unusable pickup stores %j',async patch=>{
  await f.db.update(systemStore).set(patch);expect((await read()).shippingTypes).toEqual([1]);expect((await read()).stores).toEqual([]);
 });
 it('restricts store-owned products to their own eligible store, never a different active store',async()=>{
  await f.db.insert(systemStore).values({id:2,name:'所属门店',isShow:1,isStore:1});await f.db.update(storeProduct).set({type:1,relationId:2});
  expect((await read()).stores.map(s=>s.id)).toEqual([2]);await f.db.update(systemStore).set({isStore:0}).where(eq(systemStore.id,2));
  expect((await read()).shippingTypes).toEqual([1]);
 });
 it.each([1,2,3,4])('preserves product type %i logistics requirements',async productType=>{
  await f.db.update(storeProduct).set({productType});await f.db.update(storeBargain).set({deliveryType:'2'});
  expect(await read()).toMatchObject({shippingTypes:productType===4?[2]:[1],requiresAddress:false});
 });
 it.each([{isDel:1},{status:0},{deliveryType:'1,x'},{startTime:new Date('2099-01-01')},{stopTime:new Date('2000-01-01')}])('rejects unavailable activity %j',async patch=>{
  await f.db.update(storeBargain).set(patch);const before=await state();await expect(read()).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it.each([{uid:22},{isPay:1},{isDel:1},{status:0},{type:0},{activityId:999},{cartNum:0}])('rejects foreign/stale carts %j',async patch=>{
  await f.db.update(storeCart).set(patch);await expect(read()).rejects.toThrow('失效');
 });
 it.each([[],[10,10],[0],[2147483648]].map(ids=>[ids]))('rejects malformed selection %j',async ids=>{
  await expect(readBargainShippingSelection(f.container,f.env,11,ids)).rejects.toThrow('参数');
 });
 it('rejects mixed activities and unauthenticated requests rather than merging their methods',async()=>{
  await f.db.insert(storeBargain).values({id:41,productId:70,status:1,startTime:f.startTime,stopTime:f.stopTime,deliveryType:'2'});
  await f.db.insert(storeCart).values({id:11,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:41,isNew:1,status:1});
  await expect(readBargainShippingSelection(f.container,f.env,11,[10,11])).rejects.toThrow('分开');
  const r=await f.app.request('/api/order/check_shipping',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"cartIds":[10],"view":"bargain"}'},f.env);
  expect((await r.json() as {status:number}).status).not.toBe(200);expect(r.headers.get('cache-control')).toBe('private, no-store');
 });
 it('does not accept legacy, foreign-cart, inconsistent or unbounded client response shapes',async()=>{
  const valid=await read();expect(normalizeBargainShipping(valid,[10])).toMatchObject({kind:'bargain',cartIds:[10]});
  for(const patch of [{kind:undefined},{cartIds:[11]},{shippingTypes:[2]},{methods:['1']},{stores:[]},{stores:Array(201).fill(valid.stores[0])},{requiresAddress:0}]) {
   expect(()=>normalizeBargainShipping({...valid,...patch},[10])).toThrow('响应无效');
  }
 });
});
