import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderOutbox, storeDeliveryOrder, storePink, storeService, systemStore, user, userBill,orderNotificationDelivery,type OrderDeliveryNoticeOutboxPayload } from '../src/models/schema';
import { customerCityDeliveryJob as jobs, customerCityDeliveryAttempt as attempts, customerCityDeliveryBinding as bindings } from '../src/models/schema/customer_city_delivery';
import { assertCustomerCityDeliveryReady, installCustomerCityDelivery } from '../src/migrations/customerCityDelivery';
import { CustomerCityDeliveryProvider, type CustomerCityIssueInput } from '../src/services/delivery/CustomerCityDeliveryProvider';
import { CityDeliverySettingsResolver } from '../src/services/delivery/CityDeliverySettingsResolver';
import { CityDeliveryCallbackService } from '../src/services/delivery/CityDeliveryCallbackService';
import { normalizeDadaCityDeliveryQuery } from '../src/services/delivery/DadaCityDeliveryCallback';
import { CustomerCityDeliveryService } from '../src/services/customer-work/CustomerCityDeliveryService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { CustomerWorkFulfillmentService } from '../src/services/customer-work/CustomerWorkFulfillmentService';
import { customerCityNoticeIsActive,enqueueOrderDeliveryNoticeEvent } from '../src/services/order/OrderNotificationOutboxService';
import { OrderNotificationDeliveryService,isOrderNotificationDeliveryMessage } from '../src/services/order/OrderNotificationDeliveryService';
import { isOrderNotificationOutboxMessage } from '../src/services/order/OrderOutboxService';
import { customerCityDeliveryFixture } from './helpers/customerCityDeliveryFixture';

type Fixture=Awaited<ReturnType<typeof customerCityDeliveryFixture>>;
const response=(result:unknown,code=0,status='success')=>new Response(JSON.stringify({code,status,result}),{headers:{'Content-Type':'application/json'}});
interface Call { url:string;body:Record<string,unknown>;biz:Record<string,unknown> }
function dadaFetch(overrides:Partial<Record<'cities'|'quote'|'issue'|'query',(call:Call)=>Promise<Response>|Response>>={}){
 const calls:Call[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input),body=JSON.parse(String(init?.body)) as Record<string,unknown>,biz=JSON.parse(String(body.body)) as Record<string,unknown>,call={url,body,biz};calls.push(call);
  expect(init?.method).toBe('POST');expect(url.startsWith('https://newopen.imdada.cn/api/')).toBe(true);
  const {signature,...fields}=body,material=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+v).join('');
  expect(signature).toBe(createHash('md5').update('owned-dada-secret'+material+'owned-dada-secret').digest('hex').toUpperCase());
  if(url.endsWith('/api/cityCode/list'))return overrides.cities?.(call)??response([{cityName:'上海',cityCode:'021'}]);
  if(url.endsWith('/api/order/queryDeliverFee'))return overrides.quote?.(call)??response({deliveryNo:'actual-provider-delivery-001',distance:1200,fee:8.5});
  if(url.endsWith('/api/order/addAfterQuery'))return overrides.issue?.(call)??response('');
  if(url.endsWith('/api/order/status/query'))return overrides.query?.(call)??response({order_id:biz.order_id,order_status:2,update_time:Math.floor(Date.now()/1000)});
  throw Error('Unexpected controlled provider endpoint '+url);
 });
 vi.stubGlobal('fetch',fetch);return{calls,fetch};
}
const jobRow=async(f:Fixture,id:number)=>(await f.db.select().from(jobs).where(eq(jobs.id,id)))[0]!;
const orderRow=async(f:Fixture,id=1)=>(await f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0]!;
async function event(f:Fixture,db:Parameters<Fixture['city']>[0],providerOrderId:string,status:number,time=Math.floor(Date.now()/1000)){
 const service=new CityDeliveryCallbackService(createContainerFromDb(db),f.env);
 const received=await service.receive(normalizeDadaCityDeliveryQuery({order_status:status,update_time:time},{providerOrderId,expectedClientId:'owned-dada-client',observedAt:time}));
 const outcome=await service.processMessage({action:'processCityDeliveryCallbackOutbox',outboxId:received.outboxId,eventId:received.eventId,replayKey:received.replayKey});return{outcome,received};
}

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer city durable chain with actual native PG16 LOGIN and controlled provider transport',()=>{
 let f:Fixture;
 beforeAll(async()=>{f=await customerCityDeliveryFixture();},60000);
 afterAll(async()=>{vi.unstubAllGlobals();await f?.close();},60000);
 beforeEach(async()=>{vi.unstubAllGlobals();await f.reset();});
 it('requires the exact full catalog and immutable ordinary runtime identity columns',async()=>{
  await f.app(async(db,role,peer)=>{
   await assertCustomerCityDeliveryReady(db);
   const [p]=await peer.exec("SELECT current_user=session_user AS real_login,has_column_privilege(current_user,'customer_city_delivery_job','intent','UPDATE') AS mutate_intent,has_column_privilege(current_user,'customer_city_delivery_attempt','job_id','UPDATE') AS mutate_attempt,has_column_privilege(current_user,'customer_city_delivery_binding','order_id','UPDATE') AS mutate_binding,has_table_privilege(current_user,'customer_city_delivery_job','DELETE') AS erase,has_schema_privilege(current_user,'public','CREATE') AS ddl");
   expect(p).toEqual({real_login:true,mutate_intent:false,mutate_attempt:false,mutate_binding:false,erase:false,ddl:false});
   await expect(installCustomerCityDelivery(db,{maintenance:true})).rejects.toThrow();
   expect(role).toMatch(/^cinashop_runtime_/);
  });
  await expect(installCustomerCityDelivery(f.db,{maintenance:true})).rejects.toThrow('fresh');
 });
 it('reports actual provider, station and reviewed deployment readiness without network calls',async()=>{
  const controlled=dadaFetch();
  await f.app(async db=>{const s=await withTx(createContainerFromDb(db),tx=>f.city(db).bootstrap(tx,f.identity()));expect(s.schema_ready).toBe(true);expect(s.station).toMatchObject({type:0,relation_id:0,name:'真实平台发件人',city_name:'上海市'});expect(s.providers[0]).toMatchObject({provider:'dada',available:true,reasons:[]});expect(s.providers[1]).toMatchObject({provider:'uu',available:false});expect(s.providers[1]!.reasons).toContain('uu_origin_binding_contract_unverified');expect(s.job).toBe(null);});
  expect(controlled.calls).toHaveLength(0);
 });
 it('persists the original UUID and PENDING intent before calling Dada; acceptance records actual delivery and exact binding',async()=>{
  const controlled=dadaFetch(),key=randomUUID();
  await f.app(async db=>{
   const admitted=await f.admit(db,key);expect(admitted).toMatchObject({request_key:key,status:'PENDING',delivery_status:null,may_retry:false});expect(controlled.calls).toHaveLength(0);expect((await orderRow(f)).status).toBe(0);
   await f.city(db).process(admitted.job_id);const result=await f.city(db).outcome(f.actor(),admitted.job_id);expect(result).toMatchObject({status:'ADMITTED',delivery_status:0});
   expect(controlled.calls).toHaveLength(3);expect(controlled.calls[1]!.biz).toMatchObject({origin_id:result.provider_order_id,shop_no:'plat_delivery_city_shop_001',city_code:'021',cargo_weight:2.5,receiver_name:'实际收件人',receiver_phone:'13900000201'});
   expect(controlled.calls[1]!.biz.callback).toBe('https://city-fixture.example.com/api/city_delivery/notify?provider=dada&token='+f.env.DADA_CALLBACK_TOKEN);
   expect(controlled.calls[2]!.biz).toEqual({deliveryNo:'actual-provider-delivery-001'});
   expect(await orderRow(f)).toMatchObject({status:1,deliveryType:'city_delivery',deliveryId:'actual-provider-delivery-001',deliveryName:'达达配送'});
   const [a]=await f.db.select().from(attempts),[binding]=await f.db.select().from(bindings),[delivery]=await f.db.select().from(storeDeliveryOrder);
   expect(a).toMatchObject({jobId:admitted.job_id,requestKey:key,phase:'ACCEPTED'});expect(binding).toMatchObject({jobId:admitted.job_id,attemptId:a!.id,deliveryOrderId:delivery!.id,orderId:1,rootOrderId:1,customerUid:201,storeId:0,supplierId:0,active:1});expect(delivery).toMatchObject({orderId:result.provider_order_id,deliveryNo:'actual-provider-delivery-001',type:0,relationId:0,fee:'8.50'});
   expect((await f.db.select().from(storeOrderOutbox))[0]?.eventType).toBe('order.delivery.notice');
  });
 });
 it('compensates a genuinely pending task through scheduled dispatch and preserves legacy all-absent behavior',async()=>{
  const controlled=dadaFetch();await f.app(async db=>{const a=await f.admit(db,randomUUID());expect(await f.city(db).dispatchPending()).toBe(1);expect((await jobRow(f,a.job_id)).status).toBe('ADMITTED');expect(await f.city(db).dispatchPending()).toBe(0);
   const names=['customer_city_delivery_job','customer_city_delivery_attempt','customer_city_delivery_binding'];
   await f.exec(names.map(n=>`ALTER TABLE ${n} RENAME TO ${n}_owned_hidden`).join(';'));
   try{expect(await f.city(db).dispatchPending()).toBe(0);}finally{await f.exec(names.map(n=>`ALTER TABLE ${n}_owned_hidden RENAME TO ${n}`).join(';'));}
   await assertCustomerCityDeliveryReady(db);await f.exec('ALTER TABLE customer_city_delivery_binding RENAME TO customer_city_delivery_binding_owned_hidden');
   try{await expect(f.city(db).dispatchPending()).rejects.toThrow('partial');}finally{await f.exec('ALTER TABLE customer_city_delivery_binding_owned_hidden RENAME TO customer_city_delivery_binding');}
   await assertCustomerCityDeliveryReady(db);
  });expect(controlled.calls).toHaveLength(3);
 });
 it('replays one identical UUID without a second publication and rejects a different immutable hash',async()=>{
  const controlled=dadaFetch(),key=randomUUID();await f.app(async db=>{const a=await f.admit(db,key);await f.city(db).process(a.job_id);expect((await f.admit(db,key)).job_id).toBe(a.job_id);await f.city(db).process(a.job_id);await expect(f.admit(db,key,f.identity(),{request_hash:'b'.repeat(64)})).rejects.toThrow('原始请求');});expect(controlled.calls).toHaveLength(3);expect(await f.db.select().from(jobs)).toHaveLength(1);
 });
 it('uses actual store and supplier stations for global customer physical children',async()=>{
  await f.db.update(storeOrder).set({pid:-1,supplierAllocationStatus:2}).where(eq(storeOrder.id,1));await f.db.insert(storeOrder).values(f.order(2,{pid:1,storeId:77,supplierId:88}));await f.db.insert(storeOrderCartInfo).values(f.cart(2));
  const controlled=dadaFetch();await f.app(async db=>{const id=f.identity(2,77,88,1,1),ready=await withTx(createContainerFromDb(db),tx=>f.city(db).bootstrap(tx,id));expect(ready.station).toMatchObject({type:1,relation_id:77,address:'上海市真实门店地址'});const a=await f.admit(db,randomUUID(),id);await f.city(db).process(a.job_id);expect((await f.city(db).outcome(f.actor(),a.job_id)).status).toBe('ADMITTED');});expect(controlled.calls[1]!.biz.shop_no).toBe('real-store-station-77');expect(await orderRow(f,2)).toMatchObject({uid:201,storeId:77,supplierId:88,status:1});
 });
 it('fulfills shippingType3 through the complete original customer wire for platform, store and supplier stations',async()=>{
  for(const station of[{storeId:0,supplierId:0,type:0,relationId:0,shop:'plat_delivery_city_shop_001'},{storeId:77,supplierId:0,type:1,relationId:77,shop:'real-store-station-77'},{storeId:0,supplierId:88,type:2,relationId:88,shop:'real-supplier-station-88'}]){
   await f.reset();await f.db.update(storeOrder).set({shippingType:3,storeId:station.storeId,supplierId:station.supplierId}).where(eq(storeOrder.id,1));const controlled=dadaFetch();
   await f.app(async db=>{const service=new CustomerWorkFulfillmentService(createContainerFromDb(db),f.env),b=await service.bootstrap(f.actor(),'customer-order-1',{}),o=b.data.order;
    expect(b.data.actions.city_delivery.available).toBe(true);expect(b.data.actions.electronic_waybill.available).toBe(false);expect(b.data.readiness.city.station).toMatchObject({type:station.type,relation_id:station.relationId});
    const context={actor:f.actor(),request_key:randomUUID()},input={version:'customer-work-operation-v1' as const,scope_key:b.scope_key,order_id:o.id,expected_order_revision:o.order_revision,expected_fulfillment_revision:o.fulfillment_revision,payload:{type:2,delivery_type:2,station_type:1,cargo_weight:'2.50',delivery_remark:'真实配送备注'}};
    const result=await service.delivery(context,input);expect(result.receipt).toMatchObject({outcome:'provider-admitted',kind:'city_delivery',request_key:context.request_key});
    const dynamic=await service.operationOutcome(f.actor(),context.request_key);expect(dynamic.receipt).toEqual(result.receipt);expect(dynamic.city_job).toMatchObject({status:'ADMITTED',delivery_status:0,request_key:context.request_key});
    expect(await orderRow(f)).toMatchObject({shippingType:3,status:1,uid:201,storeId:station.storeId,supplierId:station.supplierId,deliveryType:'city_delivery'});expect((await f.db.select().from(storeDeliveryOrder))[0]).toMatchObject({type:station.type,relationId:station.relationId,deliveryNo:'actual-provider-delivery-001'});
    expect((await service.delivery(context,input)).replayed).toBe(true);expect(controlled.calls).toHaveLength(3);expect(controlled.calls[1]!.biz.shop_no).toBe(station.shop);
   });
  }
 },20000);
 it('does not register or guess a missing store station and rejects virtual/pickup delivery',async()=>{
  const controlled=dadaFetch();await f.db.update(storeOrder).set({storeId:77}).where(eq(storeOrder.id,1));await f.db.update(systemStore).set({cityShopId:''}).where(eq(systemStore.id,77));
  await f.app(async db=>{const id=f.identity(1,77),s=await withTx(createContainerFromDb(db),tx=>f.city(db).bootstrap(tx,id));expect(s.providers[0]!.reasons).toContain('station_registration_unavailable');await expect(f.admit(db,randomUUID(),id)).rejects.toThrow('未就绪');});
  await f.db.update(systemStore).set({cityShopId:'real-store-station-77'}).where(eq(systemStore.id,77));
  await f.app(async db=>{for(const values of[{productType:3},{productType:1},{shippingType:2}]){await f.db.update(storeOrder).set({productType:0,shippingType:1,...values}).where(eq(storeOrder.id,1));await expect(f.admit(db,randomUUID(),f.identity(1,77))).rejects.toThrow('不支持');}});expect(controlled.calls).toHaveLength(0);
 });
 it('rejects failed pink, future presale and open refunds before admission or any provider call',async()=>{
  const controlled=dadaFetch();await f.app(async db=>{
   await f.db.update(storeOrder).set({type:3,pinkId:9}).where(eq(storeOrder.id,1));await f.db.insert(storePink).values({id:9,status:1});await expect(f.admit(db,randomUUID())).rejects.toThrow('拼团');
   await f.db.update(storeOrder).set({type:6}).where(eq(storeOrder.id,1));await f.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify({productInfo:{id:1,presale_end_time:Math.floor(Date.now()/1000)+3600}})}).where(eq(storeOrderCartInfo.id,1));await expect(f.admit(db,randomUUID())).rejects.toThrow('预售');
   await f.db.update(storeOrder).set({type:0}).where(eq(storeOrder.id,1));await f.db.insert(storeOrderRefund).values({id:1,storeOrderId:1,uid:201,orderId:'actual-open-refund',refundType:0});await expect(f.admit(db,randomUUID())).rejects.toThrow('售后');
  });expect(controlled.calls).toHaveLength(0);expect(await f.db.select().from(jobs)).toHaveLength(0);
 });
 it('validates selected carts and financial evidence before a split and uses the genuine split engine after acceptance',async()=>{
  const controlled=dadaFetch();await f.app(async db=>{
   for(const selected of[[{cart_id:'missing',cart_num:1}],[{cart_id:'cart-1',cart_num:4}],[{cart_id:'cart-1',cart_num:1},{cart_id:'cart-1',cart_num:1}]])await expect(f.admit(db,randomUUID(),f.identity(),{cart_ids:selected})).rejects.toThrow('商品或数量');
   expect(controlled.calls).toHaveLength(0);const a=await f.admit(db,randomUUID(),f.identity(),{cart_ids:[{cart_id:'cart-1',cart_num:1}]});await f.city(db).process(a.job_id);expect((await f.city(db).outcome(f.actor(),a.job_id)).status).toBe('ADMITTED');
   const all=await f.db.select().from(storeOrder).orderBy(storeOrder.id),binding=(await f.db.select().from(bindings))[0]!;expect(all.filter(o=>o.pid===1).map(o=>o.status).sort()).toEqual([0,1]);expect(all.filter(o=>o.pid===1).map(o=>Number(o.payPrice)).reduce((a,b)=>a+b,0)).toBe(30);expect(binding.orderId).not.toBe(1);expect(binding.rootOrderId).toBe(1);expect(binding.customerUid).toBe(201);
   expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
  });expect(controlled.calls).toHaveLength(3);
 });
 it('revokes queued work before transport after customer, password, account or expiry changes',async()=>{
  const controlled=dadaFetch();await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,1));await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');expect(await f.db.select().from(attempts)).toHaveLength(0);});expect(controlled.calls).toHaveLength(0);
  for(const changed of['password','account','expiry']){await f.reset();await f.app(async db=>{const a=await f.admit(db,randomUUID());if(changed==='password')await f.db.update(user).set({pwd:'changed-owned-password'}).where(eq(user.uid,101));else if(changed==='account')await f.db.update(user).set({status:0}).where(eq(user.uid,101));else await f.db.update(jobs).set({actorExpiresAt:1}).where(eq(jobs.id,a.job_id));await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');});}expect(controlled.calls).toHaveLength(0);
 },20000);
 it('checks the fresh customer grant after quote and refuses create after a midway revoke',async()=>{
  const controlled=dadaFetch({quote:async()=>{await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,1));return response({deliveryNo:'actual-provider-delivery-001',distance:1200,fee:8.5});}});await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');expect((await f.db.select().from(attempts))[0]?.phase).toBe('REVOKED');});expect(controlled.calls.map(c=>c.url)).toHaveLength(2);expect((await orderRow(f)).status).toBe(0);
 });
 it('revalidates the exact registered station after quote and before either queued or immediate create',async()=>{
  for(const change of[{isShow:0},{cityShopId:'different-real-registration'},{phone:'13900000778'},{detailedAddress:'上海市另一真实地址'}]){
   await f.reset();await f.db.update(storeOrder).set({storeId:77}).where(eq(storeOrder.id,1));
   const controlled=dadaFetch({quote:async()=>{await f.db.update(systemStore).set(change).where(eq(systemStore.id,77));return response({deliveryNo:'actual-provider-delivery-001',distance:1200,fee:8.5});}});
   await f.app(async db=>{const a=await f.admit(db,randomUUID(),f.identity(1,77));await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');expect((await orderRow(f)).status).toBe(0);});expect(controlled.calls).toHaveLength(2);
  }
  await f.reset();await f.db.update(storeOrder).set({storeId:77}).where(eq(storeOrder.id,1));const controlled=dadaFetch();await f.app(async db=>{const a=await f.admit(db,randomUUID(),f.identity(1,77));await f.db.update(systemStore).set({cityShopId:'different-real-registration'}).where(eq(systemStore.id,77));await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');});expect(controlled.calls).toHaveLength(0);
 },20000);
 it('retains an accepted effect after customer role loss and exposes only the owning ordinary User receipt',async()=>{
  const controlled=dadaFetch({issue:async()=>{await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,1));return response('');}});await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);const minimal=await f.city(db).outcome(f.actor(),a.job_id);expect(minimal.status).toBe('ADMITTED');expect(Object.keys(minimal).sort()).toEqual(['delivery_status','job_id','last_error_code','may_retry','provider','provider_order_id','request_key','status','updated_at']);expect(JSON.stringify(minimal)).not.toMatch(/实际收件人|13900000201|真实平台地址/);await expect(f.city(db).recover(f.actor(),a.job_id)).rejects.toThrow();await expect(f.city(db).outcome(f.actor(102),a.job_id)).rejects.toThrow('不存在');await f.db.update(user).set({pwd:'changed-owned-password'}).where(eq(user.uid,101));await expect(f.city(db).outcome(f.actor(),a.job_id)).rejects.toThrow('失效');});expect(controlled.calls).toHaveLength(3);
 });
 it('detects deployment credential changes privately after quote even when public configured readiness is unchanged',async()=>{
  const secret=f.env.DADA_APP_SECRET,controlled=dadaFetch({quote:()=>{f.env.DADA_APP_SECRET='different-owned-deployment-secret';return response({deliveryNo:'actual-provider-delivery-001',distance:1200,fee:8.5});}});
  try{await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');expect((await orderRow(f)).status).toBe(0);const minimal=await f.city(db).outcome(f.actor(),a.job_id);expect(JSON.stringify(minimal)).not.toMatch(/deployment-secret|provider_authority_revision|owned-dada-secret/);});expect(controlled.calls).toHaveLength(2);}finally{f.env.DADA_APP_SECRET=secret;}
 });
 it('preserves one UNKNOWN publication after transport failure and reconciles the original provider identity without republishing',async()=>{
  const controlled=dadaFetch({issue:()=>{throw Error('controlled-transport-timeout');}});await f.app(async db=>{const key=randomUUID(),a=await f.admit(db,key);await f.city(db).process(a.job_id);expect((await f.city(db).outcome(f.actor(),a.job_id))).toMatchObject({status:'UNKNOWN',request_key:key,may_retry:false});expect((await orderRow(f)).status).toBe(0);await f.city(db).process(a.job_id);await f.city(db).dispatchPending();expect(controlled.calls).toHaveLength(3);const recovered=await f.city(db).recover(f.actor(),a.job_id);expect(recovered.status).toBe('ADMITTED');expect(controlled.calls).toHaveLength(4);expect(controlled.calls[3]!.biz).toEqual({order_id:a.provider_order_id});expect(await f.db.select().from(attempts)).toHaveLength(1);});
 });
 it('rejects a mutable Dada origin or quote drift before any original-identity recovery transport or local apply',async()=>{
  await f.app(async db=>{const controlled=dadaFetch(),a=await f.admit(db,randomUUID());await db.update(jobs).set({providerOrderId:'wrong-provider-reference'}).where(eq(jobs.id,a.job_id));await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('REVOKED');expect(controlled.fetch).not.toHaveBeenCalled();expect(await f.db.select().from(attempts)).toHaveLength(0);expect((await orderRow(f)).status).toBe(0);});
  for(const drift of['job','quote']){await f.reset();const controlled=dadaFetch({issue:()=>{throw Error('controlled-transport-timeout');}});await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('UNKNOWN');expect(controlled.calls).toHaveLength(3);const saved=(await f.db.select().from(attempts))[0]!;
   if(drift==='job')await db.update(jobs).set({providerOrderId:'wrong-provider-reference'}).where(eq(jobs.id,a.job_id));else await db.update(attempts).set({quote:{...saved.quote,provider_order_id:'wrong-quote-reference'}}).where(eq(attempts.id,saved.id));
   controlled.fetch.mockClear();await expect(f.city(db).recover(f.actor(),a.job_id)).rejects.toThrow(drift==='job'?'city_original_origin_binding_conflict':'city_original_quote_binding_missing');expect(controlled.fetch).not.toHaveBeenCalled();expect((await orderRow(f)).status).toBe(0);expect(await f.db.select().from(bindings)).toHaveLength(0);expect(await f.db.select().from(storeDeliveryOrder)).toHaveLength(0);expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(0);expect((await jobRow(f,a.job_id)).status).toBe('UNKNOWN');
  });}
 },20000);
 it('treats malformed issue results as UNKNOWN and known provider rejection as REJECTED',async()=>{
  for(const malformed of[true,false]){await f.reset();const controlled=dadaFetch({issue:()=>malformed?new Response('{"unexpected":true}'):response(null,500,'fail')});await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe(malformed?'UNKNOWN':'REJECTED');expect(await f.db.select().from(bindings)).toHaveLength(0);expect((await orderRow(f)).status).toBe(0);});expect(controlled.calls).toHaveLength(3);}
 },15000);
 it('does not restart an interrupted ISSUING attempt after its lease expires',async()=>{
  const controlled=dadaFetch();await f.app(async db=>{const a=await f.admit(db,randomUUID()),time=Math.floor(Date.now()/1000);await f.db.update(jobs).set({status:'PROCESSING',leaseToken:randomUUID(),leaseUntil:time-1}).where(eq(jobs.id,a.job_id));await f.db.insert(attempts).values({jobId:a.job_id,requestKey:a.request_key,phase:'ISSUING',startedTime:time-5,issuedTime:time-4,updateTime:time});await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('UNKNOWN');expect((await f.db.select().from(attempts))[0]?.phase).toBe('UNKNOWN');});expect(controlled.calls).toHaveLength(0);
 });
 it('blocks every unrelated manual fulfillment while a city intent is pending or admitted',async()=>{
  dadaFetch();await f.app(async db=>{const a=await f.admit(db,randomUUID()),manual=new SupplierFulfillmentService(createContainerFromDb(db),f.env),input={deliveryType:'send' as const,deliveryName:'平台配送',deliveryId:'13900000105',deliveryCode:'',fictitiousContent:'',deliveryUid:105};await expect(manual.deliver(0,1,input,{expectedStoreId:0})).rejects.toThrow('同城');await f.city(db).process(a.job_id);expect((await jobRow(f,a.job_id)).status).toBe('ADMITTED');await expect(manual.deliver(0,1,input,{expectedStoreId:0})).rejects.toThrow('同城');});
 });
 it('applies only the exact bound callback despite another historical delivery row and finalizes real receipt rewards once',async()=>{
  const observedAt=Math.floor(Date.now()/1000);dadaFetch();await f.db.update(storeOrder).set({gainIntegral:'3'}).where(eq(storeOrder.id,1));await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);await f.db.insert(storeDeliveryOrder).values({oid:1,uid:201,type:0,relationId:0,stationType:1,orderId:'unrelated-historical-id',deliveryNo:'historical-no'});expect((await event(f,db,a.provider_order_id,4,observedAt)).outcome).toBe('completed');expect(await orderRow(f)).toMatchObject({status:2,deliveryType:'city_delivery'});expect((await jobRow(f,a.job_id)).status).toBe('DELIVERED');expect((await f.db.select().from(user).where(eq(user.uid,201)))[0]?.integral).toBe(3);expect(await f.db.select().from(userBill)).toHaveLength(1);expect((await event(f,db,a.provider_order_id,4,observedAt)).outcome).toBe('already-completed');expect(await f.db.select().from(userBill)).toHaveLength(1);});
 });
 it('retires a cancelled exact attempt and refuses its later callback once a new city attempt is admitted',async()=>{
  const applyErrors:string[]=[],prototype=CustomerCityDeliveryService.prototype as unknown as {apply(job:unknown,result:unknown):Promise<unknown>},original=prototype.apply;
  const spy=vi.spyOn(prototype,'apply').mockImplementation(function(this:typeof prototype,job,result){return original.call(this,job,result).catch(error=>{let cause:unknown=error;const codes:string[]=[];for(let depth=0;depth<4&&cause instanceof Error;depth++){codes.push(cause.message);cause=cause.cause;}applyErrors.push(codes.join(' → '));throw error;});});
  const first=dadaFetch();try{await f.app(async db=>{const a=await f.admit(db,randomUUID());await f.city(db).process(a.job_id);
   const firstNotice=(await f.db.select().from(storeOrderOutbox))[0]!,firstBytes=JSON.stringify(firstNotice),firstPayload=firstNotice.payload as OrderDeliveryNoticeOutboxPayload;
   expect(firstNotice.eventKey).toBe(`order.delivery.notice:1:city:${a.job_id}`);expect(firstPayload.cityDeliveryJobId).toBe(a.job_id);expect(await customerCityNoticeIsActive(db,firstPayload)).toBe(true);expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:firstNotice.id,eventKey:firstNotice.eventKey})).toBe(true);
   for(const invalid of['order.delivery.notice:1:city:0','order.delivery.notice:1:city:-1','order.refund.refused.notice:1:city:1','withdrawal.approved.notice:1:city:1']){expect(isOrderNotificationOutboxMessage({action:'processOrderNotificationOutbox',outboxId:firstNotice.id,eventKey:invalid})).toBe(false);expect(isOrderNotificationDeliveryMessage({action:'processOrderNotificationDelivery',deliveryId:1,eventKey:invalid,channel:'sms'})).toBe(false);}
   await expect(withTx(createContainerFromDb(db),tx=>enqueueOrderDeliveryNoticeEvent(tx,{orderId:1,orderNo:'customer-order-1',userId:201,deliveryType:'city_delivery',deliveryName:'达达配送',deliveryId:'actual-provider-delivery-001',userAddress:'实际收件地址'}))).rejects.toThrow('同城任务');
   const [queued]=await f.db.insert(orderNotificationDelivery).values({outboxId:firstNotice.id,eventKey:firstNotice.eventKey,orderId:1,userId:201,noticeMark:'send_order_success',channel:'sms',target:'13900000201',templateCode:'OWNED-SMS-TEMPLATE',payload:{kind:'sms',params:{order:'customer-order-1'}},status:'ENQUEUED',leaseUntil:Math.floor(Date.now()/1000)+60}).returning();
   const at=Math.floor(Date.now()/1000)-4,callbacks=new CityDeliveryCallbackService(createContainerFromDb(db),f.env),received=await callbacks.receive(normalizeDadaCityDeliveryQuery({order_status:2,update_time:at,dm_name:'实际骑手',dm_mobile:'13900000666'},{providerOrderId:a.provider_order_id,expectedClientId:'owned-dada-client',observedAt:at}));
   expect(await callbacks.processMessage({action:'processCityDeliveryCallbackOutbox',outboxId:received.outboxId,eventId:received.eventId,replayKey:received.replayKey})).toBe('completed');expect((await orderRow(f)).deliveryId).toBe('13900000666');expect(await customerCityNoticeIsActive(db,firstPayload)).toBe(true);
   expect((await event(f,db,a.provider_order_id,5,Math.floor(Date.now()/1000)-2)).outcome).toBe('completed');expect((await jobRow(f,a.job_id)).status).toBe('CANCELLED');expect((await orderRow(f)).status).toBe(0);expect((await f.db.select().from(bindings))[0]?.active).toBe(0);expect(await customerCityNoticeIsActive(db,firstPayload)).toBe(false);
   const message={action:'processOrderNotificationDelivery' as const,deliveryId:queued!.id,eventKey:firstNotice.eventKey,channel:'sms' as const};expect(isOrderNotificationDeliveryMessage(message)).toBe(true);const external=vi.fn(async()=>{throw Error('inactive city notice must not reach transport');});expect(await new OrderNotificationDeliveryService(createContainerFromDb(db),f.env).processMessage(message,external as typeof fetch)).toBe('skipped');expect(external).not.toHaveBeenCalled();expect((await f.db.select().from(orderNotificationDelivery))[0]).toMatchObject({status:'SKIPPED',attemptCount:0,lastError:'city_attempt_no_longer_active'});
   dadaFetch({quote:()=>response({deliveryNo:'actual-provider-delivery-002',distance:1300,fee:9})});const b=await f.admit(db,randomUUID(),f.identity(),{request_hash:'b'.repeat(64)});await f.city(db).process(b.job_id);expect((await jobRow(f,b.job_id)).status,JSON.stringify({actualApplyErrors:applyErrors})).toBe('ADMITTED');expect(applyErrors).toEqual([]);
   const allNotices=await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id);expect(allNotices).toHaveLength(2);expect(JSON.stringify(allNotices[0])).toBe(firstBytes);expect(allNotices[1]!.eventKey).toBe(`order.delivery.notice:1:city:${b.job_id}`);expect(await customerCityNoticeIsActive(db,allNotices[1]!.payload as OrderDeliveryNoticeOutboxPayload)).toBe(true);expect(await customerCityNoticeIsActive(db,firstPayload)).toBe(false);
   expect((await event(f,db,a.provider_order_id,4)).outcome).toBe('conflict');expect((await orderRow(f)).status).toBe(1);expect((await jobRow(f,b.job_id)).status).toBe('ADMITTED');expect((await event(f,db,b.provider_order_id,2)).outcome).toBe('completed');
  });expect(first.calls).toHaveLength(3);}finally{spy.mockRestore();}
 });
 it('keeps legacy callback ambiguity rejected when no durable binding names either historical attempt',async()=>{
  await f.db.update(storeOrder).set({status:1,deliveryType:'city_delivery'}).where(eq(storeOrder.id,1));await f.db.insert(storeDeliveryOrder).values([{oid:1,uid:201,type:0,relationId:0,stationType:1,orderId:'legacy-attempt-a',deliveryNo:'legacy-no-a'},{oid:1,uid:201,type:0,relationId:0,stationType:1,orderId:'legacy-attempt-b',deliveryNo:'legacy-no-b'}]);await f.app(async db=>{expect((await event(f,db,'legacy-attempt-a',2)).outcome).toBe('conflict');expect((await orderRow(f)).status).toBe(1);});
 });
 it('fails closed on check definitions, defaults, index predicates/order and RLS rather than trusting names',async()=>{
  await f.app(async db=>{
   const mutations=["ALTER TABLE customer_city_delivery_job ALTER status SET DEFAULT 'ADMITTED'",'ALTER TABLE customer_city_delivery_job ENABLE ROW LEVEL SECURITY','CREATE INDEX city_unreviewed_extra ON customer_city_delivery_job(actor_uid)','DROP INDEX ccdbinding_active_order_uq; CREATE UNIQUE INDEX ccdbinding_active_order_uq ON customer_city_delivery_binding(order_id) WHERE active=0','DROP INDEX ccdjob_dispatch; CREATE INDEX ccdjob_dispatch ON customer_city_delivery_job(status DESC,lease_until,id)',"ALTER TABLE customer_city_delivery_job DROP CONSTRAINT ccdjob_status_ck; ALTER TABLE customer_city_delivery_job ADD CONSTRAINT ccdjob_status_ck CHECK(status IS NOT NULL)"];
   for(const change of mutations){
    const rollback=new Error('owned_catalog_negative_rollback');
    await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(change));await expect(assertCustomerCityDeliveryReady(tx as unknown as Parameters<typeof assertCustomerCityDeliveryReady>[0],false)).rejects.toThrow('完整目录');throw rollback;})).rejects.toBe(rollback);
    await assertCustomerCityDeliveryReady(db);
   }
  });
 });
 it('rejects broad runtime identity grants, missing sequence grants and unreviewed station column defaults',async()=>{
  await f.app(async(db,role)=>{await f.exec(`GRANT UPDATE(intent) ON customer_city_delivery_job TO "${role}"`);await expect(assertCustomerCityDeliveryReady(db)).rejects.toThrow('身份不可变');await f.exec(`REVOKE UPDATE(intent) ON customer_city_delivery_job FROM "${role}"`);await assertCustomerCityDeliveryReady(db);await f.exec(`REVOKE USAGE ON SEQUENCE customer_city_delivery_attempt_id_seq FROM "${role}"`);await expect(assertCustomerCityDeliveryReady(db)).rejects.toThrow('运行时权限');await f.exec(`GRANT USAGE ON SEQUENCE customer_city_delivery_attempt_id_seq TO "${role}"`);await f.exec("ALTER TABLE system_store ALTER city_shop_id SET DEFAULT 'guessed' ");await expect(assertCustomerCityDeliveryReady(db)).rejects.toThrow('站点列');await f.exec("ALTER TABLE system_store ALTER city_shop_id SET DEFAULT ''");await assertCustomerCityDeliveryReady(db);});
 });
 it('keeps UU unavailable without a reviewed origin contract; controlled V3 tests bind actual returned origin and forbid a guessed one',async()=>{
  await f.app(async db=>{
   const adapter=new CustomerCityDeliveryProvider(f.env,new CityDeliverySettingsResolver(createContainerFromDb(db),f.env)),input:CustomerCityIssueInput={provider:'uu',provider_order_id:'unused-local-intent-reference',station:{type:0,relation_id:0,name:'实际平台发件人',address:'上海市真实平台地址',phone:'13900000999',city_name:'上海市',shop_no:'plat_delivery_city_shop_001'},receiver_name:'实际收件人',receiver_phone:'13900000201',receiver_address:'实际收件地址',cargo_price:'30.00',cargo_weight:'2.50',delivery_remark:'真实配送备注'};
   const calls:Call[]=[];vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)) as Record<string,unknown>,biz=JSON.parse(String(body.biz)) as Record<string,unknown>;calls.push({url:String(url),body,biz});expect(body.sign).toBe(createHash('md5').update(String(body.biz)+'owned-uu-key'+body.timestamp).digest('hex').toUpperCase());return new Response(JSON.stringify({code:1,state:1,body:String(url).endsWith('/orderPrice')?{priceToken:'actual-price-token',needPayMoney:850,distance:1200}:{originId:'actual-provider-origin',orderCode:'actual-provider-code'}}));}));
   await expect(adapter.quote(input)).rejects.toThrow('unverified');expect(calls).toHaveLength(0);
   f.env.CUSTOMER_CITY_UU_ORIGIN_BINDING_CONTRACT='uu-v3-originId-return-v1';const quote=await adapter.quote(input);expect(await adapter.issue(input,quote)).toMatchObject({provider_order_id:'actual-provider-origin',delivery_no:'actual-provider-code',fee:'8.50'});expect(calls[0]!.biz).toEqual({fromAddress:input.station.address,toAddress:input.receiver_address,sendType:'SEND',cityName:'上海市',specialChannel:2});expect(calls[1]!.biz).toEqual({priceToken:'actual-price-token',receiver_phone:'13900000201',pushType:'OPEN_ORDER',payType:'BALANCE_PAY',specialChannel:2,specialType:'NOT_NEED_WARM',note:'真实配送备注'});
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:1,state:1,body:{orderCode:'only-order-code'}}))));await expect(adapter.issue(input,quote)).rejects.toThrow('origin_binding');
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:1,state:1,body:{orderCode:'actual-provider-code',originId:'actual-provider-origin',orderUrl:'https://payment.example.com'}}))));await expect(adapter.issue(input,quote)).rejects.toThrow('payment_outcome');
  });
 });
 it('accepts only a strict public HTTPS callback origin and applies bounded provider responses',async()=>{
  await f.app(async db=>{const env={...f.env},adapter=new CustomerCityDeliveryProvider(env,new CityDeliverySettingsResolver(createContainerFromDb(db),env));for(const origin of['http://city-fixture.example.com','https://127.0.0.1','https://localhost','https://host.local','https://user@city-fixture.example.com','https://city-fixture.example.com/path','https://city-fixture.example.com?x=1','https://city-fixture.example.com#x']){env.CUSTOMER_CITY_CALLBACK_ORIGIN=origin;expect(()=>adapter.callback('dada')).toThrow();}env.CUSTOMER_CITY_CALLBACK_ORIGIN=f.env.CUSTOMER_CITY_CALLBACK_ORIGIN;expect(adapter.callback('dada')).toContain('/api/city_delivery/notify?');
   const input:CustomerCityIssueInput={provider:'dada',provider_order_id:'owned-bounded-origin',station:{type:0,relation_id:0,name:'真实发件人',address:'上海市真实地址',phone:'13900000999',city_name:'上海市',shop_no:'plat_delivery_city_shop_001'},receiver_name:'实际收件人',receiver_phone:'13900000201',receiver_address:'实际地址',cargo_price:'30.00',cargo_weight:'2.50',delivery_remark:''},quote={token:'',delivery_no:'actual-no',distance:1,fee:'1.00',provider_order_id:input.provider_order_id};
   for(const bad of[()=>new Response('x',{headers:{'content-length':'65537'}}),()=>new Response('x'.repeat(65537)),()=>new Response(new Uint8Array([0xff,0xfe]))]){const controlled=vi.fn(async()=>bad());vi.stubGlobal('fetch',controlled);await expect(adapter.issue(input,quote)).rejects.toThrow();expect(controlled).toHaveBeenCalledTimes(1);}
  });
 });
});
