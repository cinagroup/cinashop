import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineOriginalPaymentEvidenceCatalog } from '@/migrations/routineOriginalPaymentEvidence';
import { inspectRoutinePaymentAccountPolicyCatalog } from '@/migrations/routinePaymentAccountPolicy';
import { assertRoutineSubscriptionReadTx, inspectRoutineSubscriptionCatalog } from '@/migrations/routineSubscription';
import { amountToCents } from '@/services/payment/RefundGateway';
import { parseRoutineOriginalEvidence, type RoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { readRoutineApprovedUsesForSubscriptionTx } from '@/services/payment/RoutineApprovedPaymentAccount';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionInteger, subscriptionMac,
  subscriptionObject, subscriptionSame } from './RoutineSubscriptionAccount';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RoutineSubscriptionOriginalExpected {
  rootId: number; buyerUid: number; orderNo: string; transactionId: string; totalAmount: number;
}
export interface RoutineSubscriptionOriginal {
  readonly evidence: RoutineOriginalEvidence;
  readonly relatedDigest: string;
  readonly approvedUseDigest: string;
}
const owners = new WeakMap<RoutineSubscriptionOriginal, DbClient>();

function capture(input: RoutineSubscriptionOriginalExpected): RoutineSubscriptionOriginalExpected {
  const r = subscriptionObject(input, ['rootId','buyerUid','orderNo','transactionId','totalAmount']);
  if (!subscriptionInteger(r.rootId) || !subscriptionInteger(r.buyerUid) || !subscriptionInteger(r.totalAmount)
    || typeof r.orderNo !== 'string' || !/^[A-Za-z0-9_-]{2,64}$/u.test(r.orderNo)
    || typeof r.transactionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(r.transactionId))
    return routineSubscriptionUnavailable();
  return { rootId: r.rootId, buyerUid: r.buyerUid, orderNo: r.orderNo,
    transactionId: r.transactionId, totalAmount: r.totalAmount };
}

/** Source proof is local to the very transaction that read it. Cloned JSON,
 * object spreads and references from another transaction are not capabilities. */
export function assertRoutineSubscriptionOriginalTx(tx: DbClient, value: RoutineSubscriptionOriginal): RoutineSubscriptionOriginal {
  if (!value || typeof value !== 'object' || owners.get(value) !== tx || !Object.isFrozen(value))
    return routineSubscriptionUnavailable();
  return value;
}

/** The caller already stabilized the physical product payment root. This
 * App-only reader takes no payment/refund/business/advisory lock, reads no
 * current configuration and grants no receiver, subscription or provider use.
 * The payer in the original remains a payment fact, never a notification target. */
export async function readRoutineSubscriptionOriginalTx(tx: DbClient, env: Signing,
  input: RoutineSubscriptionOriginalExpected): Promise<RoutineSubscriptionOriginal> {
  return readOriginal(tx, env, input, 'store_order');
}
/** Separate membership entry: identical provenance rules, explicitly other_order. */
export async function readRoutineSubscriptionMembershipOriginalTx(tx: DbClient, env: Signing,
  input: RoutineSubscriptionOriginalExpected): Promise<RoutineSubscriptionOriginal> {
  return readOriginal(tx, env, input, 'membership');
}
async function readOriginal(tx: DbClient, env: Signing, input: RoutineSubscriptionOriginalExpected,
  domain: 'store_order' | 'membership'): Promise<RoutineSubscriptionOriginal> {
  env = { APP_KEY: env.APP_KEY }; const e = capture(input);
  const table = domain === 'membership' ? 'other_order' : 'store_order';
  try {
    if (!await assertRoutineSubscriptionReadTx(tx)) return routineSubscriptionUnavailable();
    const subscription = await inspectRoutineSubscriptionCatalog(tx), b = subscription.binding;
    const original = await inspectRoutineOriginalPaymentEvidenceCatalog(tx), account = await inspectRoutinePaymentAccountPolicyCatalog(tx);
    const o = original.binding, a = account.binding;
    if (!subscription.ready || !b?.app || !b.appOid || !original.ready || !account.ready || !o || !a
      || o.maintenance !== b.maintenance || o.maintenanceOid !== b.maintenanceOid
      || a.maintenance !== b.maintenance || a.maintenanceOid !== b.maintenanceOid
      || o.app !== b.app || o.appOid !== b.appOid || a.app !== b.app || a.appOid !== b.appOid)
      return routineSubscriptionUnavailable();
    const [resolution] = await tx.execute<{ ready: boolean }>(sql`SELECT
      pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table})
      AND pg_catalog.to_regclass('routine_subscription_account_policy')=pg_catalog.to_regclass('public.routine_subscription_account_policy')
      AND pg_catalog.to_regclass('routine_original_payment_evidence')=pg_catalog.to_regclass('public.routine_original_payment_evidence')
      AND pg_catalog.to_regclass('routine_payment_account_policy')=pg_catalog.to_regclass('public.routine_payment_account_policy')
      AND pg_catalog.to_regclass('routine_payment_account_use')=pg_catalog.to_regclass('public.routine_payment_account_use') AS ready`);
    if (resolution?.ready !== true) return routineSubscriptionUnavailable();
    const rows = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence
      WHERE order_no=${e.orderNo} OR transaction_id=${e.transactionId} ORDER BY evidence_id LIMIT 65`);
    if (!rows.length || rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1048576)
      return routineSubscriptionUnavailable();
    const decoded = Array.from(rows, r => parseRoutineOriginalEvidence(env, r));
    const selected = decoded[0], facts = selected.payload.observation.facts;
    for (const row of decoded) {
      const bound = row.payload.binding, f = row.payload.observation.facts;
      if (!subscriptionSame(f, facts) || bound.state !== 'bound' || bound.local.domain !== domain
        || bound.local.orderId !== e.rootId || bound.local.buyerUid !== e.buyerUid
        || bound.local.orderNo !== e.orderNo || bound.local.amountCents !== e.totalAmount
        || bound.local.tradeNo !== '' && bound.local.tradeNo !== e.transactionId
        || bound.local.paid === 1 && bound.local.payType !== 'weixin'
        || f.orderNo !== e.orderNo || f.transactionId !== e.transactionId || f.amountCents !== e.totalAmount
        || f.currency !== 'CNY' || f.tradeState !== 'SUCCESS' || f.tradeType !== 'JSAPI' || !f.payerId)
        return routineSubscriptionUnavailable();
    }
    const current = await tx.execute<{ uid: number; order_no: string; price: string; paid: number; pay_type: string; trade_no: string; shape: boolean }>(sql`
      SELECT uid,order_id AS order_no,pay_price::text AS price,paid,pay_type,trade_no,
      ${sql.raw(domain === 'membership' ? 'type=1 AND is_free=0 AND is_del=0' : 'pid IN (0,-1)')} AS shape
      FROM ${sql.raw('public.' + table)} WHERE id=${e.rootId} LIMIT 2`);
    const root = current[0];
    if (current.length !== 1 || root.uid !== e.buyerUid || root.order_no !== e.orderNo || amountToCents(root.price) !== e.totalAmount
      || root.paid !== 1 || root.pay_type !== 'weixin' || root.trade_no !== e.transactionId || root.shape !== true)
      return routineSubscriptionUnavailable();
    const uses = await readRoutineApprovedUsesForSubscriptionTx(tx, env, decoded);
    const result = Object.freeze({ evidence: freezeSubscription(selected),
      relatedDigest: subscriptionMac(env, 'related-originals', decoded), approvedUseDigest: uses.digest });
    owners.set(result, tx); return result;
  } catch (error) {
    // Legacy readers retain their existing unavailable projection. A new
    // membership reader must not disguise SQL/lock failures as absent evidence.
    if (domain === 'store_order') return routineSubscriptionUnavailable();
    throw error;
  }
}
