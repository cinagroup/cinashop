/** Author acceptance, not independent review of the format9 Mini patch.
 * Actual UserJWT recharge authors, five LOGINs, verified provider callbacks/
 * default signed query, Queue and controlled I/O; no paid or ownership seeding. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { notificationTemplate, orderNotificationDelivery, userRecharge, userBill, systemGroup, systemGroupData,
  storeOrderOutbox, systemConfig, systemMessage, systemNotification, user, wechatUser } from '@/models/schema';
import { runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import {runMembershipPaidNoticeUpgrade} from '@/migrations/membershipPaidNotice';
import { runRechargePaidNoticeUpgrade } from '@/migrations/rechargePaidNotice';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment } from '@/services/payment/RoutineShippingAccount';
import type { PaymentProviderQueryRequest } from '@/services/payment/PaymentProviderQuery';
import { PaymentCallbackEventService, isPaymentCallbackMessage } from '@/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService, isPaymentReconciliationMessage } from '@/services/payment/PaymentReconciliationService';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { consumeOrderNotificationOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { rechargePaidNoticeBusinessFromPayload, rechargePaidNoticeEventKey, rechargePaidSettlementKey,
  type RechargePaidNoticeBusiness } from '@/services/order/RechargePaidNoticeCodec';
import { paidNoticeDate } from '@/services/order/OrderPaidNoticeCodec';
import { decimalToCents, centsToDecimal } from '@/services/order/OrderBrokerageService';
import {applyRechargePayment} from '@/services/payment/RechargePaymentService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment } from '@/services/wechat/RoutineSubscriptionAccount';
import type { RoutineSubscriptionRechargeRequest, RoutineSubscriptionRechargeUnavailable } from '@/services/wechat/RoutineSubscriptionRechargeRequest';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: unknown) => { values.set(key, value); return true; });
  const remove = vi.fn(async (key: string) => values.delete(key));
  const take = vi.fn(async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Event = typeof storeOrderOutbox.$inferSelect;
type Member = typeof userRecharge.$inferSelect;
type Payload = RechargePaidNoticeBusiness & {routineSubscriptionRequest?: RoutineSubscriptionRechargeRequest | RoutineSubscriptionRechargeUnavailable};
const A='wx-local-query',B='wx_recharge_current_b',OFFICIAL='wx_recharge_official';
const SUBREF='recharge_subscription_ref',SUBSECRET='synthetic-recharge-subscription-secret',SHIPREF='recharge_shipping_ref',SHIPSECRET='synthetic-recharge-shipping-secret';
const MINI='owned_recharge_755',OFFICIAL_TEMPLATE='owned_recharge_42934',SMS='owned_recharge_sms';
const ACCOUNT='recharge_original_account',PAYREF='recharge_original_payment',MERCHANT='1234567890',AES='a'.repeat(32),SERIAL='TEST_QUERY_PUBLIC_KEY';
const QUOTA=66001,PAYER='recharge_distinct_actual_payer';
const UIDS=[11,22,33,44] as const;
const OWNER:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'recharge_owned_uid'+uid]));
const OFFICIAL_OWNER:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'recharge_official_uid'+uid]));
const PHONE:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'138000000'+String(uid).padStart(2,'0')]));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge settlement buyer notices on independent PG16 LOGINs',{timeout:60000},()=>{
 let f:Fixture,keys:ReturnType<typeof paymentQueryKeys>,signer:Awaited<ReturnType<typeof paymentQueryFixture>>;
 let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>,legacy:Member,serial=0,loginUid=11;
 let queried:{order:Member;transaction:string}|undefined;
 const expected=new Map<string,RechargePaidNoticeBusiness>(),lostMini=new Set<string>(),shippingTransactions=new Map<string,string>();
 const posts:Array<{channel:string;orderNo:string;body:unknown}>=[];
 const app=()=>createContainerFromDb(f.appRuntime.db),outbox=()=>new OrderOutboxService(app(),f.env),delivery=()=>new OrderNotificationDeliveryService(app(),f.env);
 const named=()=>({database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin});
 async function config(values:Record<string,unknown>){
  await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
  await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
 }
 const current=(appId=B)=>config({routine_appId:appId,routine_appsecret:'synthetic-current-secret',wechat_appid:OFFICIAL,wechat_appsecret:'synthetic-official-secret',
  wechat_app_appid:B,pay_weixin_mchid:'1900000651',pay_weixin_serial_no:'B1B2C3D4',pay_weixin_open:1,order_shipping_open:0,
  balance_func_status:1,yue_pay_status:1});
 async function identity(uid:number){
  await current(A);loginUid=uid;await f.maintenanceDb.insert(wechatUser).values({uid,userType:'routine',openid:OWNER[uid],isDel:0});
  const auth=new WechatAuthService(app(),f.env),ticket=await auth.beginMiniProgramLogin({code:randomUUID(),ip:'127.0.0.1'});
  const raw=transport.values.get('routine_login:'+ticket.key) as {identity:VerifiedSocialIdentity};
  expect(raw.identity.routineObservation).toMatchObject({appId:A,openid:OWNER[uid]});
  expect(await auth.reconcileVerifiedIdentity({...raw.identity,phone:PHONE[uid]})).toBe(uid);await current();
 }
 function provider(){
  network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));
   if(url.pathname==='/sns/jscode2session'){expect(url.searchParams.get('appid')).toBe(A);return Response.json({openid:OWNER[loginUid],session_key:Buffer.from('0123456789abcdef').toString('base64')});}
   if(url.hostname==='api.mch.weixin.qq.com'){
    expect(queried).toBeDefined();expect(signer.verifyRequest(String(input),init!)).toBe(true);expect(url.pathname).toContain(queried!.order.orderId);
    return signer.wechatResponse(signer.wxBody({out_trade_no:queried!.order.orderId,transaction_id:queried!.transaction,payer:{openid:PAYER}}));
   }
   if(url.pathname==='/cgi-bin/token'){
    const appId=url.searchParams.get('appid'),secret=url.searchParams.get('secret');
    if(appId===A&&secret===SUBSECRET)return Response.json({access_token:'owned_recharge_mini_token',expires_in:7200});
    if(appId===A&&secret===SHIPSECRET)return Response.json({access_token:'owned_recharge_shipping_token',expires_in:7200});
    expect(appId).toBe(OFFICIAL);return Response.json({access_token:'owned_recharge_official_token',expires_in:7200});
   }
   expect(init?.method).toBe('POST');
   if(url.hostname==='dysmsapi.aliyuncs.com'){
    const params=new URLSearchParams(String(init?.body)),data=JSON.parse(params.get('TemplateParam')!) as {price:string;now_money:string};
    const p=[...expected.values()].reverse().find(v=>v.phone===params.get('PhoneNumbers')&&v.payPrice===data.price&&v.postBalance===data.now_money);expect(p).toBeDefined();expect(params.get('PhoneNumbers')).toBe(p!.phone);expect(params.get('TemplateCode')).toBe(SMS);
    expect(data).toEqual({price:p!.payPrice,now_money:p!.postBalance});expect(params.get('Signature')).toBeTruthy();
    posts.push({channel:'sms',orderNo:p!.orderNo,body:data});return Response.json({Code:'OK',BizId:'owned-recharge-biz',RequestId:'owned-recharge-request'});
   }
   if(url.pathname==='/wxa/sec/order/upload_shipping_info'){
    const body=JSON.parse(String(init?.body)) as {order_key:{transaction_id:string};payer:{openid:string};logistics_type:number;delivery_mode:number;shipping_list:Array<{item_desc:string}>};
    const orderNo=shippingTransactions.get(body.order_key.transaction_id);expect(orderNo).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_recharge_shipping_token');
    expect(body).toMatchObject({payer:{openid:PAYER},logistics_type:3,delivery_mode:1});expect(body.shipping_list).toEqual([{item_desc:'用户充值10.00'}]);
    posts.push({channel:'shipping',orderNo:orderNo!,body});return Response.json({errcode:0});
   }
   const body=JSON.parse(String(init?.body)) as {touser:string;template_id:string;page?:string;url?:string|null;data:Record<string,{value:string}>};
   if(url.pathname==='/cgi-bin/message/template/send'){
    const p=[...expected.values()].reverse().find(v=>OFFICIAL_OWNER[v.userId]===body.touser&&paidNoticeDate(v.creationTime)===body.data.time11.value&&v.payPrice===body.data.amount5.value);expect(p).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_recharge_official_token');
    expect(body.touser).toBe(OFFICIAL_OWNER[p!.userId]);expect(body.template_id).toBe(OFFICIAL_TEMPLATE);expect(body.url).toBeNull();
    expect(body.data).toEqual({time11:{value:paidNoticeDate(p!.creationTime)},amount5:{value:p!.payPrice}});
    posts.push({channel:'official',orderNo:p!.orderNo,body});return Response.json({errcode:0,msgid:'owned_recharge_msg'});
   }
   expect(url.pathname).toBe('/cgi-bin/message/subscribe/send');
   const p=expected.get(body.data.character_string1.value);expect(p).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_recharge_mini_token');
   expect(body.touser).toBe(OWNER[p!.userId]);expect(body.template_id).toBe(MINI);expect(body.page).toBe('/pages/users/user_bill/index?type=2');
   expect(body.data).toEqual({character_string1:{value:p!.orderNo},amount3:{value:p!.payPrice},amount4:{value:p!.postBalance},date5:{value:paidNoticeDate(p!.occurredAt)}});
   posts.push({channel:'mini',orderNo:p!.orderNo,body});
   const [active]=await f.maintenanceDb.execute<{count:number}>(sql`SELECT count(*)::integer AS count FROM pg_stat_activity
    WHERE datname=current_database() AND state='idle in transaction' AND usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.cashierRuntime.role},${f.managerRuntime.role})`);
   expect(active.count).toBe(0);if(lostMini.has(p!.orderNo))throw Error('Controlled lost response after actual Mini POST');return Response.json({errcode:0});
  });
 }
 async function ok<T>(path:string,body:unknown,uid=11):Promise<T>{const r=await f.request(path,body,undefined,uid);expect(r.body.status,r.body.msg).toBe(200);return r.body.data as T;}
 async function create(uid=11){
  const c=await ok<{orderId:string}>('/recharge/recharge',{price:10,from:'routine',rechar_id:QUOTA},uid);
  const rows=await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.orderId,c.orderId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({uid,paid:0,price:'10.00',givePrice:'1.50'});return rows[0];
 }
 async function notice(order:Member){
  const rows=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,rechargePaidNoticeEventKey(order.id)));expect(rows).toHaveLength(1);
  const event=rows[0],body=rechargePaidNoticeBusinessFromPayload(event.payload);
  expect(event).toMatchObject({aggregateType:'recharge',aggregateId:order.id,eventType:'recharge.pay.success.notice',addTime:body.occurredAt});
  expect(body).toMatchObject({domain:'recharge',orderId:order.id,orderNo:order.orderId,userId:order.uid});expected.set(body.orderNo,body);return event;
 }
 function request(event:Event){const r=(event.payload as Payload).routineSubscriptionRequest;if(!r||'unavailable'in r)throw Error('Actual format9 request missing');return r;}
 async function consume(event:Event){
  await outbox().dispatchPending(1,event.id);const body=f.messages.filter(isOrderNotificationOutboxMessage).filter(m=>m.outboxId===event.id).at(-1);expect(body).toBeDefined();
  const ack=vi.fn(),retry=vi.fn();await consumeOrderNotificationOutboxQueueMessage({body:body!,attempts:1,ack,retry},outbox());
  expect(retry).not.toHaveBeenCalled();expect(ack).toHaveBeenCalledTimes(1);expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,event.id)))[0].status).toBe('COMPLETED');
 }
 const rows=(event:Event)=>f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey,event.eventKey)).orderBy(asc(orderNotificationDelivery.id));
 async function queued(event:Event){await consume(event);await delivery().dispatchPending(20,event.eventKey);return[...new Map(f.messages.filter(isOrderNotificationDeliveryMessage).filter(m=>m.eventKey===event.eventKey).map(m=>[m.deliveryId,m])).values()];}
 async function send(event:Event,mini:'sent'|'unknown'|'skipped'='sent'){
  const messages=await queued(event),p=rechargePaidNoticeBusinessFromPayload(event.payload);
  expect(new Set(messages.map(m=>m.channel))).toEqual(new Set(mini==='skipped'?['sms','wechat_official']:['sms','wechat_official','wechat_routine']));
  for(const message of messages)expect(await delivery().processMessage(message,network)).toBe(message.channel==='wechat_routine'&&mini==='unknown'?'unknown':'sent');
  const saved=await rows(event);expect(saved.find(r=>r.channel==='wechat_routine')?.status).toBe(mini==='skipped'?'SKIPPED':mini==='unknown'?'UNKNOWN':'SENT');
  expect(saved.filter(r=>r.channel!=='wechat_routine').every(r=>r.status==='SENT')).toBe(true);
  const physical=await f.maintenanceDb.execute<{domain:string;subject:number;order_id:number|null;withdrawal_id:number|null}>(sql`SELECT subject_domain AS domain,subject_id AS subject,order_id,withdrawal_id FROM public.order_notification_delivery WHERE event_key=${event.eventKey}`);
  expect(physical).toHaveLength(3);for(const row of physical)expect(row).toEqual({domain:'recharge',subject:p.orderId,order_id:null,withdrawal_id:null});
  expect(await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey,event.eventKey))).toMatchObject([{userId:p.userId,mark:'recharge_success',title:'充值到账 '+p.orderNo,content:p.payPrice+' '+p.postBalance}]);return messages;
 }
 async function effects(){const[row]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
  'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY uid) FROM public."user" t WHERE uid IN(11,22,33,44)),
  'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_recharge t),
  'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t),
  'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_order_outbox t WHERE aggregate_type='recharge'),
  'deliveries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.order_notification_delivery t WHERE subject_domain='recharge')) AS value`);return row.value;}
 async function retryCallback(message:Parameters<PaymentCallbackEventService['processMessage']>[0]){const[row]=await f.maintenanceDb.execute<{available:number}>(sql`SELECT available_time AS available FROM public.payment_callback_outbox WHERE event_id=${message.eventId}`);const clock=vi.spyOn(Date,'now').mockReturnValueOnce((row.available+1)*1000);try{return await new PaymentCallbackEventService(app(),f.env).processMessage(message);}finally{clock.mockRestore();}}
 function sqlStates(error:unknown){const states:unknown[]=[];while(error&&typeof error==='object'&&states.length<8){const r=error as {code?:unknown;cause?:unknown};states.push(r.code);error=r.cause;}return states;}

 function packet(order:Member,transaction:string){
  const plain={appid:A,mchid:MERCHANT,out_trade_no:order.orderId,transaction_id:transaction,trade_state:'SUCCESS',trade_type:'JSAPI',
   payer:{openid:PAYER},success_time:new Date().toISOString(),amount:{total:1000,currency:'CNY'}};
  const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction',cipher=createCipheriv('aes-256-gcm',Buffer.from(AES),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const body=JSON.stringify({id:randomUUID(),event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext,nonce,associated_data:associated}});
  const timestamp=String(Math.floor(Date.now()/1000));
  return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':SERIAL,
   'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
 }
 async function callback(order:Member){
  const transaction='recharge_tx_'+randomUUID().replaceAll('-',''),p=packet(order,transaction),pending:Promise<unknown>[]=[];
  const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',app());await next();});h.onError(errorHandler);h.route('/api',v1Routes);
  const ingress=async()=>{
   const response=await h.request('/api/pay/notify/routine-account/'+ACCOUNT,{method:'POST',headers:p.headers,body:p.body},f.env,
    {waitUntil:(p:Promise<unknown>)=>pending.push(p),props:{},passThroughOnException:()=>{throw Error('Unexpected fallback');}});
   await Promise.all(pending.splice(0));expect(response.status).toBe(200);const text=await response.text();
   for(const secret of[PAYER,SUBSECRET,AES,f.env.APP_KEY])expect(text).not.toContain(secret);
  };
  const before=f.messages.length;await ingress();
  const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();shippingTransactions.set(transaction,order.orderId);return{message:message!,transaction,ingress};
 }
 async function shipping(order:Member,transaction:string){
  const key='recharge.paid.shipping:'+order.id;
  const[row]=await f.maintenanceDb.execute<{id:number;add_time:number;available_time:number;subject_domain:string;subject_id:number;order_id:number|null;withdrawal_id:number|null;status:string}>(sql`
   SELECT id,add_time,available_time,subject_domain,subject_id,order_id,withdrawal_id,status FROM public.order_notification_delivery WHERE event_key=${key} AND channel='wechat_shipping'`);
  expect(row).toMatchObject({subject_domain:'recharge',subject_id:order.id,order_id:null,withdrawal_id:null,status:'ENQUEUED'});expect(row.available_time-row.add_time).toBe(10);
  expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key)))[0]).toMatchObject({aggregateType:'recharge',aggregateId:order.id,status:'COMPLETED',eventType:'recharge.paid.shipping'});
  const message=f.messages.filter(isOrderNotificationDeliveryMessage).find(m=>m.deliveryId===row.id);expect(message).toBeDefined();
  const[clock]=await f.maintenanceDb.execute<{remaining:number}>(sql`SELECT GREATEST(0,${row.add_time+11}-FLOOR(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::integer)::integer AS remaining`);
  expect(clock.remaining).toBeLessThanOrEqual(12);if(clock.remaining>0)await new Promise(resolve=>setTimeout(resolve,clock.remaining*1000));
  expect(await delivery().processMessage(message!,network)).toBe('sent');expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='shipping')).toHaveLength(1);
  expect(shippingTransactions.get(transaction)).toBe(order.orderId);
 }
 beforeAll(async()=>{
  network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unplanned external transport'));keys=paymentQueryKeys();
  f=await customerCashierRuntimeHttpFixture();await f.reset();
  await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineSubscriptionUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runPaidNoticeUpgrade(f.maintenanceDb);await runMembershipPaidNoticeUpgrade(f.maintenanceDb);
  expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(role=>role.verify()))).size).toBe(5);
  Object.assign(f.env,{ALIYUN_SMS_ACCESS_KEY_ID:'synthetic-recharge-key',ALIYUN_SMS_ACCESS_KEY_SECRET:'synthetic-recharge-secret',ALIYUN_SMS_SIGN_NAME:'充值原生验收',
   WECHAT_MCH_PRIVATE_KEY:keys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:keys.publicKey,WECHAT_PLATFORM_PUBLIC_KEY_ID:SERIAL,WECHAT_API_V3_KEY:AES,
   ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SUBREF,version:1,appId:A,secret:SUBSECRET}]}),
   ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SHIPREF,version:1,appId:A,secret:SHIPSECRET}]}),
   ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:PAYREF,version:1,appId:A,merchantId:MERCHANT,serialNo:'ABCDEF123456',apiV3Key:AES,privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:SERIAL}]})});
  f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async(input:Request|string|URL)=>new Response((new URL(String(input)).searchParams.get('prefix')??'cz')+'_recharge_notice_'+(++serial))})} as unknown as Env['SEQUENCE'];
  for(const uid of UIDS){await f.maintenanceDb.insert(user).values({uid,account:'recharge-notice-'+uid,pwd:'owned-financial-password',status:1}).onConflictDoNothing();
   await f.maintenanceDb.update(user).set({phone:PHONE[uid],nickname:'充值'+uid,nowMoney:'1000.00',pwd:'owned-financial-password',isDel:0,status:1}).where(eq(user.uid,uid));}
  await f.maintenanceDb.update(wechatUser).set({isDel:1}).where(and(inArray(wechatUser.uid,[...UIDS]),eq(wechatUser.userType,'routine')));
  for(const uid of UIDS)await f.maintenanceDb.insert(wechatUser).values({uid,userType:'wechat',openid:OFFICIAL_OWNER[uid],isDel:0});
  const groups=await f.maintenanceDb.select().from(systemGroup).where(eq(systemGroup.configName,'user_recharge_quota')).limit(2);expect(groups.length).toBeLessThanOrEqual(1);
  if(!groups.length)await f.maintenanceDb.insert(systemGroup).values({id:QUOTA,configName:'user_recharge_quota',name:'充值通知真实套餐',info:'充值通知真实套餐'});
  await f.maintenanceDb.insert(systemGroupData).values({id:QUOTA,gid:groups[0]?.id??QUOTA,status:1,value:JSON.stringify({price:{type:'input',value:'10.00'},give_money:{type:'input',value:'1.50'}})});
  await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark,'recharge_success'));
  await f.maintenanceDb.insert(systemNotification).values({mark:'recharge_success',isSystem:1,isSms:1,isWechat:1,isRoutine:1,smsId:SMS,systemTitle:'充值到账 {order_id}',systemText:'{price} {now_money}'});
  await f.maintenanceDb.delete(notificationTemplate).where(inArray(notificationTemplate.mark,['42934','755']));
  await f.maintenanceDb.insert(notificationTemplate).values([{mark:'42934',legacyType:1,status:1,tempid:OFFICIAL_TEMPLATE},{mark:'755',legacyType:0,status:1,tempid:'current_b_template_is_not_authority'}]);
  await current();provider();await identity(11);await identity(44);signer=await paymentQueryFixture(app(),keys);
  const now=Math.floor(Date.now()/1000);
  await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb,f.env,named(),{operationId:randomUUID(),expectedRevision:0,data:{accountId:routineSubscriptionAccountId(f.env,A),state:'active',appId:A,credentialRef:SUBREF,credentialVersion:1,credentialStamp:routineSubscriptionCredentialCommitment(f.env,SUBREF,1).credentialStamp,purposes:['subscription_send'],templates:[{mark:'755',templateId:MINI}],validFrom:now-60,validUntil:now+7200}});
  await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',data:{accountId:ACCOUNT,state:'active',...routinePaymentCredentialCommitment(f.env,PAYREF,1),credentialRef:PAYREF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+7200}});
  await appendRoutineShippingAccountPolicy(f.maintenanceDb,f.env,named(),{operationId:randomUUID(),expectedRevision:0,data:{accountId:routineShippingAccountId(f.env,A,MERCHANT),state:'active',appId:A,merchantId:MERCHANT,credentialRef:SHIPREF,credentialVersion:1,credentialStamp:routineShippingCredentialCommitment(f.env,SHIPREF,1).credentialStamp,purposes:['shipping_upload'],validFrom:now-60,validUntil:now+7200}});
  legacy=await create();const cb=await callback(legacy);expect(await new PaymentCallbackEventService(app(),f.env).processMessage(cb.message)).toBe('completed');
  expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,rechargePaidSettlementKey(legacy.id)))).toHaveLength(0);
  await runRechargePaidNoticeUpgrade(f.maintenanceDb);
 },240000);
 afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
 async function paid(uid=11){const order=await create(uid),cb=await callback(order),service=new PaymentCallbackEventService(app(),f.env);expect(await service.processMessage(cb.message)).toBe('completed');return{order:(await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0],cb,service};}
 async function ali(order:Member){
  const k=paymentQueryKeys(),appId='2026110500000066',seller='2088000000000066';Object.assign(f.env,{ALIPAY_APP_ID:appId,ALIPAY_PUBLIC_KEY:k.publicKey,ALIPAY_SELLER_ID:seller});
  const transaction='recharge_ali_'+randomUUID().replaceAll('-',''),params:Record<string,string>={app_id:appId,seller_id:seller,out_trade_no:order.orderId,trade_no:transaction,notify_id:randomUUID(),trade_status:'TRADE_SUCCESS',total_amount:'10.00',sign_type:'RSA2',gmt_payment:new Date(Date.now()+8*3600*1000).toISOString().slice(0,19).replace('T',' ')};
  const content=Object.keys(params).sort().map(key=>key+'='+params[key]).join('&'),body=new URLSearchParams({...params,sign:Buffer.from(sign('RSA-SHA256',Buffer.from(content),k.privateKey)).toString('base64')}).toString();
  const h=new Hono<{Bindings:Env;Variables:AppVariables}>(),pending:Promise<unknown>[]=[];h.use('*',async(c,next)=>{c.set('container',app());await next();});h.onError(errorHandler);h.route('/api',v1Routes);
  const ingress=async()=>{const response=await h.request('/api/pay/notify/alipay',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},f.env,{waitUntil:(work:Promise<unknown>)=>pending.push(work),props:{},passThroughOnException:()=>{throw Error('Unexpected fallback');}});await Promise.all(pending.splice(0));expect(response.status).toBe(200);expect(await response.text()).toBe('success');};
  const n=f.messages.length;await ingress();const message=f.messages.slice(n).find(isPaymentCallbackMessage);expect(message).toBeDefined();return{message:message!,transaction,ingress};
 }
 it('never backfills a genuinely paid pre-0202 recharge on callback or scanner replay',async()=>{
  const order=(await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,legacy.id)))[0],before=await effects();
  expect(await applyRechargePayment(app(),{orderId:order.orderId,payType:'weixin',tradeNo:order.tradeNo,expectedAmountCents:1000})).toMatchObject({outcome:'already-paid'});
  await delivery().dispatchPending(20,rechargePaidNoticeEventKey(order.id));for(const key of[rechargePaidSettlementKey(order.id),rechargePaidNoticeEventKey(order.id)])expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key))).toHaveLength(0);expect(await effects()).toEqual(before);
 });
 it('settles actual verified Routine recharge principal plus gift once, sends four channels from A after switch to B, and preserves later wallet changes',async()=>{
  const before=(await f.maintenanceDb.select().from(user).where(eq(user.uid,11)))[0].nowMoney,{order,cb,service}=await paid(),event=await notice(order),p=rechargePaidNoticeBusinessFromPayload(event.payload);
  expect(request(event)).toMatchObject({format:9,selection:{mode:'routine-original',appId:A,openid:OWNER[11]}});expect(p).toMatchObject({payPrice:'10.00',giftPrice:'1.50',creditedAmount:'11.50',postBalance:(Number(before)+11.5).toFixed(2)});
  const[bill]=await f.maintenanceDb.select().from(userBill).where(eq(userBill.id,p.billId));expect(bill).toMatchObject({uid:11,linkId:order.orderId,eventKey:'recharge_external_payment',number:'11.50',balance:p.postBalance,pm:1});
  await f.maintenanceDb.update(user).set({nowMoney:sql`now_money-1`}).where(eq(user.uid,11));await send(event);
  const effectsBefore=await effects(),sent=posts.length;expect(await service.processMessage(cb.message)).toBe('already-completed');await cb.ingress();expect(await outbox().processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('already-completed');expect(await effects()).toEqual(effectsBefore);expect(posts).toHaveLength(sent);
 });
 it('uses actual signed query transaction evidence before authoring format9 and independently retains virtual shipping',async()=>{
  const order=await create(),transaction='recharge_query_'+randomUUID().replaceAll('-',''),queryRequest:PaymentProviderQueryRequest={provider:'wechat',profile:'routine',orderDomain:'recharge',orderNo:order.orderId,expectedAmountCents:1000,currency:'CNY'};
  queried={order,transaction};shippingTransactions.set(transaction,order.orderId);await config({order_shipping_open:1});
  try{const now=Math.floor(Date.now()/1000);await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'query',data:{state:'active',accountId:ACCOUNT,accountRevision:1,request:queryRequest,validFrom:now-60,validUntil:now+1800}});
   const service=new PaymentReconciliationService(app(),f.env),registered=await service.registerIntent({...queryRequest,initiatedAt:now-121});await service.dispatchPage({action:'dispatchPaymentReconciliation',scheduledAt:Date.now(),cursor:0});const message=f.messages.filter(isPaymentReconciliationMessage).find(m=>m.caseId===registered.id);expect(message).toBeDefined();expect(await service.processMessage(message!)).toBe('settled');
   const saved=(await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0],event=await notice(saved);expect(request(event).format).toBe(9);await send(event);await shipping(saved,transaction);
   const state=await effects();expect(await service.processMessage(message!)).toBe('already-terminal');expect(await effects()).toEqual(state);
  }finally{queried=undefined;await current();}
 },90000);
 it('settles a real RSA2 Alipay callback using unique explicit A ownership without inventing original WeChat evidence',async()=>{
  const order=await create(),before=await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence ORDER BY evidence_id`),cb=await ali(order),service=new PaymentCallbackEventService(app(),f.env);
  expect(await service.processMessage(cb.message)).toBe('completed');const saved=(await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0],event=await notice(saved);expect(request(event)).toMatchObject({format:9,selection:{mode:'unique-owner',appId:A}});await send(event);
  const[mini]=(await rows(event)).filter(r=>r.channel==='wechat_routine'),[attempt]=await f.maintenanceDb.execute<{payload:{facts:{subjectDomain:string;payment:{kind:string;payType:string}}}}>(sql`SELECT payload FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.id}`);expect(attempt.payload.facts).toMatchObject({subjectDomain:'recharge',payment:{kind:'unique-identity',payType:'alipay'}});
  expect(await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence ORDER BY evidence_id`)).toEqual(before);expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'recharge.paid.shipping:'+order.id))).toHaveLength(0);const state=await effects(),n=posts.length;expect(await service.processMessage(cb.message)).toBe('already-completed');await cb.ingress();expect(await effects()).toEqual(state);expect(posts).toHaveLength(n);
 });
 for(const kind of['recharge.settled','recharge.pay.success.notice'])it('atomically rolls back wallet, ledger and paid status on '+kind+' returned corruption, then retries the actual callback',async()=>{
  const order=await create(),cb=await callback(order),before=await effects(),n=f.messages.length;
  await f.exec(`CREATE FUNCTION public.recharge_notice_corrupt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $owned$ BEGIN NEW.payload=pg_catalog.jsonb_set(NEW.payload,'{signature}','"corrupted"'::jsonb,true);RETURN NEW;END $owned$;REVOKE ALL ON FUNCTION public.recharge_notice_corrupt() FROM PUBLIC;CREATE TRIGGER recharge_notice_corrupt BEFORE INSERT ON public.store_order_outbox FOR EACH ROW WHEN(NEW.event_type='${kind}' AND NEW.aggregate_id=${order.id}) EXECUTE FUNCTION public.recharge_notice_corrupt()`);
  const service=new PaymentCallbackEventService(app(),f.env);try{await expect(service.processMessage(cb.message)).rejects.toThrow();expect(await effects()).toEqual(before);expect(f.messages).toHaveLength(n);}finally{await f.exec('DROP TRIGGER IF EXISTS recharge_notice_corrupt ON public.store_order_outbox;DROP FUNCTION IF EXISTS public.recharge_notice_corrupt()');}
  expect(await retryCallback(cb.message)).toBe('completed');await send(await notice((await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0]));expect(await f.maintenanceDb.select().from(userBill).where(eq(userBill.linkId,order.orderId))).toHaveLength(1);
 });
 it('rolls back real identity SQL contention instead of committing a permanently unavailable request',async()=>{
  const order=await create(),cb=await callback(order),service=new PaymentCallbackEventService(app(),f.env),before=await effects();
  await f.withMaintenancePeer(peer=>peer.transaction(async held=>{await held.execute(sql`LOCK TABLE ONLY public.routine_identity_ownership IN ACCESS EXCLUSIVE MODE NOWAIT`);const error=await service.processMessage(cb.message).then(()=>null,error=>error);expect(sqlStates(error)).toContain('55P03');expect(await effects()).toEqual(before);}));
  expect(await retryCallback(cb.message)).toBe('completed');const event=await notice((await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0]);expect(request(event).format).toBe(9);await send(event);
 });
 it('freezes missing ownership and does not adopt a later UID binding or current B',async()=>{
  const{order}=await paid(33),event=await notice(order);expect((event.payload as Payload).routineSubscriptionRequest).toEqual({format:9,unavailable:true});await identity(33);await send(event,'skipped');expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(0);
 });
 it('does not use a second unmapped live binding to infer an Ali AppID',async()=>{
  const extra=await f.maintenanceDb.insert(wechatUser).values({uid:44,userType:'routine',openid:'unmaintained_recharge_binding',isDel:0}).returning();
  try{const order=await create(44),cb=await ali(order);expect(await new PaymentCallbackEventService(app(),f.env).processMessage(cb.message)).toBe('completed');const event=await notice((await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0]);expect((event.payload as Payload).routineSubscriptionRequest).toEqual({format:9,unavailable:true});await send(event,'skipped');}finally{await f.maintenanceDb.delete(wechatUser).where(eq(wechatUser.id,extra[0].id));}
 });
 it('keeps UNKNOWN after one actual Mini POST and never repeats the possible send',async()=>{
  const{order}=await paid(),event=await notice(order);lostMini.add(order.orderId);try{const messages=await send(event,'unknown'),mini=messages.find(m=>m.channel==='wechat_routine')!;expect(await delivery().processMessage(mini,network)).toBe('unknown');expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(1);expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.deliveryId}`)).toHaveLength(1);expect(await f.maintenanceDb.execute(sql`SELECT r.result_id FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${mini.deliveryId}`)).toHaveLength(0);}finally{lostMini.delete(order.orderId);}
 });
 it('schedules confirmed pre-attempt source lock contention with zero attempt/result and posts once after release',async()=>{
  const{order}=await paid(),event=await notice(order),messages=await queued(event),mini=messages.find(m=>m.channel==='wechat_routine')!;
  for(const m of messages.filter(m=>m.channel!=='wechat_routine'))expect(await delivery().processMessage(m,network)).toBe('sent');const[before]=(await rows(event)).filter(r=>r.channel==='wechat_routine');
  await f.withMaintenancePeer(peer=>peer.transaction(async held=>{await held.execute(sql`UPDATE public.user_recharge SET trade_no=trade_no WHERE id=${order.id}`);expect(await delivery().processMessage(mini,network)).toBe('retry-scheduled');const[retry]=(await rows(event)).filter(r=>r.channel==='wechat_routine');expect(retry).toMatchObject({status:'RETRYABLE',attemptCount:0,dispatchCount:before.dispatchCount,leaseToken:'',leaseUntil:0});expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.deliveryId}`)).toHaveLength(0);expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(0);}));
  const[retry]=(await rows(event)).filter(r=>r.channel==='wechat_routine'),n=f.messages.length,clock=vi.spyOn(Date,'now').mockReturnValue((retry.availableTime+1)*1000);try{expect((await delivery().dispatchPending(20,event.eventKey)).enqueued).toBe(1);}finally{clock.mockRestore();}const next=f.messages.slice(n).filter(isOrderNotificationDeliveryMessage).find(m=>m.deliveryId===mini.deliveryId)!;expect(await delivery().processMessage(next,network)).toBe('sent');expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(1);
 });
 it('rejects a mutated bill anchor before any channel send and recovers the original signed snapshot after restoration',async()=>{
  const{order}=await paid(),event=await notice(order),p=rechargePaidNoticeBusinessFromPayload(event.payload);await f.maintenanceDb.update(userBill).set({balance:'0.01'}).where(eq(userBill.id,p.billId));try{await expect(outbox().processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).rejects.toThrow();expect(posts.filter(v=>v.orderNo===order.orderId)).toHaveLength(0);expect(await rows(event)).toHaveLength(0);}finally{await f.maintenanceDb.update(userBill).set({balance:p.postBalance}).where(eq(userBill.id,p.billId));}await send(event);
 });
 it('keeps trusted settlement and other channel staging when independent755 credentials are unavailable, then uses restored A only',async()=>{
  const{order}=await paid(),event=await notice(order),registry=f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS;
  f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS='';
  try{expect(await outbox().processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('deferred');expect((await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0].paid).toBe(1);expect((await rows(event)).map(r=>r.channel).sort()).toEqual(['sms','wechat_official']);expect(await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey,event.eventKey))).toHaveLength(1);expect(posts.filter(p=>p.orderNo===order.orderId)).toHaveLength(0);}finally{f.env.ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS=registry;}
  await send(event);expect(request(event).selection.appId).toBe(A);
 });
 it('keeps disabled channels silent and preserves missing official recipient skip metadata',async()=>{
  const{order}=await paid(),event=await notice(order);await f.maintenanceDb.update(systemNotification).set({isSms:0,isRoutine:0}).where(eq(systemNotification.mark,'recharge_success'));
  const original=await f.maintenanceDb.select().from(wechatUser).where(and(eq(wechatUser.uid,11),eq(wechatUser.userType,'wechat'),eq(wechatUser.isDel,0)));
  await f.maintenanceDb.update(wechatUser).set({isDel:1}).where(and(eq(wechatUser.uid,11),eq(wechatUser.userType,'wechat')));
  try{await consume(event);const saved=await rows(event);expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({channel:'wechat_official',status:'SKIPPED',target:'',lastError:'target_not_configured'});expect(await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey,event.eventKey))).toHaveLength(1);expect(posts.filter(p=>p.orderNo===order.orderId)).toHaveLength(0);}finally{await f.maintenanceDb.update(systemNotification).set({isSms:1,isRoutine:1}).where(eq(systemNotification.mark,'recharge_success'));for(const r of original)await f.maintenanceDb.update(wechatUser).set({isDel:r.isDel}).where(eq(wechatUser.id,r.id));}
 });

 it('keeps a real commission-to-wallet transfer outside provider recharge notification authority',async()=>{
  const configKey='user_extract_balance_status',hadConfig=Object.hasOwn(f.config,configKey),originalConfigValue=f.config[configKey];
  const originalConfigRows=await f.maintenanceDb.select().from(systemConfig).where(eq(systemConfig.menuName,configKey));
  try{
   await config({[configKey]:1});await f.setConfig({[configKey]:'1'});
   const[before]=await f.maintenanceDb.update(user).set({brokeragePrice:'20.00'}).where(eq(user.uid,44)).returning({nowMoney:user.nowMoney,brokeragePrice:user.brokeragePrice});
   expect(before.brokeragePrice).toBe('20.00');const events=await f.maintenanceDb.select().from(storeOrderOutbox),n=f.messages.length;
   const c=await ok<{orderId:string;nowMoney:string;brokeragePrice:string}>('/recharge/recharge',{type:1,price:10},44);
   const[order]=await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.orderId,c.orderId));expect(order).toMatchObject({uid:44,paid:1,rechargeType:'balance',price:'10.00',givePrice:'0.00'});
   const[account]=await f.maintenanceDb.select({nowMoney:user.nowMoney,brokeragePrice:user.brokeragePrice}).from(user).where(eq(user.uid,44));
   expect(account).toEqual({nowMoney:centsToDecimal(decimalToCents(before.nowMoney)+1000),brokeragePrice:'10.00'});
   expect(c).toMatchObject({nowMoney:account.nowMoney,brokeragePrice:account.brokeragePrice});
   expect(await f.maintenanceDb.select().from(storeOrderOutbox)).toEqual(events);expect(f.messages).toHaveLength(n);for(const key of[rechargePaidSettlementKey(order.id),rechargePaidNoticeEventKey(order.id)])expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key))).toHaveLength(0);
  }finally{
   try{await f.maintenanceDb.delete(systemConfig).where(eq(systemConfig.menuName,configKey));if(originalConfigRows.length)await f.maintenanceDb.insert(systemConfig).values(originalConfigRows);}
   finally{if(hadConfig)f.config[configKey]=originalConfigValue;else delete f.config[configKey];}
  }
 });

 it('rolls back a bill BEFORE INSERT balance corruption instead of signing a false historical post-credit balance',async()=>{
  const order=await create(),cb=await callback(order),before=await effects();
  await f.exec(`CREATE FUNCTION public.recharge_bill_corrupt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $owned$ BEGIN NEW.balance=0.01;RETURN NEW;END $owned$;REVOKE ALL ON FUNCTION public.recharge_bill_corrupt() FROM PUBLIC;CREATE TRIGGER recharge_bill_corrupt BEFORE INSERT ON public.user_bill FOR EACH ROW WHEN(NEW.link_id='${order.orderId}' AND NEW.event_key='recharge_external_payment') EXECUTE FUNCTION public.recharge_bill_corrupt()`);
  try{await expect(new PaymentCallbackEventService(app(),f.env).processMessage(cb.message)).rejects.toThrow('当次入账余额');expect(await effects()).toEqual(before);}finally{await f.exec('DROP TRIGGER IF EXISTS recharge_bill_corrupt ON public.user_bill;DROP FUNCTION IF EXISTS public.recharge_bill_corrupt()');}
  expect(await retryCallback(cb.message)).toBe('completed');await send(await notice((await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,order.id)))[0]));
 });
 it('preserves a genuinely negative post-credit wallet and renders its exact historical bill balance',async()=>{
  await f.maintenanceDb.update(user).set({nowMoney:'-20.00'}).where(eq(user.uid,44));const{order}=await paid(44),event=await notice(order);expect(rechargePaidNoticeBusinessFromPayload(event.payload).postBalance).toBe('-8.50');await send(event);
 });

});
