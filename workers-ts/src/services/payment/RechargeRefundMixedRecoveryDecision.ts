/** Routing addresses only. Owning claim/economic transactions independently
 * reread all actual history. No transport, money or replay permit is returned. */
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundState } from './RechargeRefundAccounting';
import type { RechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
import { rechargeRefundQueryClaimProjection } from './RechargeRefundQueryClaimProjection';

export type RechargeRefundMixedRecoveryDecision =
  | { readonly action: 'not_requested'; readonly operationId: string }
  | { readonly action: 'wait'; readonly operationId: string; readonly nextQueryAt: number }
  | { readonly action: 'query'; readonly operationId: string }
  | { readonly action: 'settle'; readonly operationId: string; readonly source: 'request' | 'query' | 'callback';
    readonly status: 'SUCCESS' | 'CLOSED'; readonly providerResultId: string; readonly firstReceiptVersion?: 1 | 2 };
const fail = (): never => { throw new ServiceUnavailableException('充值退款完整恢复依据存在缺失或矛盾，请保留原操作人工核对'); };
/** Supplied authenticated data never proves physical rows or current grants.
 * Existing local history always retains its actual original cause family.
 * For a held operation a genuine terminal callback takes precedence over a
 * new GET, without rewriting it as a request/query result or creating an attempt. */
export function decideRechargeRefundMixedRecovery(universe: RechargeRefundCallbackProviderUniverse, rawState: unknown, now: number,
  local: RechargeRefundRecord | null = null): RechargeRefundMixedRecoveryDecision {
  const h = universe.requestQueryHistory, s = captureRechargeRefundState(rawState, h.operation);
  const id = String(h.operation.operation_id), n = h.totalAttempts, tail = h.attempts.at(-1);
  const latestObservation = Math.max(0, ...h.results.map(r => r.observation.observedAt), ...universe.callbacks.map(r => r.observation.receivedAt));
  if (!Number.isSafeInteger(now) || now < 1 || now > 2147483647 || !tail || now < Number(tail.created_at) - 1
    || now < latestObservation - 1 || s.attempt_count !== n || universe.disposition === 'manual_review') return fail();
  const causes = [...h.results, ...universe.callbacks];
  if (local) {
    const cause = causes.find(r => r.record.result_id === local.caused_by_result_id);
    const capture = local.source === 'local_settlement', release = local.source === 'local_release';
    if (!cause || (!capture && !release) || local.operation_id !== id || local.attempt_id !== null || local.status !== 'SUCCESS'
      || local.source_id !== (capture ? 'settle:' : 'release:') + id || s.last_result_id !== local.result_id
      || s.status !== (capture ? 'SUCCEEDED' : 'FAILED') || s.wallet_state !== (capture ? 'captured' : 'released')
      || s.version !== n + 1 || s.updated_at !== local.created_at || s.provider_refund_id !== cause.observation.providerRefundId
      || s.lease_id !== null || s.lease_until !== null || s.next_query_at !== null
      || cause.observation.status !== (capture ? 'SUCCESS' : 'CLOSED')
      || !['request', 'query', 'callback'].includes(String(cause.record.source))) return fail();
    // The original cause stays REQUEST. Route its receipt only by its actual
    // authenticated purpose/count; the owning codec still checks every field.
    let firstReceiptVersion: 1 | 2 | undefined;
    if (cause.record.source === 'request') {
      const purpose = (local.evidence as Record<string, unknown>).purpose;
      const expected = capture ? 'local-capture-v1' : 'closed-release-v1';
      if (n === 1 && purpose === 'recharge-refund-' + expected) firstReceiptVersion = 1;
      else if (n >= 2 && purpose === 'recharge-refund-counted-first-' + expected) firstReceiptVersion = 2;
      else return fail();
    }
    return Object.freeze({ action: 'settle', operationId: id, source: cause.record.source as 'request' | 'query' | 'callback',
      status: capture ? 'SUCCESS' : 'CLOSED', providerResultId: String(cause.record.result_id),
      ...(firstReceiptVersion ? { firstReceiptVersion } : {}) });
  }
  if (s.wallet_state !== 'held' || s.status !== (n === 1 ? 'SUBMITTING' : 'UNKNOWN') || s.version !== n
    || s.provider_refund_id !== null || s.last_result_id !== null || s.lease_id !== tail.lease_id
    || s.lease_until !== Number(tail.created_at) + 30 || s.next_query_at !== Number(tail.created_at) + 60
    || s.updated_at !== tail.created_at) return fail();
  if (universe.disposition === 'terminal_evidence') {
    const rank = (source: unknown) => source === 'callback' ? 0 : source === 'query' ? 1 : 2;
    const terminals = causes.filter(r => ['SUCCESS', 'CLOSED'].includes(r.observation.status))
      .sort((a, b) => rank(a.record.source) - rank(b.record.source)
        || Number(a.record.created_at) - Number(b.record.created_at) || String(a.record.result_id).localeCompare(String(b.record.result_id)));
    const cause = terminals[0];
    if (!cause || !['request', 'query', 'callback'].includes(String(cause.record.source))) return fail();
    return Object.freeze({ action: 'settle', operationId: id, source: cause.record.source as 'request' | 'query' | 'callback',
      status: cause.observation.status as 'SUCCESS' | 'CLOSED', providerResultId: String(cause.record.result_id),
      ...(cause.record.source === 'request' ? { firstReceiptVersion: n === 1 ? 1 as const : 2 as const } : {}) });
  }
  const projection = rechargeRefundQueryClaimProjection({ ...h, state: s });
  const next = Math.max(projection.nextQueryAt, projection.previousLeaseUntil);
  return now < next ? Object.freeze({ action: 'wait', operationId: id, nextQueryAt: next }) : Object.freeze({ action: 'query', operationId: id });
}
