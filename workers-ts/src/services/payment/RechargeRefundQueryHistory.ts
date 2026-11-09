/** Self-collected physical query history on actual App/Admin/Financial LOGIN.
 * No caller ready data, credential trial, query capability, lease or funds write. */
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundJson } from './RechargeRefundJournalCodec';
import { parseRechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { parseRechargeRefundQueryAttempt,type RechargeRefundQueryAttempt } from './RechargeRefundQueryCodec';
import { parseRechargeRefundQueryHistory,RECHARGE_QUERY_HISTORY_LIMITS,type RechargeRefundQueryHistory } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRoutineRefundAccountJournal,validateRechargeRoutineRefundAccountHistory } from './RechargeRoutineRefundAccountCodec';
import { readRechargeRefundMixedProviderHistoryTx } from './RechargeRefundMixedProviderHistory';
import type { RechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
export interface RechargeRefundMixedQueryHistory extends RechargeRefundQueryHistory { readonly providerUniverse:RechargeRefundCallbackProviderUniverse; }

type Signing=Pick<Env,'APP_KEY'>;
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询物理历史暂不可核对，请保留原操作');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
async function runtime(tx:DbClient,role:RechargeRefundRuntimeRole,mode:'read'|'write'){
 const scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,role,mode);
 const [context]=await tx.execute<{actual_login:boolean}>(sql`SELECT pg_catalog.current_setting('role')='none' AS actual_login`);
 if(context?.actual_login!==true)return fail();return scope;
}

/** RR/RO mode observes one actual snapshot. RC/RW mode is read-only work for
 * an owning author, which must hold its own operation/state locks. A result
 * writer may append after this SELECT: this is not a no-late-result guarantee. */
export async function readRechargeRefundQueryHistoryTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,
 operationId:unknown,mode:'read'|'write'='read'):Promise<RechargeRefundMixedQueryHistory>{
 const physical=await readRechargeRefundMixedProviderHistoryTx(tx,env,role,operationId,undefined,mode),h=physical.universe.requestQueryHistory;
 const view=parseRechargeRefundQueryHistory(env,h.scope,h.operation,h.attempts,h.approvals,h.results.map(r=>r.record),physical.state);
 return Object.freeze({...view,providerUniverse:physical.universe});
}

/** Minimal historical point closure for a future verified query-result writer.
 * It deliberately does not read mutable state, wallet, other results, current
 * actor or current credentials: later local release must not erase external
 * truth already verified by that private transport. This reader mints nothing. */
export async function readRechargeRefundQueryAttemptTx(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,
 operationId:unknown,attemptId:unknown,mode:'read'|'write'='read'):Promise<RechargeRefundQueryAttempt>{
 if(Object.hasOwn(tx,'$client')||!uuid(operationId)||!uuid(attemptId))return fail();
 const scope=await runtime(tx,role,mode);
 const operations=await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${operationId}::uuid LIMIT 2`);
 if(operations.length!==1)return fail();
 const operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',operations[0]);
 const firstRows=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt
  WHERE operation_id=${operationId}::uuid AND ordinal=1 LIMIT 2`);
 const queryRows=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt
  WHERE operation_id=${operationId}::uuid AND attempt_id=${attemptId}::uuid LIMIT 2`);
 if(firstRows.length!==1||queryRows.length!==1)return fail();
 const first=parseRechargeRefundFirstRequest(env,scope,operation,firstRows[0]);
 const raw=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy
  WHERE account_id=${first.payload.approval.accountId} ORDER BY revision LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.policies+1}`);
 if(raw.length>RECHARGE_QUERY_HISTORY_LIMITS.policies)return fail();
 const policies=Array.from(raw,row=>parseRechargeRoutineRefundAccountJournal(env,scope,row));
 if(new TextEncoder().encode(JSON.stringify(policies)).byteLength>RECHARGE_QUERY_HISTORY_LIMITS.policyBytes)return fail();
 validateRechargeRoutineRefundAccountHistory(policies,first.payload.approval.accountId);
 const row=authenticateRechargeRefundRecord(env,scope,'recharge_refund_attempt',queryRows[0]);
 const payload=row.payload;
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return fail();
 const ref=(payload as Readonly<Record<string,RechargeRefundJson>>).approval;
 if(!ref||typeof ref!=='object'||Array.isArray(ref))return fail();
 const id=(ref as Readonly<Record<string,RechargeRefundJson>>).recordId;if(typeof id!=='string')return fail();
 if(new Set(policies.map(p=>p.record_id)).size!==policies.length)return fail();
 const firstApproval=policies.find(p=>p.record_id===first.payload.approval.recordId),approval=policies.find(p=>p.record_id===id);
 if(!firstApproval||!approval)return fail();
 return parseRechargeRefundQueryAttempt(env,scope,operation,first.attempt,firstApproval,row,approval);
}
