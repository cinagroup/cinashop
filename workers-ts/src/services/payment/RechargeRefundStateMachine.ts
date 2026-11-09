import { ServiceUnavailableException } from '@/utils/errors';

export type RechargeRefundStatus = 'RESERVED' | 'SUBMITTING' | 'PROCESSING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
export type RechargeRefundWalletState = 'held' | 'captured' | 'released';
export type RechargeRefundProviderStatus = 'SUCCESS' | 'PROCESSING' | 'CLOSED' | 'ABNORMAL' | 'FAILED' | 'UNKNOWN' | 'NOT_FOUND';
export interface RechargeRefundProjection {
  readonly status: RechargeRefundStatus;
  readonly walletState: RechargeRefundWalletState;
}
export interface RechargeRefundVerifiedOutcome {
  readonly source: 'request' | 'query' | 'callback';
  readonly status: RechargeRefundProviderStatus;
  /** Only the completed, sole POST's authenticated definitive rejection may
   * set this flag. A query NOT_FOUND, exception or HTTP status never can. */
  readonly definitiveRequestRejection: boolean;
}
export interface RechargeRefundTransition extends RechargeRefundProjection {
  readonly walletAction: 'none' | 'capture' | 'release';
}
const unavailable = (): never => { throw new ServiceUnavailableException('充值退款资金状态需要人工核对'); };

function projection(value: RechargeRefundProjection): void {
  if (!value || !['RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED'].includes(value.status)
    || value.walletState !== (value.status === 'SUCCEEDED' ? 'captured' : value.status === 'FAILED' ? 'released' : 'held')) unavailable();
}

/** Pure financial transition only. The caller must authenticate the immutable
 * provider observation, original operation/amount/refund number and SQL actor
 * BEFORE invoking this function. This is not an evidence decoder or a permit
 * to credit/debit; those writes must share the CAS/evidence transaction. */
export function rechargeRefundTransition(current: RechargeRefundProjection,
  outcome: RechargeRefundVerifiedOutcome): Readonly<RechargeRefundTransition> {
  projection(current);
  if (!outcome || !['request','query','callback'].includes(outcome.source)
    || !['SUCCESS','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND'].includes(outcome.status)
    || typeof outcome.definitiveRequestRejection !== 'boolean'
    || outcome.definitiveRequestRejection && (outcome.source !== 'request' || outcome.status !== 'FAILED')) unavailable();
  if (current.status === 'SUCCEEDED') return Object.freeze({ ...current, walletAction: 'none' });
  if (current.status === 'FAILED') {
    // Contradictory later success is not permission to debit a user again.
    if (outcome.status === 'SUCCESS' || outcome.status === 'PROCESSING') unavailable();
    return Object.freeze({ ...current, walletAction: 'none' });
  }
  if (outcome.status === 'SUCCESS') return Object.freeze({ status: 'SUCCEEDED', walletState: 'captured', walletAction: 'capture' });
  if (outcome.status === 'CLOSED' || outcome.definitiveRequestRejection) {
    return Object.freeze({ status: 'FAILED', walletState: 'released', walletAction: 'release' });
  }
  if (outcome.status === 'PROCESSING') return Object.freeze({ status: 'PROCESSING', walletState: 'held', walletAction: 'none' });
  // NOT_FOUND does not fence a delayed POST; ABNORMAL is not permanent CLOSED.
  // Unclassified errors/rejections retain the money reservation for resolution.
  return Object.freeze({ status: 'UNKNOWN', walletState: 'held', walletAction: 'none' });
}

export interface RechargeRefundDispatchClock extends RechargeRefundProjection {
  readonly requestAttempts: number;
  readonly leaseUntil: number;
  readonly nextQueryAt: number;
}

/** One POST for the lifetime of an operation. An expired lease can permit a
 * bounded query, never a second POST; a missing result is treated as unknown. */
export function rechargeRefundNextAction(value: RechargeRefundDispatchClock,
  now: number): 'request' | 'query' | 'wait' | 'none' {
  projection(value);
  if (![value.requestAttempts, value.leaseUntil, value.nextQueryAt, now].every(Number.isSafeInteger)
    || value.requestAttempts < 0 || value.requestAttempts > 1 || value.leaseUntil < 0 || value.nextQueryAt < 0 || now <= 0) unavailable();
  if (value.status === 'SUCCEEDED' || value.status === 'FAILED') return 'none';
  if (value.requestAttempts === 0) {
    if (value.status !== 'RESERVED' || value.leaseUntil !== 0) unavailable();
    return 'request';
  }
  if (value.leaseUntil > now || value.nextQueryAt > now) return 'wait';
  return 'query';
}

/** The SQL caller must hold the operation/state locks, reauthorize its admin
 * and prove NOT EXISTS any immutable request attempt in that same transaction.
 * Recording local_cancel and local_release plus returning the reservation to
 * the wallet must share the FAILED CAS. This is not a provider observation. */
export function rechargeRefundCancelBeforePost(value: RechargeRefundDispatchClock): Readonly<RechargeRefundTransition> {
  projection(value);
  if (value.status !== 'RESERVED' || value.walletState !== 'held' || value.requestAttempts !== 0
    || value.leaseUntil !== 0 || value.nextQueryAt !== 0) unavailable();
  return Object.freeze({ status: 'FAILED', walletState: 'released', walletAction: 'release' });
}
