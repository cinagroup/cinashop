import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { assertRoutineShippingReadTx, inspectRoutineShippingCatalog } from '@/migrations/routineShipping';
import { amountToCents } from './RefundGateway';
import { parseRoutineOriginalEvidence, type RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';
import { readRoutineApprovedUsesForShippingTx } from './RoutineApprovedPaymentAccount';
import { freezeShipping, routineShippingUnavailable, shippingInteger, shippingMac, shippingObject, shippingSame } from './RoutineShippingAccount';

type Signing=Pick<Env,'APP_KEY'>;
export interface RoutineShippingOriginalExpected {
 domain:'store_order'|'recharge'|'membership';rootId:number;buyerUid:number;orderNo:string;transactionId:string;totalAmount:number;
}
const originalSlot=Symbol('routine.shipping.original-transaction.v1');
export interface RoutineShippingOriginal {
 readonly evidence:RoutineOriginalEvidence;readonly relatedDigest:string;readonly approvedUseDigest:string;
 readonly [originalSlot]:DbClient;
}
function capture(input:RoutineShippingOriginalExpected):RoutineShippingOriginalExpected{
 const r=shippingObject(input,['domain','rootId','buyerUid','orderNo','transactionId','totalAmount']);
 if(r.domain!=='store_order'&&r.domain!=='recharge'&&r.domain!=='membership'||!shippingInteger(r.rootId)||!shippingInteger(r.buyerUid)||!shippingInteger(r.totalAmount)
  ||typeof r.orderNo!=='string'||!/^[A-Za-z0-9_-]{2,64}$/u.test(r.orderNo)||typeof r.transactionId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(r.transactionId))return routineShippingUnavailable();
 return{domain:r.domain,rootId:r.rootId,buyerUid:r.buyerUid,orderNo:r.orderNo,transactionId:r.transactionId,totalAmount:r.totalAmount};
}
export function assertRoutineShippingOriginalTx(tx:DbClient,value:RoutineShippingOriginal){
 const d=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,originalSlot):undefined;
 if(!d||!('value'in d)||d.value!==tx||!Object.isFrozen(value))return routineShippingUnavailable();return value;
}
/** The physical source is already stabilized by its business caller. This
 * bounded App-only reader takes no payment/refund/advisory lock, needs no refund
 * addon, and never promotes current config, INIT or a buyer binding to payer. */
export async function readRoutineShippingOriginalTx(tx:DbClient,env:Signing,input:RoutineShippingOriginalExpected):Promise<RoutineShippingOriginal>{
 env={APP_KEY:env.APP_KEY};const e=capture(input);
 try{
  if(!await assertRoutineShippingReadTx(tx))return routineShippingUnavailable();
  const shipping=await inspectRoutineShippingCatalog(tx),b=shipping.binding;
  const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx),account=await inspectRoutinePaymentAccountPolicyCatalog(tx);
  if(!shipping.ready||!b?.app||!original.ready||!account.ready||original.binding?.maintenanceOid!==b.maintenanceOid
   ||account.binding?.maintenanceOid!==b.maintenanceOid||original.binding?.appOid!==b.appOid||account.binding?.appOid!==b.appOid)return routineShippingUnavailable();
  const table=e.domain==='store_order'?'store_order':e.domain==='recharge'?'user_recharge':'other_order';
  const [resolution]=await tx.execute<{ready:boolean}>(sql`SELECT
   pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.'+table})
   AND pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
   AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
   AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use') AS ready`);
  if(resolution?.ready!==true)return routineShippingUnavailable();
  const rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
   WHERE order_no=${e.orderNo} OR transaction_id=${e.transactionId} ORDER BY evidence_id LIMIT 65`);
  if(!rows.length||rows.length>64||new TextEncoder().encode(JSON.stringify(rows)).byteLength>1048576)return routineShippingUnavailable();
  const decoded=Array.from(rows,r=>parseRoutineOriginalEvidence(env,r)),selected=decoded[0],facts=selected.payload.observation.facts;
  for(const row of decoded){
   const bound=row.payload.binding,f=row.payload.observation.facts;
   if(!shippingSame(f,facts)||bound.state!=='bound'||bound.local.domain!==e.domain||bound.local.orderId!==e.rootId||bound.local.buyerUid!==e.buyerUid
    ||bound.local.orderNo!==e.orderNo||bound.local.amountCents!==e.totalAmount||bound.local.tradeNo!==''&&bound.local.tradeNo!==e.transactionId
    ||bound.local.paid===1&&bound.local.payType!=='weixin'||f.orderNo!==e.orderNo||f.transactionId!==e.transactionId||f.amountCents!==e.totalAmount
    ||f.currency!=='CNY'||f.tradeState!=='SUCCESS'||f.tradeType!=='JSAPI'||!f.payerId)return routineShippingUnavailable();
  }
  // Closed internal identifiers only. Recharge and membership retain their real
  // physical domain instead of masquerading as a same-number product order.
  const price=e.domain==='recharge'?'price':'pay_price',payType=e.domain==='recharge'?'recharge_type':'pay_type';
  const current=await tx.execute<{uid:number;order_no:string;price:string;paid:number;pay_type:string;trade_no:string;shape:boolean}>(sql`
   SELECT uid,order_id AS order_no,${sql.raw(price)}::text AS price,paid,${sql.raw(payType)} AS pay_type,trade_no,
    ${sql.raw(e.domain==='store_order'?"pid IN (0,-1)":e.domain==='membership'?"type IN (0,1)":"true")} AS shape
   FROM ${sql.raw('public.'+table)} WHERE id=${e.rootId} LIMIT 2`);
  const root=current[0];
  if(current.length!==1||root.uid!==e.buyerUid||root.order_no!==e.orderNo||amountToCents(root.price)!==e.totalAmount||root.paid!==1||root.pay_type!=='weixin'
   ||root.trade_no!==e.transactionId||root.shape!==true)return routineShippingUnavailable();
  const uses=await readRoutineApprovedUsesForShippingTx(tx,env,decoded);
  const result={evidence:freezeShipping(selected),relatedDigest:shippingMac(env,'related-originals',decoded),approvedUseDigest:uses.digest};
  Object.defineProperty(result,originalSlot,{value:tx,enumerable:false,writable:false,configurable:false});return Object.freeze(result) as RoutineShippingOriginal;
 }catch{return routineShippingUnavailable();}
}
