/** Actual paid-pickup shipping, not delivery/writeoff simulation. Five formally
 * commissioned LOGINs, real Admin pickup checkout, RSA/AES payment capture,
 * default paid effects and ordinary staff HTTP writeoff; a separate ninth case
 * covers the genuine local zero-amount transition without provider proof. Only external provider,
 * KV and Queue transports are local. No paid/store/source-positive row is seeded. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderOutbox, storeOrderCartInfo, storeProduct, storeProductAttrValue, systemConfig, systemSupplier, user, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment,
  type RoutineShippingAccountPolicy } from '@/services/payment/RoutineShippingAccount';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { applyStoreOrderPayment } from '@/services/order/StoreOrderPayService';
import { consumeOrderPaidOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { isOrderNotificationDeliveryMessage, OrderNotificationDeliveryService } from '@/services/order/OrderNotificationDeliveryService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { amountToCents } from '@/services/payment/RefundGateway';
import type { RoutineShippingDispatch, RoutineShippingRequest } from '@/services/payment/RoutineShippingDispatch';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys = ReturnType<typeof paymentQueryKeys>;
const APP='wx_pickup_original',MERCHANT='1900000101',ACCOUNT='pickup_payment_original',REF='pickup_payment_materials';
const CURRENT_APP='wx_pickup_current_b',CURRENT_MERCHANT='1900000102',PLATFORM='PUB_PICKUP_ORIGINAL',AES='s'.repeat(32);
const PAYER='pickup_real_payer_not_buyer_binding',BUYER_BINDING='pickup_unrelated_latest_buyer_binding',SECRET='synthetic-archived-shipping-secret-A';
const SHIPPING_REF='shipping_archived_appsecret';

function envelope(keys:Keys,payload:unknown,eventId=randomUUID(),materials={apiV3Key:AES,platformPublicKeyId:PLATFORM}){
  const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction';
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(materials.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const body=JSON.stringify({id:eventId,event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',
    original_type:'transaction',ciphertext,nonce,associated_data:associated}}),timestamp=String(Math.floor(Date.now()/1000));
  return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':materials.platformPublicKeyId,
    'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual original Routine pickup shipping through paid outbox and Queue',()=>{
  let f:Fixture,keys:Keys,nativeKeys:Keys,paymentRegistry='',shippingRegistry='',policy:RoutineShippingAccountPolicy,revision=0,state:'active'|'revoked'='active';
  let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>,connections:MockInstance<typeof Di.createDbFromConnectionString>;
  const logs:unknown[]=[];
  const application=()=>createContainerFromDb(f.appRuntime.db);
  const consumer=()=>new OrderNotificationDeliveryService(application(),f.env);
  const actual=async(id:number)=>(await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
  const delivery=async(id:number)=>(await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,id)))[0];
  const noSecrets=(value:unknown)=>{const text=JSON.stringify(value);for(const secret of[PAYER,BUYER_BINDING,SECRET,AES,f.env.APP_KEY,'BEGIN PRIVATE KEY'])expect(text).not.toContain(secret);};
  const policyTarget=()=>({database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin});
  const approve=async(next:'active'|'revoked'='active')=>{const r=await appendRoutineShippingAccountPolicy(f.maintenanceDb,f.env,policyTarget(),
    {operationId:randomUUID(),expectedRevision:revision,data:{...policy,state:next}});revision=r.revision;state=next;return r;};
  const current=async(clear=false)=>{
    const values={routine_appId:clear?'':CURRENT_APP,routine_appsecret:clear?'':'synthetic-current-secret-B',wechat_appid:clear?'':CURRENT_APP,
      wechat_app_appid:CURRENT_APP,pay_weixin_mchid:CURRENT_MERCHANT,pay_weixin_serial_no:'B1B2B3B4',pay_weixin_open:1,order_shipping_open:1};
    await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
    await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
  };
  const admin=async(path:string,body?:unknown,method:'GET'|'POST'|'PUT'='POST')=>{
    const token=(await createToken(1,'admin',md5('offline-native-admin-password'),f.env.APP_KEY)).token;
    const response=await f.raw(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      ...(method==='GET'?{}:{body:JSON.stringify(body)})});
    const json=await response.json() as {status:number;msg:string;data:any};noSecrets(json);
    expect(response.status).toBe(200);expect(json.status,json.msg).toBe(200);return json.data;
  };
  const notify=async(packet:ReturnType<typeof envelope>)=>{
    const h=new Hono<{Bindings:Env;Variables:AppVariables}>(),pending:Promise<unknown>[]=[];
    h.use('*',async(c,next)=>{c.set('container',application());await next();});h.onError(errorHandler);h.route('/api',v1Routes);
    const response=await h.request('/api/pay/notify/routine-account/'+ACCOUNT,{method:'POST',headers:packet.headers,body:packet.body},f.env,
      {waitUntil:(promise:Promise<unknown>)=>pending.push(promise),props:{},passThroughOnException:()=>{throw Error('Unexpected payment fallback');}});
    await Promise.all(pending);noSecrets(await response.text());expect(response.status).toBe(200);
  };
  type PaidEvent = typeof storeOrderOutbox.$inferSelect;
  async function created(mixed=false,quantity=2){
    if(!mixed){const source=await f.unpaid(11,'5.00',quantity);expect(source.order).toMatchObject({paid:0,uid:11,shippingType:2,storeId:1,status:0});return source.order;}
    const carts:Array<{cartId:string}>=[];
    for(const [productId,uniqueId]of [[70,'qared001'],[70171,'pick0007'],[70172,'pick0008']]as const)
      carts.push(await admin('/admin/order/cart/add/11',{tourist_uid:'',productId,uniqueId,cartNum:1,new:1}) as {cartId:string});
    const selection={cartId:carts.map(c=>c.cartId),tourist_uid:'',new:1,shipping_type:2,store_id:1,
      real_name:'真实多供应商自提',phone:'00000000000',payType:'cash',useIntegral:false,couponId:0,from:'pc'};
    const quote=await admin('/admin/order/confirm/11',selection);
    const result=await admin('/admin/order/create/'+quote.orderKey+'/11',{...selection,quoteToken:quote.quoteToken});
    const order=await f.container.storeOrderDao.findByOrderId(result.result.order_id);if(!order)throw Error('Real mixed pickup checkout absent');
    expect(order).toMatchObject({paid:0,uid:11,shippingType:2,storeId:1,status:0});return order;
  }
  async function paidEvent(id:number):Promise<PaidEvent>{
    const rows=await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,id),eq(storeOrderOutbox.eventType,'order.paid')));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({eventKey:'order.paid:'+id,aggregateType:'order',aggregateId:id});return rows[0];
  }
  const paidMessage=(event:PaidEvent)=>({action:'processOrderPaidOutbox' as const,outboxId:event.id,eventKey:event.eventKey});
  async function capturePaid(mixed=false,quantity=2){
    const row=await created(mixed,quantity),total=amountToCents(row.payPrice);if(total===null||total<=0)throw Error('Real pickup amount absent');
    const transactionId='pickup_tx_'+randomUUID().replaceAll('-',''),before=f.messages.length;
    await notify(envelope(keys,{appid:APP,mchid:MERCHANT,out_trade_no:row.orderId,transaction_id:transactionId,trade_state:'SUCCESS',trade_type:'JSAPI',
      payer:{openid:PAYER},success_time:new Date().toISOString(),amount:{total,currency:'CNY'}}));
    const callback=f.messages.slice(before).find(isPaymentCallbackMessage);expect(callback).toBeDefined();
    expect(await new PaymentCallbackEventService(application(),f.env).processMessage(callback!)).toBe('completed');
    const order=await actual(row.id);expect(order).toMatchObject({paid:1,payType:'weixin',tradeNo:transactionId,shippingType:2,storeId:1,status:0,isChannel:2});
    const originals=await f.maintenanceDb.execute<{row:unknown}>(sql`SELECT pg_catalog.to_jsonb(t) AS row FROM public.routine_original_payment_evidence t WHERE order_no=${order.orderId}`);
    expect(originals).toHaveLength(1);expect(parseRoutineOriginalEvidence(f.env,originals[0].row)).toMatchObject({payload:{binding:{state:'bound',local:{domain:'store_order',orderId:order.id,buyerUid:11}},
      observation:{facts:{payerId:PAYER,appId:APP,merchantId:MERCHANT,tradeType:'JSAPI',tradeState:'SUCCESS'}}}});
    const event=await paidEvent(order.id);expect(event.payload).toEqual({orderId:order.id,orderNo:order.orderId});
    return{order,event};
  }
  async function finishPaid(source:Awaited<ReturnType<typeof capturePaid>>){
    expect(await new OrderOutboxService(application(),f.env).processMessage(paidMessage(source.event))).toBe('completed');
    return{...source,order:await actual(source.order.id),event:await paidEvent(source.order.id)};
  }
  async function stage(source:Awaited<ReturnType<typeof capturePaid>>){
    const event=await paidEvent(source.order.id);expect(event.status).toBe('COMPLETED');
    const rows=await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey,event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')));
    expect(rows).toHaveLength(1);const row=rows[0];expect(row).toMatchObject({status:'PENDING',target:'',outboxId:event.id,orderId:source.order.id,
      userId:11,noticeMark:'paid_pickup_shipping',templateCode:'',payload:{kind:'wechat_shipping',transactionId:source.order.tradeNo,logisticsType:4,deliveryMode:1,
        isAllDelivered:true,trackingNumber:'',expressCompanyName:'',receiverContact:''}});
    const falseDelivery=await f.maintenanceDb.select({id:storeOrderOutbox.id}).from(storeOrderOutbox)
      .where(and(eq(storeOrderOutbox.aggregateId,source.order.id),eq(storeOrderOutbox.eventType,'order.delivery.notice')));
    expect(falseDelivery).toHaveLength(0);
    const before=f.messages.length;expect((await consumer().dispatchPending(20,event.eventKey)).enqueued).toBeGreaterThan(0);
    const messages=f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m=>m.channel==='wechat_shipping'&&m.deliveryId===row.id);
    expect(messages).toHaveLength(1);expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);noSecrets(messages);
    return{...source,event,order:await actual(source.order.id),id:row.id,message:messages[0]};
  }
  async function staged(mixed=false,quantity=2){return stage(await finishPaid(await capturePaid(mixed,quantity)));}
  const dispatchFor=async(id:number)=>{
    const rows=await f.maintenanceDb.execute<{dispatch_id:string;delivery_id:number;source_key:string;payload:RoutineShippingDispatch['payload'];created_at:string;signature:string;xmin:string}>(
      sql`SELECT d.*,d.xmin::text AS xmin FROM public.routine_shipping_dispatch d WHERE delivery_id=${id}`);
    expect(rows).toHaveLength(1);return rows[0];
  };
  async function enqueueDue(id:number,eventKey:string){
    const row=await delivery(id);expect(row.status).toBe('RETRYABLE');expect(row.availableTime).toBeGreaterThan(0);
    const before=f.messages.length,clock=vi.spyOn(Date,'now').mockReturnValue((row.availableTime+1)*1000);
    try{expect((await consumer().dispatchPending(20,eventKey)).enqueued).toBeGreaterThan(0);}finally{clock.mockRestore();}
    const messages=f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m=>m.channel==='wechat_shipping'&&m.deliveryId===id);
    expect(messages).toHaveLength(1);expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);noSecrets(messages);return messages[0];
  }
  const immutable=async(id:number)=>({dispatch:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,xmin::text AS xmin
      FROM public.routine_shipping_dispatch t WHERE delivery_id=${id}`)),
    evidence:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(e) AS row,e.xmin::text AS xmin
      FROM public.routine_shipping_provider_evidence e JOIN public.routine_shipping_dispatch d ON d.dispatch_id=e.dispatch_id WHERE d.delivery_id=${id} ORDER BY e.evidence_id`))});
  async function family(rootId:number){return f.maintenanceDb.select().from(storeOrder).where(sql`${storeOrder.id}=${rootId} OR ${storeOrder.pid}=${rootId}`).orderBy(storeOrder.id);}
  async function writeoff(orderId:number,quantity?:number){
    const order=await actual(orderId),carts=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,orderId)).orderBy(storeOrderCartInfo.id);
    expect(carts).toHaveLength(1);const amount=quantity??carts[0].writeSurplusTimes;expect(amount).toBeGreaterThan(0);
    const response=await f.raw('/store/order/writeoff',{method:'POST',headers:{Authorization:'Bearer '+await f.bearer(104),'Content-Type':'application/json'},
      body:JSON.stringify({code:order.verifyCode,items:[{order_cart_id:carts[0].id,quantity:amount}]})});
    const value=await response.json() as {status:number;msg:string;data:{completed:boolean;status:number}};noSecrets(value);
    expect(response.status).toBe(200);expect(value.status,value.msg).toBe(200);return value.data;
  }
  function transport(order:typeof storeOrder.$inferSelect,onUpload?:()=>Promise<Response>,familyIds=[order.id]){
    let uploads=0,tokens=0;const bodies:RoutineShippingRequest[]=[];
    network.mockImplementation(async(input,init)=>{
      const url=new URL(String(input));expect(url.origin).toBe('https://api.weixin.qq.com');
      if(url.pathname==='/cgi-bin/token'){tokens++;expect(url.searchParams.get('appid')).toBe(APP);expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({access_token:'synthetic-shipping-access-A',expires_in:7200});}
      expect(url.pathname).toBe('/wxa/sec/order/upload_shipping_info');expect(url.searchParams.get('access_token')).toBe('synthetic-shipping-access-A');expect(init?.method).toBe('POST');uploads++;
      const body=JSON.parse(String(init?.body)) as RoutineShippingRequest;bodies.push(body);
      expect(body).toMatchObject({order_key:{order_number_type:2,transaction_id:order.tradeNo},payer:{openid:PAYER},logistics_type:4,delivery_mode:1});
      expect(Object.hasOwn(body,'is_all_delivered')).toBe(false);expect(body.shipping_list).toHaveLength(1);
      expect(Object.keys(body.shipping_list[0])).toEqual(['item_desc']);expect(body.shipping_list[0].item_desc.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(BUYER_BINDING);
      await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
        const locked=await tx.select({id:storeOrder.id}).from(storeOrder).where(inArray(storeOrder.id,familyIds)).orderBy(storeOrder.id).for('update',{noWait:true});
        expect(locked.map(r=>r.id)).toEqual([...familyIds].sort((a,b)=>a-b));
        expect(await tx.select({id:orderNotificationDelivery.id}).from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.orderId,order.id),eq(orderNotificationDelivery.channel,'wechat_shipping'))).for('update',{noWait:true})).toHaveLength(1);
        const [idle]=await tx.execute<{n:number}>(sql`SELECT pg_catalog.count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename=${f.appRuntime.role} AND state='idle in transaction'`);
        expect(idle.n).toBe(0);
      }));
      return onUpload?onUpload():Response.json({errcode:0,errmsg:'ok'});
    });return{uploads:()=>uploads,tokens:()=>tokens,bodies:()=>bodies};
  }
  function nativeReached(){const calls=connections.mock.calls.filter(call=>call[2]?.applicationName==='cinashop_routine_shipping_verify');expect(calls.length).toBeGreaterThan(0);
    for(const call of calls){expect(call[0]===f.appRuntime.connectionString).toBe(true);expect(call[1]).toBe(1);}}
  beforeAll(async()=>{
    keys=paymentQueryKeys();nativeKeys=paymentQueryKeys();network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unplanned provider transport'));
    for(const name of['log','warn','error'] as const)vi.spyOn(console,name).mockImplementation((...args:unknown[])=>{logs.push(args);});
    f=await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await f.maintenanceDb.update(storeProduct).set({productType:0,stock:40,freight:1,isVip:0}).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({stock:40,price:'5.00',vipPrice:'5.00'}).where(eq(storeProductAttrValue.id,1));
    // Legitimate static supplier/product catalog specimens only. The cart,
    // source order, paid transition and supplier children are real producers.
    await f.maintenanceDb.insert(systemSupplier).values([{id:7007,adminId:7707,supplierName:'Pickup supplier seven',isShow:1,isDel:0},
      {id:7008,adminId:7708,supplierName:'Pickup supplier eight',isShow:1,isDel:0}]);
    const [product]=await f.maintenanceDb.select().from(storeProduct).where(eq(storeProduct.id,70)),
      [sku]=await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));
    await f.maintenanceDb.insert(storeProduct).values([{...product,id:70171,type:2,relationId:7007,storeName:'Supplier pickup seven',stock:40},
      {...product,id:70172,type:2,relationId:7008,storeName:'Supplier pickup eight',stock:40}]);
    await f.maintenanceDb.insert(storeProductAttrValue).values([{...sku,id:70171,productId:70171,unique:'pick0007',stock:40,settlePrice:'0.00'},
      {...sku,id:70172,productId:70172,unique:'pick0008',stock:40,settlePrice:'0.00'}]);
    await f.maintenanceDb.insert(user).values({uid:22,account:'owned-shipping-payer',pwd:'owned-shipping-payer-password',status:1,nowMoney:'23.00'}).onConflictDoNothing();
    await f.maintenanceDb.insert(wechatUser).values([{uid:22,userType:'routine',openid:PAYER},{uid:11,userType:'routine',openid:BUYER_BINDING}]);
    paymentRegistry=JSON.stringify({format:1,credentials:[{ref:REF,version:1,appId:APP,merchantId:MERCHANT,serialNo:'A1B2C3D4',apiV3Key:AES,
      privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:PLATFORM}]});
    shippingRegistry=JSON.stringify({format:1,credentials:[{ref:SHIPPING_REF,version:1,appId:APP,secret:SECRET}]});
    Object.assign(f.env,{ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:paymentRegistry,ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:shippingRegistry,
      WECHAT_MCH_PRIVATE_KEY:nativeKeys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:nativeKeys.publicKey,WECHAT_PLATFORM_PUBLIC_KEY_ID:'PUB_SHIPPING_CURRENT',WECHAT_API_V3_KEY:'b'.repeat(32)});
    await current();const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(f.env,REF,1);
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',
      data:{accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600}});
    policy={accountId:routineShippingAccountId(f.env,APP,MERCHANT),state:'active',appId:APP,merchantId:MERCHANT,credentialRef:SHIPPING_REF,credentialVersion:1,
      credentialStamp:routineShippingCredentialCommitment(f.env,SHIPPING_REF,1).credentialStamp,purposes:['shipping_upload'],validFrom:now-60,validUntil:now+3600};
    await approve();connections=vi.spyOn(Di,'createDbFromConnectionString');
  },180000);
  beforeEach(async()=>{network.mockReset().mockRejectedValue(Error('Unplanned provider transport'));connections.mockClear();
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=paymentRegistry;f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=shippingRegistry;if(state==='revoked')await approve();await current();});
  afterEach(()=>{noSecrets(logs);noSecrets(f.messages);});
  afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);

  it('stages one real pickup at payment while status is zero and uploads original payer A outside SQL with current config empty',async()=>{
    const bindings=await f.maintenanceDb.select().from(wechatUser),[payer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,22));
    const c=await staged();expect(c.order).toMatchObject({status:0,shippingType:2,storeId:1,paid:1});await current(true);
    const calls=transport(c.order);expect(await consumer().processMessage(c.message)).toBe('sent');nativeReached();expect(calls.uploads()).toBe(1);
    expect(await delivery(c.id)).toMatchObject({status:'SENT',responseCode:'0'});expect((await actual(c.order.id)).status).toBe(0);
    const first=await immutable(c.id);expect(first.dispatch).toHaveLength(1);expect(first.evidence).toHaveLength(1);
    await approve('revoked');f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=undefined;
    expect(await consumer().processMessage(c.message)).toBe('already-sent');expect(await immutable(c.id)).toEqual(first);expect(calls.uploads()).toBe(1);
    expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
  },90000);

  it('aggregates a genuine platform and two-supplier pickup family into one paid-root mode1 upload',async()=>{
    const c=await staged(true),rows=await family(c.order.id),root=rows.find(r=>r.id===c.order.id)!,leaves=rows.filter(r=>r.pid===c.order.id);
    expect(root).toMatchObject({pid:-1,supplierAllocationStatus:2,paid:1,shippingType:2,storeId:1});expect(leaves).toHaveLength(3);
    expect(leaves.map(r=>r.supplierId).sort((a,b)=>a-b)).toEqual([0,7007,7008]);
    for(const leaf of leaves)expect(leaf).toMatchObject({uid:11,paid:1,payType:'weixin',status:0,shippingType:2,storeId:1});
    expect(leaves.reduce((sum,r)=>sum+(amountToCents(r.payPrice)??NaN),0)).toBe(amountToCents(root.payPrice));
    expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(inArray(orderNotificationDelivery.orderId,rows.map(r=>r.id)),eq(orderNotificationDelivery.channel,'wechat_shipping')))).toHaveLength(1);
    const calls=transport(root,undefined,rows.map(r=>r.id));expect(await consumer().processMessage(c.message)).toBe('sent');nativeReached();expect(calls.uploads()).toBe(1);
    const intent=await dispatchFor(c.id);expect(intent.payload.identity).toMatchObject({rootId:root.id,childId:root.id,buyerUid:11,transactionId:root.tradeNo});
    expect(intent.payload.request).toMatchObject({delivery_mode:1,logistics_type:4});expect((await immutable(c.id)).evidence).toHaveLength(1);
  },90000);

  it('rolls back pickup staging with genuine paid effects and replays the same paid source without duplicates',async()=>{
    const source=await capturePaid(),before=await f.facts(),pid=await f.appRuntime.verify();
    expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey,source.event.eventKey))).toHaveLength(0);
    await f.exec(`CREATE FUNCTION public.pickup_paid_stage_fail() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN PERFORM pg_catalog.pg_advisory_lock(731719,${source.order.id});RAISE EXCEPTION 'owned pickup paid staging rollback';END$$`);
    await f.exec('REVOKE ALL ON FUNCTION public.pickup_paid_stage_fail() FROM PUBLIC');
    await f.exec(`CREATE TRIGGER pickup_paid_stage_fail BEFORE INSERT ON public.order_notification_delivery FOR EACH ROW WHEN(NEW.notice_mark='paid_pickup_shipping' AND NEW.order_id=${source.order.id}) EXECUTE FUNCTION public.pickup_paid_stage_fail()`);
    try{
      await expect(new OrderOutboxService(application(),f.env).processMessage(paidMessage(source.event))).rejects.toThrow();
      const [witness]=await f.maintenanceDb.execute<{yes:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=${pid}
        AND classid=731719::oid AND objid=${source.order.id}::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS yes`);expect(witness.yes).toBe(true);
      const after=await f.facts();expect({...after,outbox:null}).toEqual({...before,outbox:null});
      expect(await paidEvent(source.order.id)).toMatchObject({status:'FAILED',eventKey:source.event.eventKey,payload:source.event.payload});
      expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey,source.event.eventKey))).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
    }finally{await f.appRuntime.db.execute(sql`SELECT pg_catalog.pg_advisory_unlock(731719,${source.order.id})`);
      await f.exec('DROP TRIGGER IF EXISTS pickup_paid_stage_fail ON public.order_notification_delivery');await f.exec('DROP FUNCTION IF EXISTS public.pickup_paid_stage_fail()');}
    const finished=await finishPaid(source),c=await stage(finished),beforeReplay=await delivery(c.id),facts=await f.facts();
    expect(await new OrderOutboxService(application(),f.env).processMessage(paidMessage(source.event))).toBe('already-completed');
    expect(await f.facts()).toEqual(facts);expect(await delivery(c.id)).toEqual(beforeReplay);
    const calls=transport(c.order);expect(await consumer().processMessage(c.message)).toBe('sent');expect(calls.uploads()).toBe(1);nativeReached();
  },90000);

  it('retains the first busy intent through real partial and complete staff writeoff then retries the identical upload once',async()=>{
    const c=await staged(false,2),rejected=transport(c.order,async()=>Response.json({errcode:10060012,errmsg:'synthetic explicit busy rejection'}));
    expect(await consumer().processMessage(c.message)).toBe('retry-scheduled');expect(rejected.uploads()).toBe(1);
    const intent=await dispatchFor(c.id),original=await immutable(c.id),fixed=rejected.bodies()[0],source=await paidEvent(c.order.id);
    expect(await writeoff(c.order.id,1)).toMatchObject({completed:false,status:5});expect((await actual(c.order.id)).verifyCode).not.toBe(c.order.verifyCode);
    expect(await writeoff(c.order.id)).toMatchObject({completed:true,status:2});expect((await actual(c.order.id)).verifyCode).toBe('');
    expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,c.order.id),eq(storeOrderOutbox.eventType,'order.delivery.notice')))).toHaveLength(0);
    expect(await new OrderOutboxService(application(),f.env).processMessage(paidMessage(source))).toBe('already-completed');
    expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey,source.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')))).toHaveLength(1);
    const retry=await enqueueDue(c.id,c.message.eventKey),accepted=transport(await actual(c.order.id));
    expect(await consumer().processMessage(retry)).toBe('sent');expect(accepted.uploads()).toBe(1);expect(accepted.bodies()[0]).toEqual(fixed);nativeReached();
    expect(await dispatchFor(c.id)).toEqual(intent);const after=await immutable(c.id);expect(after.dispatch).toEqual(original.dispatch);expect(after.evidence).toHaveLength(2);
    expect(after.evidence).toEqual(expect.arrayContaining(original.evidence));expect(await consumer().processMessage(retry)).toBe('already-sent');expect(accepted.uploads()).toBe(1);
  },90000);

  it('keeps a lost pickup POST UNKNOWN across duplicate Queue messages paid-source replays and dispatch scans',async()=>{
    const c=await staged(),calls=transport(c.order,async()=>{throw Error('Lost response with '+PAYER+' '+SECRET);});
    expect(await consumer().processMessage(c.message)).toBe('unknown');nativeReached();expect(calls.uploads()).toBe(1);
    const first=await immutable(c.id);expect(first.dispatch).toHaveLength(1);expect(first.evidence).toHaveLength(0);expect(await delivery(c.id)).toMatchObject({status:'UNKNOWN',lastError:'wechat_shipping_outcome_unknown'});
    expect(await new OrderOutboxService(application(),f.env).processMessage(paidMessage(c.event))).toBe('already-completed');
    expect(await consumer().processMessage(c.message)).toBe('unknown');expect((await consumer().dispatchPending(20,c.event.eventKey)).enqueued).toBe(0);
    expect(calls.uploads()).toBe(1);expect(await immutable(c.id)).toEqual(first);
  },90000);

  it('refuses all other actual LOGINs before claiming the pickup then accepts that same Queue message through App',async()=>{
    const c=await staged(),before=await delivery(c.id),calls=transport(c.order);
    for(const peer of[f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]){
      await expect(new OrderNotificationDeliveryService(createContainerFromDb(peer.db),f.env).processMessage(c.message)).rejects.toMatchObject({code:503});expect(await delivery(c.id)).toEqual(before);
    }
    expect(network).not.toHaveBeenCalled();expect(await consumer().processMessage(c.message)).toBe('sent');expect(calls.uploads()).toBe(1);nativeReached();
  },90000);

  it('refuses withdrawn approval or a contradictory paid source before token or upload I/O',async()=>{
    const first=await staged();await approve('revoked');const calls=transport(first.order);
    expect(await consumer().processMessage(first.message)).toBe('dead');expect(network).not.toHaveBeenCalled();expect((await immutable(first.id)).dispatch).toHaveLength(0);await approve();
    const second=await staged();await f.maintenanceDb.update(storeOrder).set({payPrice:'99.99'}).where(eq(storeOrder.id,second.order.id));
    try{expect(await consumer().processMessage(second.message)).toBe('dead');expect(network).not.toHaveBeenCalled();expect((await immutable(second.id)).dispatch).toHaveLength(0);}
    finally{await f.maintenanceDb.update(storeOrder).set({payPrice:second.order.payPrice}).where(eq(storeOrder.id,second.order.id));}
    expect(calls.uploads()).toBe(0);
  },90000);

  it('reaches the independent App verifier and rejects genuine APP evidence for the same paid pickup root',async()=>{
    const c=await staged(),eventId=randomUUID(),native=envelope(nativeKeys,{appid:CURRENT_APP,mchid:CURRENT_MERCHANT,out_trade_no:c.order.orderId,
      transaction_id:'native_pickup_'+randomUUID().replaceAll('-',''),trade_state:'SUCCESS',trade_type:'APP',success_time:new Date().toISOString(),
      amount:{total:amountToCents(c.order.payPrice),currency:'CNY'}},eventId,{apiV3Key:'b'.repeat(32),platformPublicKeyId:'PUB_SHIPPING_CURRENT'});
    const pay=new WechatPayService(application(),f.env);await expect(pay.verifyAndParseNotify({...native.headers,'wechatpay-signature':'bad'},native.body,'app')).rejects.toThrow();
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE order_no=${c.order.orderId}`)).toHaveLength(0);
    expect(await pay.verifyAndParseNotify(native.headers,native.body,'app')).toMatchObject({outTradeNo:c.order.orderId,tradeState:'SUCCESS'});
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE evidence_id=${'callback:'+eventId}`)).toHaveLength(1);
    const calls=transport(c.order);connections.mockClear();expect(await consumer().processMessage(c.message)).toBe('dead');nativeReached();
    expect(calls.uploads()).toBe(0);expect(network).not.toHaveBeenCalled();expect((await immutable(c.id)).dispatch).toHaveLength(0);
  },90000);

  it('completes a real zero-amount local weixin-label pickup without inventing provider or shipping evidence',async()=>{
    // Actual Admin checkout and actual App local guards, not a crypto callback:
    // zero comes from the locked SQL price and never establishes provider SUCCESS.
    const source=await f.unpaid(11,'0.00',1),order=source.order;
    expect(order).toMatchObject({paid:0,payPrice:'0.00',tradeNo:'',shippingType:2,storeId:1,status:0});
    const result=await applyStoreOrderPayment(application(),{orderId:order.id,payType:'weixin'});
    expect(result).toMatchObject({outcome:'paid',outbox:{eventKey:'order.paid:'+order.id}});
    const event=await paidEvent(order.id);expect(result.outbox?.id).toBe(event.id);
    expect(await actual(order.id)).toMatchObject({paid:1,payType:'weixin',payPrice:'0.00',tradeNo:'',status:0});
    const service=new OrderOutboxService(application(),f.env),message=paidMessage(event);
    expect(await service.processMessage(message)).toBe('completed');expect((await paidEvent(order.id)).status).toBe('COMPLETED');
    const noProviderOrShipping=async()=>{
      expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId}`)).toHaveLength(0);
      expect(await f.maintenanceDb.execute(sql`SELECT dispatch_id FROM public.routine_shipping_dispatch WHERE payload->'identity'->>'rootId'=${String(order.id)}`)).toHaveLength(0);
      expect(await f.maintenanceDb.execute(sql`SELECT e.evidence_id FROM public.routine_shipping_provider_evidence e JOIN public.routine_shipping_dispatch d ON d.dispatch_id=e.dispatch_id
        WHERE d.payload->'identity'->>'rootId'=${String(order.id)}`)).toHaveLength(0);
      expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.orderId,order.id))).toHaveLength(0);
    };
    await noProviderOrShipping();expect(network).not.toHaveBeenCalled();expect(connections).not.toHaveBeenCalled();
    const completed=await f.facts(),saved=await paidEvent(order.id);
    expect(await service.processMessage(message)).toBe('already-completed');expect(await f.facts()).toEqual(completed);expect(await paidEvent(order.id)).toEqual(saved);
    expect(await applyStoreOrderPayment(application(),{orderId:order.id,payType:'weixin'})).toEqual({outcome:'already-paid',outbox:null});
    expect(await f.facts()).toEqual(completed);await noProviderOrShipping();expect(network).not.toHaveBeenCalled();expect(connections).not.toHaveBeenCalled();
  },90000);


  it('uses the real paid Queue helper to enqueue and upload a committed pickup immediately',async()=>{
    const source=await capturePaid(),ack=vi.fn(),retry=vi.fn(),before=f.messages.length,notifications=consumer();
    await consumeOrderPaidOutboxQueueMessage({body:paidMessage(source.event),attempts:1,ack,retry},
      new OrderOutboxService(application(),f.env),notifications);
    expect(ack).toHaveBeenCalledOnce();expect(retry).not.toHaveBeenCalled();expect((await paidEvent(source.order.id)).status).toBe('COMPLETED');
    const rows=await f.maintenanceDb.select().from(orderNotificationDelivery)
      .where(and(eq(orderNotificationDelivery.eventKey,source.event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({outboxId:source.event.id,orderId:source.order.id,
      status:'ENQUEUED',noticeMark:'paid_pickup_shipping',target:'',payload:{logisticsType:4,deliveryMode:1}});
    const messages=f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(message=>message.deliveryId===rows[0].id);
    expect(messages).toHaveLength(1);expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);
    expect(messages[0]).toMatchObject({action:'processOrderNotificationDelivery',eventKey:source.event.eventKey,channel:'wechat_shipping'});
    noSecrets(messages);expect(network).not.toHaveBeenCalled();
    const calls=transport(await actual(source.order.id));
    expect(await notifications.processMessage(messages[0])).toBe('sent');expect(calls.uploads()).toBe(1);nativeReached();
    expect(await delivery(rows[0].id)).toMatchObject({status:'SENT',responseCode:'0'});const first=await immutable(rows[0].id);
    expect(first.dispatch).toHaveLength(1);expect(first.evidence).toHaveLength(1);
    const facts=await f.facts(),secondAck=vi.fn(),secondRetry=vi.fn();
    await consumeOrderPaidOutboxQueueMessage({body:paidMessage(source.event),attempts:2,ack:secondAck,retry:secondRetry},
      new OrderOutboxService(application(),f.env),notifications);
    expect(secondAck).toHaveBeenCalledOnce();expect(secondRetry).not.toHaveBeenCalled();expect(await f.facts()).toEqual(facts);
    expect(await immutable(rows[0].id)).toEqual(first);expect(calls.uploads()).toBe(1);
  },90000);

});
