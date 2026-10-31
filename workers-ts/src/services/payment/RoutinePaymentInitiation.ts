import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase, wechatUser } from '@/models/schema';
import { assertRoutinePaymentAttemptReady } from '@/migrations/routinePaymentAttempt';
import { assertRoutineIdentityWitnessReady } from '@/migrations/routineIdentityWitness';
import { readRoutineIdentityWitness, type RoutineIdentityWitness } from '@/services/wechat/RoutineIdentityWitness';
import { assertRoutineIdentityOwnershipInstalledTx } from '@/migrations/routineIdentityOwnership';
import { readRoutineIdentityOwnerForUidTx } from '@/services/wechat/RoutineIdentityOwnership';
import { verifyRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { lockPaymentReconciliationRegistrationTx, registerPaymentReconciliationTx } from './PaymentReconciliationRegistry';
import { withRoutinePaymentPublicSource, type PaymentPublicSnapshot } from './PaymentPublicRuntimeConfig';

export type RoutinePaymentOrderDomain = 'store_order' | 'recharge' | 'membership';
export interface RoutinePaymentAdmission {
  readonly uid: number;
  readonly orderId: number;
  readonly orderDomain: RoutinePaymentOrderDomain;
  /** SQL only, on this bound connection: lock/revalidate the exact live order,
   * owner, amount, unpaid status and all domain-specific payment conditions. */
  readonly lockOrder: (bound: Container) => Promise<void>;
}
type RuntimeEnv = Pick<Env,'APP_KEY'>;
type Request = { orderNo:string; amountCents:number; admission:RoutinePaymentAdmission };
type ProviderBody = {appid:string;mchid:string;out_trade_no:string;description:string;notify_url:string;attach:string;
  amount:{total:number;currency:'CNY'};payer:{openid:string}};
type IntentPayload = {
  version:1; purpose:'routine_payment_initiation'; uid:number; orderId:number; orderDomain:RoutinePaymentOrderDomain;
  amountCents:number; currency:'CNY'; appId:string; merchantId:string; payerId:string; bindingId:number;
  witness:RoutineIdentityWitness; publicSourceStamp:string; providerBody:ProviderBody;
};
export type RoutinePaymentPacket = {prepay_id:string;timeStamp:string;nonceStr:string;package:string;signType:string;paySign:string};
type ReceiptPayload = {version:1;purpose:'routine_payment_prepay_receipt';intentSignature:string;expiresAt:number;packet:RoutinePaymentPacket};
type EventRow = {order_no:string;event_kind:string;payload:unknown;created_at:string|number;signature:string};
export interface RoutinePaymentIntent {readonly orderNo:string;readonly payload:Readonly<IntentPayload>;readonly createdAt:number;readonly signature:string}
export type RoutinePaymentReplay = {kind:'new'} | {kind:'recovery'} | {kind:'ready';packet:RoutinePaymentPacket;expiresAt:number};
export type RoutinePaymentReservation = Exclude<RoutinePaymentReplay,{kind:'new'}> | {kind:'conflict'} | {kind:'reserved';intent:RoutinePaymentIntent};
const unavailable = () => new ServiceUnavailableException('小程序付款记录无效，请核对原交易');
const recovery = () => new ValidateException('小程序付款已发起，请查询原交易；结果未知或凭据过期时请先维护原交易');
const positive = (n:unknown):n is number => Number.isSafeInteger(n) && Number(n)>0 && Number(n)<=2147483647;
const id = (s:unknown,max:number):s is string => typeof s==='string' && s.length>0 && s.length<=max && !/[^A-Za-z0-9_-]/u.test(s);
const hex = (s:unknown):s is string => typeof s==='string' && /^[a-f0-9]{64}$/u.test(s);
const exact = (v:unknown,keys:string[]):v is Record<string,unknown> => {
  if (!v || typeof v!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) return false;
  const descriptors=Object.getOwnPropertyDescriptors(v), own=Reflect.ownKeys(descriptors);
  return own.length===keys.length && keys.every(key=>Object.hasOwn(descriptors,key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key],'value'));
};
function canonical(v:unknown):string {
  if (v===null || typeof v==='string' || typeof v==='boolean' || typeof v==='number' && Number.isSafeInteger(v)) return JSON.stringify(v);
  if (!v || typeof v!=='object' || Array.isArray(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) throw unavailable();
  const keys=Reflect.ownKeys(v);
  if (keys.some(key=>typeof key!=='string')) throw unavailable();
  return '{'+(keys as string[]).sort().map(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(v,key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw unavailable();
    return JSON.stringify(key)+':'+canonical(descriptor.value);
  }).join(',')+'}';
}
function signature(env:RuntimeEnv,orderNo:string,kind:string,payload:unknown,createdAt:number) {
  if (typeof env.APP_KEY!=='string' || !env.APP_KEY) throw unavailable();
  return createHmac('sha256',env.APP_KEY).update('cinashop.routine-payment-attempt.v1\0')
    .update(JSON.stringify([orderNo,kind,canonical(payload),createdAt])).digest('hex');
}
function request(input:Request):Request {
  const orderNo=input.orderNo,amountCents=input.amountCents;
  const {uid,orderId,orderDomain,lockOrder}=input.admission;
  if (!id(orderNo,32) || orderNo.length<6 || !positive(amountCents) || !positive(uid) || !positive(orderId)
    || !['store_order','recharge','membership'].includes(orderDomain) || typeof lockOrder!=='function') throw new ValidateException('小程序付款准入参数无效');
  return {orderNo,amountCents,admission:Object.freeze({uid,orderId,orderDomain,lockOrder})};
}
function intentPayload(env:RuntimeEnv,value:unknown):IntentPayload {
  if (!exact(value,['version','purpose','uid','orderId','orderDomain','amountCents','currency','appId','merchantId','payerId','bindingId','witness','publicSourceStamp','providerBody'])
    || value.version!==1 || value.purpose!=='routine_payment_initiation' || !positive(value.uid) || !positive(value.orderId) || !positive(value.amountCents)
    || value.currency!=='CNY' || !['store_order','recharge','membership'].includes(String(value.orderDomain))
    || !id(value.appId,32) || typeof value.merchantId!=='string' || !/^\d{1,32}$/u.test(value.merchantId)
    || !id(value.payerId,100) || !positive(value.bindingId) || !hex(value.publicSourceStamp)
    || !exact(value.witness,['observationId','uid','bindingId','observation','createdAt'])) throw unavailable();
  const w=value.witness, observation=verifyRoutineIdentityObservation(env,w.observation,undefined,{allowExpired:true});
  if (w.uid!==value.uid || w.bindingId!==value.bindingId || w.observationId!==observation.observationId
    || observation.appId!==value.appId || observation.openid!==value.payerId || !positive(w.createdAt)
    || w.createdAt<observation.observedAt-60 || w.createdAt>Math.floor(Date.now()/1000)+60) throw unavailable();
  const body=value.providerBody;
  if (!exact(body,['appid','mchid','out_trade_no','description','notify_url','attach','amount','payer'])
    || body.appid!==value.appId || body.mchid!==value.merchantId || !id(body.out_trade_no,32) || body.out_trade_no.length<6
    || typeof body.description!=='string' || !body.description || [...body.description].length>127
    || typeof body.notify_url!=='string' || body.notify_url.length>255 || !body.notify_url.startsWith('https://')
    || body.attach!==({store_order:'product',recharge:'user_recharge',membership:'member'} as const)[value.orderDomain as RoutinePaymentOrderDomain]
    || !exact(body.amount,['total','currency']) || body.amount.total!==value.amountCents || body.amount.currency!=='CNY'
    || !exact(body.payer,['openid']) || body.payer.openid!==value.payerId) throw unavailable();
  return Object.freeze({...value,witness:Object.freeze({...w,observation}),providerBody:Object.freeze({...body,
    amount:Object.freeze({...body.amount}),payer:Object.freeze({...body.payer})})}) as IntentPayload;
}
function packet(value:unknown):RoutinePaymentPacket {
  if (!exact(value,['prepay_id','timeStamp','nonceStr','package','signType','paySign']) || !id(value.prepay_id,64)
    || typeof value.timeStamp!=='string' || !/^\d{10,13}$/u.test(value.timeStamp)
    || !id(value.nonceStr,64) || value.package!=='prepay_id='+value.prepay_id || value.signType!=='RSA'
    || typeof value.paySign!=='string' || value.paySign.length<64 || value.paySign.length>1024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.paySign)) throw unavailable();
  return Object.freeze({...value}) as RoutinePaymentPacket;
}
async function shortTx<T>(container:Container,fn:(tx:DbClient)=>Promise<T>):Promise<T> {
  return withTx(container,async tx=>{
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [context]=await tx.execute<{valid:boolean}>(sql`SELECT current_setting('transaction_isolation')='read committed'
      AND NOT current_setting('transaction_read_only')::boolean AS valid`);
    if (context?.valid!==true) throw unavailable();
    const result=await fn(tx);
    const [deadline]=await tx.execute<{valid:boolean}>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
    if (deadline?.valid!==true) throw unavailable();
    return result;
  });
}
async function now(tx:DbClient):Promise<number> {
  const [row]=await tx.execute<{now:string|number}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);
  const value=Number(row?.now); if (!positive(value)) throw unavailable(); return value;
}
function verifyEvent(env:RuntimeEnv,row:EventRow) {
  const createdAt=Number(row.created_at);
  if (!positive(createdAt) || createdAt>Math.floor(Date.now()/1000)+60 || !hex(row.signature)
    || !timingSafeEqual(Buffer.from(row.signature,'hex'),Buffer.from(signature(env,row.order_no,row.event_kind,row.payload,createdAt),'hex'))) throw unavailable();
  return createdAt;
}
async function events(tx:DbClient,env:RuntimeEnv,input:Request):Promise<{intent:RoutinePaymentIntent|null;ready:RoutinePaymentPacket|null;expiresAt?:number}> {
  const rows=await tx.execute<EventRow>(sql`SELECT order_no,event_kind,payload,created_at,signature FROM public.routine_payment_attempt
    WHERE order_no=${input.orderNo} ORDER BY event_kind LIMIT 3`);
  if (!rows.length) return {intent:null,ready:null};
  const raw=rows.find(row=>row.event_kind==='INITIATION');
  if (!raw || rows.length>2 || rows.some(row=>row.order_no!==input.orderNo || !['INITIATION','PREPAY'].includes(row.event_kind))) throw unavailable();
  const createdAt=verifyEvent(env,raw),payload=intentPayload(env,raw.payload);
  if (payload.providerBody.out_trade_no!==input.orderNo || createdAt<payload.witness.createdAt) throw unavailable();
  if (payload.uid!==input.admission.uid || payload.orderId!==input.admission.orderId
    || payload.orderDomain!==input.admission.orderDomain || payload.amountCents!==input.amountCents) throw recovery();
  const intent=Object.freeze({orderNo:input.orderNo,payload,createdAt,signature:raw.signature});
  const receipt=rows.find(row=>row.event_kind==='PREPAY'); if (!receipt) return {intent,ready:null};
  const receiptAt=verifyEvent(env,receipt),p=receipt.payload;
  if (!exact(p,['version','purpose','intentSignature','expiresAt','packet']) || p.version!==1 || p.purpose!=='routine_payment_prepay_receipt'
    || p.intentSignature!==intent.signature || p.expiresAt!==intent.createdAt+300 || receiptAt<intent.createdAt || receiptAt>p.expiresAt) throw unavailable();
  const ready=packet(p.packet);
  if (Number(ready.timeStamp)<intent.createdAt-60 || Number(ready.timeStamp)>receiptAt+60) throw unavailable();
  return {intent,ready:await now(tx)<p.expiresAt ? ready:null,expiresAt:p.expiresAt};
}
async function registry(tx:DbClient,input:Request) {
  // Domain order row is already held. All rails' registrations share this
  // boundary, including callbacks, so no second provider can claim behind us.
  await lockPaymentReconciliationRegistrationTx(tx,'wechat',input.orderNo);
  return tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo,input.orderNo)).for('update');
}
function matches(row:typeof paymentReconciliationCase.$inferSelect,input:Request) {
  return row.profile==='routine' && row.orderDomain===input.admission.orderDomain
    && row.expectedAmountCents===input.amountCents && row.currency==='CNY';
}
function pristine(row:typeof paymentReconciliationCase.$inferSelect) {
  return row.status==='OPEN' && row.providerStatus==='UNKNOWN' && row.initiatedTime===0
    && row.callbackEventId===null && row.providerTransactionId==='' && row.providerEventTime===0
    && row.attemptCount===0 && row.lastQueryTime===0 && row.leaseUntil===0 && row.leaseToken===''
    && row.resolvedTime===0 && row.lastErrorCode==='';
}
async function hasPriorAction(tx:DbClient,cases:(typeof paymentReconciliationCase.$inferSelect)[]) {
  if (!cases.length) return false;
  // A manual query RETRY deliberately clears mutable status/lease/error fields.
  // Its durable action still distinguishes old UNKNOWN from a fresh case. The
  // case row locks above serialize decide() until this admission commits.
  const actions=await tx.select({id:paymentReconciliationAction.id}).from(paymentReconciliationAction)
    .where(inArray(paymentReconciliationAction.caseId,cases.map(row=>row.id))).limit(1);
  return actions.length>0;
}
async function replay(tx:DbClient,env:RuntimeEnv,input:Request):Promise<RoutinePaymentReplay> {
  const saved=await events(tx,env,input);
  if (!saved.intent) return {kind:'new'};
  const cases=await registry(tx,input),own=cases.find(row=>row.provider==='wechat');
  if (!own || await hasPriorAction(tx,cases) || !matches(own,input) || own.initiatedTime<=0 || !['OPEN','WAITING'].includes(own.status)
    || !['UNKNOWN','PENDING'].includes(own.providerStatus) || own.callbackEventId!==null || own.providerTransactionId!==''
    || cases.some(row=>row.provider!=='wechat' && !pristine(row))) return {kind:'recovery'};
  return saved.ready ? {kind:'ready',packet:saved.ready,expiresAt:saved.expiresAt!}:{kind:'recovery'};
}

/** Old local attempts replay before current configuration/credentials/bindings.
 * Live owner/order conditions and signed original packet still must match. */
export function readRoutinePaymentReplay(container:Container,env:RuntimeEnv,raw:Request):Promise<RoutinePaymentReplay> {
  const input=request(raw);
  return shortTx(container,async tx=>{
    await assertRoutinePaymentAttemptReady(tx);
    await input.admission.lockOrder(createContainerFromDb(tx));
    return replay(tx,env,input);
  });
}

/** SQL-only reservation. A committed intent means at most one HTTP attempt;
 * missing receipt, timeout/crash or expired packet never re-pin/re-send. */
export function reserveRoutinePayment(container:Container,env:RuntimeEnv,raw:Request & {
  publicSource:PaymentPublicSnapshot; appId:string; merchantId:string; description:string; notifyUrl:string; attach:string;
}):Promise<RoutinePaymentReservation> {
  const input=request(raw),{publicSource,appId,merchantId,description,notifyUrl,attach}=raw;
  if (publicSource.scope!=='routine' || publicSource.values.routine_appId!==appId || publicSource.values.pay_weixin_mchid!==merchantId
    || !id(appId,32) || !/^\d{1,32}$/u.test(merchantId)) throw unavailable();
  return withRoutinePaymentPublicSource(container,publicSource,async bound=>{
    const tx=bound.db;
    await assertRoutineIdentityWitnessReady(tx); await assertRoutinePaymentAttemptReady(tx);
    await input.admission.lockOrder(bound);
    const existing=await replay(tx,env,input); if (existing.kind!=='new') return existing;
    const cases=await registry(tx,input),own=cases.find(row=>row.provider==='wechat');
    if (own && !matches(own,input)) {
      // Commit the registry's CONFLICT before rejecting outside this gate.
      await registerPaymentReconciliationTx(tx,{provider:'wechat',profile:'routine',orderDomain:input.admission.orderDomain,
        orderNo:input.orderNo,expectedAmountCents:input.amountCents,terminalConflict:true});
      return {kind:'conflict'};
    }
    if (cases.some(row=>!pristine(row)) || await hasPriorAction(tx,cases)) return {kind:'recovery'};
    const scoped=await assertRoutineIdentityOwnershipInstalledTx(tx);
    let binding:{id:number;openid:string},witness:RoutineIdentityWitness|null;
    if (scoped) {
      const owned=await readRoutineIdentityOwnerForUidTx(tx,env,{uid:input.admission.uid,appId});
      if (!owned) throw new ValidateException('小程序付款缺少唯一的有效账号归属，请重新授权或维护');
      binding={id:owned.owner.bindingId,openid:owned.owner.openid}; witness=owned.witness;
    } else {
      const bindings=await tx.select({id:wechatUser.id,openid:wechatUser.openid}).from(wechatUser)
        .where(sql`${wechatUser.uid}=${input.admission.uid} AND ${wechatUser.userType}='routine' AND ${wechatUser.isDel}=0`).limit(2).for('share');
      if (bindings.length!==1 || !id(bindings[0].openid,100)) throw new ValidateException('小程序付款缺少唯一的有效身份绑定，请重新授权或维护');
      binding=bindings[0]; witness=await readRoutineIdentityWitness(tx,env,{uid:input.admission.uid,bindingId:binding.id,appId,openid:binding.openid});
    }
    if (!witness) throw new ValidateException('小程序付款身份尚未证明属于当前 AppID，请重新授权；跨账号切换请先维护归属');
    const payload=intentPayload(env,{version:1,purpose:'routine_payment_initiation',uid:input.admission.uid,orderId:input.admission.orderId,orderDomain:input.admission.orderDomain,
      amountCents:input.amountCents,currency:'CNY',appId,merchantId,payerId:binding.openid,bindingId:binding.id,witness,publicSourceStamp:publicSource.stamp,
      providerBody:{appid:appId,mchid:merchantId,out_trade_no:input.orderNo,description,notify_url:notifyUrl,attach,
        amount:{total:input.amountCents,currency:'CNY'},payer:{openid:binding.openid}}});
    const createdAt=await now(tx),seal=signature(env,input.orderNo,'INITIATION',payload,createdAt);
    await registerPaymentReconciliationTx(tx,{provider:'wechat',profile:'routine',orderDomain:input.admission.orderDomain,
      orderNo:input.orderNo,expectedAmountCents:input.amountCents,initiated:true});
    await tx.execute(sql`INSERT INTO public.routine_payment_attempt(order_no,event_kind,payload,created_at,signature)
      VALUES(${input.orderNo},'INITIATION',${JSON.stringify(payload)}::jsonb,${createdAt},${seal})`);
    return {kind:'reserved',intent:Object.freeze({orderNo:input.orderNo,payload,createdAt,signature:seal})};
  });
}

/** Called only after a verified successful prepay response and local RSA sign.
 * Keep the captured account on late rotation. This is not payment settlement or
 * provider original-payer evidence; no query/callback/refund may treat it as so. */
export function recordRoutinePaymentReceipt(container:Container,env:RuntimeEnv,original:RoutinePaymentIntent,rawPacket:RoutinePaymentPacket):Promise<void> {
  const intent=Object.freeze({...original,payload:intentPayload(env,original.payload)}),signed=packet(rawPacket);
  return shortTx(container,async tx=>{
    await assertRoutinePaymentAttemptReady(tx);
    const rows=await tx.execute<EventRow>(sql`SELECT order_no,event_kind,payload,created_at,signature FROM public.routine_payment_attempt
      WHERE order_no=${intent.orderNo} AND event_kind='INITIATION'`);
    if (rows.length!==1 || verifyEvent(env,rows[0])!==intent.createdAt || rows[0].signature!==intent.signature
      || canonical(rows[0].payload)!==canonical(intent.payload)) throw unavailable();
    const createdAt=await now(tx),expiresAt=intent.createdAt+300;
    if (createdAt>expiresAt || Number(signed.timeStamp)<intent.createdAt-60 || Number(signed.timeStamp)>createdAt+60) throw recovery();
    const payload:ReceiptPayload={version:1,purpose:'routine_payment_prepay_receipt',intentSignature:intent.signature,expiresAt,packet:signed};
    const seal=signature(env,intent.orderNo,'PREPAY',payload,createdAt);
    await tx.execute(sql`INSERT INTO public.routine_payment_attempt(order_no,event_kind,payload,created_at,signature)
      VALUES(${intent.orderNo},'PREPAY',${JSON.stringify(payload)}::jsonb,${createdAt},${seal}) ON CONFLICT DO NOTHING`);
    const [saved]=await tx.execute<EventRow>(sql`SELECT order_no,event_kind,payload,created_at,signature FROM public.routine_payment_attempt
      WHERE order_no=${intent.orderNo} AND event_kind='PREPAY'`);
    if (!saved || verifyEvent(env,saved)<intent.createdAt || Number(saved.created_at)>expiresAt
      || canonical(saved.payload)!==canonical(payload)) throw unavailable();
  });
}

export function requireRoutinePaymentReady(result:Exclude<RoutinePaymentReplay,{kind:'new'}>):RoutinePaymentPacket {
  if (result.kind!=='ready' || !positive(result.expiresAt) || Math.floor(Date.now()/1000)>=result.expiresAt) throw recovery();
  return result.packet;
}
