/** Actual-App immutable first-request/policy point closure. This reader does
 * not prove the complete provider/economic universe or grant funds authority.
 * It deliberately ignores current wallet/source/state/credential projections:
 * their later failure must not erase an already verified external observation. */
import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord } from './RechargeRefundLedger';
import { parseRechargeRefundFirstRequest, rechargeRefundTransportApproval } from './RechargeRefundFirstRequest';
import { parseRechargeRoutineRefundAccountJournal, requireRechargeRoutineRefundPurpose,
  validateRechargeRoutineRefundAccountHistory } from './RechargeRoutineRefundAccountCodec';
import { RECHARGE_QUERY_HISTORY_LIMITS } from './RechargeRefundQueryHistoryCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

const fail = (): never => { throw new ServiceUnavailableException('充值退款回调原请求或批准历史暂不可核对'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export async function readRechargeRefundCallbackPointTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>,
  operationId: unknown, mode: 'read' | 'write' = 'read') {
  if (Object.hasOwn(tx, '$client') || !uuid(operationId) || !['read', 'write'].includes(mode)) return fail();
  const scope = await assertRechargeRoutineRefundAccountRuntimeTx(tx, 'app', mode);
  const [context] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_setting('role')='none' AS ready`);
  if (context?.ready !== true) return fail();
  const operations = await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if (operations.length !== 1) return fail();
  const operation = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', operations[0]);
  const attempts = await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt
    WHERE operation_id=${operationId}::uuid AND ordinal=1 LIMIT 2`);
  if (attempts.length !== 1) return fail();
  const first = parseRechargeRefundFirstRequest(env, scope, operation, attempts[0]);
  const raw = await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy
    WHERE account_id=${first.payload.approval.accountId} ORDER BY revision LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.policies + 1}`);
  if (raw.length > RECHARGE_QUERY_HISTORY_LIMITS.policies) return fail();
  const policies = Array.from(raw, row => parseRechargeRoutineRefundAccountJournal(env, scope, row));
  if (Buffer.byteLength(JSON.stringify(policies), 'utf8') > RECHARGE_QUERY_HISTORY_LIMITS.policyBytes) return fail();
  validateRechargeRoutineRefundAccountHistory(policies, first.payload.approval.accountId);
  if (new Set(policies.map(p => p.record_id)).size !== policies.length) return fail();
  const firstApproval = policies.find(p => p.record_id === first.payload.approval.recordId);
  if (!firstApproval || firstApproval.created_at > first.payload.issuedAt
    || routineEvidenceCanonical(rechargeRefundTransportApproval(firstApproval)) !== routineEvidenceCanonical(first.payload.approval)) return fail();
  requireRechargeRoutineRefundPurpose(firstApproval, 'refund_request', first.payload.issuedAt);
  return Object.freeze({ scope, operation, first, firstApproval, policies: Object.freeze(policies) });
}
export type RechargeRefundCallbackPoint = Awaited<ReturnType<typeof readRechargeRefundCallbackPointTx>>;
