import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { amountToCents } from './RefundGateway';
import { assertRoutineRefundReadInTx,inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { parseRoutineOriginalEvidence,type RoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';
import { readRoutineApprovedUsesForRefundTx } from './RoutineApprovedPaymentAccount';
import { routineEvidenceCanonical,routineEvidenceHmac } from './RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
export interface RoutineRefundOriginalExpected {
 rootOrderId:number;buyerUid:number;orderNo:string;transactionId:string;totalAmount:number;evidenceId?:string;
}
const originalSlot=Symbol('routine.refund.original-caller-transaction.v1');
export interface RoutineRefundOriginal {
 readonly evidence:RoutineOriginalEvidence;
 readonly relatedDigest:string;
 readonly approvedUseDigest:string;
 readonly [originalSlot]:DbClient;
}
const fail=():never=>{throw new ServiceUnavailableException('小程序退款原付款证据或实际订单归属尚未完整就绪');};
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown,max:number):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`,'u').test(v);
function expected(value:RoutineRefundOriginalExpected):RoutineRefundOriginalExpected {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const ds=Object.getOwnPropertyDescriptors(value),evidenceId=ds.evidenceId,
 keys=['rootOrderId','buyerUid','orderNo','transactionId','totalAmount',...(Object.hasOwn(ds,'evidenceId')?['evidenceId']:[])];
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k]))
  ||!positive(value.rootOrderId)||!positive(value.buyerUid)||!positive(value.totalAmount)
  ||!token(value.orderNo,64)||value.orderNo.length<2||!token(value.transactionId,100)
  ||Object.hasOwn(ds,'evidenceId')&&(!evidenceId||!('value'in evidenceId)||typeof evidenceId.value!=='string'||!/^[a-f0-9]{64}$/u.test(evidenceId.value)))return fail();
 return{rootOrderId:value.rootOrderId,buyerUid:value.buyerUid,orderNo:value.orderNo,transactionId:value.transactionId,totalAmount:value.totalAmount,
  ...(evidenceId?{evidenceId:evidenceId.value as string}:{})};
}
function freeze<T>(value:T):T {
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freeze(d.value);Object.freeze(value);}
 return value;
}
/** A plain JSON/scalar or a proof read on another connection/transaction cannot
 * select the Routine exception to the independent NativeApp restriction. */
export function assertRoutineRefundOriginalTx(tx:DbClient,value:RoutineRefundOriginal):RoutineRefundOriginal {
 const d=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,originalSlot):undefined;
 if(!d||!('value'in d)||d.value!==tx||!Object.isFrozen(value))return fail();
 return value;
}

/** Caller has already stabilized the physical root/child/refund in its declared
 * order, before any payment boundary. This reader acquires no advisory/row lock,
 * reads no current configuration, and never turns INIT or payer into buyer UID.
 * It is not approval, a CNSR claim or provider authority. */
export async function readRoutineRefundOriginalTx(tx:DbClient,env:Signing,input:RoutineRefundOriginalExpected):Promise<RoutineRefundOriginal|null> {
 env={APP_KEY:env.APP_KEY};const e=expected(input);
 try {
  if(!await assertRoutineRefundReadInTx(tx))return null;
  const refund=await inspectRoutineRefundCatalog(tx),b=refund.binding;
  const original=await inspectRoutineOriginalPaymentEvidenceCatalog(tx),account=await inspectRoutinePaymentAccountPolicyCatalog(tx);
  if(!refund.ready||!b?.app||!original.ready||!account.ready||original.binding?.maintenanceOid!==b.maintenanceOid
   ||account.binding?.maintenanceOid!==b.maintenanceOid||original.binding?.appOid!==b.appOid||account.binding?.appOid!==b.appOid)return fail();
  const[resolution]=await tx.execute<{ready:boolean}>(sql`SELECT
   pg_catalog.to_regclass('store_order')=pg_catalog.to_regclass('public.store_order')
   AND pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
   AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
   AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use') AS ready`);
  if(resolution?.ready!==true)return fail();
  const rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
   WHERE order_no=${e.orderNo} OR transaction_id=${e.transactionId} ORDER BY evidence_id LIMIT 65`);
  if(rows.length>64||new TextEncoder().encode(JSON.stringify(rows)).byteLength>1048576)return fail();
  if(!rows.length)return e.evidenceId?fail():null;
  const decoded=Array.from(rows,r=>parseRoutineOriginalEvidence(env,r));
  const selected=e.evidenceId?decoded.find(r=>r.evidence_id===e.evidenceId):decoded[0];if(!selected)return fail();
  const facts=selected.payload.observation.facts,canonical=routineEvidenceCanonical(facts);
  for(const row of decoded) {
   const binding=row.payload.binding,f=row.payload.observation.facts;
   if(routineEvidenceCanonical(f)!==canonical||binding.state!=='bound'||binding.local.domain!=='store_order'
    ||binding.local.orderId!==e.rootOrderId||binding.local.buyerUid!==e.buyerUid||binding.local.orderNo!==e.orderNo
    ||binding.local.amountCents!==e.totalAmount||binding.local.tradeNo!==''&&binding.local.tradeNo!==e.transactionId
    ||binding.local.paid===1&&binding.local.payType!=='weixin'||f.orderNo!==e.orderNo||f.transactionId!==e.transactionId
    ||f.amountCents!==e.totalAmount||f.currency!=='CNY'||f.tradeState!=='SUCCESS'||f.tradeType!=='JSAPI'||!f.payerId)return fail();
  }
  const current=await tx.execute<{id:number;uid:number;order_no:string;price:string;paid:number;pay_type:string;trade_no:string;pid:number}>(sql`
   SELECT id,uid,order_id AS order_no,pay_price::text AS price,paid,pay_type,trade_no,pid FROM public.store_order WHERE id=${e.rootOrderId} LIMIT 2`);
  const root=current[0];
  if(current.length!==1||root.uid!==e.buyerUid||root.order_no!==e.orderNo||amountToCents(root.price)!==e.totalAmount
   ||root.paid!==1||root.pay_type!=='weixin'||root.trade_no!==e.transactionId||root.pid!==0&&root.pid!==-1)return fail();
  const uses=await readRoutineApprovedUsesForRefundTx(tx,env,decoded);
  const result={evidence:freeze(selected),relatedDigest:routineEvidenceHmac(env,'refund-related-originals',decoded),approvedUseDigest:uses.digest};
  // Keep the caller transaction out of recursive freezing and public JSON.
  Object.defineProperty(result,originalSlot,{value:tx,enumerable:false,writable:false,configurable:false});
  return Object.freeze(result) as RoutineRefundOriginal;
 }catch{return fail();}
}
