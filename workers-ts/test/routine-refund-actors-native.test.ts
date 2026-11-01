/** Phase31 original Routine refund through actual Admin/Manager consumers.
 * One owned full five-LOGIN fixture, generated RSA/AES, real HTTP middleware,
 * actual runtime DSNs and default payment/refund consumers. Only fetch and
 * private KV/Queue transports are local. No signed fact/HMAC/proof is forged.
 * Execution DTOs are asserted at their narrow existing/versioned contracts.
 */
import { createCipheriv, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi,
  type MockInstance } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import * as Di from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment,
  storeOrderRefundSplit, storeProduct, storeProductAttrValue, systemAdmin, systemRole, systemConfig,
  systemStoreStaff, systemMenus, user, wechatUser } from '@/models/schema';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import { adminapiRoutes } from '@/routes/adminapi';
import { adminRefundOperationRoutes } from '@/routes/admin-refund-operations';
import { createToken, md5 } from '@/utils/jwt';
import { runRoutineOriginalPaymentEvidenceUpgrade } from '@/migrations/runRoutineOriginalPaymentEvidenceUpgrade';
import { runRoutinePaymentAccountPolicyUpgrade } from '@/migrations/runRoutinePaymentAccountPolicyUpgrade';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { upgradeCustomerFinancialRoutineRefund } from '@/migrations/upgradeCustomerFinancialRoutineRefund';
import { upgradeRoutineRefundActors } from '@/migrations/upgradeRoutineRefundActors';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCheckoutPricingLockRuntime } from '@/migrations/checkoutPricingLock';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { appendRoutinePaymentAccountPolicy, routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineRefundAccountPolicy, type RoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { isPaymentCallbackMessage, PaymentCallbackEventService } from '@/services/payment/PaymentCallbackEventService';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { CustomerWorkFinancialService } from '@/services/customer-work/CustomerWorkFinancialService';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_QUOTE_VERSION, CUSTOMER_FINANCIAL_VERSION,
  type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '@/services/customer-work/CustomerWorkOperationRequest';
import { requireStoreManagerScope, merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { MANAGER_OPERATION_VERSION, type ManagerOperationInput, type ManagerJson } from '@/services/store/ManagerOrderOperationRequest';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const APP='wx_actor_refund_original', MERCHANT='1900000001', REF='actor_refund_materials', ACCOUNT='actor_refund_account';
const CURRENT_APP='wx_actor_unrelated', CURRENT_MERCHANT='1900000002', SERIAL='A1B2C3D4', PLATFORM='PUB_ACTOR_REFUND';
const AES='r'.repeat(32), PAYER='actor_provider_payer_distinct_from_buyer', BUYER_BINDING='actor_buyer_current_binding';
const ORIGIN='https://actor-refund-fixture.example', ADMIN_PASSWORD='owned-actor-admin-password';
const ADMIN=161, RESUMER=162, READER=163, ADMIN_ROLE=9161, READER_ROLE=9163;
const ADMIN_MENU=99161;
const MANAGER=103, MANAGER_STAFF=901, MANAGER_PASSWORD='owned-financial-password';
const ADMIN_VERSION='admin-refund-operation-v1', EXECUTION_VERSION='admin-refund-execution-v1';
const ADMIN_BASE='/api/admin/refund/operations', ADMIN_ALIAS='/adminapi/refund/operations';
const MANAGER_BASE='/api/store/manager/order/financial';
type Fixture=Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
type Keys=ReturnType<typeof paymentQueryKeys>;
type ObjectRow=Record<string,unknown>;
type Signed={body:string;headers:Record<string,string>};
type Actor={kind:'admin'|'manager';adminId?:number;actorUid?:number;requestKey:string;
  requestHash:string;receiptDigest:string;storeId?:number;staffId?:number;role:string;roleOid:string};
interface DispatchRow extends Record<string,unknown>{dispatch_id:string;refund_id:number;out_refund_no:string;
 payload:{format:2;actor:Actor;identity:{childId:number;rootId:number;buyerUid:number};
  request:{outTradeNo:string;transactionId:string;outRefundNo:string;refundAmount:number;totalAmount:number;reason:string};
  approval:{appId:string;merchantId:string};notifyUrl:string};signature:string}
const object=(v:unknown):ObjectRow=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Expected response object');return v as ObjectRow;};
const integer=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1)throw Error('Expected positive actual id');return v;};
const text=(v:unknown):string=>{if(typeof v!=='string')throw Error('Expected actual text');return v;};
const data=(r:{json:ObjectRow})=>object(r.json.data);
const receipt=(r:{json:ObjectRow})=>object(data(r).receipt);
function envelope(keys:Keys,payload:unknown,kind:'transaction'|'refund',eventId=randomUUID(),
 materials={apiV3Key:AES,platformPublicKeyId:PLATFORM}):Signed{
 const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated=kind;
 const cipher=createCipheriv('aes-256-gcm',Buffer.from(materials.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const eventType=kind==='refund'?'REFUND.'+object(payload).refund_status:'TRANSACTION.SUCCESS';
 const body=JSON.stringify({id:eventId,event_type:eventType,resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',
  original_type:kind,ciphertext,nonce,associated_data:associated}}),timestamp=String(Math.floor(Date.now()/1000));
 return{body,headers:{'content-type':'application/json','wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,
  'wechatpay-serial':materials.platformPublicKeyId,'wechatpay-signature':Buffer.from(sign('RSA-SHA256',
   Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}};
}
function signedResponse(keys:Keys,value:unknown,status=200){
 const body=JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000)),nonce='actor-response-'+randomUUID();
 return new Response(body,{status,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':timestamp,
  'Wechatpay-Nonce':nonce,'Wechatpay-Serial':PLATFORM,'Wechatpay-Signature':Buffer.from(sign('RSA-SHA256',
   Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),keys.privateKey)).toString('base64')}});
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual Admin/Manager original Routine refund consumers',()=>{
 let f:Fixture,keys:Keys,currentKeys:Keys,peers:RuntimeGiftPeerDeclarations,financial:CustomerWorkFinancialService;
 let registry='',policy:RoutineRefundAccountPolicy,policyRevision=0,lastPolicyState:'active'|'revoked'='active';
 let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
 let connections:MockInstance<typeof Di.createDbFromConnectionString>;
 const logs:unknown[]=[];
 const noSecrets=(value:unknown)=>{const s=JSON.stringify(value);for(const secret of[PAYER,BUYER_BINDING,AES,f.env.APP_KEY,'BEGIN PRIVATE KEY'])expect(s).not.toContain(secret);};
 const order=async(id:number)=>(await f.maintenanceDb.select().from(storeOrder).where(eq(storeOrder.id,id)))[0];
 const refund=async(id:number)=>(await f.maintenanceDb.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id)))[0];
 const payment=async(id:number)=>(await f.maintenanceDb.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,id)))[0];
 const dispatch=async(id:number)=>{const rows=await f.maintenanceDb.execute<DispatchRow>(sql`
  SELECT * FROM public.routine_refund_dispatch WHERE refund_id=${id}`);expect(rows).toHaveLength(1);return rows[0];};
 const immutable=async(id:number)=>{
  const d=await dispatch(id);return{dispatch:Array.from(await f.maintenanceDb.execute(sql`
   SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin FROM public.routine_refund_dispatch t WHERE refund_id=${id}`)),
   results:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
    FROM public.routine_refund_provider_evidence t WHERE dispatch_id=${d.dispatch_id} ORDER BY evidence_id`))};
 };
 const actorRows=async(id:number)=>({admin:Array.from(await f.maintenanceDb.execute(sql`
  SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin FROM public.admin_refund_operation t
   WHERE refund_id=${id} ORDER BY created_at,admin_id,request_key`)),
  manager:Array.from(await f.maintenanceDb.execute(sql`SELECT pg_catalog.to_jsonb(t) AS row,t.xmin::text AS xmin
   FROM public.manager_order_operation_request t WHERE evidence->>'refund_id'=${String(id)} ORDER BY created_at,actor_uid,request_key`))});
 const sourceCount=async(id:number)=>Array.from(await f.maintenanceDb.execute(sql`
  SELECT dispatch_id FROM public.routine_refund_dispatch WHERE refund_id=${id}`));
 const current=async(clear=false)=>{
  const values={routine_appId:clear?'':CURRENT_APP,wechat_appid:clear?'':CURRENT_APP,
   wechat_app_appid:clear?'':CURRENT_APP,pay_weixin_mchid:clear?'':CURRENT_MERCHANT,
   pay_weixin_serial_no:clear?'':'B1B2B3B4',pay_weixin_open:1,site_url:'https://current-unrelated.example'};
  await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
  await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
 };
 const appendPolicy=async(state:'active'|'revoked'='active')=>{
  const r=await appendRoutineRefundAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),
   expectedRevision:policyRevision,data:{...policy,state}});policyRevision=r.revision;lastPolicyState=state;return r;
 };
 // No createApp DI/session mocks. This is the production subrouter graph with
 // one ordinary App actual container, and unchanged per-request DSN factories.
 const app=()=>{
  const h=new Hono<{Bindings:Env;Variables:AppVariables}>();
  h.use('*',async(c,next)=>{c.set('container',createContainerFromDb(f.appRuntime.db));await next();});h.onError(errorHandler);
  h.route(ADMIN_BASE,adminRefundOperationRoutes);h.route(ADMIN_ALIAS,adminRefundOperationRoutes);
  h.route('/api',v1Routes);h.route('/adminapi',adminapiRoutes);return h;
 };
 const raw=async(path:string,init:RequestInit={})=>{
  const pending:Promise<unknown>[]=[];const response=await app().request(path,init,f.env,
   {waitUntil:(p:Promise<unknown>)=>pending.push(p),props:{},passThroughOnException:()=>{throw Error('No network fallback');}});
  await Promise.all(pending);return response;
 };
 const jwt=async(kind:'admin'|'manager',id=kind==='admin'?ADMIN:MANAGER,realm:'admin'|'api'=kind==='admin'?'admin':'api',
  password=kind==='admin'?ADMIN_PASSWORD:MANAGER_PASSWORD)=>(await createToken(id,realm,md5(password),f.env.APP_KEY)).token;
 const http=async(path:string,value:unknown,options:{kind?:'admin'|'manager';id?:number;key?:string;scope?:string;
  realm?:'admin'|'api';password?:string;token?:string}={})=>{
  const kind=options.kind??'admin',id=options.id??(kind==='admin'?ADMIN:MANAGER),headers=new Headers({
   Authorization:'Bearer '+(options.token??await jwt(kind,id,options.realm,options.password))});
  if(value!==undefined)headers.set('Content-Type','application/json');if(options.key)headers.set('Idempotency-Key',options.key);
  if(kind==='admin')headers.set('X-Refund-Operation-Scope',options.scope??`v1:admin:${id}`);
  const response=await raw(path,{method:value===undefined?'GET':'POST',headers,...(value===undefined?{}:{body:JSON.stringify(value)})});
  const json=object(await response.json());expect(typeof json.status).toBe('number');expect(typeof json.msg).toBe('string');
  expect(Object.hasOwn(json,'data')).toBe(true);noSecrets(json);return{response,json};
 };
 const ok=(r:Awaited<ReturnType<typeof http>>)=>{
  // http() has already checked noSecrets(json); expose only the bounded public
  // message rather than the response object, headers or provider/source data.
  const message=text(r.json.msg);expect(r.response.status,message).toBe(200);expect(r.json.status,message).toBe(200);return r;
 };
 const privateResponse=(r:Awaited<ReturnType<typeof http>>)=>{expect(r.response.headers.get('Cache-Control')).toContain('no-store');expect(r.response.headers.get('Pragma')).toBe('no-cache');};
 const postProvider=async(path:string,signed:Signed)=>{
  const response=await raw('/api'+path,{method:'POST',headers:signed.headers,body:signed.body});noSecrets(await response.clone().text());return response;
 };
 const financialInput=async(payload:CustomerJson,id:number):Promise<FinancialInput>=>{
  const actual=await order(id),scope=await authorizeCustomerWorkActor(f.financialRuntime.db,f.actor()),state=await financialRevisions(f.financialRuntime.db,actual);
  return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:id,
   expected_order_revision:state.order_revision,expected_financial_revision:state.financial_revision,payload};
 };
 const originalPaid=async()=>{
  await f.maintenanceDb.update(storeProduct).set({productType:0}).where(eq(storeProduct.id,70));
  const created=await f.unpaid(11,'5.00',2),before=f.messages.length,txid='actor_original_'+randomUUID().replaceAll('-','');
  const signed=envelope(keys,{appid:APP,mchid:MERCHANT,out_trade_no:created.order.orderId,transaction_id:txid,
   trade_state:'SUCCESS',trade_type:'JSAPI',payer:{openid:PAYER},success_time:new Date().toISOString(),amount:{total:1000,currency:'CNY'}},'transaction');
  expect((await postProvider('/pay/notify/routine-account/'+ACCOUNT,signed)).status).toBe(200);
  const message=f.messages.slice(before).find(isPaymentCallbackMessage);expect(message).toBeDefined();
  expect(Object.keys(message!).sort()).toEqual(['action','eventId','replayKey']);
  expect(await new PaymentCallbackEventService(createContainerFromDb(f.appRuntime.db),f.env).processMessage(message!)).toBe('completed');
  const actual=await order(created.order.id);expect(actual).toMatchObject({paid:1,payType:'weixin',tradeNo:txid,payPrice:'10.00',uid:11});
  const evidence=await f.maintenanceDb.execute<{row:unknown}>(sql`SELECT pg_catalog.to_jsonb(t) AS row
   FROM public.routine_original_payment_evidence t WHERE order_no=${actual.orderId}`);expect(evidence).toHaveLength(1);
  expect(parseRoutineOriginalEvidence(f.env,evidence[0].row)).toMatchObject({payload:{binding:{state:'bound',local:{domain:'store_order',orderId:actual.id,buyerUid:11}},
   observation:{facts:{appId:APP,merchantId:MERCHANT,payerId:PAYER,tradeType:'JSAPI',tradeState:'SUCCESS'}}}});
  expect(await f.maintenanceDb.execute(sql`SELECT u.use_id FROM public.routine_payment_account_use u
   JOIN public.routine_original_payment_evidence e ON e.evidence_id=u.evidence_id WHERE e.order_no=${actual.orderId}`)).toHaveLength(1);
  const outboxes=await f.maintenanceDb.execute<{id:number;event_key:string}>(sql`SELECT id,event_key FROM public.store_order_outbox
   WHERE aggregate_id=${actual.id} AND event_type='order.paid'`);expect(outboxes).toHaveLength(1);
  await f.consume({id:outboxes[0].id,eventKey:outboxes[0].event_key});return actual;
 };
 // Existing real Financial producer creates a real item application only;
 // all new Admin execution/review/receipt/status below use actual HTTP.
 const applicationForAdmin=async()=>{
  const root=await originalPaid(),items=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id));expect(items).toHaveLength(1);
  const selected=[{cart_row_id:items[0].id,cart_num:1}],base=await financialInput({},root.id),quote=(await financial.reader.quote(f.actor(),{
   version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:base.scope_key,order_id:root.id,
   expected_order_revision:base.expected_order_revision,expected_financial_revision:base.expected_financial_revision,mode:'items',items:selected})).data;
  expect(quote.quoted_price).toBe('5.00');const made=await financial.create({actor:f.actor(),request_key:randomUUID()},await financialInput({
   mode:'items',items:selected,quoted_price:quote.quoted_price,refund_price:quote.quoted_price,
   quote_fingerprint:quote.quote_fingerprint,reason:'Admin 原商户完整真实申请原因'},root.id));expect(made.receipt?.outcome).toBe('refund-created');
  const id=Number(made.receipt!.evidence.refund_id);return{id,root,body:await adminReview(id),key:randomUUID()};
 };
 const adminReview=async(id:number,actor=ADMIN)=>{
  const detail=data(ok(await http('/api/admin/refund/detail/'+id,undefined,{id:actor})));
  return{version:ADMIN_VERSION,action:'refund',review:{uid:integer(detail.uid),storeOrderId:integer(detail.storeOrderId),
   storeId:detail.storeId,supplierId:detail.supplierId,orderId:text(detail.orderId),refundPrice:text(detail.refundPrice)},
   decision:{applyType:detail.applyType,refundType:detail.refundType,received:false}};
 };
 const adminExecute=(id:number,key:string,body:unknown,actor=ADMIN,base=ADMIN_BASE)=>http(`${base}/execute/${id}`,body,{id:actor,key});
 const adminStatus=(key:string,actor=ADMIN,base=ADMIN_BASE)=>http(base+'/execution',{version:EXECUTION_VERSION},{id:actor,key});
 const managerInput=async(id:number,payload:ManagerJson={}):Promise<ManagerOperationInput>=>{
  const actual=await order(id),scope=await requireStoreManagerScope(f.managerRuntime.db,MANAGER,1);
  return{version:MANAGER_OPERATION_VERSION,store_id:1,scope_key:scope.scope_key,order_id:id,
   expected_order_revision:await merchantOrderRevision(actual),payload};
 };
 const managerReview=async(id:number,rootId:number)=>{
  const base=await managerInput(rootId),r=data(ok(await http(MANAGER_BASE+'/refund/review',{
   version:'merchant-refund-review-v1',store_id:1,scope_key:base.scope_key,order_id:rootId,refund_id:id},{kind:'manager'})));
  expect(object(object(r.actions).refund_execute).available).toBe(true);
  return managerInput(rootId,{action:'refund',refund_id:id,review_fingerprint:text(r.review_fingerprint),
   decision:{apply_type:integer(r.apply_type),refund_type:Number(r.refund_type),received:false}});
 };
 const managerApplication=async()=>{
  const root=await originalPaid(),items=await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id));expect(items).toHaveLength(1);
  await withTx(createContainerFromDb(f.managerRuntime.db),async tx=>{
   const pricing=await auditCheckoutPricingLockRuntime(tx,'public','shared-shop');
   if(!pricing.ready){
    const definers=await tx.execute<{name:string}>(sql`SELECT n.nspname||'.'||p.proname AS name
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE p.prosecdef AND n.nspname!~'^pg_' AND n.nspname<>'information_schema'
      AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE') ORDER BY n.nspname,p.proname LIMIT 16`);
    throw Error('Actual Manager pricing readiness: '+JSON.stringify({pricing,definers:Array.from(definers,row=>row.name)}));
   }
  });
  const selected=[{cart_id:items[0].cartId,cart_num:1}],base=await managerInput(root.id);
  const quote=data(ok(await http(MANAGER_BASE+'/refund/quote',{version:'merchant-refund-quote-v1',store_id:1,
   scope_key:base.scope_key,order_id:root.id,expected_order_revision:base.expected_order_revision,mode:'items',items:selected},{kind:'manager'})));
  expect(quote.quoted_price).toBe('5.00');const creation=ok(await http(MANAGER_BASE+'/refund/create',await managerInput(root.id,{
   mode:'items',items:selected,quoted_price:text(quote.quoted_price),refund_price:text(quote.quoted_price),
   quote_fingerprint:text(quote.quote_fingerprint),reason:'Manager 原商户完整真实申请原因'}),{kind:'manager',key:randomUUID()}));
  expect(receipt(creation).outcome).toBe('application-created');const id=integer(object(receipt(creation).evidence).refund_id);
  return{id,root,body:await managerReview(id,root.id),key:randomUUID()};
 };
 const managerExecute=(id:number,key:string,body:unknown)=>{
  if(object(object(body).payload).refund_id!==id)throw Error('Manager fixture target differs from its actual refund');
  return http(MANAGER_BASE+'/refund/execute',body,{kind:'manager',key});
 };
 const managerStatus=(key:string)=>http('/api/store/manager/order/operation/'+key+'/status',undefined,{kind:'manager'});
 const providerBody=(d:DispatchRow,status='PROCESSING')=>({out_trade_no:d.payload.request.outTradeNo,
  transaction_id:d.payload.request.transactionId,out_refund_no:d.out_refund_no,refund_id:'provider_'+d.out_refund_no,
  status,success_time:status==='SUCCESS'?new Date().toISOString():undefined,
  amount:{refund:d.payload.request.refundAmount,total:d.payload.request.totalAmount,currency:'CNY'}});
 const callback=(d:DispatchRow,eventId=randomUUID())=>{
  const response=providerBody(d,'SUCCESS'),{status,amount,...rest}=response;
  // Official notify includes mchid; unlike refund-query JSON it need not carry
  // currency. Do not require a fake query mchid field to make the test pass.
  return envelope(keys,{...rest,mchid:MERCHANT,refund_status:status,amount:{refund:amount.refund,total:amount.total}},'refund',eventId);
 };
 const assertArchivedRequest=async(url:RequestInfo|URL,init:RequestInit|undefined,id:number)=>{
  expect(typeof url).toBe('string');expect(init).toBeDefined();const u=new URL(String(url)),h=new Headers(init!.headers),auth=h.get('Authorization')??'';
  const fields=Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/gu)].map(match=>[match[1],match[2]]));
  expect(fields.mchid).toBe(MERCHANT);expect(fields.serial_no).toBe(SERIAL);expect(u.origin).toBe('https://api.mch.weixin.qq.com');
  const message=Buffer.from(`${init!.method}\n${u.pathname}${u.search}\n${fields.timestamp}\n${fields.nonce_str}\n${typeof init!.body==='string'?init!.body:''}\n`);
  expect(verify('RSA-SHA256',message,keys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(true);
  expect(verify('RSA-SHA256',message,currentKeys.publicKey,Buffer.from(fields.signature,'base64'))).toBe(false);
  const d=await dispatch(id);await f.withMaintenancePeer(async peer=>withTx(createContainerFromDb(peer),async tx=>{
   const locked=await tx.execute<{id:number}>(sql`SELECT id FROM public.store_order
    WHERE id IN(${d.payload.identity.rootId},${d.payload.identity.childId}) ORDER BY id FOR UPDATE NOWAIT`);
   expect(Array.from(locked,row=>row.id)).toEqual([...new Set([d.payload.identity.rootId,d.payload.identity.childId])].sort((a,b)=>a-b));
   expect(await tx.execute(sql`SELECT id FROM public.store_order_refund WHERE id=${id} FOR UPDATE NOWAIT`)).toHaveLength(1);
   const[r]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE
    usename IN(${f.appRuntime.role},${f.adminRuntime.role},${f.managerRuntime.role},${f.financialRuntime.role}) AND state='idle in transaction'`);expect(r.n).toBe(0);
  }));return d;
 };
 const assertNativeProofReached=()=>{
  const calls=connections.mock.calls.filter(call=>call[2]?.applicationName==='cinashop_routine_refund_verify');
  expect(calls.length).toBeGreaterThan(0);for(const call of calls){expect(call[0]===f.appRuntime.connectionString).toBe(true);
   expect(call[1]).toBe(1);expect(call[2]).toEqual({searchPath:'public,pg_temp',applicationName:'cinashop_routine_refund_verify'});}
 };
 const processing=(id:number)=>network.mockImplementation(async(url,init)=>{const d=await assertArchivedRequest(url,init,id);
  expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toMatchObject({out_refund_no:'CNSR'+id,
   transaction_id:d.payload.request.transactionId,notify_url:ORIGIN+'/api/pay/notify/routine-refund/'+d.dispatch_id,
   amount:{refund:500,total:1000,currency:'CNY'}});return signedResponse(keys,providerBody(d));});
 const assertPaidUnchanged=async(id:number,original:Awaited<ReturnType<typeof order>>)=>expect(await order(id)).toMatchObject({
  uid:11,paid:1,payType:'weixin',tradeNo:original.tradeNo,payPrice:'10.00'});
 const assertMaterialized=async(id:number,rootId:number)=>{
  expect(await refund(id)).toMatchObject({refundType:6,refundedPrice:'5.00'});
  const splits=await f.maintenanceDb.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,id));expect(splits).toHaveLength(1);
  expect(splits[0]).toMatchObject({sourceOrderId:rootId,paymentOrderId:rootId,disposition:'split',uid:11});
  expect(splits[0].selectedOrderId).not.toBe(rootId);expect(splits[0].remainingOrderId).toBeGreaterThan(0);
  expect(await order(rootId)).toMatchObject({pid:-1,payPrice:'10.00',uid:11});
  expect(await order(splits[0].remainingOrderId!)).toMatchObject({pid:rootId,payPrice:'5.00',uid:11});
 };

 beforeAll(async()=>{
  keys=paymentQueryKeys();currentKeys=paymentQueryKeys();network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Unconfigured provider transport'));
  for(const name of['log','warn','error'] as const)vi.spyOn(console,name).mockImplementation((...args:unknown[])=>{logs.push(args);});
  f=await customerCashierRuntimeHttpFixture();await runRoutineOriginalPaymentEvidenceUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  // This one fixture covers eight real two-item producers across six cases.
  // Seed their exact ordinary SKU once; real producers/consumers still own
  // reservation, stock deduction and refunds. This is no system resource limit.
  expect(await f.maintenanceDb.update(storeProduct).set({stock:40}).where(eq(storeProduct.id,70)).returning({id:storeProduct.id})).toEqual([{id:70}]);
  expect(await f.maintenanceDb.update(storeProductAttrValue).set({stock:40})
   .where(sql`${storeProductAttrValue.id}=1 AND ${storeProductAttrValue.productId}=70 AND ${storeProductAttrValue.unique}='qared001'`)
   .returning({id:storeProductAttrValue.id})).toEqual([{id:1}]);
  await runRoutinePaymentAccountPolicyUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  await runRoutineRefundUpgrade(f.maintenanceDb,f.target,f.peers,f.appReaders);
  const finance=await upgradeCustomerFinancialRoutineRefund(f.maintenanceDb,f.target,{routineRefund:{routineRefund:true},
   manualRefund:f.manual,originalPaymentReaders:f.readers},f.peers,f.appReaders);peers=finance.peers;
  await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,peers,f.appReaders);
  const actors=await upgradeRoutineRefundActors(f.maintenanceDb,f.target,{actors:{admin:true,manager:true}},
   {...peers,routineRefundActors:{admin:true,manager:true}},f.appReaders);peers=actors.peers;
  expect(new Set(await Promise.all([f.appRuntime,f.adminRuntime,f.managerRuntime,f.financialRuntime,f.cashierRuntime].map(r=>r.verify()))).size).toBe(5);
  // Do not use fixture's level0 id1 as the refund actor. It only creates unpaid
  // assisted roots through its established producer. All new decisions below
  // must traverse real nonroot role resolution at auth AND the SQL boundary.
  await f.maintenanceDb.insert(systemMenus).values({id:ADMIN_MENU,pid:0,type:1,authType:2,
   apiUrl:'refund/operations/execute/:id',methods:'POST',menuPath:'',uniqueAuth:'',isDel:0});
  await f.maintenanceDb.insert(systemRole).values([{id:ADMIN_ROLE,type:1,relationId:0,roleName:'Owned actor refund managers',
   rules:ADMIN_MENU+',refund.view',status:1},{id:READER_ROLE,type:1,relationId:0,roleName:'Owned actor refund reader',rules:'refund.view',status:1}]);
  await f.maintenanceDb.insert(systemAdmin).values([ADMIN,RESUMER,READER].map(id=>({id,account:'owned-actor-'+id,pwd:ADMIN_PASSWORD,
   adminType:1,relationId:0,level:1,status:1,isDel:0,roles:String(id===READER?READER_ROLE:ADMIN_ROLE)})));
  const role=await new AdminPermissionService(createContainerFromDb(f.adminRuntime.db)).resolveRoleAssignment(String(ADMIN_ROLE));
  expect(role.keys.has('refund.manage')).toBe(true);expect(role.legacyRuleIds).toEqual([ADMIN_MENU]);
  expect((await f.maintenanceDb.select().from(systemAdmin).where(eq(systemAdmin.id,ADMIN)))[0].level).toBe(1);
  registry=JSON.stringify({format:1,credentials:[{ref:REF,version:1,appId:APP,merchantId:MERCHANT,serialNo:SERIAL,
   apiV3Key:AES,privateKey:keys.privateKey,platformPublicKey:keys.publicKey,platformPublicKeyId:PLATFORM}]});
  Object.assign(f.env,{ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:registry,ROUTINE_REFUND_NOTIFY_ORIGIN:ORIGIN,
   WECHAT_MCH_PRIVATE_KEY:currentKeys.privateKey,WECHAT_PLATFORM_PUBLIC_KEY:currentKeys.publicKey,
   WECHAT_PLATFORM_PUBLIC_KEY_ID:'PUB_CURRENT_UNRELATED',WECHAT_API_V3_KEY:'b'.repeat(32)});
  await f.maintenanceDb.insert(user).values({uid:22,account:'actor-refund-actual-payer',pwd:'payer-password',status:1,nowMoney:'23.00'}).onConflictDoNothing();
  await f.maintenanceDb.insert(wechatUser).values([{uid:22,userType:'routine',openid:PAYER},{uid:11,userType:'routine',openid:BUYER_BINDING}]);
  const now=Math.floor(Date.now()/1000),commitment=routinePaymentCredentialCommitment(f.env,REF,1);
  await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:0,kind:'account',data:{
   accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,purposes:['query','notify'],validFrom:now-60,validUntil:now+3600}});
  policy={accountId:ACCOUNT,state:'active',...commitment,credentialRef:REF,credentialVersion:1,
   purposes:['refund_request','refund_query','refund_notify'],validFrom:now-60,validUntil:now+3600};await appendPolicy();await current();
  financial=new CustomerWorkFinancialService(f.container,f.env);connections=vi.spyOn(Di,'createDbFromConnectionString');
 },180000);
 beforeEach(async()=>{network.mockReset().mockRejectedValue(Error('Unconfigured external transport'));connections.mockClear();
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;if(lastPolicyState==='revoked')await appendPolicy();await current();
 });
 afterEach(()=>{noSecrets(logs);noSecrets(f.messages);});
 afterAll(async()=>{
  try{if(f){for(const[role,kind]of[[f.appRuntime,'app'],[f.adminRuntime,'admin']] as const)
   expect(await auditRuntimeBusinessPrivileges(role.db,kind,f.target,undefined,peers,kind==='app'?f.appReaders:undefined)).toMatchObject({ready:true,failures:[]});
   expect(await auditManagerRuntimePrivileges(f.managerRuntime.db,f.target,true)).toMatchObject({ready:true});
   expect(await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db,f.target,f.manual,f.readers,{routineRefund:true})).toMatchObject({ready:true});
   if(!peers.cashierSecondCard)throw Error('Complete Cashier declaration required');
   expect(await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db,f.cashierRuntime.role,f.target,peers.cashierSecondCard)).toMatchObject({ready:true});
  }}finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);

 it('uses nonroot Admin HTTP, archived A request/query and split finalization; both status aliases and same-key replay remain durable',async()=>{
  const bindings=await f.maintenanceDb.select().from(wechatUser),payer=(await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0];
  const c=await applicationForAdmin();processing(c.id);
  const admitted=ok(await adminExecute(c.id,c.key,c.body));privateResponse(admitted);
  expect(data(admitted)).toMatchObject({version:ADMIN_VERSION,replayed:false,receipt:{adminId:ADMIN,requestKey:c.key,refundId:c.id,
   action:'refund',outcome:'provider-admitted'},execution:{status:'PROCESSING',completed:false}});
  expect(Object.keys(receipt(admitted)).sort()).toEqual(['action','adminId','outcome','refundId','requestHash','requestKey','version']);
  const d=await dispatch(c.id),[role]=await f.adminRuntime.db.execute<{oid:string}>(sql`SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user`);
  expect(d.payload).toMatchObject({format:2,actor:{kind:'admin',adminId:ADMIN,requestKey:c.key,requestHash:receipt(admitted).requestHash,
   role:f.adminRuntime.role,roleOid:role.oid},approval:{appId:APP,merchantId:MERCHANT}});
  expect(d.payload.actor.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);const firstDispatch=(await immutable(c.id)).dispatch,firstReceipt=await actorRows(c.id);
  assertNativeProofReached();
  const beforeStatus=network.mock.calls.length,status=ok(await adminStatus(c.key));privateResponse(status);
  expect(data(status)).toEqual({version:EXECUTION_VERSION,receipt:receipt(admitted),execution:{completed:false,status:'PROCESSING'}});
  expect(network).toHaveBeenCalledTimes(beforeStatus);
  network.mockImplementation(async(url,init)=>{const actual=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');
   await appendPolicy('revoked');return signedResponse(keys,providerBody(actual,'SUCCESS'));});
  const completed=ok(await adminExecute(c.id,c.key,c.body));expect(data(completed)).toMatchObject({receipt:receipt(admitted),execution:{status:'SUCCESS',completed:true}});
  expect(network).toHaveBeenCalledTimes(2);await assertMaterialized(c.id,c.root.id);expect((await immutable(c.id)).dispatch).toEqual(firstDispatch);
  expect(await actorRows(c.id)).toEqual(firstReceipt);const stable=await immutable(c.id),business=await f.facts();
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=undefined;await current(true);
  for(const base of[ADMIN_BASE,ADMIN_ALIAS]){const r=ok(await adminStatus(c.key,ADMIN,base));privateResponse(r);
   expect(data(r)).toEqual({version:EXECUTION_VERSION,receipt:receipt(admitted),execution:{completed:true,status:'SUCCESS'}});}
  expect(data(ok(await adminExecute(c.id,c.key,c.body,ADMIN,ADMIN_ALIAS)))).toMatchObject({receipt:receipt(admitted),replayed:true,
   execution:{status:'SUCCESS',completed:true}});expect(network).toHaveBeenCalledTimes(2);
  expect(await immutable(c.id)).toEqual(stable);expect(await actorRows(c.id)).toEqual(firstReceipt);expect(await f.facts()).toEqual(business);
  expect(await f.maintenanceDb.select().from(wechatUser)).toEqual(bindings);expect((await f.maintenanceDb.select().from(user).where(eq(user.uid,22)))[0]).toEqual(payer);
 },90000);

 it('uses Manager real quote/create/review/execute with current config empty, then authenticates callback and RR/RO status after materials withdrawal',async()=>{
  // The fixed Manager's already commissioned case lock is admissible only
  // with its complete existing catalog. An altered definer stays rejected.
  await f.maintenanceDb.execute(sql`ALTER FUNCTION public.local_payment_case_lock_v1(text) COST 101`);
  try{
   const pricing=await withTx(createContainerFromDb(f.managerRuntime.db),tx=>auditCheckoutPricingLockRuntime(tx,'public','shared-shop'));
   expect(pricing).toMatchObject({ready:false,noUnreviewedDefinerRoutine:false});
  }finally{await f.maintenanceDb.execute(sql`ALTER FUNCTION public.local_payment_case_lock_v1(text) COST 100`);}
  await current(true);const c=await managerApplication();processing(c.id);
  const admitted=ok(await managerExecute(c.id,c.key,c.body));privateResponse(admitted);
  expect(receipt(admitted)).toMatchObject({actor_uid:MANAGER,store_id:1,staff_id:MANAGER_STAFF,kind:'refund_execute',outcome:'provider-admitted'});
  const d=await dispatch(c.id),[role]=await f.managerRuntime.db.execute<{oid:string}>(sql`SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user`);
  expect(d.payload).toMatchObject({format:2,actor:{kind:'manager',actorUid:MANAGER,requestKey:c.key,requestHash:receipt(admitted).request_hash,
   storeId:1,staffId:MANAGER_STAFF,role:f.managerRuntime.role,roleOid:role.oid}});
  assertNativeProofReached();
  const first=(await immutable(c.id)).dispatch,receipts=await actorRows(c.id),signed=callback(d);
  expect((await postProvider('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
  await assertMaterialized(c.id,c.root.id);const stable=await immutable(c.id),business=await f.facts();
  // A fresh callback verification still requires its currently approved
  // materials. Identical replay is idempotent while those remain available.
  expect((await postProvider('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(204);
  expect(await immutable(c.id)).toEqual(stable);expect(await f.facts()).toEqual(business);
  await appendPolicy('revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=undefined;
  const status=ok(await managerStatus(c.key));privateResponse(status);
  expect(data(status)).toMatchObject({version:MANAGER_OPERATION_VERSION,receipt:receipt(admitted),execution:{completed:true,status:'SUCCESS',refund_id:c.id}});
  expect(data(ok(await managerExecute(c.id,c.key,c.body)))).toMatchObject({receipt:receipt(admitted),execution:{completed:true,status:'SUCCESS'}});
  expect((await postProvider('/pay/notify/routine-refund/'+d.dispatch_id,signed)).status).toBe(400);
  expect(network).toHaveBeenCalledOnce();expect((await immutable(c.id)).dispatch).toEqual(first);expect(await immutable(c.id)).toEqual(stable);
  expect(await actorRows(c.id)).toEqual(receipts);expect(await f.facts()).toEqual(business);
 },90000);

 it('pins the first Admin receipt while another currently authorized Admin legally resumes the original refund',async()=>{
  const c=await applicationForAdmin();network.mockImplementation(async(url,init)=>{await assertArchivedRequest(url,init,c.id);
   expect(init?.method).toBe('POST');throw Error('Owned request response lost after send');});
  const first=await adminExecute(c.id,c.key,c.body);expect(first.json.status).not.toBe(200);
  const minimal=ok(await http(ADMIN_BASE+'/receipt',{version:ADMIN_VERSION},{key:c.key}));expect(receipt(minimal)).toMatchObject({adminId:ADMIN,outcome:'provider-admitted'});
  const d=await dispatch(c.id),pinned=(await immutable(c.id)).dispatch,firstRows=await actorRows(c.id),otherKey=randomUUID();
  expect(d.payload.actor).toMatchObject({kind:'admin',adminId:ADMIN,requestKey:c.key});
  network.mockImplementation(async(url,init)=>{const actual=await assertArchivedRequest(url,init,c.id);expect(init?.method).toBe('GET');return signedResponse(keys,providerBody(actual,'SUCCESS'));});
  const resumed=ok(await adminExecute(c.id,otherKey,await adminReview(c.id,RESUMER),RESUMER));expect(receipt(resumed)).toMatchObject({adminId:RESUMER,requestKey:otherKey,outcome:'provider-admitted'});
  expect(data(resumed)).toMatchObject({execution:{completed:true,status:'SUCCESS'}});await assertMaterialized(c.id,c.root.id);
  expect((await immutable(c.id)).dispatch).toEqual(pinned);expect((await dispatch(c.id)).payload.actor).toEqual(d.payload.actor);
  const after=await actorRows(c.id);expect(after.admin).toHaveLength(2);expect(after.admin).toContainEqual(firstRows.admin[0]);
  expect(data(ok(await adminStatus(c.key)))).toMatchObject({receipt:receipt(minimal),execution:{completed:true,status:'SUCCESS'}});
  expect(data(ok(await adminStatus(otherKey,RESUMER)))).toMatchObject({receipt:receipt(resumed),execution:{completed:true,status:'SUCCESS'}});
  expect(network).toHaveBeenCalledTimes(2);
 },90000);

 it('keeps real permission/realm/scope/store/staff and reviewed-state refusals ahead of provider admission',async()=>{
  const c=await applicationForAdmin(),before=await f.facts(),rows=await actorRows(c.id);
  for(const options of[{id:READER},{realm:'api' as const},{scope:'v1:admin:'+RESUMER},{password:'wrong-current-password'}]){
   const r=await http(`${ADMIN_BASE}/execute/${c.id}`,c.body,{key:randomUUID(),...options});privateResponse(r);
   expect(r.json.status).not.toBe(200);expect(await actorRows(c.id)).toEqual(rows);expect(await f.facts()).toEqual(before);
  }
  await f.maintenanceDb.update(systemRole).set({rules:'refund.view'}).where(eq(systemRole.id,ADMIN_ROLE));
  try{for(const endpoint of['execute/'+c.id,'execution','receipt']){
   const r=await http(ADMIN_BASE+'/'+endpoint,endpoint.startsWith('execute/')?c.body:{version:endpoint==='execution'?EXECUTION_VERSION:ADMIN_VERSION},{key:randomUUID()});
   expect(r.json.status).toBe(400011);expect(await actorRows(c.id)).toEqual(rows);
  }}finally{await f.maintenanceDb.update(systemRole).set({rules:ADMIN_MENU+',refund.view'}).where(eq(systemRole.id,ADMIN_ROLE));}
  await f.maintenanceDb.update(systemMenus).set({methods:'GET'}).where(eq(systemMenus.id,ADMIN_MENU));
  try{expect((await adminExecute(c.id,randomUUID(),c.body)).json.status).toBe(400011);expect(await actorRows(c.id)).toEqual(rows);}
  finally{await f.maintenanceDb.update(systemMenus).set({methods:'POST'}).where(eq(systemMenus.id,ADMIN_MENU));}
  const altered={...c.body,review:{...c.body.review,refundPrice:'4.00'}};
  expect((await adminExecute(c.id,randomUUID(),altered)).json.status).not.toBe(200);
  expect(await actorRows(c.id)).toEqual(rows);expect(await sourceCount(c.id)).toHaveLength(0);expect(await payment(c.id)).toBeUndefined();
  const m=await managerApplication(),managerBefore=await f.facts(),managerRows=await actorRows(m.id);
  const wrongRealm=await http(MANAGER_BASE+'/refund/execute',m.body,{kind:'manager',realm:'admin',key:randomUUID()});expect(wrongRealm.json.status).not.toBe(200);
  expect(await actorRows(m.id)).toEqual(managerRows);expect(await f.facts()).toEqual(managerBefore);
  // Local rejection is an explicit existing durable outcome, not admission.
  // Expect zero provider-admitted/dispatch/payment, not zero total ledger rows.
  const cross=await http(MANAGER_BASE+'/refund/execute',{...m.body,store_id:2},{kind:'manager',key:randomUUID()});
  expect(receipt(ok(cross)).outcome).toBe('rollback-rejected');
  await f.maintenanceDb.update(systemStoreStaff).set({isManager:0}).where(eq(systemStoreStaff.id,MANAGER_STAFF));
  try{const denied=ok(await managerExecute(m.id,randomUUID(),m.body));expect(receipt(denied).outcome).toBe('rollback-rejected');}
  finally{await f.maintenanceDb.update(systemStoreStaff).set({isManager:1}).where(eq(systemStoreStaff.id,MANAGER_STAFF));}
  const stale={...m.body,payload:{...object(m.body.payload),review_fingerprint:'0'.repeat(64)}};
  expect(receipt(ok(await managerExecute(m.id,randomUUID(),stale))).outcome).toBe('rollback-rejected');
  const actual=await actorRows(m.id);for(const r of actual.manager)expect(object(object(r).row).outcome).not.toBe('provider-admitted');
  expect(await sourceCount(m.id)).toHaveLength(0);expect(await payment(m.id)).toBeUndefined();
  expect(network).not.toHaveBeenCalled();await assertPaidUnchanged(c.root.id,c.root);await assertPaidUnchanged(m.root.id,m.root);
 },90000);

 it('does not turn forged mutable SUCCESS into Admin/Manager durable status or a trusted completed replay',async()=>{
  for(const kind of['admin','manager'] as const){
   const c=kind==='admin'?await applicationForAdmin():await managerApplication();processing(c.id);
   const admit=ok(kind==='admin'?await adminExecute(c.id,c.key,c.body):await managerExecute(c.id,c.key,c.body));
   const d=await dispatch(c.id),original=await payment(c.id),immutableBefore=await immutable(c.id),rows=await actorRows(c.id),before=network.mock.calls.length;
   // Maintenance adversarial projection is deliberately NOT real provider evidence.
   // Set mutable completed shape without inserting a result, then require unknown.
   const application=await refund(c.id);
   await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:'SUCCESS',successTime:Math.floor(Date.now()/1000)}).where(eq(storeOrderRefundPayment.refundId,c.id));
   await f.maintenanceDb.update(storeOrderRefund).set({refundType:6,refundedPrice:'5.00'}).where(eq(storeOrderRefund.id,c.id));
   try{
    const status=ok(kind==='admin'?await adminStatus(c.key):await managerStatus(c.key));
    expect(data(status)).toMatchObject({receipt:receipt(admit),execution:{status:'UNKNOWN',completed:false}});
    const replay=kind==='admin'?await adminExecute(c.id,c.key,c.body):await managerExecute(c.id,c.key,c.body);
    expect(replay.json.status).toBe(503);expect(await immutable(c.id)).toEqual(immutableBefore);expect(await actorRows(c.id)).toEqual(rows);
    expect(network).toHaveBeenCalledTimes(before);
   }finally{
    await f.maintenanceDb.update(storeOrderRefundPayment).set({providerStatus:original.providerStatus,successTime:original.successTime,
     providerRefundId:original.providerRefundId}).where(eq(storeOrderRefundPayment.refundId,c.id));
    await f.maintenanceDb.update(storeOrderRefund).set({refundType:application.refundType,refundedPrice:application.refundedPrice}).where(eq(storeOrderRefund.id,c.id));
   }
   expect((await postProvider('/pay/notify/routine-refund/'+d.dispatch_id,callback(d))).status).toBe(204);await assertMaterialized(c.id,c.root.id);
  }
 },90000);

 it('reaches the independent actual App verifier and refuses genuine APP SUCCESS conflicting with the same Routine root',async()=>{
  await current(true);const c=await applicationForAdmin(),nativeApp='wx_actor_native_conflict';
  const values={wechat_app_appid:nativeApp,pay_weixin_mchid:CURRENT_MERCHANT,pay_weixin_serial_no:'B1B2B3B4',site_url:'https://current-unrelated.example'};
  await f.maintenanceDb.delete(systemConfig).where(inArray(systemConfig.menuName,Object.keys(values)));
  await f.maintenanceDb.insert(systemConfig).values(Object.entries(values).map(([menuName,value])=>({menuName,value:JSON.stringify(value),sort:20})));
  const eventId=randomUUID(),nativeTransaction='native_actor_conflict_'+randomUUID().replaceAll('-','');
  const signed=envelope(currentKeys,{appid:nativeApp,mchid:CURRENT_MERCHANT,out_trade_no:c.root.orderId,
   transaction_id:nativeTransaction,trade_state:'SUCCESS',trade_type:'APP',success_time:new Date().toISOString(),amount:{total:1000,currency:'CNY'}},
   'transaction',eventId,{apiV3Key:'b'.repeat(32),platformPublicKeyId:'PUB_CURRENT_UNRELATED'});
  const pay=new WechatPayService(createContainerFromDb(f.appRuntime.db),f.env);
  await expect(pay.verifyAndParseNotify({...signed.headers,'wechatpay-signature':'invalid'},signed.body,'app')).rejects.toThrow();
  expect(await f.maintenanceDb.execute(sql`SELECT evidence_id FROM public.native_app_payment_evidence WHERE order_no=${c.root.orderId}`)).toHaveLength(0);
  expect(await pay.verifyAndParseNotify(signed.headers,signed.body,'app')).toMatchObject({appId:nativeApp,
   merchantId:CURRENT_MERCHANT,outTradeNo:c.root.orderId,transactionId:nativeTransaction,tradeState:'SUCCESS'});
  expect(await f.maintenanceDb.execute(sql`SELECT evidence_id,kind,payload->>'tradeState' AS state,payload->>'tradeType' AS type
   FROM public.native_app_payment_evidence WHERE order_no=${c.root.orderId}`)).toEqual([{evidence_id:'callback:'+eventId,kind:'callback',state:'SUCCESS',type:'APP'}]);
  for(const runtime of[f.adminRuntime,f.managerRuntime])await expect(runtime.db.execute(sql`SELECT * FROM public.native_app_payment_evidence LIMIT 0`)).rejects.toMatchObject({cause:{code:'42501'}});
  // Refresh real review after configuration/provider evidence changes so the
  // failure cannot be a stale snapshot shortcut before the NativeApp branch.
  const body=await adminReview(c.id),business=await f.facts(),receipts=await actorRows(c.id);connections.mockClear();
  const response=await adminExecute(c.id,c.key,body);expect(response.json.status).toBe(503);
  assertNativeProofReached();
  expect(await f.facts()).toEqual(business);expect(await actorRows(c.id)).toEqual(receipts);
  expect(await sourceCount(c.id)).toHaveLength(0);expect(await payment(c.id)).toBeUndefined();expect(network).not.toHaveBeenCalled();
  await assertPaidUnchanged(c.root.id,c.root);
 },90000);
});

/* Boundaries:
 * - The second Admin uses a current real review; the admitted owner keeps its
 *   original key/body for completed replay and corrupt-proof guard witnesses.
 * - Manager localRejection intentionally persists rollback-rejected; those
 *   rows never count as provider-admitted or successful money movement.
 * - No capacity, deployment, Hyperdrive cache, full migration or historical
 *   account-switch activation is proved by this local finite fixture.
 */
