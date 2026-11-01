/** Real domain creation, RSA/AES callback and default signed-query settlement,
 * five actual LOGINs and Queue shipping. Only external transports are local. */
import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { memberShip, otherOrder, storeOrderOutbox, systemConfig, systemGroup, systemGroupData, user, userRecharge, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment, type RoutineShippingAccountPolicy } from '@/services/payment/RoutineShippingAccount';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { isPaymentReconciliationMessage, PaymentReconciliationService } from '@/services/payment/PaymentReconciliationService';
import type { PaymentProviderQueryRequest } from '@/services/payment/PaymentProviderQuery';
import { OrderNotificationDeliveryService, isOrderNotificationDeliveryMessage } from '@/services/order/OrderNotificationDeliveryService';
import { type RoutineShippingRequest, type RoutineVirtualShippingDispatch } from '@/services/payment/RoutineShippingDispatch';
import { UserFinanceService } from '@/services/user/UserFinanceService';
import { PaidMembershipService, applyMembershipPayment } from '@/services/user/PaidMembershipService';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryFixture, paymentQueryKeys } from './helpers/paymentQueryFixture';

type Fixture=Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Domain='recharge'|'membership';
type Subject={domain:Domain;id:number;orderNo:string};
const APP='wx-local-query',MERCHANT='1234567890',CURRENT_APP='wx_virtual_current_B',CURRENT_MERCHANT='1900000135';
const ACCOUNT='virtual_original_account',REF='virtual_original_merchant',SHIPPING_REF='virtual_original_secret';
const PLATFORM='TEST_QUERY_PUBLIC_KEY',AES='a'.repeat(32),PAYER='virtual_actual_payer',BUYER_BINDING='virtual_latest_buyer_binding',SECRET='synthetic-virtual-original-secret';
function envelope(keys:ReturnType<typeof paymentQueryKeys>,orderNo:string,transactionId:string,eventId=randomUUID(),native=false){
 const payload={appid:native?CURRENT_APP:APP,mchid:native?CURRENT_MERCHANT:MERCHANT,out_trade_no:orderNo,transaction_id:transactionId,
  trade_state:'SUCCESS',trade_type:native?'APP':'JSAPI',...(native?{}:{payer:{openid:PAYER}}),success_time:new Date().toISOString(),amount:{total:1000,currency:'CNY'}};
 const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction',cipher=createCipheriv('aes-256-gcm',Buffer.from(native?'b'.repeat(32):AES),Buffer.from(nonce));
 cipher.setAAD(Buffer.from(associated));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const body=JSON.stringify({id:eventId,event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext,nonce,associated_data:associated}});
 const timestamp=String(Math.floor(Date.now()/1000));return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,
  'wechatpay-serial':native?'PUB_VIRTUAL_CURRENT':PLATFORM,'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge and membership original-account virtual shipping',()=>{
 let f:Fixture,keys:ReturnType<typeof paymentQueryKeys>,nativeKeys:ReturnType<typeof paymentQueryKeys>,network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
 let policy:RoutineShippingAccountPolicy,revision=0,revoked=false,paymentRegistry='',shippingRegistry='',serial=0,failShippingSend=false;
 const logs:unknown[]=[],batches:Array<{messages:unknown[];delay:number|undefined}>=[];
 const application=()=>createContainerFromDb(f.appRuntime.db),consumer=()=>new OrderNotificationDeliveryService(application(),f.env);
 const key=(s:Subject)=>`${s.domain}.paid.shipping:${s.id}`;
 const noSecrets=(v:unknown)=>{const text=JSON.stringify(v);for(const secret of[PAYER,BUYER_BINDING,SECRET,AES,f.env.APP_KEY,'BEGIN PRIVATE KEY'])expect(text).not.toContain(secret);};
 const policyTarget=()=>({database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin});
 const approve=async(state:'active'|'revoked'='active')=>{const r=await appendRoutineShippingAccountPolicy(f.maintenanceDb,f.env,policyTarget(),
  {operationId:randomUUID(),expectedRevision:revision,data:{...policy,state}});revision=r.revision;revoked=state==='revoked';};
 async function current(clear=false){
  const values={routine_appId:clear?'':CURRENT_APP,routine_appsecret:clear?'':'synthetic-current-secret',wechat_appid:CURRENT_APP,
   wechat_app_appid:CURRENT_APP,pay_weixin_mchid:CURRENT_MERCHANT,pay_weixin_serial_no:'B1B2C3D4',pay_weixin_open:1,order_shipping_open:1,member_card_status:1};
  await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
  await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
 }
 async function created(domain:Domain):Promise<Subject>{
  if(domain==='recharge'){
   const c=await new UserFinanceService(application(),f.env).recharge(11,10,'routine',75001);
   const rows=await f.maintenanceDb.select().from(userRecharge).where(eq(userRecharge.orderId,c.orderId));
   expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({paid:0,uid:11,price:'10.00',givePrice:'1.50',tradeNo:''});
   return{domain,id:rows[0].id,orderNo:c.orderId};
  }
  const c=await new PaidMembershipService(application(),f.env).createOrder(11,{memberType:75001,from:'routine'});
  const rows=await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.orderId,c.order_id));
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({paid:0,uid:11,type:1,isFree:0,payPrice:'10.00',vipDay:30,tradeNo:''});
  return{domain,id:rows[0].id,orderNo:c.order_id};
 }
 const financial=async()=>Array.from(await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
  'user',(SELECT to_jsonb(t) FROM public."user" t WHERE uid=11),
  'recharge',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_recharge t),
  'member',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.other_order t),
  'member_status',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid,change_time,change_type) FROM public.other_order_status t),
  'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t)) AS value`));
 const wallet=async()=>(await f.maintenanceDb.select({balance:user.nowMoney}).from(user).where(eq(user.uid,11)))[0].balance;
 async function callback(s:Subject){
  const transaction='virtual_tx_'+randomUUID().replaceAll('-',''),packet=envelope(keys,s.orderNo,transaction),pending:Promise<unknown>[]=[];
  const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',application());await next();});h.onError(errorHandler);h.route('/api',v1Routes);
  const before=f.messages.length,response=await h.request('/api/pay/notify/routine-account/'+ACCOUNT,{method:'POST',headers:packet.headers,body:packet.body},f.env,
   {waitUntil:(p:Promise<unknown>)=>pending.push(p),props:{},passThroughOnException:()=>{throw Error('Unexpected fallback');}});
  await Promise.all(pending);expect(response.status).toBe(200);noSecrets(await response.text());
  const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();return{message:message!,transaction};
 }
 async function paid(domain:Domain){
  const subject=await created(domain),cb=await callback(subject);
  expect(await new PaymentCallbackEventService(application(),f.env).processMessage(cb.message)).toBe('completed');
  return{...subject,...cb};
 }
 async function delivery(s:Subject){
  const rows=await f.maintenanceDb.execute<{id:number;status:string;available:number;addTime:number;domain:string;subjectId:number;orderId:number|null;withdrawalId:number|null;payload:unknown}>(sql`
   SELECT id,status,available_time AS available,add_time AS "addTime",subject_domain AS domain,subject_id AS "subjectId",order_id AS "orderId",withdrawal_id AS "withdrawalId",payload
   FROM public.order_notification_delivery WHERE event_key=${key(s)} AND channel='wechat_shipping'`);
  expect(rows).toHaveLength(1);return rows[0];
 }
 async function staged(s:Subject){
  const row=await delivery(s);expect(row).toMatchObject({status:'ENQUEUED',domain:s.domain,subjectId:s.id,orderId:null,withdrawalId:null,
   payload:{kind:'wechat_shipping',logisticsType:3,deliveryMode:1,isAllDelivered:true,trackingNumber:'',expressCompanyName:'',receiverContact:''}});
  const source=await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key(s)));
  expect(source).toHaveLength(1);expect(source[0]).toMatchObject({status:'COMPLETED',aggregateType:s.domain,aggregateId:s.id,eventType:s.domain+'.paid.shipping'});
  const messages=f.messages.filter(isOrderNotificationDeliveryMessage).filter(m=>m.deliveryId===row.id);expect(messages).toHaveLength(1);
  expect(Object.keys(messages[0]).sort()).toEqual(['action','channel','deliveryId','eventKey']);
  const send=batches.find(b=>b.messages.some(m=>isOrderNotificationDeliveryMessage(m)&&m.deliveryId===row.id));expect(send?.delay).toBeGreaterThanOrEqual(0);expect(send?.delay).toBeLessThanOrEqual(10);
  noSecrets(messages);return{...s,row,message:messages[0]};
 }
 async function consume(c:Awaited<ReturnType<typeof staged>>){
  // The new initial deferral is SQL-clock authority. Wait for the actual
  // finite deadline outside every transaction; do not manufacture due rows.
  const [remaining]=await f.maintenanceDb.execute<{seconds:number}>(sql`SELECT GREATEST(0,${c.row.addTime+11}-FLOOR(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::integer)::integer AS seconds`);
  expect(remaining.seconds).toBeLessThanOrEqual(12);
  if(remaining.seconds>0)await new Promise(resolve=>setTimeout(resolve,remaining.seconds*1000));
  const clock=vi.spyOn(Date,'now').mockReturnValue(Math.max(Date.now(),(c.row.available+1)*1000));
  try{return await consumer().processMessage(c.message);}finally{clock.mockRestore();}
 }
 async function scanner(s:Subject){
  const row=await delivery(s),before=f.messages.length,clock=vi.spyOn(Date,'now').mockReturnValue((row.available+1)*1000);
  try{expect((await consumer().dispatchPending(20,key(s))).enqueued).toBe(1);}finally{clock.mockRestore();}
  const message=f.messages.slice(before).find(isOrderNotificationDeliveryMessage);expect(message).toBeDefined();return{...s,row:await delivery(s),message:message!};
 }
 const history=async(id:number)=>Array.from(await f.maintenanceDb.execute(sql`SELECT to_jsonb(d) AS row,d.xmin::text AS xmin,
  (SELECT jsonb_agg(jsonb_build_array(to_jsonb(e),e.xmin::text) ORDER BY e.evidence_id) FROM public.routine_shipping_provider_evidence e WHERE e.dispatch_id=d.dispatch_id) AS evidence
  FROM public.routine_shipping_dispatch d WHERE delivery_id=${id}`));
 function transport(s:Subject,response:()=>Promise<Response>=async()=>Response.json({errcode:0,errmsg:'ok'})){
  const bodies:RoutineShippingRequest[]=[];
  network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));expect(url.origin).toBe('https://api.weixin.qq.com');
   if(url.pathname==='/cgi-bin/token'){expect(url.searchParams.get('appid')).toBe(APP);expect(url.searchParams.get('secret')).toBe(SECRET);return Response.json({access_token:'synthetic-virtual-token',expires_in:7200});}
   expect(url.pathname).toBe('/wxa/sec/order/upload_shipping_info');expect(init?.method).toBe('POST');const body=JSON.parse(String(init?.body)) as RoutineShippingRequest;bodies.push(body);
   expect(body).toMatchObject({payer:{openid:PAYER},logistics_type:3,delivery_mode:1});expect(body.shipping_list).toHaveLength(1);expect(Object.keys(body.shipping_list[0])).toEqual(['item_desc']);expect(Object.hasOwn(body,'is_all_delivered')).toBe(false);
   await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
    await tx.execute(sql`SELECT id FROM ${sql.raw(s.domain==='recharge'?'public.user_recharge':'public.other_order')} WHERE id=${s.id} FOR UPDATE NOWAIT`);
    expect(await tx.execute(sql`SELECT id FROM public.order_notification_delivery WHERE event_key=${key(s)} FOR UPDATE NOWAIT`)).toHaveLength(1);
    const [idle]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE usename=${f.appRuntime.role} AND state='idle in transaction'`);expect(idle.n).toBe(0);
   }));return response();
  });return bodies;
 }
 beforeAll(async()=>{
  keys=paymentQueryKeys();nativeKeys=paymentQueryKeys();network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unplanned provider transport'));
  for(const name of['log','warn','error'] as const)vi.spyOn(console,name).mockImplementation((...args:unknown[])=>{logs.push(args);});
  f=await customerCashierRuntimeHttpFixture();
  await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  f.env.SEQUENCE={idFromName:()=>({}),get:()=>({fetch:async(input:Request|string|URL)=>new Response(new URL(String(input)).searchParams.get('prefix')+'_virtual_'+(++serial))})} as unknown as Env['SEQUENCE'];
  f.env.ORDER_QUEUE={send:async(body:unknown)=>{f.messages.push(body);},sendBatch:async(batch:Array<{body:unknown}>,options?:{delaySeconds?:number})=>{
   if(failShippingSend&&batch.some(b=>isOrderNotificationDeliveryMessage(b.body))){failShippingSend=false;throw Error('Controlled Queue unavailability');}
   const messages=batch.map(item=>item.body);batches.push({messages,delay:options?.delaySeconds});f.messages.push(...messages);
  }} as unknown as Env['ORDER_QUEUE'];
  await f.maintenanceDb.insert(user).values({uid:22,account:'virtual-owned-payer',pwd:'virtual-owned-payer-password',status:1,nowMoney:'23.00'}).onConflictDoNothing();
  await f.maintenanceDb.insert(wechatUser).values([{uid:22,userType:'routine',openid:PAYER},{uid:11,userType:'routine',openid:BUYER_BINDING}]);
  await f.maintenanceDb.insert(memberShip).values({id:75001,type:'month',title:'Actual virtual monthly',vipDay:30,price:'12.00',prePrice:'10.00',isDel:0});
  const groups=await f.maintenanceDb.select().from(systemGroup).where(eq(systemGroup.configName,'user_recharge_quota')).limit(2);expect(groups.length).toBeLessThanOrEqual(1);
  if(!groups.length)await f.maintenanceDb.insert(systemGroup).values({id:75001,configName:'user_recharge_quota',name:'Virtual recharge quota',info:'Virtual recharge quota'});
  await f.maintenanceDb.insert(systemGroupData).values({id:75001,gid:groups[0]?.id??75001,status:1,value:JSON.stringify({price:{type:'input',value:'10.00'},give_money:{type:'input',value:'1.50'}})});
  paymentRegistry=JSON.stringify({format:1,credentials:[{ref:REF,version:1,appId:APP,merchantId:MERCHANT,serialNo:'ABCDEF123456',apiV3Key:AES,
   privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:PLATFORM}]});
  shippingRegistry=JSON.stringify({format:1,credentials:[{ref:SHIPPING_REF,version:1,appId:APP,secret:SECRET}]});
  Object.assign(f.env,{ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:paymentRegistry,ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS:shippingRegistry,
   WECHAT_MCH_PRIVATE_KEY:nativeKeys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:nativeKeys.publicKey,WECHAT_PLATFORM_PUBLIC_KEY_ID:'PUB_VIRTUAL_CURRENT',WECHAT_API_V3_KEY:'b'.repeat(32)});
  await current();const now=Math.floor(Date.now()/1000);
  await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',
   data:{accountId:ACCOUNT,state:'active',...routinePaymentCredentialCommitment(f.env,REF,1),credentialRef:REF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600}});
  policy={accountId:routineShippingAccountId(f.env,APP,MERCHANT),state:'active',appId:APP,merchantId:MERCHANT,credentialRef:SHIPPING_REF,credentialVersion:1,
   credentialStamp:routineShippingCredentialCommitment(f.env,SHIPPING_REF,1).credentialStamp,purposes:['shipping_upload'],validFrom:now-60,validUntil:now+3600};await approve();
 },180000);
 beforeEach(async()=>{network.mockReset().mockRejectedValue(Error('Unplanned provider transport'));
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=paymentRegistry;f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=shippingRegistry;
  if(revoked)await approve();failShippingSend=false;await current();});
 afterEach(()=>{noSecrets(logs);noSecrets(f.messages);});
 afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);

 it('credits a genuinely created recharge once and dispatches one domain-bound virtual upload from original A with current config cleared',async()=>{
  const before=Number(await wallet()),bindings=await f.maintenanceDb.select().from(wechatUser),payer=(await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0],s=await paid('recharge'),c=await staged(s);
  expect(await wallet()).toBe((before+11.5).toFixed(2));
  const early=vi.spyOn(Date,'now').mockReturnValue((c.row.available+40)*1000);
  try{expect(await consumer().processMessage(c.message)).toBe('busy');}finally{early.mockRestore();}
  await current(true);const bodies=transport(s);expect(await consume(c)).toBe('sent');expect(bodies[0].shipping_list[0].item_desc).toBe('用户充值10.00');
  const rows=await f.maintenanceDb.execute<{payload:RoutineVirtualShippingDispatch['payload']}>(sql`SELECT payload FROM public.routine_shipping_dispatch WHERE delivery_id=${c.row.id}`);
  expect(rows[0].payload).toMatchObject({format:2,identity:{domain:'recharge',subjectId:s.id,buyerUid:11,totalAmount:1000},packages:[{domain:'recharge',subjectId:s.id}]});
  expect(Object.hasOwn(rows[0].payload.identity,'rootId')).toBe(false);const original=await history(c.row.id),facts=await financial();
  expect(await new PaymentCallbackEventService(application(),f.env).processMessage(s.message)).toBe('already-completed');expect(await financial()).toEqual(facts);
  await approve('revoked');f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS=undefined;
  expect(await consumer().processMessage(c.message)).toBe('already-sent');expect(await history(c.row.id)).toEqual(original);expect(bodies).toHaveLength(1);
  expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);
  expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
 },90000);
 it('grants a real monthly purchase and keeps its shipping description after a later actual local membership renewal',async()=>{
  const s=await paid('membership'),c=await staged(s),original=(await f.maintenanceDb.select().from(otherOrder).where(eq(otherOrder.id,s.id)))[0];
  expect(original.overdueTime).toBeGreaterThanOrEqual(original.payTime+30*86400);
  const renewed=await created('membership');expect((await applyMembershipPayment(application(),{orderId:renewed.orderNo,uid:11,payType:'yue',debitBalance:true})).outcome).toBe('paid');
  expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key(renewed)))).toHaveLength(0);
  await f.maintenanceDb.update(memberShip).set({type:'ever',vipDay:999,title:'Changed current plan'}).where(eq(memberShip.id,75001));
  try{const bodies=transport(s);expect(await consume(c)).toBe('sent');expect(bodies[0].shipping_list[0].item_desc).toBe('用户购买30天会员卡');}
  finally{await f.maintenanceDb.update(memberShip).set({type:'month',vipDay:30,title:'Actual virtual monthly'}).where(eq(memberShip.id,75001));}
 },90000);
 for(const domain of['recharge','membership'] as const)it(`authors ${domain} shipping through the actual archived signed-query default consumer`,async()=>{
  const s=await created(domain),transaction='virtual_query_'+randomUUID().replaceAll('-',''),request:PaymentProviderQueryRequest={provider:'wechat',profile:'routine',orderDomain:domain,orderNo:s.orderNo,expectedAmountCents:1000,currency:'CNY'};
  const now=Math.floor(Date.now()/1000);await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'query',
   data:{state:'active',accountId:ACCOUNT,accountRevision:1,request,validFrom:now-60,validUntil:now+1800}});
  const signer=await paymentQueryFixture(application(),keys);network.mockImplementation(async(input,init)=>{
   expect(typeof input).toBe('string');expect(signer.verifyRequest(String(input),init!)).toBe(true);
   await f.withMaintenancePeer(peer=>peer.execute(sql`SELECT id FROM ${sql.raw(domain==='recharge'?'public.user_recharge':'public.other_order')} WHERE id=${s.id} FOR UPDATE NOWAIT`));
   return signer.wechatResponse(signer.wxBody({out_trade_no:s.orderNo,transaction_id:transaction,payer:{openid:PAYER}}));
  });
  const service=new PaymentReconciliationService(application(),f.env),registered=await service.registerIntent({...request,initiatedAt:now-121});
  await service.dispatchPage({action:'dispatchPaymentReconciliation',scheduledAt:Date.now(),cursor:0});
  const message=f.messages.filter(isPaymentReconciliationMessage).find(m=>m.caseId===registered.id);expect(message).toBeDefined();
  expect(await service.processMessage(message!)).toBe('settled');const c=await staged(s),bodies=transport(s);expect(await consume(c)).toBe('sent');
  expect(bodies[0].order_key.transaction_id).toBe(transaction);const facts=await financial();expect(await service.processMessage(message!)).toBe('already-terminal');expect(await financial()).toEqual(facts);
 },90000);
 for(const domain of['recharge','membership'] as const)it(`rolls back ${domain} wallet/rights when its real late delivery insert fails, then replays the same callback`,async()=>{
  const s=await created(domain),cb=await callback(s),before=await financial(),pid=await f.appRuntime.verify();
  await f.exec(`CREATE FUNCTION public.virtual_paid_stage_fail() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN PERFORM pg_catalog.pg_advisory_lock(731722,${s.id});RAISE EXCEPTION 'owned virtual stage rollback';END$$`);
  await f.exec('REVOKE ALL ON FUNCTION public.virtual_paid_stage_fail() FROM PUBLIC');
  await f.exec(`CREATE TRIGGER virtual_paid_stage_fail BEFORE INSERT ON public.order_notification_delivery FOR EACH ROW WHEN(NEW.event_key='${key(s)}') EXECUTE FUNCTION public.virtual_paid_stage_fail()`);
  try{await expect(new PaymentCallbackEventService(application(),f.env).processMessage(cb.message)).rejects.toThrow();
   const [witness]=await f.maintenanceDb.execute<{yes:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=${pid} AND classid=731722::oid AND objid=${s.id}::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS yes`);expect(witness.yes).toBe(true);
   expect(await financial()).toEqual(before);expect(await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,key(s)))).toHaveLength(0);
  }finally{await f.appRuntime.db.execute(sql`SELECT pg_catalog.pg_advisory_unlock(731722,${s.id})`);await f.exec('DROP TRIGGER IF EXISTS virtual_paid_stage_fail ON public.order_notification_delivery');await f.exec('DROP FUNCTION IF EXISTS public.virtual_paid_stage_fail()');}
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000);
  try{expect(await new PaymentCallbackEventService(application(),f.env).processMessage(cb.message)).toBe('completed');}finally{clock.mockRestore();}
  const c=await staged(s);transport(s);expect(await consume(c)).toBe('sent');
 },90000);
 it('keeps a committed recharge when Queue is unavailable and recovers only its delivery through the real scanner',async()=>{
  failShippingSend=true;const s=await paid('recharge'),facts=await financial();expect((await delivery(s)).status).toBe('RETRYABLE');
  const c=await scanner(s),bodies=transport(s);expect(await consume(c)).toBe('sent');expect(await financial()).toEqual(facts);expect(bodies).toHaveLength(1);
 },90000);
 it('retries an explicit rejection with identical immutable body and upload_time',async()=>{
  const s=await paid('membership'),c=await staged(s),bodies=transport(s,async()=>Response.json({errcode:10060012,errmsg:'busy'}));
  expect(await consume(c)).toBe('retry-scheduled');const before=await history(c.row.id),next=await scanner(s);network.mockReset();
  const second=transport(s);expect(await consume(next)).toBe('sent');expect(second[0]).toEqual(bodies[0]);expect((await history(c.row.id))[0].row).toEqual(before[0].row);
 },90000);
 it('keeps a lost POST UNKNOWN and never automatically sends it again',async()=>{
  const s=await paid('recharge'),c=await staged(s),bodies=transport(s,async()=>{throw Error('Controlled lost POST');});expect(await consume(c)).toBe('unknown');
  expect(await consumer().processMessage(c.message)).toBe('unknown');expect((await consumer().dispatchPending(20,key(s))).enqueued).toBe(0);expect(bodies).toHaveLength(1);
 },90000);
 it('refuses all four non-App LOGINs before claim and then lets the actual App consume',async()=>{
  const s=await paid('recharge'),c=await staged(s),before=await delivery(s),bodies=transport(s);
  for(const role of[f.adminRuntime,f.financialRuntime,f.managerRuntime,f.cashierRuntime]){
   await expect(new OrderNotificationDeliveryService(createContainerFromDb(role.db),f.env).processMessage(c.message)).rejects.toMatchObject({code:503});expect(await delivery(s)).toEqual(before);
  }
  expect(network).not.toHaveBeenCalled();expect(await consume(c)).toBe('sent');expect(bodies).toHaveLength(1);
 },90000);
 it('refuses a changed physical amount and the SQL cross-domain subject mismatch without provider I/O',async()=>{
  const s=await paid('recharge'),c=await staged(s);await expect(f.maintenanceDb.execute(sql`UPDATE public.order_notification_delivery SET subject_domain='membership' WHERE id=${c.row.id}`)).rejects.toMatchObject({cause:{code:'23514'}});
  await f.maintenanceDb.update(userRecharge).set({price:'10.01'}).where(eq(userRecharge.id,s.id));const bodies=transport(s);
  expect(await consume(c)).toBe('dead');expect(network).not.toHaveBeenCalled();expect(bodies).toHaveLength(0);expect(await history(c.row.id)).toHaveLength(0);
 },90000);
 it('refuses revoked original shipping approval before token or upload for a genuine recharge intent',async()=>{
  const s=await paid('recharge'),c=await staged(s);await approve('revoked');transport(s);
  expect(await consume(c)).toBe('dead');expect(network).not.toHaveBeenCalled();expect(await history(c.row.id)).toHaveLength(0);
 },90000);
 it('reaches the independent App verifier and refuses genuine APP evidence for the same membership subject',async()=>{
  const s=await paid('membership'),c=await staged(s),eventId=randomUUID(),packet=envelope(nativeKeys,s.orderNo,'native_virtual_'+randomUUID().replaceAll('-',''),eventId,true);
  const connect=vi.spyOn(Di,'createDbFromConnectionString');
  try{expect(await new WechatPayService(application(),f.env).verifyAndParseNotify(packet.headers,packet.body,'app')).toMatchObject({outTradeNo:s.orderNo,tradeState:'SUCCESS'});
   transport(s);expect(await consume(c)).toBe('dead');expect(connect.mock.calls.some(call=>call[2]?.applicationName==='cinashop_routine_shipping_verify')).toBe(true);expect(network).not.toHaveBeenCalled();expect(await history(c.row.id)).toHaveLength(0);
  }finally{connect.mockRestore();}
 },90000);
});
