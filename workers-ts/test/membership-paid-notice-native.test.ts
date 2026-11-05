/** Author acceptance, not independent review of the format8 Mini patch.
 * Actual UserJWT membership authors, five LOGINs, verified provider callbacks/
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
import { memberCard, memberCardBatch, memberShip, notificationTemplate, orderNotificationDelivery, otherOrder, otherOrderStatus,
  storeOrder, storeOrderOutbox, storeProduct, storeProductAttrValue, systemConfig, systemMessage, systemNotification, user, wechatUser,
  type OrderPaidNoticeOutboxPayload } from '@/models/schema';
import { runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { runMembershipPaidNoticeUpgrade } from '@/migrations/membershipPaidNotice';
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
import { OrderOutboxService, isOrderPaidOutboxMessage, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { consumeOrderPaidOutboxQueueMessage, consumeOrderNotificationOutboxQueueMessage } from '@/services/order/OrderPaidOutboxQueueConsumer';
import { membershipPaidNoticeBusinessFromPayload, membershipPaidNoticeEventKey, membershipPaidSettlementKey,
  type MembershipPaidNoticeBusiness } from '@/services/order/MembershipPaidNoticeCodec';
import { paidNoticeDate } from '@/services/order/OrderPaidNoticeCodec';
import { applyMembershipPayment } from '@/services/user/PaidMembershipService';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment } from '@/services/wechat/RoutineSubscriptionAccount';
import type { RoutineSubscriptionMembershipRequest, RoutineSubscriptionMembershipUnavailable } from '@/services/wechat/RoutineSubscriptionMembershipRequest';
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
type Member = typeof otherOrder.$inferSelect;
type Payload = MembershipPaidNoticeBusiness & {routineSubscriptionRequest?: RoutineSubscriptionMembershipRequest | RoutineSubscriptionMembershipUnavailable};
const A='wx-local-query',B='wx_member_current_b',OFFICIAL='wx_member_official';
const SUBREF='member_subscription_ref',SUBSECRET='synthetic-member-subscription-secret',SHIPREF='member_shipping_ref',SHIPSECRET='synthetic-member-shipping-secret';
const MINI='owned_member_1927',OFFICIAL_TEMPLATE='owned_member_43216',SMS='owned_member_sms';
const ACCOUNT='member_original_account',PAYREF='member_original_payment',MERCHANT='1234567890',AES='a'.repeat(32),SERIAL='TEST_QUERY_PUBLIC_KEY';
const FREE=65001,MONTH=65002,BATCH=65003,CARD=65004,EVER=65005,CARD_CODE='MEMBER-CARD-65',CARD_SECRET='CARD65KEY',PAYER='member_distinct_actual_payer';
const UIDS=[11,22,33,44] as const;
const OWNER:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'member_owned_uid'+uid]));
const OFFICIAL_OWNER:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'member_official_uid'+uid]));
const PHONE:Record<number,string>=Object.fromEntries(UIDS.map(uid=>[uid,'138000000'+String(uid).padStart(2,'0')]));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual membership settlement buyer notices on independent PG16 LOGINs',{timeout:60000},()=>{
 let f:Fixture,keys:ReturnType<typeof paymentQueryKeys>,signer:Awaited<ReturnType<typeof paymentQueryFixture>>;
 let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>,legacy:Member,legacyRequest='',serial=0,loginUid=11;
 let queried:{order:Member;transaction:string}|undefined;
 const expected=new Map<string,MembershipPaidNoticeBusiness>(),lostMini=new Set<string>(),shippingTransactions=new Map<string,string>();
 const posts:Array<{channel:string;orderNo:string;body:unknown}>=[];
 const app=()=>createContainerFromDb(f.appRuntime.db),outbox=()=>new OrderOutboxService(app(),f.env),delivery=()=>new OrderNotificationDeliveryService(app(),f.env);
 const named=()=>({database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin});
 async function config(values:Record<string,unknown>){
  await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
  await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
 }
 const current=(appId=B)=>config({routine_appId:appId,routine_appsecret:'synthetic-current-secret',wechat_appid:OFFICIAL,wechat_appsecret:'synthetic-official-secret',
  wechat_app_appid:B,pay_weixin_mchid:'1900000651',pay_weixin_serial_no:'B1B2C3D4',pay_weixin_open:1,order_shipping_open:0,
  member_card_status:1,balance_func_status:1,yue_pay_status:1});
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
    if(appId===A&&secret===SUBSECRET)return Response.json({access_token:'owned_member_mini_token',expires_in:7200});
    if(appId===A&&secret===SHIPSECRET)return Response.json({access_token:'owned_member_shipping_token',expires_in:7200});
    expect(appId).toBe(OFFICIAL);return Response.json({access_token:'owned_member_official_token',expires_in:7200});
   }
   expect(init?.method).toBe('POST');
   if(url.hostname==='dysmsapi.aliyuncs.com'){
    const params=new URLSearchParams(String(init?.body)),data=JSON.parse(params.get('TemplateParam')!) as {order_id:string;pay_price:string};
    const p=expected.get(data.order_id);expect(p).toBeDefined();expect(params.get('PhoneNumbers')).toBe(p!.phone);expect(params.get('TemplateCode')).toBe(SMS);
    expect(data).toEqual({order_id:p!.orderNo,pay_price:p!.payPrice});expect(params.get('Signature')).toBeTruthy();
    posts.push({channel:'sms',orderNo:p!.orderNo,body:data});return Response.json({Code:'OK',BizId:'owned-member-biz',RequestId:'owned-member-request'});
   }
   if(url.pathname==='/wxa/sec/order/upload_shipping_info'){
    const body=JSON.parse(String(init?.body)) as {order_key:{transaction_id:string};payer:{openid:string};logistics_type:number;delivery_mode:number;shipping_list:Array<{item_desc:string}>};
    const orderNo=shippingTransactions.get(body.order_key.transaction_id);expect(orderNo).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_member_shipping_token');
    expect(body).toMatchObject({payer:{openid:PAYER},logistics_type:3,delivery_mode:1});expect(body.shipping_list).toEqual([{item_desc:'用户购买30天会员卡'}]);
    posts.push({channel:'shipping',orderNo:orderNo!,body});return Response.json({errcode:0});
   }
   const body=JSON.parse(String(init?.body)) as {touser:string;template_id:string;page?:string;url?:string;data:Record<string,{value:string}>};
   if(url.pathname==='/cgi-bin/message/template/send'){
    const p=expected.get(body.data.character_string2.value);expect(p).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_member_official_token');
    expect(body.touser).toBe(OFFICIAL_OWNER[p!.userId]);expect(body.template_id).toBe(OFFICIAL_TEMPLATE);expect(body.url).toBe('/pages/annex/vip_paid/index');
    expect(body.data).toEqual({character_string2:{value:p!.orderNo},thing3:{value:p!.storeName},amount5:{value:p!.payPrice},phrase18:{value:p!.sendName},time4:{value:paidNoticeDate(p!.payTime)}});
    posts.push({channel:'official',orderNo:p!.orderNo,body});return Response.json({errcode:0,msgid:'owned_member_msg'});
   }
   expect(url.pathname).toBe('/cgi-bin/message/subscribe/send');
   const p=expected.get(body.data.character_string1.value);expect(p).toBeDefined();expect(url.searchParams.get('access_token')).toBe('owned_member_mini_token');
   expect(body.touser).toBe(OWNER[p!.userId]);expect(body.template_id).toBe(MINI);expect(body.page).toBe('/pages/goods/order_details/index?order_id='+p!.orderNo);
   expect(body.data).toEqual({character_string1:{value:p!.orderNo},amount2:{value:p!.payPrice+'元'},date3:{value:paidNoticeDate(p!.occurredAt)}});
   posts.push({channel:'mini',orderNo:p!.orderNo,body});
   const [active]=await f.maintenanceDb.execute<{count:number}>(sql`SELECT count(*)::integer AS count FROM pg_stat_activity
    WHERE datname=current_database() AND state='idle in transaction' AND usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.financialRuntime.role},${f.cashierRuntime.role},${f.managerRuntime.role})`);
   expect(active.count).toBe(0);if(lostMini.has(p!.orderNo))throw Error('Controlled lost response after actual Mini POST');return Response.json({errcode:0});
  });
 }
 async function ok<T>(path:string,body:unknown,uid=11):Promise<T>{const r=await f.request(path,body,undefined,uid);expect(r.body.status,r.body.msg).toBe(200);return r.body.data as T;}
 async function create(plan=MONTH,uid=11,requestId=randomUUID()){
  const c=await ok<{id:number;order_id:string}>('/user/member/card/create',{member_type:plan,from:'routine',request_id:requestId},uid);
  const rows=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.orderId,c.order_id));expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:c.id,uid,type:plan===FREE?0:1,paid:plan===FREE?1:0,isFree:plan===FREE?1:0,payPrice:plan===FREE?'0.00':'10.00',vipDay:plan===FREE?7:plan===EVER?0:30,isPermanent:plan===EVER?1:0});
  return{order:rows[0],requestId};
 }
 async function pay(order:Member){await ok('/user/member/card/pay',{uni:order.orderId,paytype:'yue',from:'h5'},order.uid);return(await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id)))[0];}
 async function notice(order:Member){
  const rows=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,membershipPaidNoticeEventKey(order.id)));expect(rows).toHaveLength(1);
  const event=rows[0],body=membershipPaidNoticeBusinessFromPayload(event.payload);
  expect(event).toMatchObject({aggregateType:'membership',aggregateId:order.id,eventType:'membership.pay.success.notice',addTime:body.occurredAt});
  expect(body).toMatchObject({domain:'membership',orderId:order.id,orderNo:order.orderId,userId:order.uid});expected.set(body.orderNo,body);return event;
 }
 function request(event:Event){const r=(event.payload as Payload).routineSubscriptionRequest;if(!r||'unavailable'in r)throw Error('Actual format8 request missing');return r;}
 async function consume(event:Event){
  await outbox().dispatchPending(1,event.id);const body=f.messages.filter(isOrderNotificationOutboxMessage).filter(m=>m.outboxId===event.id).at(-1);expect(body).toBeDefined();
  const ack=vi.fn(),retry=vi.fn();await consumeOrderNotificationOutboxQueueMessage({body:body!,attempts:1,ack,retry},outbox());
  expect(retry).not.toHaveBeenCalled();expect(ack).toHaveBeenCalledTimes(1);expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,event.id)))[0].status).toBe('COMPLETED');
 }
 const rows=(event:Event)=>f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey,event.eventKey)).orderBy(asc(orderNotificationDelivery.id));
 async function queued(event:Event){await consume(event);await delivery().dispatchPending(20,event.eventKey);return[...new Map(f.messages.filter(isOrderNotificationDeliveryMessage).filter(m=>m.eventKey===event.eventKey).map(m=>[m.deliveryId,m])).values()];}
 async function send(event:Event,mini:'sent'|'unknown'|'skipped'='sent'){
  const messages=await queued(event),p=membershipPaidNoticeBusinessFromPayload(event.payload);
  expect(new Set(messages.map(m=>m.channel))).toEqual(new Set(mini==='skipped'?['sms','wechat_official']:['sms','wechat_official','wechat_routine']));
  for(const message of messages)expect(await delivery().processMessage(message,network)).toBe(message.channel==='wechat_routine'&&mini==='unknown'?'unknown':'sent');
  const saved=await rows(event);expect(saved.find(r=>r.channel==='wechat_routine')?.status).toBe(mini==='skipped'?'SKIPPED':mini==='unknown'?'UNKNOWN':'SENT');
  expect(saved.filter(r=>r.channel!=='wechat_routine').every(r=>r.status==='SENT')).toBe(true);
  const physical=await f.maintenanceDb.execute<{domain:string;subject:number;order_id:number|null;withdrawal_id:number|null}>(sql`SELECT subject_domain AS domain,subject_id AS subject,order_id,withdrawal_id FROM public.order_notification_delivery WHERE event_key=${event.eventKey}`);
  expect(physical).toHaveLength(3);for(const row of physical)expect(row).toEqual({domain:'membership',subject:p.orderId,order_id:null,withdrawal_id:null});
  expect(await f.maintenanceDb.select().from(systemMessage).where(eq(systemMessage.eventKey,event.eventKey))).toMatchObject([{userId:p.userId,mark:'order_pay_success',title:'会员付款 '+p.orderNo,content:p.payPrice+' 1'}]);return messages;
 }
 async function effects(){const[row]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
  'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY uid) FROM public."user" t WHERE uid IN(11,22,33,44)),
  'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.other_order t),
  'statuses',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid,change_time,change_type) FROM public.other_order_status t),
  'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t),
  'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_order_outbox t WHERE aggregate_type='membership'),
  'deliveries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.order_notification_delivery t WHERE subject_domain='membership')) AS value`);return row.value;}
 async function closeNewAdmission(order:Member,provider:'weixin'|'alipay'){
  const offset=provider==='weixin'?10:11,batchId=BATCH+offset,cardId=CARD+offset;
  const code=provider==='weixin'?'ADMISSION-CARD-WX65':'ADMISSION-CARD-ALI65',secret='ADMIT65KEY';
  await f.maintenanceDb.insert(memberCardBatch).values({id:batchId,title:'关闭新准入实际未使用卡',totalNum:1,useNum:0,useDay:7,status:1});
  await f.maintenanceDb.insert(memberCard).values({id:cardId,cardBatchId:batchId,cardNumber:code,cardPassword:secret,status:1,useUid:0,useTime:0});
  await config({member_card_status:0});
  const original=f.env.CONFIG_KV;
  const cachedGet=vi.fn(async(...args:unknown[])=>args[0]==='cfg_member_card_status'?'1':Reflect.apply(original.get,original,args));
  f.env.CONFIG_KV=new Proxy(original,{get:(target,key,receiver)=>key==='get'?cachedGet:Reflect.get(target,key,receiver)});
  const restore=()=>{f.env.CONFIG_KV=original;};
  async function assertClosed(){
   expect(await app().systemConfigDao.getValue('member_card_status')).toBe('0');
   expect(await f.env.CONFIG_KV.get('cfg_member_card_status')).toBe('1');
   const before=await effects(),count=f.messages.length,requests=network.mock.calls.length,sequence=serial;
   const cards=await f.maintenanceDb.select().from(memberCard).where(eq(memberCard.id,cardId));
   const batches=await f.maintenanceDb.select().from(memberCardBatch).where(eq(memberCardBatch.id,batchId));
   expect(cards).toMatchObject([{useUid:0,useTime:0,status:1}]);expect(batches).toMatchObject([{useNum:0,status:1}]);
   const purchase=await f.request('/user/member/card/create',{member_type:MONTH,from:'routine',request_id:randomUUID()},undefined,order.uid);
   expect(purchase.body).toMatchObject({status:400,msg:'付费会员功能暂未开启'});
   const draw=await f.request('/user/member/card/draw',{member_card_code:code,member_card_pwd:secret,from:'h5'},undefined,order.uid);
   expect(draw.body).toMatchObject({status:400,msg:'会员功能暂未开启'});
   expect(await effects()).toEqual(before);expect(f.messages).toHaveLength(count);expect(network.mock.calls).toHaveLength(requests);expect(serial).toBe(sequence);
   expect(await f.maintenanceDb.select().from(memberCard).where(eq(memberCard.id,cardId))).toEqual(cards);
   expect(await f.maintenanceDb.select().from(memberCardBatch).where(eq(memberCardBatch.id,batchId))).toEqual(batches);
  }
  try{await assertClosed();return{assertClosed,restore};}catch(error){restore();throw error;}
 }
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
  const transaction='member_tx_'+randomUUID().replaceAll('-',''),p=packet(order,transaction),pending:Promise<unknown>[]=[];
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
  const key='membership.paid.shipping:'+order.id;
  const[row]=await f.maintenanceDb.execute<{id:number;add_time:number;available_time:number;subject_domain:string;subject_id:number;order_id:number|null;withdrawal_id:number|null;status:string}>(sql`
   SELECT id,add_time,available_time,subject_domain,subject_id,order_id,withdrawal_id,status FROM public.order_notification_delivery WHERE event_key=${key} AND channel='wechat_shipping'`);
  expect(row).toMatchObject({subject_domain:'membership',subject_id:order.id,order_id:null,withdrawal_id:null,status:'ENQUEUED'});expect(row.available_time-row.add_time).toBe(10);
  expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key)))[0]).toMatchObject({aggregateType:'membership',aggregateId:order.id,status:'COMPLETED',eventType:'membership.paid.shipping'});
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
  await runPaidNoticeUpgrade(f.maintenanceDb);
  expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime].map(role=>role.verify()))).size).toBe(5);
  Object.assign(f.env,{ALIYUN_SMS_ACCESS_KEY_ID:'synthetic-member-key',ALIYUN_SMS_ACCESS_KEY_SECRET:'synthetic-member-secret',ALIYUN_SMS_SIGN_NAME:'会员原生验收',
   WECHAT_MCH_PRIVATE_KEY:keys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:keys.publicKey,WECHAT_PLATFORM_PUBLIC_KEY_ID:SERIAL,WECHAT_API_V3_KEY:AES,
   ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SUBREF,version:1,appId:A,secret:SUBSECRET}]}),
   ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SHIPREF,version:1,appId:A,secret:SHIPSECRET}]}),
   ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:PAYREF,version:1,appId:A,merchantId:MERCHANT,
    serialNo:'ABCDEF123456',apiV3Key:AES,privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:SERIAL}]})});
  f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async(input:Request|string|URL)=>new Response((new URL(String(input)).searchParams.get('prefix')??'wx')+'_member_notice_'+(++serial))})} as unknown as Env['SEQUENCE'];
  for(const uid of UIDS){
   await f.maintenanceDb.insert(user).values({uid,account:'member-notice-'+uid,pwd:'owned-financial-password',status:1}).onConflictDoNothing();
   await f.maintenanceDb.update(user).set({phone:PHONE[uid],nickname:'会员'+uid,nowMoney:'1000.00',pwd:'owned-financial-password',isMoneyLevel:0,isEverLevel:0,overdueTime:0,isDel:0,status:1}).where(eq(user.uid,uid));
  }
  await f.maintenanceDb.update(wechatUser).set({isDel:1}).where(and(inArray(wechatUser.uid,[...UIDS]),eq(wechatUser.userType,'routine')));
  for(const uid of UIDS)await f.maintenanceDb.insert(wechatUser).values({uid,userType:'wechat',openid:OFFICIAL_OWNER[uid],isDel:0});
  await f.maintenanceDb.insert(memberShip).values([{id:FREE,type:'free',title:'会员通知真实免费7天',vipDay:7,price:'0.00',prePrice:'0.00',isDel:0},
   {id:MONTH,type:'month',title:'会员通知真实付费30天',vipDay:30,price:'12.00',prePrice:'10.00',isDel:0},
   {id:EVER,type:'ever',title:'会员通知真实永久会员',vipDay:0,price:'12.00',prePrice:'10.00',isDel:0}]);
  await f.maintenanceDb.insert(memberCardBatch).values({id:BATCH,title:'会员通知实际卡密静默批次',totalNum:1,useNum:0,useDay:10,status:1});
  await f.maintenanceDb.insert(memberCard).values({id:CARD,cardBatchId:BATCH,cardNumber:CARD_CODE,cardPassword:CARD_SECRET,status:1,useUid:0,useTime:0});
  await f.maintenanceDb.update(storeProduct).set({productType:0,type:0,relationId:0,storeName:'同ID真实商品对照',isVip:0,freight:2,stock:100,sales:0}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.update(storeProductAttrValue).set({price:'7.00',vipPrice:'7.00',stock:100,sales:0}).where(eq(storeProductAttrValue.id,1));
  await f.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark,'order_pay_success'));
  await f.maintenanceDb.insert(systemNotification).values({mark:'order_pay_success',isSystem:1,isSms:1,isWechat:1,isRoutine:1,smsId:SMS,systemTitle:'会员付款 {order_id}',systemText:'{pay_price} {total_num}'});
  await f.maintenanceDb.delete(notificationTemplate).where(inArray(notificationTemplate.mark,['43216','1927']));
  await f.maintenanceDb.insert(notificationTemplate).values([{mark:'43216',legacyType:1,status:1,tempid:OFFICIAL_TEMPLATE},{mark:'1927',legacyType:0,status:1,tempid:'current_b_template_is_not_original_authority'}]);
  await current();provider();await identity(11);await identity(44);signer=await paymentQueryFixture(app(),keys);
  const now=Math.floor(Date.now()/1000);
  await appendRoutineSubscriptionAccountPolicy(f.maintenanceDb,f.env,named(),{operationId:randomUUID(),expectedRevision:0,data:{
   accountId:routineSubscriptionAccountId(f.env,A),state:'active',appId:A,credentialRef:SUBREF,credentialVersion:1,
   credentialStamp:routineSubscriptionCredentialCommitment(f.env,SUBREF,1).credentialStamp,purposes:['subscription_send'],templates:[{mark:'1927',templateId:MINI}],validFrom:now-60,validUntil:now+7200}});
  await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',data:{
   accountId:ACCOUNT,state:'active',...routinePaymentCredentialCommitment(f.env,PAYREF,1),credentialRef:PAYREF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+7200}});
  await appendRoutineShippingAccountPolicy(f.maintenanceDb,f.env,named(),{operationId:randomUUID(),expectedRevision:0,data:{
   accountId:routineShippingAccountId(f.env,A,MERCHANT),state:'active',appId:A,merchantId:MERCHANT,credentialRef:SHIPREF,credentialVersion:1,
   credentialStamp:routineShippingCredentialCommitment(f.env,SHIPREF,1).credentialStamp,purposes:['shipping_upload'],validFrom:now-60,validUntil:now+7200}});
  const first=await create();legacyRequest=first.requestId;legacy=await pay(first.order);
  expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,membershipPaidSettlementKey(legacy.id)))).toHaveLength(0);
  await runMembershipPaidNoticeUpgrade(f.maintenanceDb);
 },240000);
 afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);

 it('never backfills genuine pre-commission paid membership through payment/UUID/receipt/scanner replay',async()=>{
  const before=await effects(),count=f.messages.length;await pay(legacy);
  await ok('/user/member/card/create',{member_type:MONTH,from:'routine',request_id:legacyRequest});
  expect((await f.request('/user/member/card/index?purchase_request='+legacyRequest,undefined,undefined,11)).body.status).toBe(200);
  await delivery().dispatchPending(20,membershipPaidNoticeEventKey(legacy.id));
  for(const key of[membershipPaidSettlementKey(legacy.id),membershipPaidNoticeEventKey(legacy.id)])
   expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key))).toHaveLength(0);
  expect(await effects()).toEqual(before);expect(f.messages).toHaveLength(count);
 });
 it('grants a real free claim once, sends four channels from unique A and retains immutable UUID/pay replays',async()=>{
  const{order,requestId}=await create(FREE),event=await notice(order),p=membershipPaidNoticeBusinessFromPayload(event.payload);
  expect(request(event)).toMatchObject({format:8,actor:{role:f.appRuntime.role},selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
  expect(p).toMatchObject({kind:'free-claim',payPrice:'0.00',payType:'yue',tradeNo:'',storeName:'免费领取会员卡'});
  await send(event);const before=await effects(),count=posts.length;
  await ok('/user/member/card/create',{member_type:FREE,from:'routine',request_id:requestId});await pay(order);
  const receipt=await f.request('/user/member/card/index?purchase_request='+requestId,undefined,undefined,11);
  expect(receipt.body.status,receipt.body.msg).toBe(200);expect(receipt.body.data).toMatchObject({state:'committed',order:{id:order.id,paid:true}});
  expect(await outbox().processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('already-completed');
  expect(await effects()).toEqual(before);expect(posts).toHaveLength(count);
 });
 it('settles actual balance membership with four channels after A becomes B and no fake original-provider proof',async()=>{
  const order=await pay((await create()).order),event=await notice(order);
  expect(request(event)).toMatchObject({format:8,selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
  expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence`)).toHaveLength(0);await send(event);
  const[mini]=(await rows(event)).filter(r=>r.channel==='wechat_routine');
  const[a]=await f.maintenanceDb.execute<{payload:{facts:{subjectDomain:string;payment:{kind:string}}}}>(sql`SELECT payload FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.id}`);
  expect(a.payload.facts).toMatchObject({subjectDomain:'membership',payment:{kind:'unique-identity'}});
  const before=await effects(),count=posts.length;await pay(order);expect(await effects()).toEqual(before);expect(posts).toHaveLength(count);
 });
 it('keeps actual card draw type2 silent with real single-use card/batch/right accounting',async()=>{
  const before=await f.maintenanceDb.select().from(storeOrderOutbox),count=f.messages.length,sent=posts.length;
  const c=await ok<{order_id:string;overdue_time:number}>('/user/member/card/draw',{member_card_code:CARD_CODE,member_card_pwd:CARD_SECRET,from:'h5'},33);
  const[order]=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.orderId,c.order_id));
  expect(order).toMatchObject({uid:33,type:2,paid:1,payPrice:'0.00',code:CARD_CODE});
  expect((await f.maintenanceDb.select().from(memberCard).where(eq(memberCard.id,CARD)))[0]).toMatchObject({useUid:33});
  expect((await f.maintenanceDb.select().from(memberCardBatch).where(eq(memberCardBatch.id,BATCH)))[0].useNum).toBe(1);
  expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,33)))[0]).toMatchObject({isMoneyLevel:2,overdueTime:c.overdue_time});
  expect(await f.maintenanceDb.select().from(otherOrderStatus).where(eq(otherOrderStatus.oid,order.id))).toMatchObject([{changeType:'card_redeem',shopType:2}]);
  expect(await f.maintenanceDb.select().from(storeOrderOutbox)).toEqual(before);expect(f.messages).toHaveLength(count);expect(posts).toHaveLength(sent);
  expect((await f.request('/user/member/card/draw',{member_card_code:CARD_CODE,member_card_pwd:CARD_SECRET,from:'h5'},undefined,33)).body.status).toBe(400);
  expect((await f.maintenanceDb.select().from(memberCardBatch).where(eq(memberCardBatch.id,BATCH)))[0].useNum).toBe(1);
 });
 it('freezes unavailable for a second bare live binding and never adopts the old request after repair',async()=>{
  const[bare]=await f.maintenanceDb.insert(wechatUser).values({uid:11,userType:'routine',openid:'member_bare_unmaintained_b',isDel:0}).returning();
  let event:Event;
  try{const order=await pay((await create()).order);event=await notice(order);expect((event.payload as Payload).routineSubscriptionRequest).toEqual({format:8,unavailable:true});}
  finally{await f.maintenanceDb.update(wechatUser).set({isDel:1}).where(eq(wechatUser.id,bare.id));}
  await send(event!,'skipped');await send(await notice(await pay((await create()).order)));
 });

 it('cannot borrow a genuine ordinary format7 request through the same numeric other_order ID',async()=>{
  // Sequence positioning changes no business row. Both domains then obtain
  // their matching ID through their own real HTTP create/payment authors.
  const[n]=await f.maintenanceDb.execute<{n:number}>(sql`SELECT GREATEST(COALESCE((SELECT max(id) FROM public.store_order),0),COALESCE((SELECT max(id) FROM public.other_order),0))+100 AS n`);
  await f.maintenanceDb.execute(sql`SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.store_order','id'),${n.n-1},true),
   pg_catalog.setval(pg_catalog.pg_get_serial_sequence('public.other_order','id'),${n.n-1},true)`);
  const cart=await ok<{cartId:number}>('/cart/add',{productId:70,uniqueId:'qared001',cartNum:1,isNew:1});
  const selection={cartIds:[cart.cartId],shippingType:2,storeId:1,useIntegral:false,couponId:0};
  const quote=await ok<{orderKey:string;quoteToken:string}>('/order/confirm',selection);
  const created=await ok<{orderId:string}>('/order/create/'+quote.orderKey,{...selection,quoteToken:quote.quoteToken,
   realName:'商品对照',userPhone:PHONE[11],payType:'yue',from:'h5'});
  const[ordinary]=await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.orderId,created.orderId));
  expect(ordinary).toMatchObject({id:n.n,uid:11,paid:1});
  const[paid]=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'order.paid:'+ordinary.id));
  await outbox().dispatchPending(1,paid.id);
  const body=f.messages.filter(isOrderPaidOutboxMessage).filter(m=>m.outboxId===paid.id).at(-1);expect(body).toBeDefined();
  const ack=vi.fn(),retry=vi.fn();await consumeOrderPaidOutboxQueueMessage({body:body!,attempts:1,ack,retry},outbox(),delivery());
  expect(ack).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
  const[ordinaryNotice]=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,'order.pay.success.notice:'+ordinary.id));
  const ordinaryRequest=(ordinaryNotice.payload as OrderPaidNoticeOutboxPayload).routineSubscriptionRequest;
  expect(ordinaryRequest).toMatchObject({format:7,selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
  const order=await pay((await create(MONTH,22)).order),event=await notice(order);
  expect(order.id).toBe(ordinary.id);expect((event.payload as Payload).routineSubscriptionRequest).toEqual({format:8,unavailable:true});
  // Maintenance-only negative specimen: a genuine other-domain request is
  // transplanted into this notice. No paid fact or ownership signature is
  // created, and it must never authorize a membership Mini provider POST.
  const corrupt={...membershipPaidNoticeBusinessFromPayload(event.payload),routineSubscriptionRequest:ordinaryRequest};
  await f.withMaintenancePeer(peer=>peer.execute(sql`UPDATE public.store_order_outbox SET payload=${JSON.stringify(corrupt)}::jsonb WHERE id=${event.id}`));
  const[changed]=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,event.id));await send(changed,'skipped');
  expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(0);
  expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,ordinaryNotice.id)))[0]).toEqual(ordinaryNotice);
 });
 it('never adopts an unknown UID settlement after later genuine phone continuity establishes A ownership',async()=>{
  const order=await pay((await create(MONTH,22)).order),event=await notice(order);
  expect((event.payload as Payload).routineSubscriptionRequest).toEqual({format:8,unavailable:true});
  await identity(22);await send(event,'skipped');
  const next=await notice(await pay((await create(MONTH,22)).order));
  expect(request(next)).toMatchObject({format:8,selection:{mode:'unique-owner',appId:A,openid:OWNER[22]}});await send(next);
 });
 for(const kind of['membership.settled','membership.pay.success.notice'] as const)
 it('rolls back actual balance, rights and status on returned '+kind+' INSERT corruption, then pays once',async()=>{
  const order=(await create()).order,before=await effects(),sent=structuredClone(posts),count=f.messages.length;
  await f.exec(`CREATE FUNCTION public.member_notice_corrupt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $owned$
   BEGIN NEW.payload=pg_catalog.jsonb_set(NEW.payload,'{signature}','"corrupted"'::jsonb,true);RETURN NEW;END $owned$;
   REVOKE ALL ON FUNCTION public.member_notice_corrupt() FROM PUBLIC;
   CREATE TRIGGER member_notice_corrupt BEFORE INSERT ON public.store_order_outbox FOR EACH ROW
    WHEN(NEW.event_type='${kind}' AND NEW.aggregate_id=${order.id}) EXECUTE FUNCTION public.member_notice_corrupt()`);
  try{
   const result=await f.request('/user/member/card/pay',{uni:order.orderId,paytype:'yue',from:'h5'},undefined,order.uid);
   expect(result.body.status).toBe(500);expect(await effects()).toEqual(before);expect(posts).toEqual(sent);expect(f.messages).toHaveLength(count);
  }finally{await f.exec('DROP TRIGGER IF EXISTS member_notice_corrupt ON public.store_order_outbox; DROP FUNCTION IF EXISTS public.member_notice_corrupt()');}
  const saved=await pay(order);expect(saved.paid).toBe(1);const event=await notice(saved);expect(request(event).format).toBe(8);await send(event);
  const statuses=await f.maintenanceDb.select().from(otherOrderStatus).where(and(eq(otherOrderStatus.oid,order.id),eq(otherOrderStatus.changeType,'pay_success')));
  expect(statuses).toHaveLength(1);const committed=await effects();await pay(order);expect(await effects()).toEqual(committed);
 });
 it('rolls back a real free-create grant and retries that exact UUID without manufacturing a paid row',async()=>{
  const requestId=randomUUID(),before=await effects(),count=f.messages.length;
  await f.exec(`CREATE FUNCTION public.member_free_corrupt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $owned$
   BEGIN NEW.payload=pg_catalog.jsonb_set(NEW.payload,'{signature}','"corrupted"'::jsonb,true);RETURN NEW;END $owned$;
   REVOKE ALL ON FUNCTION public.member_free_corrupt() FROM PUBLIC;
   CREATE TRIGGER member_free_corrupt BEFORE INSERT ON public.store_order_outbox FOR EACH ROW
    WHEN(NEW.event_type='membership.settled' AND NEW.payload->'business'->>'userId'='44') EXECUTE FUNCTION public.member_free_corrupt()`);
  try{
   const result=await f.request('/user/member/card/create',{member_type:FREE,from:'routine',request_id:requestId},undefined,44);
   expect(result.body.status).toBe(500);expect(await effects()).toEqual(before);expect(f.messages).toHaveLength(count);
  }finally{await f.exec('DROP TRIGGER IF EXISTS member_free_corrupt ON public.store_order_outbox; DROP FUNCTION IF EXISTS public.member_free_corrupt()');}
  const{order}=await create(FREE,44,requestId);await send(await notice(order));
  expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,44)))[0]).toMatchObject({isMoneyLevel:1,overdueTime:order.overdueTime});
 });
 it('rolls back a real identity SELECT lock conflict and retries with a valid request instead of freezing unavailable',async()=>{
  const order=(await create()).order,before=await effects(),count=f.messages.length;
  await f.withMaintenancePeer(peer=>peer.transaction(async held=>{
   await held.execute(sql`LOCK TABLE ONLY public.routine_identity_ownership IN ACCESS EXCLUSIVE MODE NOWAIT`);
   // This is the exact App core behind the HTTP payment route. Calling it
   // directly preserves the real driver SQLSTATE that HTTP deliberately hides.
   const failure:unknown=await applyMembershipPayment(app(),{uid:order.uid,orderId:order.orderId,payType:'yue',
    debitBalance:true,routineNotice:{APP_KEY:f.env.APP_KEY}}).then(()=>null,error=>error);
   expect(failure).toBeInstanceOf(Error);expect(sqlStates(failure)).toContain('55P03');
   expect(await effects()).toEqual(before);expect(f.messages).toHaveLength(count);
   expect((await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id)))[0].paid).toBe(0);
  }));
  const event=await notice(await pay(order));expect(request(event)).toMatchObject({format:8,selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
  await send(event);
 });
 it('retains an immutable unknown Mini attempt and never repeats a possible provider POST',async()=>{
  const order=await pay((await create()).order),event=await notice(order);lostMini.add(order.orderId);
  try{
   const messages=await send(event,'unknown'),mini=messages.find(m=>m.channel==='wechat_routine');expect(mini).toBeDefined();
   expect(await delivery().processMessage(mini!,network)).toBe('unknown');
   expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(1);
   expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini!.deliveryId}`)).toHaveLength(1);
   expect(await f.maintenanceDb.execute(sql`SELECT r.result_id FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${mini!.deliveryId}`)).toHaveLength(0);
  }finally{lostMini.delete(order.orderId);}
 });
 it('makes a confirmed pre-attempt membership source SQL lock RETRYABLE with zero evidence, then posts exactly once',async()=>{
  const order=await pay((await create()).order),event=await notice(order),messages=await queued(event);
  const mini=messages.find(m=>m.channel==='wechat_routine');expect(mini).toBeDefined();
  for(const message of messages.filter(m=>m.channel!=='wechat_routine'))expect(await delivery().processMessage(message,network)).toBe('sent');
  const[before]=(await rows(event)).filter(r=>r.channel==='wechat_routine');expect(before).toMatchObject({status:'ENQUEUED',attemptCount:0});
  await f.withMaintenancePeer(peer=>peer.transaction(async held=>{
   // Stage is already committed. This UPDATE takes ROW EXCLUSIVE while the
   // fresh physical source proof needs SHARE ROW EXCLUSIVE NOWAIT. Mini's
   // claim proves only its physical subject and cannot acquire this lock.
   await held.execute(sql`UPDATE public.other_order SET remarks=remarks WHERE id=${order.id}`);
   expect(await delivery().processMessage(mini!,network)).toBe('retry-scheduled');
   const[retry]=(await rows(event)).filter(r=>r.channel==='wechat_routine');
   expect(retry).toMatchObject({status:'RETRYABLE',attemptCount:0,dispatchCount:before.dispatchCount,leaseToken:'',leaseUntil:0});
   expect(retry.availableTime).toBeGreaterThan(retry.updateTime);expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(0);
   expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini!.deliveryId}`)).toHaveLength(0);
   expect(await f.maintenanceDb.execute(sql`SELECT r.result_id FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${mini!.deliveryId}`)).toHaveLength(0);
  }));
  const[retry]=(await rows(event)).filter(r=>r.channel==='wechat_routine'),start=f.messages.length;
  // Advance only the scanner's application deadline. Restore the clock
  // before claim/source/evidence so its SQL-clock lease remains genuine.
  const clock=vi.spyOn(Date,'now').mockReturnValue((retry.availableTime+1)*1000);
  try{expect((await delivery().dispatchPending(20,event.eventKey)).enqueued).toBe(1);}finally{clock.mockRestore();}
  const next=f.messages.slice(start).filter(isOrderNotificationDeliveryMessage).find(m=>m.deliveryId===mini!.deliveryId);expect(next).toBeDefined();
  expect(await delivery().processMessage(next!,network)).toBe('sent');
  const[done]=(await rows(event)).filter(r=>r.channel==='wechat_routine');
  expect(done).toMatchObject({status:'SENT',attemptCount:1,dispatchCount:before.dispatchCount+1});
  expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(1);
  expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini!.deliveryId}`)).toHaveLength(1);
  expect(await f.maintenanceDb.execute(sql`SELECT r.result_id FROM public.routine_subscribe_result r JOIN public.routine_subscribe_attempt a USING(attempt_id) WHERE a.delivery_id=${mini!.deliveryId}`)).toHaveLength(1);
 });
 it('settles an existing member order through a real Routine callback after new admission closes, with four notices and independent virtual upload',async()=>{
  const order=(await create()).order;await config({order_shipping_open:1});
  let admission:Awaited<ReturnType<typeof closeNewAdmission>>|undefined;
  try{
   admission=await closeNewAdmission(order,'weixin');
   const[buyer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,order.uid));
   const cb=await callback(order),service=new PaymentCallbackEventService(app(),f.env);
   expect(await service.processMessage(cb.message)).toBe('completed');
   const[saved]=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id));expect(saved).toMatchObject({paid:1,payType:'weixin',tradeNo:cb.transaction});
   expect(saved.overdueTime).toBe(Math.max(buyer.overdueTime,saved.payTime)+30*86400);
   expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,order.uid)))[0]).toMatchObject({nowMoney:buyer.nowMoney,overdueTime:saved.overdueTime,isMoneyLevel:1});
   const event=await notice(saved);expect(request(event)).toMatchObject({format:8,selection:{mode:'routine-original',appId:A,openid:OWNER[11]}});
   await send(event);await shipping(saved,cb.transaction);
   const[evidence]=await f.maintenanceDb.execute<{payload:{binding:{local:{domain:string;orderId:number;buyerUid:number}}}}>(sql`
    SELECT payload FROM public.routine_original_payment_evidence WHERE payload->'binding'->'local'->>'orderNo'=${order.orderId}`);
   expect(evidence.payload.binding.local).toMatchObject({domain:'membership',orderId:order.id,buyerUid:11});
   const before=await effects(),sent=structuredClone(posts),queueCount=f.messages.length;
   expect(await service.processMessage(cb.message)).toBe('already-completed');await cb.ingress();
   await ok('/user/member/card/pay',{uni:saved.orderId,paytype:'weixin',from:'h5'},saved.uid);
   expect(await effects()).toEqual(before);expect(posts).toEqual(sent);expect(f.messages).toHaveLength(queueCount);
   expect(await f.maintenanceDb.select().from(otherOrderStatus).where(and(eq(otherOrderStatus.oid,order.id),eq(otherOrderStatus.changeType,'pay_success')))).toHaveLength(1);
   expect(await f.maintenanceDb.execute(sql`SELECT id FROM public.payment_callback_event WHERE provider='wechat' AND order_no=${order.orderId}
    AND status='COMPLETED' AND order_domain='membership'`)).toHaveLength(1);
   await admission.assertClosed();
  }finally{admission?.restore();await current();}
 });
 it('settles the actual membership through approved default signed-query and independently dispatches both Mini and virtual shipping',async()=>{
  const order=(await create()).order,transaction='member_query_'+randomUUID().replaceAll('-','');
  const queryRequest:PaymentProviderQueryRequest={provider:'wechat',profile:'routine',orderDomain:'membership',orderNo:order.orderId,expectedAmountCents:1000,currency:'CNY'};
  queried={order,transaction};shippingTransactions.set(transaction,order.orderId);await config({order_shipping_open:1});
  try{
   const now=Math.floor(Date.now()/1000);await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'query',
    data:{state:'active',accountId:ACCOUNT,accountRevision:1,request:queryRequest,validFrom:now-60,validUntil:now+1800}});
   const service=new PaymentReconciliationService(app(),f.env),registered=await service.registerIntent({...queryRequest,initiatedAt:now-121});
   await service.dispatchPage({action:'dispatchPaymentReconciliation',scheduledAt:Date.now(),cursor:0});
   const message=f.messages.filter(isPaymentReconciliationMessage).find(m=>m.caseId===registered.id);expect(message).toBeDefined();
   expect(await service.processMessage(message!)).toBe('settled');
   const[saved]=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id));expect(saved).toMatchObject({paid:1,payType:'weixin',tradeNo:transaction});
   const event=await notice(saved);expect(request(event)).toMatchObject({format:8,selection:{mode:'routine-original',appId:A,openid:OWNER[11]}});
   await send(event);await shipping(saved,transaction);
   const before=await effects(),sent=structuredClone(posts);expect(await service.processMessage(message!)).toBe('already-terminal');
   expect(await effects()).toEqual(before);expect(posts).toEqual(sent);
  }finally{queried=undefined;await current();}
 });
 it('settles an existing member order through a real RSA2 Alipay callback after new admission closes, with four notices and no WeChat virtual shipment',async()=>{
  const order=(await create()).order,aliKeys=paymentQueryKeys(),aliApp='2026110400000065',seller='2088000000000065';
  const originalEnv={ALIPAY_APP_ID:f.env.ALIPAY_APP_ID,ALIPAY_PUBLIC_KEY:f.env.ALIPAY_PUBLIC_KEY,ALIPAY_SELLER_ID:f.env.ALIPAY_SELLER_ID};
  Object.assign(f.env,{ALIPAY_APP_ID:aliApp,ALIPAY_PUBLIC_KEY:aliKeys.publicKey,ALIPAY_SELLER_ID:seller});
  await config({order_shipping_open:1});
  let admission:Awaited<ReturnType<typeof closeNewAdmission>>|undefined;
  try{
   admission=await closeNewAdmission(order,'alipay');
   const[buyer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,order.uid));
   const originalEvidence=await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence ORDER BY evidence_id`);
   const transaction='member_ali_'+randomUUID().replaceAll('-','');
   const params:Record<string,string>={app_id:aliApp,seller_id:seller,out_trade_no:order.orderId,trade_no:transaction,
    notify_id:randomUUID(),trade_status:'TRADE_SUCCESS',total_amount:'10.00',sign_type:'RSA2',
    gmt_payment:new Date(Date.now()+8*3600*1000).toISOString().slice(0,19).replace('T',' ')};
   // Independent Node RSA signer -> production WebCrypto verification. This
   // is an authentic provider form, never a seeded callback or paid fact.
   const content=Object.keys(params).sort().map(key=>key+'='+params[key]).join('&');
   const body=new URLSearchParams({...params,sign:Buffer.from(sign('RSA-SHA256',Buffer.from(content),aliKeys.privateKey)).toString('base64')}).toString();
   const h=new Hono<{Bindings:Env;Variables:AppVariables}>(),pending:Promise<unknown>[]=[];
   h.use('*',async(c,next)=>{c.set('container',app());await next();});h.onError(errorHandler);h.route('/api',v1Routes);
   const ingress=async()=>{
    const response=await h.request('/api/pay/notify/alipay',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},f.env,
     {waitUntil:(work:Promise<unknown>)=>pending.push(work),props:{},passThroughOnException:()=>{throw Error('Unexpected fallback');}});
    await Promise.all(pending.splice(0));expect(response.status).toBe(200);expect(await response.text()).toBe('success');
   };
   const first=f.messages.length;await ingress();
   expect((await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id)))[0].paid).toBe(0);
   const message=f.messages.slice(first).find(isPaymentCallbackMessage);expect(message).toBeDefined();
   const service=new PaymentCallbackEventService(app(),f.env);expect(await service.processMessage(message!)).toBe('completed');
   const[saved]=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,order.id));
   expect(saved).toMatchObject({paid:1,type:1,payType:'alipay',payPrice:'10.00',tradeNo:transaction,uid:11});
   expect(saved.overdueTime).toBe(Math.max(buyer.overdueTime,saved.payTime)+30*86400);
   expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,order.uid)))[0]).toMatchObject({nowMoney:buyer.nowMoney,overdueTime:saved.overdueTime,isMoneyLevel:1});
   const event=await notice(saved);expect(request(event)).toMatchObject({format:8,selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
   expect(membershipPaidNoticeBusinessFromPayload(event.payload)).toMatchObject({kind:'paid-membership',payType:'alipay',tradeNo:transaction});
   await send(event);
   const[mini]=(await rows(event)).filter(r=>r.channel==='wechat_routine');
   const[attempt]=await f.maintenanceDb.execute<{payload:{facts:{subjectDomain:string;payment:{kind:string;payType:string}}}}>(sql`
    SELECT payload FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.id}`);
   expect(attempt.payload.facts).toMatchObject({subjectDomain:'membership',payment:{kind:'unique-identity',payType:'alipay'}});
   expect(await f.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence ORDER BY evidence_id`)).toEqual(originalEvidence);
   const shippingKey='membership.paid.shipping:'+order.id;
   expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,shippingKey))).toHaveLength(0);
   expect(await f.maintenanceDb.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.eventKey,shippingKey))).toHaveLength(0);
   expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='shipping')).toHaveLength(0);
   const committed=await effects(),sent=structuredClone(posts),queueCount=f.messages.length;
   expect(await service.processMessage(message!)).toBe('already-completed');await ingress();
   await ok('/user/member/card/pay',{uni:saved.orderId,paytype:'alipay',from:'h5'},saved.uid);
   expect(await effects()).toEqual(committed);expect(posts).toEqual(sent);expect(f.messages).toHaveLength(queueCount);
   expect(await f.maintenanceDb.select().from(otherOrderStatus).where(and(eq(otherOrderStatus.oid,order.id),eq(otherOrderStatus.changeType,'pay_success')))).toHaveLength(1);
   expect(await f.maintenanceDb.execute(sql`SELECT id FROM public.payment_callback_event WHERE provider='alipay' AND order_no=${order.orderId}
    AND status='COMPLETED' AND order_domain='membership'`)).toHaveLength(1);
   expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(inArray(storeOrderOutbox.eventKey,
    [membershipPaidSettlementKey(order.id),membershipPaidNoticeEventKey(order.id)]))).toHaveLength(2);
   expect(await f.maintenanceDb.execute(sql`SELECT attempt_id FROM public.routine_subscribe_attempt WHERE delivery_id=${mini.id}`)).toHaveLength(1);
   expect(posts.filter(p=>p.orderNo===order.orderId&&p.channel==='mini')).toHaveLength(1);
   await admission.assertClosed();
  }finally{admission?.restore();Object.assign(f.env,originalEnv);await current();}
 });
 it('settles an actual permanent plan, sends all four channels and preserves rights/debit/notice on replay',async()=>{
  const[buyer]=await f.maintenanceDb.select().from(user).where(eq(user.uid,11));
  const{order,requestId}=await create(EVER),saved=await pay(order),event=await notice(saved);
  expect(saved).toMatchObject({type:1,paid:1,payType:'yue',payPrice:'10.00',isPermanent:1,vipDay:0,overdueTime:-1});
  expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,11)))[0]).toMatchObject({
   nowMoney:(Number(buyer.nowMoney)-10).toFixed(2),isMoneyLevel:1,isEverLevel:1,overdueTime:0});
  expect(membershipPaidNoticeBusinessFromPayload(event.payload)).toMatchObject({kind:'paid-membership',isPermanent:1,vipDay:0,overdueTime:-1});
  expect(request(event)).toMatchObject({format:8,selection:{mode:'unique-owner',appId:A,openid:OWNER[11]}});
  await send(event);
  expect(posts.filter(p=>p.orderNo===saved.orderId).map(p=>p.channel).sort()).toEqual(['mini','official','sms']);
  const committed=await effects(),sent=structuredClone(posts),queueCount=f.messages.length;
  await pay(saved);await ok('/user/member/card/create',{member_type:EVER,from:'routine',request_id:requestId});
  expect((await f.request('/user/member/card/index?purchase_request='+requestId,undefined,undefined,11)).body.status).toBe(200);
  expect(await outbox().processMessage({action:'processOrderNotificationOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('already-completed');
  expect(await effects()).toEqual(committed);expect(posts).toEqual(sent);expect(f.messages).toHaveLength(queueCount);
  expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(inArray(storeOrderOutbox.eventKey,
   [membershipPaidSettlementKey(saved.id),membershipPaidNoticeEventKey(saved.id)]))).toHaveLength(2);
 });
});
