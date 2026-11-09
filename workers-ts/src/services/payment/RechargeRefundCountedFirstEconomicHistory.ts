/** A terminal ORIGINAL POST after actual GET claims. The claim tail only
 * addresses the immutableN counter/lease; it is never the monetary cause. */
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import type { RechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundStateRow } from './RechargeRefundAccounting';
import type { RechargeRefundQueryAttempt } from './RechargeRefundQueryCodec';
import type { RechargeRefundProviderHistory } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundFirstProviderResult, type RechargeRefundFirstProviderResult } from './RechargeRefundFirstProviderResult';
import { parseRechargeRefundCallbackProviderUniverse, type RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
import { readRechargeRefundMixedProviderHistoryTx, rechargeRefundMixedHistoryInput } from './RechargeRefundMixedProviderHistory';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RechargeRefundCountedFirstEconomicHistoryInput {
  readonly operation: unknown; readonly attempts: unknown; readonly policies: unknown; readonly results: unknown; readonly providerResultId: unknown;
}
export type RechargeRefundCountedFirstEconomicBasis = RechargeRefundFirstProviderResult & Readonly<{
  claimTail: RechargeRefundQueryAttempt; history: RechargeRefundProviderHistory; providerUniverse: RechargeRefundCallbackProviderUniverse;
}>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款首次响应与后续尝试的完整结算依据暂不可核对，请保留原操作'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);

/** All provider families retain their own bounds/decoders. Signed caller rows
 * do not establish physical SQL facts or a permission to settle/send. */
export function parseRechargeRefundCountedFirstEconomicBasis(env: Signing, expectedScope: RechargeRefundScope,
  input: RechargeRefundCountedFirstEconomicHistoryInput): RechargeRefundCountedFirstEconomicBasis {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail();
  const d = Object.getOwnPropertyDescriptors(input), keys = ['operation', 'attempts', 'policies', 'results', 'providerResultId'];
  if (Reflect.ownKeys(d).length !== keys.length || keys.some(k => !d[k]?.enumerable || !('value' in d[k]))) return fail();
  const row = Object.fromEntries(keys.map(k => [k, d[k].value])); if (!uuid(row.providerResultId)) return fail();
  const scope = captureRechargeRefundScope(expectedScope), providerUniverse = parseRechargeRefundCallbackProviderUniverse(env, scope,
    row.operation, row.attempts, row.policies, row.results), h = providerUniverse.requestQueryHistory;
  const cause = h.results.find(r => r.record.result_id === row.providerResultId), claimTail = h.queries.at(-1);
  if (providerUniverse.disposition !== 'terminal_evidence' || h.totalAttempts < 2 || !claimTail || !cause
    || cause.record.source !== 'request' || cause.ordinal !== 1 || !['SUCCESS', 'CLOSED'].includes(cause.observation.status)
    || claimTail.payload.ordinal !== h.totalAttempts || claimTail.attempt.attempt_id !== h.attempts.at(-1)?.attempt_id
    || claimTail.attempt.signature !== h.attempts.at(-1)?.signature) return fail();
  const first = parseRechargeRefundFirstProviderResult(env, scope, h.operation, h.first.attempt, cause.record, h.firstApproval);
  return Object.freeze({ ...first, claimTail, history: h, providerUniverse });
}
export function rechargeRefundCountedFirstEconomicHistoryInput(h: RechargeRefundCountedFirstEconomicBasis): RechargeRefundCountedFirstEconomicHistoryInput {
  return { ...rechargeRefundMixedHistoryInput(h.providerUniverse), providerResultId: h.record.result_id };
}
export interface RechargeRefundCountedFirstEconomicPhysicalHistory {
  readonly basis: RechargeRefundCountedFirstEconomicBasis; readonly state: Readonly<RechargeRefundStateRow>; readonly local: RechargeRefundRecord | null;
}
export async function readRechargeRefundCountedFirstEconomicHistoryTx(tx: DbClient, env: Signing, role: RechargeRefundRuntimeRole,
  operationId: unknown, providerResultId: unknown, localResultId?: unknown,
  mode: 'read' | 'write' = 'write'): Promise<RechargeRefundCountedFirstEconomicPhysicalHistory> {
  if (!uuid(providerResultId)) return fail();
  const physical = await readRechargeRefundMixedProviderHistoryTx(tx, env, role, operationId, localResultId, mode);
  const basis = parseRechargeRefundCountedFirstEconomicBasis(env, physical.universe.requestQueryHistory.scope,
    { ...rechargeRefundMixedHistoryInput(physical.universe), providerResultId });
  return Object.freeze({ basis, state: physical.state, local: physical.local });
}
