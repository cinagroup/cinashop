/** Complete mixed provider universe for monetary owners and recovery.
 * The request/GET component is explicit; every outer observation must be
 * decoded before selecting a cause. This data never authorizes funds or I/O. */
import { Buffer } from 'node:buffer';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord, type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { parseRechargeRefundProviderHistory, RECHARGE_QUERY_HISTORY_LIMITS, type RechargeRefundProviderHistory } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackResult, type RechargeRefundCallbackResult } from './RechargeRefundCallbackCodec';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RechargeRefundCallbackProviderUniverse {
  readonly purpose: 'recharge-refund-callback-provider-universe-v1';
  readonly requestQueryHistory: RechargeRefundProviderHistory;
  readonly callbacks: readonly RechargeRefundCallbackResult[];
  readonly providerRefundIds: readonly string[];
  readonly disposition: 'unresolved' | 'terminal_evidence' | 'manual_review';
  readonly providerResultCount: number;
}
const fail = (): never => { throw new ServiceUnavailableException('充值退款回调完整历史存在缺失或矛盾，请保留原操作人工核对'); };
function rows(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return fail();
  const d = Object.getOwnPropertyDescriptors(input), length = Object.getOwnPropertyDescriptor(input, 'length');
  if (!length || !('value' in length) || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0
    || length.value > RECHARGE_QUERY_HISTORY_LIMITS.results || Reflect.ownKeys(d).length !== length.value + 1) return fail();
  return Array.from({ length: length.value }, (_, i) => {
    const field = d[String(i)]; if (!field?.enumerable || !('value' in field)) return fail(); return field.value;
  });
}

/** All rows are authenticated and counted BEFORE family partitioning. Every
 * partition is decoded; no local/unknown/malformed source is omitted. The
 * POST/GET decoder owns that family only; callback approval and original-first
 * bindings are independently decoded below. This is historical data, not a
 * physical read, dispatch capability or settlement basis. */
export function parseRechargeRefundCallbackProviderUniverse(env: Signing, expectedScope: RechargeRefundScope,
  rawOperation: unknown, rawAttempts: unknown, rawPolicies: unknown, rawResults: unknown): RechargeRefundCallbackProviderUniverse {
  const scope = captureRechargeRefundScope(expectedScope);
  const all = rows(rawResults).map(row => authenticateRechargeRefundRecord(env, scope, 'recharge_refund_result', row));
  let bytes = 2;
  const resultIds = new Set<string>(), callbackEvents = new Set<string>();
  const requestQuery: RechargeRefundRecord[] = [], callbackRows: RechargeRefundRecord[] = [];
  for (const row of all) {
    bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes > RECHARGE_QUERY_HISTORY_LIMITS.resultBytes || typeof row.result_id !== 'string' || resultIds.has(row.result_id)) return fail();
    resultIds.add(row.result_id);
    if (row.source === 'request' || row.source === 'query') requestQuery.push(row);
    else if (row.source === 'callback') {
      if (typeof row.source_id !== 'string' || callbackEvents.has(row.source_id)) return fail();
      callbackEvents.add(row.source_id); callbackRows.push(row);
    } else return fail();
  }
  const h = parseRechargeRefundProviderHistory(env, scope, rawOperation, rawAttempts, rawPolicies, requestQuery);
  const callbacks = callbackRows.map(row => {
    // The evidence is already a copied authenticated JSON object. The owning
    // decoder still checks the complete closed shape and exact approval row.
    if (!row.evidence || typeof row.evidence !== 'object' || Array.isArray(row.evidence)) return fail();
    const evidence = row.evidence as Record<string, unknown>;
    if (!evidence.approval || typeof evidence.approval !== 'object' || Array.isArray(evidence.approval)) return fail();
    const selected = evidence.approval as Record<string, unknown>;
    const approval = h.approvals.find(p => p.record_id === selected?.recordId);
    if (!approval) return fail();
    return parseRechargeRefundCallbackResult(env, scope, h.operation, h.first.attempt, h.firstApproval, approval, row);
  });
  const ids = new Set(h.providerRefundIds), successTimes = new Set<number>();
  let success = false, closed = false, firstPositiveAt = Number.POSITIVE_INFINITY, lastNotFoundAt = 0;
  for (const r of h.results) {
    const o = r.observation;
    if (o.providerRefundId) firstPositiveAt = Math.min(firstPositiveAt, o.observedAt);
    if (o.status === 'NOT_FOUND') lastNotFoundAt = Math.max(lastNotFoundAt, o.observedAt);
    if (o.status === 'SUCCESS') { success = true; successTimes.add(o.successTime); }
    closed ||= o.status === 'CLOSED';
  }
  for (const r of callbacks) {
    const o = r.observation;
    ids.add(o.providerRefundId); firstPositiveAt = Math.min(firstPositiveAt, o.receivedAt);
    if (o.status === 'SUCCESS') { success = true; successTimes.add(o.successTime); }
    closed ||= o.status === 'CLOSED';
  }
  // Receipt order cannot erase a contradiction. An older NOT_FOUND strictly
  // before all positive observations may be eventual visibility; equal/later
  // negatives, differing provider IDs/times or SUCCESS+CLOSED require review.
  const disposition = h.queryDisposition === 'manual_review' || ids.size > 1 || success && closed || successTimes.size > 1
    || ids.size > 0 && lastNotFoundAt >= firstPositiveAt ? 'manual_review'
    : success || closed ? 'terminal_evidence' : 'unresolved';
  return Object.freeze({ purpose: 'recharge-refund-callback-provider-universe-v1', requestQueryHistory: h,
    callbacks: Object.freeze(callbacks), providerRefundIds: Object.freeze([...ids].sort()), disposition, providerResultCount: all.length });
}
