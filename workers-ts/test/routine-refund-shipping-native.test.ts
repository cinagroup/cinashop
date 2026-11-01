/** Actual express checkout -> verified original payment -> Financial quantity refund
 * -> signed SUCCESS/atomic materialization -> real Admin remaining delivery -> Queue
 * first shipping. Owned PG16 LOGINs; only external transport/KV/Queue are local. */
import { createCipheriv, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderOutbox, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderRefundSplit, storeProduct, storeProductAttrValue, systemConfig, user, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { upgradeFulfillmentCityConflictReaders } from '@/migrations/upgradeFulfillmentCityConflictReaders';
import { inspectFulfillmentCityConflictReader, type FulfillmentCityConflictReadersAddon } from '@/migrations/fulfillmentCityConflictReader';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment,
  type RoutineShippingAccountPolicy } from '@/services/payment/RoutineShippingAccount';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { isOrderNotificationDeliveryMessage, OrderNotificationDeliveryService } from '@/services/order/OrderNotificationDeliveryService';
import { amountToCents } from '@/services/payment/RefundGateway';
import type { RoutineRefundShippingDispatch, RoutineShippingRequest } from '@/services/payment/RoutineShippingDispatch';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { appendRoutineRefundAccountPolicy, type RoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_QUOTE_VERSION, CUSTOMER_FINANCIAL_VERSION, type FinancialContext, type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '@/services/customer-work/CustomerWorkOperationRequest';
import { shippingMac } from '@/services/payment/RoutineShippingAccount';

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys = ReturnType<typeof paymentQueryKeys>;
const APP='wx_shipping_original',MERCHANT='1900000101',ACCOUNT='shipping_payment_original',REF='shipping_payment_materials';
const CURRENT_APP='wx_shipping_current_b',CURRENT_MERCHANT='1900000102',PLATFORM='PUB_SHIPPING_ORIGINAL',AES='s'.repeat(32);
const PAYER='shipping_real_payer_not_buyer_binding',BUYER_BINDING='shipping_unrelated_latest_buyer_binding',SECRET='synthetic-archived-shipping-secret-A';
const SHIPPING_REF='shipping_archived_appsecret',ORIGIN='https://refund-shipping.example';

function envelope(keys:Keys,payload:unknown,eventId=randomUUID(),materials={apiV3Key:AES,platformPublicKeyId:PLATFORM}){
  const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction';
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(materials.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const body=JSON.stringify({id:eventId,event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',
    original_type:'transaction',ciphertext,nonce,associated_data:associated}}),timestamp=String(Math.floor(Date.now()/1000));
  return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':materials.platformPublicKeyId,
    'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('completed refund generation first original Routine shipping',()=>{
  let f:Fixture,keys:Keys,nativeKeys:Keys,paymentRegistry='',shippingRegistry='',policy:RoutineShippingAccountPolicy,revision=0,state:'active'|'revoked'='active';
  let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>,connections:MockInstance<typeof Di.createDbFromConnectionString>;
  let service:CustomerWorkFinancialService,refundPolicy:RoutineRefundAccountPolicy,refundRevision=0,refundState:'active'|'revoked'='active';
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
  async function paid(quantity=1){
    // Same real Admin cart/confirmation/create producer as f.unpaid, requesting
    // delivery address 11 instead of its fixed self-pickup selection. Neither
    // paid, isChannel nor an original/dispatch receipt is seeded or rewritten.
    const cart=await admin('/admin/order/cart/add/11',{tourist_uid:'',productId:70,uniqueId:'qared001',cartNum:quantity,new:1});
    const selection={cartId:[cart.cartId],tourist_uid:'',new:1,shipping_type:1,store_id:1,addressId:11,
      real_name:'',phone:'',payType:'cash',useIntegral:false,couponId:0,from:'pc'};
    const quote=await admin('/admin/order/confirm/11',selection);
    const created=await admin('/admin/order/create/'+quote.orderKey+'/11',{...selection,quoteToken:quote.quoteToken});
    const row=await f.container.storeOrderDao.findByOrderId(created.result.order_id);if(!row)throw Error('Actual unpaid delivery root absent');
    expect(row).toMatchObject({paid:0,shippingType:1,isChannel:2,uid:11,status:0});
    const total=amountToCents(row.payPrice);if(total===null||total<=0)throw Error('Actual checkout amount unavailable');
    const transactionId='shipping_tx_'+randomUUID().replaceAll('-',''),before=f.messages.length;
    await notify(envelope(keys,{appid:APP,mchid:MERCHANT,out_trade_no:row.orderId,transaction_id:transactionId,trade_state:'SUCCESS',trade_type:'JSAPI',
      payer:{openid:PAYER},success_time:new Date().toISOString(),amount:{total,currency:'CNY'}}));
    const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();
    expect(await new PaymentCallbackEventService(application(),f.env).processMessage(message!)).toBe('completed');
    const result=await actual(row.id);expect(result).toMatchObject({paid:1,payType:'weixin',tradeNo:transactionId,isChannel:2,shippingType:1});
    const originals=await f.maintenanceDb.execute<{row:unknown}>(sql`SELECT pg_catalog.to_jsonb(t) AS row FROM public.routine_original_payment_evidence t WHERE order_no=${row.orderId}`);
    expect(originals).toHaveLength(1);expect(parseRoutineOriginalEvidence(f.env,originals[0].row)).toMatchObject({payload:{binding:{state:'bound',local:{domain:'store_order',orderId:row.id,buyerUid:11}},
      observation:{facts:{payerId:PAYER,appId:APP,merchantId:MERCHANT,tradeType:'JSAPI',tradeState:'SUCCESS'}}}});
    const [outbox]=await f.maintenanceDb.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey}).from(storeOrderOutbox)
      .where(and(eq(storeOrderOutbox.aggregateId,row.id),eq(storeOrderOutbox.eventType,'order.paid')));
    if(!outbox)throw Error('Actual paid outbox absent');await f.consume(outbox);return actual(row.id);
  }
  async function stageNotice(order:typeof storeOrder.$inferSelect,root=order){
    const events=await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,order.id),eq(storeOrderOutbox.eventType,'order.delivery.notice')));
    expect(events).toHaveLength(1);const event=events[0];
    expect(await new OrderOutboxService(application(),f.env).processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('completed');
    const rows=await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey,event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'PENDING',target:'',orderId:order.id,
      payload:{kind:'wechat_shipping',transactionId:root.tradeNo}});
    expect(event.payload).toMatchObject({orderId:order.id,orderNo:order.orderId,userId:root.uid});
    const before=f.messages.length,dispatched=await consumer().dispatchPending(20,event.eventKey);expect(dispatched.enqueued).toBeGreaterThan(0);
    const messages=f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m=>m.channel==='wechat_shipping');
    expect(messages).toHaveLength(1);expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);
    noSecrets(messages);return{order,root,message:messages[0],id:rows[0].id};
  }
  const input=async(payload:CustomerJson,id:number):Promise<FinancialInput>=>{
    const order=await actual(id),scope=await authorizeCustomerWorkActor(f.financialRuntime.db,f.actor()),revisions=await financialRevisions(f.financialRuntime.db,order);
    return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:id,expected_order_revision:revisions.order_revision,
      expected_financial_revision:revisions.financial_revision,payload};
  };
  const approveRefund=async(next:'active'|'revoked'='active')=>{
    const receipt=await appendRoutineRefundAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:refundRevision,data:{...refundPolicy,state:next}});
    refundRevision=receipt.revision;refundState=next;
  };
  async function requestRefund(orderId:number,quantity=1){
    const rows=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,orderId));expect(rows).toHaveLength(1);
    const items=[{cart_row_id:rows[0].id,cart_num:quantity}],base=await input({},orderId);
    const quote=(await service.reader.quote(f.actor(),{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:base.scope_key,order_id:orderId,
      expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,mode:'items',items})).data;
    const context:FinancialContext={actor:f.actor(),request_key:randomUUID()};
    const created=await service.create({actor:f.actor(),request_key:randomUUID()},await input({mode:'items',items,quoted_price:quote.quoted_price,
      refund_price:quote.quoted_price,quote_fingerprint:quote.quote_fingerprint,reason:'真实退款后的余单履约'},orderId));
    expect(created.receipt?.outcome).toBe('refund-created');
    const id=Number(created.receipt!.evidence.refund_id),[row]=await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id));
    const review=(await service.reader.review(f.actor(),id,{refund_no:row.orderId})).data;
    const body=await input({refund_id:id,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,
      decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false},refund_price:review.refund_price},orderId);
    return{id,context,body};
  }
  type RefundCall=Awaited<ReturnType<typeof requestRefund>>;
  async function executeRefund(c:RefundCall,status:'PROCESSING'|'SUCCESS'){
    network.mockImplementation(async(url,init)=>{
      const rows=await f.maintenanceDb.execute<{out_refund_no:string;payload:{request:{outTradeNo:string;transactionId:string;refundAmount:number;totalAmount:number}}}>(
        sql`SELECT out_refund_no,payload FROM public.routine_refund_dispatch WHERE refund_id=${c.id}`);expect(rows).toHaveLength(1);const d=rows[0];
      const u=new URL(String(url));expect(u.origin).toBe('https://api.mch.weixin.qq.com');expect(init?.method).toBe(status==='SUCCESS'?'GET':'POST');
      const auth=new Headers(init?.headers).get('Authorization')??'',fields=Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(m=>[m[1],m[2]]));
      expect(fields.mchid).toBe(MERCHANT);expect(fields.serial_no).toBe('A1B2C3D4');
      const bytes=Buffer.from(`${init!.method}\n${u.pathname}${u.search}\n${fields.timestamp}\n${fields.nonce_str}\n${typeof init!.body==='string'?init!.body:''}\n`);
      expect(verify('RSA-SHA256',bytes,keys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(true);
      expect(verify('RSA-SHA256',bytes,nativeKeys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(false);
      await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
        expect(await tx.execute(sql`SELECT id FROM public.store_order WHERE order_id=${d.payload.request.outTradeNo} FOR UPDATE NOWAIT`)).toHaveLength(1);
        expect(await tx.execute(sql`SELECT id FROM public.store_order_refund WHERE id=${c.id} FOR UPDATE NOWAIT`)).toHaveLength(1);
        const [idle]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity
          WHERE usename IN(${f.appRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);expect(idle.n).toBe(0);
      }));
      const body=JSON.stringify({mchid:MERCHANT,out_trade_no:d.payload.request.outTradeNo,transaction_id:d.payload.request.transactionId,
        out_refund_no:d.out_refund_no,refund_id:'provider_'+d.out_refund_no,status,...(status==='SUCCESS'?{success_time:new Date().toISOString()}:{}),
        amount:{refund:d.payload.request.refundAmount,total:d.payload.request.totalAmount,currency:'CNY'}});
      const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();return new Response(body,{status:200,headers:{'Content-Type':'application/json',
        'Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':nonce,'Wechatpay-Serial':PLATFORM,
        'Wechatpay-Signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}});
    });
    const result=await service.execute('refund_execute',c.context,c.body);
    expect(result.execution).toMatchObject({status,completed:status==='SUCCESS'});noSecrets(result);return result;
  }
  async function completedRefund(orderId:number){
    const c=await requestRefund(orderId);await executeRefund(c,'PROCESSING');await executeRefund(c,'SUCCESS');
    const [receipt]=await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,c.id));
    expect(receipt).toMatchObject({disposition:'split'});expect(receipt.remainingOrderId).toBeGreaterThan(0);
    expect((await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,c.id)))[0]).toMatchObject({provider:'wechat',providerStatus:'SUCCESS'});
    return{...c,receipt,remaining:await actual(receipt.remainingOrderId!)};
  }
  async function deliver(orderId:number,root:typeof storeOrder.$inferSelect,tracking='REMAIN-'+orderId){
    const before=await actual(orderId);await admin('/admin/order/delivery/'+before.orderId,{delivery_type:'express',delivery_name:'本机真实承运商',delivery_id:tracking});
    return stageNotice(await actual(orderId),await actual(root.id));
  }
  async function splitDelivery(orderId:number,tracking:string){
    const carts=await admin('/admin/order/split_cart_info/'+orderId,undefined,'GET') as Array<{cart_id:string;surplus_num:number}>;expect(carts).toHaveLength(1);
    const before=await actual(orderId),rootId=before.pid>0?before.pid:before.id;
    expect(await admin('/admin/order/split_delivery/'+orderId,{type:1,express_record_type:1,delivery_name:'本机真实承运商',delivery_id:tracking,
      cart_ids:[{cart_id:carts[0].cart_id,cart_num:1}]},'PUT')).toBe('SUCCESS');
    const family=await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.pid,rootId));
    const selected=family.find(o=>o.deliveryId===tracking&&o.status===1),remaining=family.find(o=>o.status===0&&o.refundType!==6);
    expect(selected).toBeDefined();expect(remaining).toBeDefined();return{selected:selected!,remaining:remaining!,root:await actual(rootId)};
  }
  const journal=async(deliveryId:number)=>Array.from(await f.maintenanceDb.execute<{dispatch_id:string;source_key:string;payload:RoutineRefundShippingDispatch['payload'];created_at:string;signature:string}>(
    sql`SELECT * FROM public.routine_shipping_dispatch WHERE delivery_id=${deliveryId}`));
  const immutable=async(deliveryId:number)=>({dispatch:Array.from(await f.maintenanceDb.execute(sql`SELECT to_jsonb(d) AS row,xmin::text AS xmin FROM public.routine_shipping_dispatch d WHERE delivery_id=${deliveryId}`)),
    evidence:Array.from(await f.maintenanceDb.execute(sql`SELECT to_jsonb(e) AS row,e.xmin::text AS xmin FROM public.routine_shipping_provider_evidence e
      JOIN public.routine_shipping_dispatch d ON d.dispatch_id=e.dispatch_id WHERE d.delivery_id=${deliveryId} ORDER BY e.evidence_id`))});
  function transport(root:typeof storeOrder.$inferSelect,options:{lost?:boolean;beforeCarriers?:()=>Promise<void>}={}){
    const bodies:RoutineShippingRequest[]=[];let calls=0;
    network.mockReset().mockImplementation(async(url,init)=>{
      calls++;const u=new URL(String(url));expect(u.origin).toBe('https://api.weixin.qq.com');
      if(u.pathname==='/cgi-bin/token'){expect(u.searchParams.get('appid')).toBe(APP);expect(u.searchParams.get('secret')).toBe(SECRET);
        return Response.json({access_token:'synthetic-refund-shipping-token-A',expires_in:7200});}
      expect(u.searchParams.get('access_token')).toBe('synthetic-refund-shipping-token-A');expect(init?.method).toBe('POST');
      if(u.pathname.endsWith('/get_delivery_list')){await options.beforeCarriers?.();return Response.json({errcode:0,errmsg:'ok',count:1,delivery_list:[{delivery_id:'OWN',delivery_name:'本机真实承运商'}]});}
      expect(u.pathname).toBe('/wxa/sec/order/upload_shipping_info');const body=JSON.parse(String(init?.body)) as RoutineShippingRequest;bodies.push(body);
      expect(body).toMatchObject({order_key:{transaction_id:root.tradeNo},payer:{openid:PAYER},logistics_type:1});expect(JSON.stringify(body)).not.toContain(BUYER_BINDING);
      await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
        const family=await tx.execute<{id:number}>(sql`SELECT id FROM public.store_order WHERE id=${root.id} OR pid=${root.id} ORDER BY id FOR UPDATE NOWAIT`);expect(family.length).toBeGreaterThan(1);
        await tx.execute(sql`SELECT id FROM public.store_order_refund WHERE store_order_id=ANY(ARRAY(SELECT id FROM public.store_order WHERE id=${root.id} OR pid=${root.id})) FOR UPDATE NOWAIT`);
        const [idle]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename IN(${f.appRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);expect(idle.n).toBe(0);
      }));
      if(options.lost)throw Error('Synthetic lost shipping response');return Response.json({errcode:0,errmsg:'ok'});
    });
    return{bodies,calls:()=>calls};
  }
  beforeAll(async()=>{
    keys=paymentQueryKeys();nativeKeys=paymentQueryKeys();network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unplanned provider transport'));
    for(const name of['log','warn','error'] as const)vi.spyOn(console,name).mockImplementation((...args:unknown[])=>{logs.push(args);});
    f=await customerCashierRuntimeHttpFixture();
    await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    await runRoutineRefundUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
    const {peers}=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,
      {routineRefund:{routineRefund:true},manualRefund:f.manual,originalPaymentReaders:f.readers},f.peers,f.appReaders);
    await runRoutineShippingUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
    await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
    // Last formal forward: the source, NativeApp and shipping installers above
    // receive their complete original five-profile/App-reader declarations.
    // No GRANT is performed by this fixture or by any runtime path.
    const cityOwner=await f.createOwnedRole('cityship');
    const readers:FulfillmentCityConflictReadersAddon={owner:cityOwner.role,app:true,admin:true,manager:true};
    const commissioned=await upgradeFulfillmentCityConflictReaders(f.maintenanceDb,f.target,{readers},
      {...peers,cityConflictReaders:readers},f.appReaders);
    expect(commissioned).toMatchObject({applied:true,readers,peers:{cityConflictReaders:readers}});
    expect(await inspectFulfillmentCityConflictReader(f.maintenanceDb)).toMatchObject({ready:true,
      binding:{owner:cityOwner.role,actors:{app:true,admin:true,manager:true}}});
    for(const peer of[f.appRuntime,f.adminRuntime,f.managerRuntime]){
      await expect(peer.db.execute(sql`SELECT id FROM public.customer_city_delivery_job LIMIT 0`)).rejects.toMatchObject({cause:{code:'42501'}});
    }
    await f.maintenanceDb.update(storeProduct).set({productType:0,stock:40,freight:1,isVip:0}).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({stock:40,price:'5.00',vipPrice:'5.00'}).where(eq(storeProductAttrValue.id,1));
    await f.maintenanceDb.insert(user).values({uid:22,account:'owned-shipping-payer',pwd:'owned-shipping-payer-password',status:1,nowMoney:'23.00'}).onConflictDoNothing();
    await f.maintenanceDb.insert(wechatUser).values([{uid:22,userType:'routine',openid:PAYER},{uid:11,userType:'routine',openid:BUYER_BINDING}]);
    paymentRegistry=JSON.stringify({format:1,credentials:[{ref:REF,version:1,appId:APP,merchantId:MERCHANT,serialNo:'A1B2C3D4',apiV3Key:AES,
      privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:PLATFORM}]});
    shippingRegistry=JSON.stringify({format:1,credentials:[{ref:SHIPPING_REF,version:1,appId:APP,secret:SECRET}]});
    Object.assign(f.env,{ROUTINE_REFUND_NOTIFY_ORIGIN:ORIGIN,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:paymentRegistry,ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:shippingRegistry,
      WECHAT_MCH_PRIVATE_KEY:nativeKeys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:nativeKeys.publicKey,WECHAT_PLATFORM_PUBLIC_KEY_ID:'PUB_SHIPPING_CURRENT',WECHAT_API_V3_KEY:'b'.repeat(32)});
    await current();const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(f.env,REF,1);
    await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',
      data:{accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600}});
    policy={accountId:routineShippingAccountId(f.env,APP,MERCHANT),state:'active',appId:APP,merchantId:MERCHANT,credentialRef:SHIPPING_REF,credentialVersion:1,
      credentialStamp:routineShippingCredentialCommitment(f.env,SHIPPING_REF,1).credentialStamp,purposes:['shipping_upload'],validFrom:now-60,validUntil:now+3600};
    refundPolicy={accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,
      purposes:['refund_request','refund_query','refund_notify'],validFrom:now-60,validUntil:now+3600};
    await approveRefund();service=new CustomerWorkFinancialService(f.container,f.env);
    await approve();connections=vi.spyOn(Di,'createDbFromConnectionString');
  },180000);
  beforeEach(async()=>{network.mockReset().mockRejectedValue(Error('Unplanned provider transport'));connections.mockClear();
    f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=paymentRegistry;f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=shippingRegistry;if(state==='revoked')await approve();if(refundState==='revoked')await approveRefund();await current();});
  afterEach(()=>{noSecrets(logs);noSecrets(f.messages);});
  afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);


  it('ships the genuine remaining order once after signed refund SUCCESS, retaining the original total and PHP completion flag',async()=>{
    const bindings=await f.maintenanceDb.select().from(wechatUser),[payer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,22));
    const root=await paid(2),r=await completedRefund(root.id);
    expect(await actual(root.id)).toMatchObject({pid:-1,payPrice:'10.00'});
    expect(await actual(r.receipt.selectedOrderId)).toMatchObject({refundStatus:2,refundType:6,status:0});
    await approveRefund('revoked');const c=await deliver(r.remaining.id,root),calls=transport(root);
    expect(await consumer().processMessage(c.message)).toBe('sent');expect(calls.bodies).toHaveLength(1);
    expect(calls.bodies[0]).toMatchObject({delivery_mode:2,is_all_delivered:false,shipping_list:[{tracking_no:'REMAIN-'+r.remaining.id,express_company:'OWN'}]});
    const rows=await journal(c.id);expect(rows).toHaveLength(1);const d=rows[0];
    expect(d.payload).toMatchObject({format:3,identity:{rootId:root.id,totalAmount:1000,payerId:PAYER},refundGeneration:{format:1,
      payment:{rootId:root.id,totalAmount:1000},activeOrderIds:[r.remaining.id],retiredOrderIds:[r.receipt.selectedOrderId]}});
    expect(d.payload.refundGeneration.refunds).toHaveLength(1);expect(d.payload.packages.map(p=>p.orderId)).toEqual([r.remaining.id]);
    const i=d.payload.identity;expect(d.source_key).toBe(shippingMac(f.env,'payment-source',[i.rootId,i.buyerUid,i.orderNo,i.transactionId,i.totalAmount,i.appId,i.merchantId,i.payerId]));
    const stable=await immutable(c.id);expect(stable.evidence).toHaveLength(1);await approve('revoked');f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=undefined;
    expect(await consumer().processMessage(c.message)).toBe('already-sent');expect(await immutable(c.id)).toEqual(stable);expect(calls.bodies).toHaveLength(1);
    expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
    expect(connections.mock.calls.some(c=>c[2]?.applicationName==='cinashop_routine_refund_verify')).toBe(true);
    expect(connections.mock.calls.some(c=>c[2]?.applicationName==='cinashop_routine_shipping_verify')).toBe(true);
  },90000);

  it('proves two actual refund generations before the first remaining-order upload',async()=>{
    const root=await paid(3),first=await completedRefund(root.id),second=await completedRefund(first.remaining.id),c=await deliver(second.remaining.id,root),calls=transport(root);
    expect(await consumer().processMessage(c.message)).toBe('sent');expect(calls.bodies).toHaveLength(1);
    const [d]=await journal(c.id);expect(d.payload.format).toBe(3);expect(d.payload.identity.totalAmount).toBe(1500);
    expect(d.payload.refundGeneration.refunds.map(r=>r.refundId)).toEqual([first.id,second.id]);
    expect(d.payload.refundGeneration.retiredOrderIds).toEqual([first.receipt.selectedOrderId,second.receipt.selectedOrderId].sort((a,b)=>a-b));
    expect(d.payload.refundGeneration.activeOrderIds).toEqual([second.remaining.id]);expect(calls.bodies[0].is_all_delivered).toBe(false);
  },90000);

  it('preserves refund generations through actual remaining-order fulfillment branches and accepted package extension',async()=>{
    const root=await paid(3),r=await completedRefund(root.id),split=await splitDelivery(r.remaining.id,'REFUND-PART-A-'+root.id);
    const first=await stageNotice(split.selected,split.root),a=transport(root);expect(await consumer().processMessage(first.message)).toBe('sent');
    expect(a.bodies[0]).toMatchObject({delivery_mode:2,is_all_delivered:false});const [one]=await journal(first.id);expect(one.payload.refundGeneration.branches).toHaveLength(2);
    const [clock]=await f.maintenanceDb.execute<{now:number}>(sql`SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::integer AS now`);
    if(clock.now<=Number(one.created_at))await new Promise(resolve=>setTimeout(resolve,1100));
    const second=await deliver(split.remaining.id,root,'REFUND-PART-B-'+root.id),b=transport(root);expect(await consumer().processMessage(second.message)).toBe('sent');
    const [two]=await journal(second.id);expect(two.source_key).toBe(one.source_key);expect(two.payload.previousDispatchId).toBe(one.dispatch_id);
    expect(two.payload.refundGeneration).toEqual(one.payload.refundGeneration);expect(b.bodies[0].shipping_list).toHaveLength(2);
    expect(b.bodies[0].is_all_delivered).toBe(false);
  },90000);

  it('keeps a lost post UNKNOWN across duplicate Queue messages and ordinary recovery scanning',async()=>{
    const root=await paid(2),r=await completedRefund(root.id),c=await deliver(r.remaining.id,root),calls=transport(root,{lost:true});
    expect(await consumer().processMessage(c.message)).toBe('unknown');const stable=await immutable(c.id);
    expect(stable.dispatch).toHaveLength(1);expect(stable.evidence).toHaveLength(0);expect(calls.bodies).toHaveLength(1);
    expect(await consumer().processMessage(c.message)).toBe('unknown');expect((await consumer().dispatchPending(20,c.message.eventKey)).enqueued).toBe(0);
    expect(calls.bodies).toHaveLength(1);expect(await immutable(c.id)).toEqual(stable);
  },90000);

  it('does not create a new-format source to bypass a prior original-payment UNKNOWN',async()=>{
    const root=await paid(3),split=await splitDelivery(root.id,'BEFORE-REFUND-'+root.id),first=await stageNotice(split.selected,split.root);
    // This first intent is the historical format1 path, before any refund.
    const a=transport(root,{lost:true});expect(await consumer().processMessage(first.message)).toBe('unknown');const previous=await immutable(first.id);expect(a.bodies).toHaveLength(1);
    const r=await completedRefund(split.remaining.id),c=await deliver(r.remaining.id,root),b=transport(root);
    expect(await consumer().processMessage(c.message)).toBe('retry-scheduled');expect(b.bodies).toHaveLength(0);expect(await journal(c.id)).toHaveLength(0);
    expect(await immutable(first.id)).toEqual(previous);expect(await delivery(first.id)).toMatchObject({status:'UNKNOWN'});
  },90000);

  it('refuses changed generation facts between carrier lookup and admission before creating an intent or POST',async()=>{
    const root=await paid(2),r=await completedRefund(root.id),c=await deliver(r.remaining.id,root);
    const [cart]=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,r.remaining.id));
    const calls=transport(root,{beforeCarriers:async()=>{await f.maintenanceDb.update(storeOrderCartInfo).set({cartNum:cart.cartNum+1}).where(eq(storeOrderCartInfo.id,cart.id));}});
    try{expect(await consumer().processMessage(c.message)).toBe('dead');expect(calls.bodies).toHaveLength(0);expect(calls.calls()).toBeGreaterThan(0);expect(await journal(c.id)).toHaveLength(0);}
    finally{await f.maintenanceDb.update(storeOrderCartInfo).set({cartNum:cart.cartNum}).where(eq(storeOrderCartInfo.id,cart.id));}
  },90000);
  it('does not treat a genuine PROCESSING refund as a retired physical partition',async()=>{
    const root=await paid(3),first=await completedRefund(root.id),c=await deliver(first.remaining.id,root),r=await requestRefund(first.remaining.id);await executeRefund(r,'PROCESSING');
    expect(await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,r.id))).toHaveLength(0);
    const calls=transport(root);expect(await consumer().processMessage(c.message)).toBe('dead');expect(calls.calls()).toBe(0);
    expect(calls.bodies).toHaveLength(0);expect(await journal(c.id)).toHaveLength(0);
  },90000);

  it('requires durable provider SUCCESS in addition to materialization and completed scalar flags',async()=>{
    const root=await paid(2),r=await completedRefund(root.id),c=await deliver(r.remaining.id,root);
    const [before]=await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,r.id));
    await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:'PROCESSING'}).where(eq(storeOrderRefundPayment.refundId,r.id));
    const calls=transport(root);
    try{expect(await consumer().processMessage(c.message)).toBe('dead');expect(calls.calls()).toBe(0);expect(await journal(c.id)).toHaveLength(0);}
    finally{await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:before.providerStatus}).where(eq(storeOrderRefundPayment.refundId,r.id));}
  },90000);

  it('preserves the actual Financial refusal of zero cash for a positively priced original WeChat item',async()=>{
    const root=await paid(2),[cart]=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id));
    const items=[{cart_row_id:cart.id,cart_num:1}],base=await input({},root.id);
    const quote=(await service.reader.quote(f.actor(),{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:base.scope_key,order_id:root.id,
      expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,mode:'items',items})).data;
    expect(quote.quoted_price).toBe('5.00');
    const facts=async()=>({order:await actual(root.id),carts:await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id)),
      refunds:await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,root.id)),
      payments:await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.storeOrderId,root.id)),
      materialization:await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.paymentOrderId,root.id)),
      users:await f.maintenanceDb.select().from(user).where(inArray(user.uid,[11,22]))});
    const before=await facts();network.mockReset().mockRejectedValue(Error('No provider refund for rejected zero amount'));
    const created=await service.create({actor:f.actor(),request_key:randomUUID()},await input({mode:'items',items,quoted_price:quote.quoted_price,
      refund_price:'0.00',quote_fingerprint:quote.quote_fingerprint,reason:'保持现有正价商品零退款禁令'},root.id));
    expect(created.receipt?.outcome).toBe('rollback-rejected');expect(await facts()).toEqual(before);expect(network).not.toHaveBeenCalled();noSecrets(created);
  },90000);

});
