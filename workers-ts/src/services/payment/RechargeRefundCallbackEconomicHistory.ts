/** Complete callback money cause, not a funds permit or transport token.
 * Callback is never relabelled as an original POST or a claimed GET. */
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import type { RechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundStateRow } from './RechargeRefundAccounting';
import type { RechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { parseRechargeRefundCallbackProviderUniverse, type RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
import type { RechargeRefundCallbackResult, RechargeRefundCallbackObservation } from './RechargeRefundCallbackCodec';
import { readRechargeRefundMixedProviderHistoryTx, rechargeRefundMixedHistoryInput } from './RechargeRefundMixedProviderHistory';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RechargeRefundCallbackEconomicHistoryInput {
  readonly operation: unknown; readonly attempts: unknown; readonly policies: unknown; readonly results: unknown; readonly providerResultId: unknown;
}
export interface RechargeRefundCallbackEconomicBasis {
  readonly scope: RechargeRefundScope; readonly operation: RechargeRefundRecord;
  readonly attempt: RechargeRefundRecord; readonly request: RechargeRefundFirstRequest['payload'];
  readonly callback: RechargeRefundCallbackResult; readonly record: RechargeRefundRecord; readonly observation: RechargeRefundCallbackObservation;
  readonly history: RechargeRefundCallbackProviderUniverse;
}
const fail = (): never => { throw new ServiceUnavailableException('充值退款回调结算完整历史暂不可核对，请保留原操作'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);

/** Independent per-row/batch bounds; never copy the combined history through
 * the16KiB single-journal copier. Supplied signed rows do not prove SQL facts. */
export function parseRechargeRefundCallbackEconomicBasis(env: Signing, expectedScope: RechargeRefundScope,
  input: RechargeRefundCallbackEconomicHistoryInput): RechargeRefundCallbackEconomicBasis {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  const d = Object.getOwnPropertyDescriptors(input), keys = ['operation', 'attempts', 'policies', 'results', 'providerResultId'];
  if (Reflect.ownKeys(d).length !== keys.length || keys.some(k => !d[k]?.enumerable || !('value' in d[k]))) return fail();
  const r = Object.fromEntries(keys.map(k => [k, d[k].value])); if (!uuid(r.providerResultId)) return fail();
  const scope = captureRechargeRefundScope(expectedScope);
  const h = parseRechargeRefundCallbackProviderUniverse(env, scope, r.operation, r.attempts, r.policies, r.results);
  const callback = h.callbacks.find(p => p.record.result_id === r.providerResultId), q = h.requestQueryHistory;
  if (h.disposition !== 'terminal_evidence' || !callback || !['SUCCESS', 'CLOSED'].includes(callback.observation.status)) return fail();
  return Object.freeze({ scope, operation: q.operation, attempt: q.first.attempt, request: q.first.payload,
    callback, record: callback.record, observation: callback.observation, history: h });
}
export function rechargeRefundCallbackEconomicHistoryInput(h: RechargeRefundCallbackEconomicBasis): RechargeRefundCallbackEconomicHistoryInput {
  return { operation: h.operation, attempts: h.history.requestQueryHistory.attempts, policies: h.history.requestQueryHistory.approvals,
    results: [...h.history.requestQueryHistory.results.map(p => p.record), ...h.history.callbacks.map(p => p.record)], providerResultId: h.record.result_id };
}
/** Derive only immutable lease/count addresses. No mutable state is invented
 * merely to make an old query projection accept a callback. */
export function rechargeRefundCallbackClaimProjection(h: RechargeRefundCallbackEconomicBasis) {
  const q = h.history.requestQueryHistory, n = q.totalAttempts, tail = q.attempts.at(-1);
  if (!tail || n < 1 || n !== q.attempts.length || !uuid(tail.lease_id)
    || !Number.isSafeInteger(tail.created_at) || Number(tail.created_at) < 1 || Number(tail.created_at) > 2_147_483_587) return fail();
  return Object.freeze({ totalAttempts: n, beforeVersion: n, status: n === 1 ? 'SUBMITTING' as const : 'UNKNOWN' as const,
    leaseId: tail.lease_id, issuedAt: Number(tail.created_at), leaseUntil: Number(tail.created_at) + 30, nextQueryAt: Number(tail.created_at) + 60 });
}
export interface RechargeRefundCallbackEconomicPhysicalHistory {
  readonly basis: RechargeRefundCallbackEconomicBasis; readonly state: Readonly<RechargeRefundStateRow>; readonly local: RechargeRefundRecord | null;
}
/** The selected callback is only an address into a newly collected complete
 * physical universe. Its own monetary codec and artifacts still bind the cause. */
export async function readRechargeRefundCallbackEconomicHistoryTx(tx: DbClient, env: Signing, role: RechargeRefundRuntimeRole,
  operationId: unknown, providerResultId: unknown, localResultId?: unknown,
  mode: 'read' | 'write' = 'write'): Promise<RechargeRefundCallbackEconomicPhysicalHistory> {
  if (!uuid(providerResultId)) return fail();
  const physical = await readRechargeRefundMixedProviderHistoryTx(tx, env, role, operationId, localResultId, mode);
  const basis = parseRechargeRefundCallbackEconomicBasis(env, physical.universe.requestQueryHistory.scope,
    { ...rechargeRefundMixedHistoryInput(physical.universe), providerResultId });
  return Object.freeze({ basis, state: physical.state, local: physical.local });
}
