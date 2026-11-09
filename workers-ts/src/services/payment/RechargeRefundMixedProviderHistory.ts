/** Complete physical request/query/callback history. This is data, never a
 * dispatch token, local-result permit, funds proof or no-late-result promise. */
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord, type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundState, type RechargeRefundStateRow } from './RechargeRefundAccounting';
import { parseRechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { RECHARGE_QUERY_HISTORY_LIMITS } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackProviderUniverse, type RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';

type Signing = Pick<Env, 'APP_KEY'>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款完整渠道历史暂不可核对，请保留原操作人工处理'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export interface RechargeRefundMixedPhysicalHistory {
  readonly universe: RechargeRefundCallbackProviderUniverse;
  readonly state: Readonly<RechargeRefundStateRow>;
  readonly local: RechargeRefundRecord | null;
}
/** Preserve ALL provider families when a dedicated monetary decoder rereads
 * the basis. Selecting a cause never removes the other observations. */
export function rechargeRefundMixedHistoryInput(h: RechargeRefundCallbackProviderUniverse) {
  const q = h.requestQueryHistory;
  return { operation: q.operation, attempts: q.attempts, policies: q.approvals,
    results: [...q.results.map(r => r.record), ...h.callbacks.map(r => r.record)] };
}
/** Writers hold their own operation/state locks; RR/RO readers see their one
 * actual snapshot. Only one explicitly named local UUID can be separated,
 * and only if the actual terminal state names it. Its owning codec and real
 * financial artifacts still require separate validation. Extra local, unknown
 * or malformed rows remain in the provider batch and reject. An already issued
 * provider observation can append after this read. */
export async function readRechargeRefundMixedProviderHistoryTx(tx: DbClient, env: Signing, role: RechargeRefundRuntimeRole,
  operationId: unknown, localResultId?: unknown, mode: 'read' | 'write' = 'write'): Promise<RechargeRefundMixedPhysicalHistory> {
  if (Object.hasOwn(tx, '$client') || !uuid(operationId) || localResultId !== undefined && !uuid(localResultId)
    || !['read', 'write'].includes(mode)) return fail();
  const scope = await assertRechargeRoutineRefundAccountRuntimeTx(tx, role, mode);
  const [context] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_setting('role')='none' AS ready`);
  if (context?.ready !== true) return fail();
  const operations = await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if (operations.length !== 1) return fail();
  const operation = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', operations[0]);
  const attempts = await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${operationId}::uuid
    ORDER BY ordinal LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.attempts + 1}`);
  if (!attempts.length) return fail();
  const first = parseRechargeRefundFirstRequest(env, scope, operation, attempts[0]);
  const policies = await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy
    WHERE account_id=${first.payload.approval.accountId} ORDER BY revision LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.policies + 1}`);
  const states = await tx.execute(sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if (states.length !== 1) return fail();
  const state = captureRechargeRefundState(states[0], operation);
  if (localResultId !== undefined && (state.last_result_id !== localResultId
    || !['SUCCEEDED', 'FAILED'].includes(state.status) || !['captured', 'released'].includes(state.wallet_state))) return fail();
  const limit = RECHARGE_QUERY_HISTORY_LIMITS.results + (localResultId === undefined ? 0 : 1);
  const raw = await tx.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid
    ORDER BY created_at,result_id LIMIT ${limit + 1}`);
  if (raw.length > limit) return fail();
  const all = Array.from(raw, row => authenticateRechargeRefundRecord(env, scope, 'recharge_refund_result', row));
  let local: RechargeRefundRecord | null = null; const provider: RechargeRefundRecord[] = [];
  for (const row of all) {
    if (localResultId !== undefined && row.result_id === localResultId) {
      if (local || !['local_settlement', 'local_release'].includes(String(row.source))) return fail(); local = row;
    } else provider.push(row);
  }
  if (localResultId !== undefined && !local) return fail();
  const universe = parseRechargeRefundCallbackProviderUniverse(env, scope, operation, Array.from(attempts), Array.from(policies), provider);
  return Object.freeze({ universe, state, local });
}
