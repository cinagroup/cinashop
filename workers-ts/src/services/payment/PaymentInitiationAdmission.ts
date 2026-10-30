import { eq, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase } from '@/models/schema';
import { assertRoutinePaymentAttemptReady } from '@/migrations/routinePaymentAttempt';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { lockPaymentReconciliationRegistrationTx, registerPaymentReconciliationTx } from './PaymentReconciliationRegistry';

type Case = typeof paymentReconciliationCase.$inferSelect;
export interface PaymentOrderAdmission {
  readonly uid:number;
  readonly orderId:number;
  readonly orderDomain:'store_order'|'recharge'|'membership';
  /** SQL only. Lock and revalidate the exact physical order, owner, amount,
   * unpaid state and domain conditions on this bound transaction. */
  readonly lockOrder:(bound:Container)=>Promise<void>;
}
export interface ExternalPaymentInitiation {
  readonly provider:'wechat'|'alipay';
  readonly profile:'wechat'|'app'|'alipay';
  readonly orderNo:string;
  readonly expectedAmountCents:number;
  readonly admission:PaymentOrderAdmission;
}
type Outcome={kind:'admitted';row:Case}|{kind:'conflict'}|{kind:'recovery'};
const positive=(n:unknown):n is number=>Number.isSafeInteger(n) && Number(n)>0 && Number(n)<=2147483647;
const unavailable=()=>new ServiceUnavailableException('付款准入尚未完整就绪');
const pending=()=>new ValidateException('支付已发起或存在待核对交易，请查询原交易；切换渠道前请先完成对账');
function snapshot(raw:ExternalPaymentInitiation):ExternalPaymentInitiation {
  const {provider,profile,orderNo,expectedAmountCents}=raw,{uid,orderId,orderDomain,lockOrder}=raw.admission;
  if ((provider==='wechat'?!['wechat','app'].includes(profile):provider!=='alipay'||profile!=='alipay')
    || typeof orderNo!=='string' || orderNo.length<2 || orderNo.length>64 || /[^A-Za-z0-9_-]/u.test(orderNo) || !positive(expectedAmountCents)
    || !positive(uid) || !positive(orderId) || !['store_order','recharge','membership'].includes(orderDomain)
    || typeof lockOrder!=='function') throw new ValidateException('付款准入参数无效');
  return Object.freeze({provider,profile,orderNo,expectedAmountCents,admission:Object.freeze({uid,orderId,orderDomain,lockOrder})});
}
function exact(row:Case,input:ExternalPaymentInitiation) {
  return row.profile===input.profile && row.orderDomain===input.admission.orderDomain
    && row.expectedAmountCents===input.expectedAmountCents && row.currency==='CNY';
}
function pristine(row:Case) {
  return row.status==='OPEN' && row.providerStatus==='UNKNOWN' && row.initiatedTime===0 && row.providerTransactionId===''
    && row.providerEventTime===0 && row.callbackEventId===null && row.attemptCount===0 && row.lastQueryTime===0
    && row.leaseUntil===0 && row.leaseToken==='' && row.lastErrorCode==='' && row.resolvedTime===0;
}
function pendingOwn(row:Case) {
  // Preserve each existing non-Mini provider's same-channel contract. This
  // helper arbitrates rails; it does not claim one HTTP attempt across every
  // provider or assign an original AppID/merchant to old same-channel orders.
  return ['OPEN','WAITING'].includes(row.status) && ['UNKNOWN','PENDING'].includes(row.providerStatus)
    && row.providerTransactionId==='' && row.providerEventTime===0 && row.callbackEventId===null
    && row.leaseUntil===0 && row.leaseToken==='' && row.resolvedTime===0;
}
async function evaluate(tx:DbClient,input:ExternalPaymentInitiation,replayOnly:boolean):Promise<Outcome> {
  // Shared Mini-attempt storage must be commissioned before new ordinary
  // external capabilities. Absence is not evidence that Mini never issued one.
  // Lock order agrees with Mini's source→witness→attempt→order→boundary chain.
  await assertRoutinePaymentAttemptReady(tx);
  await input.admission.lockOrder(createContainerFromDb(tx));
  await lockPaymentReconciliationRegistrationTx(tx,input.provider,input.orderNo);
  const cases=await tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.orderNo,input.orderNo))
    .orderBy(paymentReconciliationCase.provider).for('update');
  const own=cases.find(row=>row.provider===input.provider);
  if (own && !exact(own,input)) {
    if (!replayOnly) await registerPaymentReconciliationTx(tx,{provider:input.provider,profile:input.profile,
      orderDomain:input.admission.orderDomain,orderNo:input.orderNo,expectedAmountCents:input.expectedAmountCents,terminalConflict:true});
    return {kind:'conflict'};
  }
  const attempts=await tx.execute(sql`SELECT event_kind FROM public.routine_payment_attempt WHERE order_no=${input.orderNo} LIMIT 1`);
  // Presence only denies a switch. Unverified row contents never grant an
  // account, payer, payment result or permission to reissue after expiry.
  if (attempts.length) return {kind:'recovery'};
  const actions=cases.length ? await tx.select({id:paymentReconciliationAction.id}).from(paymentReconciliationAction)
    .where(inArray(paymentReconciliationAction.caseId,cases.map(row=>row.id))).limit(1):[];
  if (actions.length || cases.some(row=>row.provider!==input.provider && (!pristine(row)
    || row.expectedAmountCents!==input.expectedAmountCents || row.currency!=='CNY'
    || row.orderDomain!==input.admission.orderDomain))) return {kind:'recovery'};
  if (own && !pristine(own) && (!pendingOwn(own) || own.initiatedTime<=0)) return {kind:'recovery'};
  if (replayOnly) return own && own.initiatedTime>0 && pendingOwn(own) ? {kind:'admitted',row:own}:{kind:'recovery'};
  const row=await registerPaymentReconciliationTx(tx,{provider:input.provider,profile:input.profile,
    orderDomain:input.admission.orderDomain,orderNo:input.orderNo,expectedAmountCents:input.expectedAmountCents,initiated:true});
  return exact(row,input) && pendingOwn(row) && row.initiatedTime>0 ? {kind:'admitted',row}:{kind:'conflict'};
}
async function run(container:Container,raw:ExternalPaymentInitiation,replayOnly:boolean):Promise<Case> {
  const input=snapshot(raw);
  const outcome=await withTx(container,async tx=>{
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [context]=await tx.execute<{valid:boolean}>(sql`SELECT current_setting('transaction_isolation')='read committed'
      AND NOT current_setting('transaction_read_only')::boolean AS valid`);
    if (context?.valid!==true) throw unavailable();
    const result=await evaluate(tx,input,replayOnly);
    const [deadline]=await tx.execute<{valid:boolean}>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
    if (deadline?.valid!==true) throw unavailable();
    return result;
  });
  // A CONFLICT write above commits before an API rejection, preserving the
  // registry evidence. SQL/protocol failures still roll back the whole gate.
  if (outcome.kind==='conflict') throw new ValidateException('支付金额或渠道与已登记的交易不一致，请先人工对账');
  if (outcome.kind==='recovery') throw pending();
  return outcome.row;
}

/** After local readiness/crypto preflight; before HTTP or signed URL delivery. */
export function admitExternalPaymentInitiation(container:Container,input:ExternalPaymentInitiation):Promise<Case> {
  return run(container,input,false);
}
/** Revalidate an existing capability, without registering or signing another. */
export function assertExternalPaymentReplay(container:Container,input:ExternalPaymentInitiation):Promise<Case> {
  return run(container,input,true);
}
