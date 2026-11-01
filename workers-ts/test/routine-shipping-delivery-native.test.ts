/** Owned PG16 five LOGINs, actual assisted checkout, RSA/AES payment capture,
 * paid/delivery outboxes and production Queue shipping consumer. Only provider,
 * internal KV and Queue transports are local; no historical account is adopted. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { orderNotificationDelivery, storeOrder, storeOrderOutbox, storeProduct, storeProductAttrValue, systemConfig, user, wechatUser } from '@/models/schema';
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
import { isOrderNotificationDeliveryMessage, OrderNotificationDeliveryService } from '@/services/order/OrderNotificationDeliveryService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { amountToCents } from '@/services/payment/RefundGateway';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys = ReturnType<typeof paymentQueryKeys>;
const APP='wx_shipping_original',MERCHANT='1900000101',ACCOUNT='shipping_payment_original',REF='shipping_payment_materials';
const CURRENT_APP='wx_shipping_current_b',CURRENT_MERCHANT='1900000102',PLATFORM='PUB_SHIPPING_ORIGINAL',AES='s'.repeat(32);
const PAYER='shipping_real_payer_not_buyer_binding',BUYER_BINDING='shipping_unrelated_latest_buyer_binding',SECRET='synthetic-archived-shipping-secret-A';
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual original Routine shipping through delivery outbox and Queue',()=>{
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
  const admin=async(path:string,body:unknown)=>{
    const token=(await createToken(1,'admin',md5('offline-native-admin-password'),f.env.APP_KEY)).token;
    const response=await f.raw(path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
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
  async function paid(){
    // Same real Admin cart/confirmation/create producer as f.unpaid, requesting
    // delivery address 11 instead of its fixed self-pickup selection. Neither
    // paid, isChannel nor an original/dispatch receipt is seeded or rewritten.
    const cart=await admin('/admin/order/cart/add/11',{tourist_uid:'',productId:70,uniqueId:'qared001',cartNum:1,new:1});
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
    if(!outbox)throw Error('Actual paid outbox absent');await f.consume(outbox);return result;
  }
  async function staged(){
    const order=await paid();await admin('/admin/order/delivery/'+order.orderId,{delivery_type:'express',delivery_name:'本机真实承运商',delivery_id:'SHIP-'+order.id});
    const events=await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,order.id),eq(storeOrderOutbox.eventType,'order.delivery.notice')));
    expect(events).toHaveLength(1);const event=events[0];
    expect(await new OrderOutboxService(application(),f.env).processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('completed');
    const rows=await f.maintenanceDb.select().from(orderNotificationDelivery).where(and(eq(orderNotificationDelivery.eventKey,event.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping')));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'PENDING',target:'',orderId:order.id});
    const before=f.messages.length,dispatched=await consumer().dispatchPending(20,event.eventKey);expect(dispatched.enqueued).toBeGreaterThan(0);
    const messages=f.messages.slice(before).filter(isOrderNotificationDeliveryMessage).filter(m=>m.channel==='wechat_shipping');
    expect(messages).toHaveLength(1);expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);
    noSecrets(messages);return{order,message:messages[0],id:rows[0].id};
  }
  const immutable=async(id:number)=>({dispatch:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,xmin::text AS xmin
      FROM public.routine_shipping_dispatch t WHERE delivery_id=${id}`)),
    evidence:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(e) AS row,e.xmin::text AS xmin
      FROM public.routine_shipping_provider_evidence e JOIN public.routine_shipping_dispatch d ON d.dispatch_id=e.dispatch_id WHERE d.delivery_id=${id} ORDER BY e.evidence_id`))});
  function transport(order:typeof storeOrder.$inferSelect,onUpload?:()=>Promise<Response>){
    let uploads=0,tokens=0,carriers=0;
    network.mockImplementation(async(input,init)=>{
      const url=new URL(String(input));expect(url.origin).toBe('https://api.weixin.qq.com');
      if(url.pathname==='/cgi-bin/token'){tokens++;expect(url.searchParams.get('appid')).toBe(APP);expect(url.searchParams.get('secret')).toBe(SECRET);
        return Response.json({access_token:'synthetic-shipping-access-A',expires_in:7200});}
      expect(url.searchParams.get('access_token')).toBe('synthetic-shipping-access-A');expect(init?.method).toBe('POST');
      if(url.pathname.endsWith('/get_delivery_list')){carriers++;return Response.json({errcode:0,errmsg:'ok',count:1,delivery_list:[{delivery_id:'OWN',delivery_name:'本机真实承运商'}]});}
      expect(url.pathname).toBe('/wxa/sec/order/upload_shipping_info');uploads++;
      const body=JSON.parse(String(init?.body));expect(body).toMatchObject({order_key:{order_number_type:2,transaction_id:order.tradeNo},payer:{openid:PAYER},
        logistics_type:1,delivery_mode:1,shipping_list:[{tracking_no:'SHIP-'+order.id,express_company:'OWN'}]});
      expect(JSON.stringify(body)).not.toContain(BUYER_BINDING);expect(body.shipping_list).toHaveLength(1);
      await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
        expect(await tx.execute(sql`SELECT id FROM public.store_order WHERE id=${order.id} FOR UPDATE NOWAIT`)).toHaveLength(1);
        expect(await tx.execute(sql`SELECT id FROM public.order_notification_delivery WHERE order_id=${order.id} AND channel='wechat_shipping' FOR UPDATE NOWAIT`)).toHaveLength(1);
        const [idle]=await tx.execute<{n:number}>(sql`SELECT pg_catalog.count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename=${f.appRuntime.role} AND state='idle in transaction'`);
        expect(idle.n).toBe(0);
      }));
      return onUpload?onUpload():Response.json({errcode:0,errmsg:'ok'});
    });
    return{uploads:()=>uploads,tokens:()=>tokens,carriers:()=>carriers};
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

  it('uses verified payer A rather than latest buyer binding, uploads outside SQL and preserves SENT after retirement',async()=>{
    const bindings=await f.maintenanceDb.select().from(wechatUser),[payer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,22));
    const c=await staged(),calls=transport(c.order);expect(await consumer().processMessage(c.message)).toBe('sent');nativeReached();
    expect(calls.uploads()).toBe(1);expect(calls.carriers()).toBe(1);expect(await delivery(c.id)).toMatchObject({status:'SENT',responseCode:'0'});
    const first=await immutable(c.id);expect(first.dispatch).toHaveLength(1);expect(first.evidence).toHaveLength(1);
    await approve('revoked');f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=undefined;await current(true);
    expect(await consumer().processMessage(c.message)).toBe('already-sent');expect(await immutable(c.id)).toEqual(first);expect(calls.uploads()).toBe(1);
    expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
  },90000);

  it('durably accepts genuine success with an App clock thirty seconds ahead of PostgreSQL and current config empty',async()=>{
    const c=await staged();await current(true);const calls=transport(c.order),clock=vi.spyOn(Date,'now'),base=Date.now();clock.mockImplementation(()=>base+30000);
    try{expect(await consumer().processMessage(c.message)).toBe('sent');expect(calls.uploads()).toBe(1);expect(await delivery(c.id)).toMatchObject({status:'SENT'});
      expect((await immutable(c.id)).evidence).toHaveLength(1);nativeReached();}finally{clock.mockRestore();}
  },90000);

  it('keeps a lost POST UNKNOWN and never sends it again on duplicate Queue messages or dispatch scanning',async()=>{
    const c=await staged(),calls=transport(c.order,async()=>{throw Error('Lost response with '+PAYER+' '+SECRET);});
    expect(await consumer().processMessage(c.message)).toBe('unknown');nativeReached();expect(calls.uploads()).toBe(1);
    const first=await immutable(c.id);expect(first.dispatch).toHaveLength(1);expect(first.evidence).toHaveLength(0);
    expect(await delivery(c.id)).toMatchObject({status:'UNKNOWN',lastError:'wechat_shipping_outcome_unknown'});
    expect(await consumer().processMessage(c.message)).toBe('unknown');expect((await consumer().dispatchPending(20,c.message.eventKey)).enqueued).toBe(0);
    expect(calls.uploads()).toBe(1);expect(await immutable(c.id)).toEqual(first);
  },90000);

  it('rejects revoked approval and changed physical source without token, carrier or upload requests',async()=>{
    const first=await staged();await approve('revoked');const none=transport(first.order);
    expect(await consumer().processMessage(first.message)).toBe('dead');expect(none.uploads()).toBe(0);expect(network).not.toHaveBeenCalled();
    expect((await immutable(first.id)).dispatch).toHaveLength(0);await approve();
    const second=await staged();await f.maintenanceDb.update(storeOrder).set({payPrice:'99.99'}).where(eq(storeOrder.id,second.order.id));
    try{expect(await consumer().processMessage(second.message)).toBe('dead');expect(network).not.toHaveBeenCalled();expect((await immutable(second.id)).dispatch).toHaveLength(0);}
    finally{await f.maintenanceDb.update(storeOrder).set({payPrice:second.order.payPrice}).where(eq(storeOrder.id,second.order.id));}
  },90000);

  it('reaches the independent App verifier and refuses a genuinely signed APP success for the same Routine root',async()=>{
    const c=await staged(),eventId=randomUUID(),native=envelope(nativeKeys,{appid:CURRENT_APP,mchid:CURRENT_MERCHANT,out_trade_no:c.order.orderId,
      transaction_id:'native_shipping_'+randomUUID().replaceAll('-',''),trade_state:'SUCCESS',trade_type:'APP',success_time:new Date().toISOString(),
      amount:{total:amountToCents(c.order.payPrice),currency:'CNY'}},eventId,{apiV3Key:'b'.repeat(32),platformPublicKeyId:'PUB_SHIPPING_CURRENT'});
    const pay=new WechatPayService(application(),f.env);await expect(pay.verifyAndParseNotify({...native.headers,'wechatpay-signature':'bad'},native.body,'app')).rejects.toThrow();
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE order_no=${c.order.orderId}`)).toHaveLength(0);
    expect(await pay.verifyAndParseNotify(native.headers,native.body,'app')).toMatchObject({outTradeNo:c.order.orderId,tradeState:'SUCCESS'});
    expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE evidence_id=${'callback:'+eventId}`)).toHaveLength(1);
    const calls=transport(c.order);connections.mockClear();expect(await consumer().processMessage(c.message)).toBe('dead');nativeReached();
    expect(calls.uploads()).toBe(0);expect(network).not.toHaveBeenCalled();expect((await immutable(c.id)).dispatch).toHaveLength(0);
  },90000);

  it('rolls provider receipt and SENT back together when the actual late delivery UPDATE fails',async()=>{
    const c=await staged(),pid=await f.appRuntime.verify(),before=await f.facts();
    const calls=transport(c.order);await f.exec(`CREATE FUNCTION public.phase32_shipping_sent_fail() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN PERFORM pg_catalog.pg_advisory_lock(731719,${c.id});RAISE EXCEPTION 'owned late shipping projection failure';END$$`);
    await f.exec('REVOKE ALL ON FUNCTION public.phase32_shipping_sent_fail() FROM PUBLIC');
    await f.exec(`CREATE TRIGGER phase32_shipping_sent_fail BEFORE UPDATE ON public.order_notification_delivery FOR EACH ROW WHEN(NEW.status='SENT') EXECUTE FUNCTION public.phase32_shipping_sent_fail()`);
    try{expect(await consumer().processMessage(c.message)).toBe('unknown');expect(calls.uploads()).toBe(1);nativeReached();
      const [witness]=await f.maintenanceDb.execute<{yes:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
        AND pid=${pid} AND classid=731719::oid AND objid=${c.id}::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS yes`);
      expect(witness.yes).toBe(true);expect((await immutable(c.id)).dispatch).toHaveLength(1);expect((await immutable(c.id)).evidence).toHaveLength(0);
      expect(await delivery(c.id)).toMatchObject({status:'UNKNOWN',sentTime:0});expect(await f.facts()).toEqual(before);
    }finally{await f.appRuntime.db.execute(sql`SELECT pg_catalog.pg_advisory_unlock(731719,${c.id})`);
      await f.exec('DROP TRIGGER IF EXISTS phase32_shipping_sent_fail ON public.order_notification_delivery');await f.exec('DROP FUNCTION IF EXISTS public.phase32_shipping_sent_fail()');}
    expect(await consumer().processMessage(c.message)).toBe('unknown');expect(calls.uploads()).toBe(1);
  },90000);

  it('refuses every other actual runtime before claiming ENQUEUED, then lets the actual App complete that same message',async()=>{
    const c=await staged(),before=await delivery(c.id),none=transport(c.order);
    for(const peer of[f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]){
      await expect(new OrderNotificationDeliveryService(createContainerFromDb(peer.db),f.env).processMessage(c.message)).rejects.toMatchObject({code:503});
      expect(await delivery(c.id)).toEqual(before);
    }
    expect(network).not.toHaveBeenCalled();expect(await consumer().processMessage(c.message)).toBe('sent');expect(none.uploads()).toBe(1);nativeReached();
  },90000);
});
