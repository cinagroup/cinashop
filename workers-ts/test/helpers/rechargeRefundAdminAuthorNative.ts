/** Actual UserJWT recharge -> local signed provider ingress -> App settlement
 * -> real non-level0 Admin authors. Only Redis/KV/Queue/fetch/ID I/O is local.
 * No source/actor/catalog mock, broad grant, paid row, MAC or hold is seeded.
 * This proves author reachability; refund HTTP and merchant POST are separate. */
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { systemAdmin, systemRole, systemConfig, systemGroup, systemGroupData, systemNotification,
 storeProduct, user, userRecharge, storeOrderOutbox, storeOrder } from '@/models/schema';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { runMembershipPaidNoticeUpgrade } from '@/migrations/membershipPaidNotice';
import { runRechargePaidNoticeUpgrade } from '@/migrations/rechargePaidNotice';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment } from '@/services/payment/RoutineShippingAccount';
import { appendRoutineSubscriptionAccountPolicy, routineSubscriptionAccountId, routineSubscriptionCredentialCommitment } from '@/services/wechat/RoutineSubscriptionAccount';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { PaymentCallbackEventService, isPaymentCallbackMessage } from '@/services/payment/PaymentCallbackEventService';
import { appendRechargeRoutineRefundAccountPolicy } from '@/services/payment/RechargeRoutineRefundAccount';
import { rechargeRoutineRefundAccountId } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { quoteAdminRechargeRefund, admitAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { cancelAdminRechargeRefundBeforePost } from '@/services/admin/AdminRechargeRefundCancellation';
import { rechargePaidSettlementKey } from '@/services/order/RechargePaidNoticeCodec';
import { RECHARGE_REFUND_VERSION, type RechargeRefundRequest } from '@/services/payment/RechargeRefundRequest';
import { md5 } from '@/utils/jwt';
import { rechargeRefundRuntimeProfileFixture } from './rechargeRefundRuntimeProfileNative';
import { paymentQueryKeys } from './paymentQueryFixture';

export const rechargeAuthorOriginal = Object.freeze({ appId:'wx_recharge_refund_original_a', merchantId:'1234567890',
 currentAppId:'wx_recharge_refund_current_b', paymentAccount:'recharge_refund_original_a', credentialRef:'recharge_refund_payment',
 payer:'recharge_refund_actual_payer', apiV3Key:'a'.repeat(32), serial:'TEST_RECHARGE_REFUND_PUBLIC_KEY' });
export const rechargeAuthorUids=Object.freeze(Array.from({length:20},(_,i)=>2401+i));
const PHONE=(uid:number)=>'1390000'+String(uid);
const OPENID=(uid:number)=>'recharge_refund_owner_'+uid;
const QUOTA=66201,ADMIN=66201,ROLE=66201,PASSWORD='recharge-refund-author-password';
const SUBREF='recharge_refund_subscription',SUBSECRET='synthetic-recharge-refund-subscription';
const SHIPREF='recharge_refund_shipping',SHIPSECRET='synthetic-recharge-refund-shipping';
export type AuthorRecharge=typeof userRecharge.$inferSelect;

export async function rechargeRefundAdminAuthorFixture(values:Map<string,unknown>,options:{paymentPayer?:(uid:number)=>string}={}) {
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unplanned external I/O in recharge refund author acceptance'));
 const calls:Array<{url:string;method:string}>=[];
 let f:Awaited<ReturnType<typeof rechargeRefundRuntimeProfileFixture>>|undefined;
 try {
  const A=rechargeAuthorOriginal,keys=paymentQueryKeys();
  f=await rechargeRefundRuntimeProfileFixture();
  const profile=f,app=()=>createContainerFromDb(profile.appRuntime.db),admin=()=>createContainerFromDb(profile.adminRuntime.db);
  // These are the established producer upgrades, in the actual recharge-paid-
  // notice fixture's order, BEFORE the complete recharge refund successor.
  // Original-payment and payment-account predecessors are installed by profile.
  await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineSubscriptionUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runPaidNoticeUpgrade(f.maintenanceDb);
  await runMembershipPaidNoticeUpgrade(f.maintenanceDb);

  Object.assign(f.env,{
   WECHAT_MCH_PRIVATE_KEY:keys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:keys.publicKey,
   WECHAT_PLATFORM_PUBLIC_KEY_ID:A.serial,WECHAT_API_V3_KEY:A.apiV3Key,
   ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[1,2].map(version=>({
    ref:A.credentialRef,version,appId:A.appId,merchantId:A.merchantId,serialNo:'ABCDEF123456',apiV3Key:A.apiV3Key,
    privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:A.serial}))}),
   ROUTINE_SUBSCRIPTION_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SUBREF,version:1,appId:A.appId,secret:SUBSECRET}]}),
   ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[{ref:SHIPREF,version:1,appId:A.appId,secret:SHIPSECRET}]}),
  });
  let serial=0,loginUid=0;
  f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async(input:Request|string|URL)=>new Response(
   (new URL(String(input)).searchParams.get('prefix')??'cz')+'rf'+(++serial))})} as unknown as Env['SEQUENCE'];
  network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));calls.push({url:String(url),method:init?.method??'GET'});
   if(url.origin==='https://api.weixin.qq.com'&&url.pathname==='/sns/jscode2session') {
    expect(url.searchParams.get('appid')).toBe(A.appId);
    expect(rechargeAuthorUids).toContain(loginUid);
    return Response.json({openid:OPENID(loginUid),session_key:Buffer.from('0123456789abcdef').toString('base64')});
   }
   // Never accepts refund/query/prepay, shipping or notification HTTP. Payment
   // ingress and its consumer use the real local signed body, not this adapter.
   throw Error('Unexpected provider transport: '+url.origin+url.pathname);
  });
  async function config(entries:Record<string,unknown>) {
   await profile.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(entries)));
   await profile.maintenanceDb.insert(systemConfig).values(Object.entries(entries).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
   for(const name of Object.keys(entries))await profile.env.CONFIG_KV.delete('cfg_'+name);
  }
  const current=(appId:string=A.currentAppId)=>config({routine_appId:appId,routine_appsecret:'synthetic-current-secret',
   wechat_appid:'wx_recharge_refund_official',wechat_appsecret:'synthetic-official-secret',
   wechat_app_appid:A.currentAppId,pay_weixin_mchid:'1900000651',pay_weixin_serial_no:'B1B2C3D4',
   pay_weixin_open:1,order_shipping_open:0,balance_func_status:1,yue_pay_status:1});
  await profile.maintenanceDb.insert(user).values(rechargeAuthorUids.map(uid=>({uid,account:'recharge-refund-'+uid,
   phone:PHONE(uid),nickname:'充值退款'+uid,pwd:'owned-financial-password',status:1})));
  // Fresh users rely on the canonical zero default. No wallet credit, paid
  // recharge, wechat_user projection or immutable identity owner is seeded.
  const balances=await profile.maintenanceDb.select({balance:user.nowMoney}).from(user).where(inArray(user.uid,[...rechargeAuthorUids]));
  expect(balances).toHaveLength(rechargeAuthorUids.length);expect(balances.every(row=>row.balance==='0.00')).toBe(true);
  for(const uid of rechargeAuthorUids) {
   await current(A.appId);loginUid=uid;
   const auth=new WechatAuthService(app(),profile.env),ticket=await auth.beginMiniProgramLogin({code:randomUUID(),ip:'127.0.0.1'});
   const pending=values.get('routine_login:'+ticket.key) as {identity:VerifiedSocialIdentity}|undefined;
   expect(pending?.identity.routineObservation).toMatchObject({appId:A.appId,openid:OPENID(uid)});
   // Same verified service entry as the established producer fixture. Its real
   // SQL phone reconciliation owns both social projection and immutable owner.
   expect(await auth.reconcileVerifiedIdentity({...pending!.identity,phone:PHONE(uid)})).toBe(uid);
  }
  await current();
  const afterIdentity=await profile.maintenanceDb.select({balance:user.nowMoney}).from(user).where(inArray(user.uid,[...rechargeAuthorUids]));
  expect(afterIdentity.every(row=>row.balance==='0.00')).toBe(true);
  const [initialLedger]=await profile.maintenanceDb.execute<{count:number}>(sql`SELECT count(*)::integer AS count FROM public.user_bill
   WHERE uid IN(${sql.join(rechargeAuthorUids.map(uid=>sql`${uid}`),sql`,`)}) AND category='now_money'`);
  expect(initialLedger.count).toBe(0);
  const groups=await profile.maintenanceDb.select().from(systemGroup).where(eq(systemGroup.configName,'user_recharge_quota')).limit(2);
  expect(groups.length).toBeLessThanOrEqual(1);
  if(!groups.length)await profile.maintenanceDb.insert(systemGroup).values({id:QUOTA,configName:'user_recharge_quota',name:'充值退款真实套餐',info:'充值退款真实套餐'});
  await profile.maintenanceDb.insert(systemGroupData).values({id:QUOTA,gid:groups[0]?.id??QUOTA,status:1,
   value:JSON.stringify({price:{type:'input',value:'10.00'},give_money:{type:'input',value:'1.50'}})});
  // Notification senders are outside this author acceptance. The real payment
  // settlement/outbox producer still executes; its delivery Queue is local.
  await profile.maintenanceDb.delete(systemNotification).where(eq(systemNotification.mark,'recharge_success'));
  await profile.maintenanceDb.insert(systemNotification).values({mark:'recharge_success',isSystem:0,isSms:0,isWechat:0,isRoutine:0});
  // Product catalogue fixture only, never a paid order: real UserJWT checkout
  // later spends 7.00 through the established wallet payment author.
  await profile.maintenanceDb.update(storeProduct).set({productType:0,systemFormId:0,freight:2,stock:100}).where(eq(storeProduct.id,70));
  await profile.maintenanceDb.insert(systemRole).values({id:ROLE,roleName:'actual recharge refund author',rules:'recharge_order.refund',status:1,type:0,relationId:0});
  await profile.maintenanceDb.insert(systemAdmin).values({id:ADMIN,account:'recharge-refund-author',pwd:PASSWORD,adminType:1,level:1,roles:String(ROLE),status:1,isDel:0});

  const now=Math.floor(Date.now()/1000),named={database:profile.target.database,maintenance:profile.target.maintenance,app:profile.target.app,admin:profile.target.admin};
  await appendRoutinePaymentAccountPolicy(profile.maintenanceDb,profile.env,profile.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',data:{
   accountId:A.paymentAccount,state:'active',...routinePaymentCredentialCommitment(profile.env,A.credentialRef,1),credentialRef:A.credentialRef,
   credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+7200}});
  await appendRoutineSubscriptionAccountPolicy(profile.maintenanceDb,profile.env,named,{operationId:randomUUID(),expectedRevision:0,data:{
   accountId:routineSubscriptionAccountId(profile.env,A.appId),state:'active',appId:A.appId,credentialRef:SUBREF,credentialVersion:1,
   credentialStamp:routineSubscriptionCredentialCommitment(profile.env,SUBREF,1).credentialStamp,purposes:['subscription_send'],
   templates:[{mark:'755',templateId:'recharge_refund_a_755'}],validFrom:now-60,validUntil:now+7200}});
  await appendRoutineShippingAccountPolicy(profile.maintenanceDb,profile.env,named,{operationId:randomUUID(),expectedRevision:0,data:{
   accountId:routineShippingAccountId(profile.env,A.appId,A.merchantId),state:'active',appId:A.appId,merchantId:A.merchantId,
   credentialRef:SHIPREF,credentialVersion:1,credentialStamp:routineShippingCredentialCommitment(profile.env,SHIPREF,1).credentialStamp,
   purposes:['shipping_upload'],validFrom:now-60,validUntil:now+7200}});
  await runRechargePaidNoticeUpgrade(profile.maintenanceDb);
  expect((await profile.commission()).applied).toBe(true);
  const actor=()=>Object.freeze({id:ADMIN,authVersion:md5(PASSWORD),expiresAt:Math.floor(Date.now()/1000)+3600});
  let revision=0;
  async function approve(version=1,state:'active'|'revoked'='active',purposes=['refund_request','refund_query','refund_notify']) {
   const clock=Math.floor(Date.now()/1000),commit=routinePaymentCredentialCommitment(profile.env,A.credentialRef,version),operationId=randomUUID();
   const data={accountId:rechargeRoutineRefundAccountId(profile.env,A.appId,A.merchantId),provider:'wechat',profile:'routine',state,
    appId:A.appId,merchantId:A.merchantId,credentialRef:A.credentialRef,credentialVersion:version,credentialStamp:commit.credentialStamp,
    purposes,validFrom:clock-60,validUntil:clock+3600};
   const result=await appendRechargeRoutineRefundAccountPolicy(profile.maintenanceDb,profile.env,profile.binding,{operationId,expectedRevision:revision,data});
   revision=result.revision;return{...result,data};
  }
  async function ok<T>(path:string,body:unknown,uid:number):Promise<T> {
   const r=await profile.request(path,body,undefined,uid);expect(r.body.status,r.body.msg).toBe(200);return r.body.data as T;
  }
  async function create(uid:number) {
   const created=await ok<{orderId:string}>('/recharge/recharge',{price:10,from:'routine',rechar_id:QUOTA},uid);
   const rows=await profile.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.orderId,created.orderId));
   expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({uid,paid:0,price:'10.00',givePrice:'1.50',refundPrice:'0.00'});
   return rows[0];
  }
  function packet(order:AuthorRecharge,transaction:string) {
   const plain={appid:A.appId,mchid:A.merchantId,out_trade_no:order.orderId,transaction_id:transaction,trade_state:'SUCCESS',trade_type:'JSAPI',
    payer:{openid:options.paymentPayer?.(order.uid)??A.payer},success_time:new Date().toISOString(),amount:{total:1000,currency:'CNY'}};
   const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction';
   const cipher=createCipheriv('aes-256-gcm',Buffer.from(A.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
   const ciphertext=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final(),cipher.getAuthTag()]).toString('base64');
   const body=JSON.stringify({id:randomUUID(),event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{
    algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext,nonce,associated_data:associated}});
   const timestamp=String(Math.floor(Date.now()/1000));
   return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':A.serial,
    'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
  }
  async function paid(uid:number) {
   const created=await create(uid),transaction='rfr_tx_'+randomUUID().replaceAll('-',''),p=packet(created,transaction),pending:Promise<unknown>[]=[];
   const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',app());await next();});
   h.onError(errorHandler);h.route('/api',v1Routes);
   const n=profile.messages.length,response=await h.request('/api/pay/notify/routine-account/'+A.paymentAccount,
    {method:'POST',headers:p.headers,body:p.body},profile.env,{waitUntil:work=>pending.push(work),props:{},
     passThroughOnException:()=>{throw Error('Unexpected provider fallback');}});
   await Promise.all(pending);expect(response.status).toBe(200);
   const text=await response.text();for(const secret of[A.payer,A.apiV3Key,profile.env.APP_KEY])expect(text).not.toContain(secret);
   const message=profile.messages.slice(n).find(isPaymentCallbackMessage);expect(message).toBeDefined();
   expect(await new PaymentCallbackEventService(app(),profile.env).processMessage(message!)).toBe('completed');
   const [order]=await profile.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.id,created.id));
   expect(order).toMatchObject({uid,paid:1,price:'10.00',givePrice:'1.50',refundPrice:'0.00',rechargeType:'weixin',tradeNo:transaction});
   const event=await settlement(order);
   expect(event.payload).toMatchObject({business:{orderId:order.id,userId:uid,creditedAmount:'11.50'},provider:{kind:'callback',provider:'wechat',profile:'routine',transactionId:transaction}});
   const original=await profile.maintenanceDb.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId}`);
   expect(original).toHaveLength(1);expect(original[0].payload).toMatchObject({observation:{facts:{appId:A.appId,merchantId:A.merchantId,payerId:options.paymentPayer?.(uid)??A.payer}},binding:{state:'bound',local:{domain:'recharge',orderId:order.id,buyerUid:uid}}});
   expect(await profile.maintenanceDb.execute(sql`SELECT * FROM public.routine_payment_account_use WHERE evidence_id IN
    (SELECT evidence_id FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId})`)).toHaveLength(1);
   return{order,transaction,event,message:message!};
  }
  async function settlement(order:AuthorRecharge) {
   const rows=await profile.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,rechargePaidSettlementKey(order.id)));
   expect(rows).toHaveLength(1);return rows[0];
  }
  const quote=(order:AuthorRecharge,who=actor())=>quoteAdminRechargeRefund(admin(),profile.env,who,order.id);
  const body=(order:AuthorRecharge,quote:Awaited<ReturnType<typeof quoteAdminRechargeRefund>>,recoverGift:boolean):RechargeRefundRequest=>({
   version:RECHARGE_REFUND_VERSION,rechargeId:order.id,quoteFingerprint:quote.options.find(o=>o.recoverGift===recoverGift)!.quoteFingerprint,recoverGift});
  const admit=(key:string,request:RechargeRefundRequest,who=actor(),env=profile.env)=>admitAdminRechargeRefund(admin(),env,who,key,request);
  const cancel=(order:AuthorRecharge,key:string,who=actor())=>cancelAdminRechargeRefundBeforePost(admin(),profile.env,who,order.id,key);
  const rules=(rules:string)=>profile.maintenanceDb.update(systemRole).set({rules}).where(eq(systemRole.id,ROLE));
  const wallet=async(uid:number)=>(await profile.maintenanceDb.select({balance:user.nowMoney}).from(user).where(eq(user.uid,uid)))[0].balance;
  async function spend(uid:number) {
   const added=await ok<{cartId:number}>('/cart/add',{productId:70,uniqueId:'qared001',cartNum:1,isNew:1},uid);
   const selection={cartIds:[added.cartId],shippingType:2,storeId:1,useIntegral:false,couponId:0};
   const confirmed=await ok<{orderKey:string;quoteToken:string}>('/order/confirm',selection,uid);
   const result=await ok<{orderId:string}>('/order/create/'+confirmed.orderKey,{...selection,quoteToken:confirmed.quoteToken,
    realName:'真实余额付款',userPhone:PHONE(uid),payType:'yue',from:'h5'},uid);
   const [order]=await profile.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.orderId,result.orderId));
   expect(order).toMatchObject({uid,paid:1,payType:'yue',payPrice:'7.00'});return order;
  }
  async function snapshot(order:AuthorRecharge) {
   const [row]=await profile.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
    'wallet',(SELECT to_jsonb(t)||jsonb_build_object('now_money',now_money::text,'_xmin',xmin::text) FROM public."user" t WHERE uid=${order.uid}),
    'recharge',(SELECT to_jsonb(t)||jsonb_build_object('price',price::text,'give_price',give_price::text,'refund_price',refund_price::text,'_xmin',xmin::text) FROM public.user_recharge t WHERE id=${order.id}),
    'bills',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('number',number::text,'balance',balance::text,'_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.user_bill t WHERE uid=${order.uid}),
    'operations',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY operation_id),'[]'::jsonb) FROM public.recharge_refund_operation t WHERE recharge_id=${order.id}),
    'states',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY operation_id),'[]'::jsonb) FROM public.recharge_refund_state t WHERE recharge_id=${order.id}),
    'attempts',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',t.xmin::text) ORDER BY attempt_id),'[]'::jsonb) FROM public.recharge_refund_attempt t WHERE operation_id IN(SELECT operation_id FROM public.recharge_refund_operation WHERE recharge_id=${order.id})),
    'results',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',t.xmin::text) ORDER BY result_id),'[]'::jsonb) FROM public.recharge_refund_result t WHERE operation_id IN(SELECT operation_id FROM public.recharge_refund_operation WHERE recharge_id=${order.id})),
    'originals',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY evidence_id),'[]'::jsonb) FROM public.routine_original_payment_evidence t WHERE order_no=${order.orderId}),
    'uses',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY use_id),'[]'::jsonb) FROM public.routine_payment_account_use t WHERE evidence_id IN(SELECT evidence_id FROM public.routine_original_payment_evidence WHERE order_no=${order.orderId})),
    'settlement',(SELECT to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) FROM public.store_order_outbox t WHERE event_key=${rechargePaidSettlementKey(order.id)}),
    'callbacks',(SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb) FROM public.payment_callback_event t WHERE order_no=${order.orderId})
   ) AS value`);
   return JSON.stringify(row.value);
  }
  return{...profile,network,calls,actor,approve,create,paid,quote,body,admit,cancel,rules,wallet,spend,snapshot,settlement,
   adminContainer:admin(),appContainer:app(),current,
   close:async()=>{try{await profile.close();}finally{network.mockRestore();}}};
 }catch(error){try{await f?.close();}finally{network.mockRestore();}throw error;}
}
export type RechargeRefundAdminAuthorFixture=Awaited<ReturnType<typeof rechargeRefundAdminAuthorFixture>>;
