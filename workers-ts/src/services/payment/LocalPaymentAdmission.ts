import { eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase } from '@/models/schema';
import { assertRoutinePaymentAttemptReady } from '@/migrations/routinePaymentAttempt';
import { lockLocalPaymentCasesTx } from '@/migrations/localPaymentCaseLock';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';

type Case = typeof paymentReconciliationCase.$inferSelect;
export interface LocalPaymentAdmission {
  readonly orderNo: string;
  readonly orderDomain: 'store_order' | 'membership';
  readonly expectedAmountCents: number;
}

/** Acquire this at the outer local-payment transaction, before business row,
 * settlement or case table locks. A savepoint cannot repair an outer lock
 * inversion. No storage read here: an already committed receipt/paid replay
 * does not become a new financial mutation when the new ledger is unavailable. */
export async function lockLocalPaymentAdmissionTx(tx: DbClient): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('本地付款准入需要调用方事务');
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [gate] = await tx.execute<{locked:boolean}>(sql`SELECT pg_try_advisory_xact_lock_shared(731670,0) AS locked`);
  if (gate?.locked !== true) throw new ServiceUnavailableException('付款记录正在维护，请查询原交易后重试');
}

function pristine(row: Case, input: LocalPaymentAdmission): boolean {
  return (row.provider === 'wechat' && ['wechat', 'routine', 'app'].includes(row.profile)
      || row.provider === 'alipay' && row.profile === 'alipay')
    && row.orderDomain === input.orderDomain && row.expectedAmountCents === input.expectedAmountCents && row.currency === 'CNY'
    && row.status === 'OPEN' && row.providerStatus === 'UNKNOWN' && row.initiatedTime === 0
    && row.providerTransactionId === '' && row.providerEventTime === 0 && row.callbackEventId === null
    && row.attemptCount === 0 && row.lastQueryTime === 0 && row.leaseUntil === 0 && row.leaseToken === ''
    && row.lastErrorCode === '' && row.resolvedTime === 0;
}

/** SQL only, after the exact live business order is locked and checked, before
 * balance/integral debit, rights, paid status or outbox writes. This is denial
 * of a new local settlement, never a provider result/ownership assertion. */
export async function assertLocalPaymentAdmissionTx(tx: DbClient, raw: LocalPaymentAdmission): Promise<void> {
  const {orderNo, orderDomain, expectedAmountCents} = raw;
  const input = Object.freeze({orderNo, orderDomain, expectedAmountCents});
  if (typeof orderNo !== 'string' || orderNo.length < 1 || orderNo.length > 64 || /[^A-Za-z0-9_-]/u.test(orderNo)
    || !['store_order', 'membership'].includes(orderDomain) || !Number.isSafeInteger(expectedAmountCents)
    || expectedAmountCents < 0 || expectedAmountCents > 2_147_483_647) throw new ValidateException('本地付款准入参数无效');
  const [context] = await tx.execute<{valid:boolean}>(sql`SELECT current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=731670 AND objid=0 AND objsubid=2 AND mode='ShareLock' AND granted) AS valid`);
  if (context?.valid !== true) throw new ServiceUnavailableException('本地付款准入事务未就绪');
  await assertRoutinePaymentAttemptReady(tx);
  await lockStoreOrderPaymentBoundary(tx, orderNo);
  const [caseAuthority] = await tx.execute<{update:boolean}>(sql`SELECT
    pg_catalog.has_any_column_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS update`);
  // Existing approved case writers retain their ordinary row locks. A
  // SELECT-only local principal needs the separately installed, exact audited
  // lock capability; it never receives case UPDATE just to obtain a lock.
  if (caseAuthority?.update !== true) await lockLocalPaymentCasesTx(tx, orderNo);
  const query = tx.select().from(paymentReconciliationCase)
    .where(eq(paymentReconciliationCase.orderNo, orderNo)).orderBy(paymentReconciliationCase.provider).limit(3);
  const cases = caseAuthority?.update === true ? await query.for('update') : await query;
  const attempts = await tx.execute(sql`SELECT event_kind FROM public.routine_payment_attempt WHERE order_no=${orderNo} LIMIT 1`);
  const actions = cases.length ? await tx.select({id:paymentReconciliationAction.id}).from(paymentReconciliationAction)
    .where(inArray(paymentReconciliationAction.caseId, cases.map(row => row.id))).limit(1) : [];
  if (attempts.length || cases.length > 2 || actions.length || cases.some(row => !pristine(row, input))) {
    throw new ValidateException('外部支付已发起或存在待核对交易，请查询原交易；确认原交易前不能另行扣款或确认收款');
  }
  const [deadline] = await tx.execute<{valid:boolean}>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
  if (deadline?.valid !== true) throw new ServiceUnavailableException('本地付款准入已超时，请核对原交易');
}
