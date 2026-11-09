/** Recovery of an already admitted refund. App and current original Admin
 * have separate fixed entry points. No initial POST or caller role selector. */
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container,DbClient } from '@/lib/di';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { captureAdminRechargeRefundActor,authorizeAdminRechargeRefundTx,type AdminRechargeRefundActor } from '@/services/admin/AdminRechargeRefundActor';
import { AuthException,ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundState } from './RechargeRefundAccounting';
import { parseRechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { RECHARGE_QUERY_HISTORY_LIMITS } from './RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackProviderUniverse } from './RechargeRefundCallbackHistoryCodec';
import { decideRechargeRefundMixedRecovery,type RechargeRefundMixedRecoveryDecision as RechargeRefundRecoveryDecision } from './RechargeRefundMixedRecoveryDecision';
import { captureRechargeRefundSuccessCallbackResult } from './RechargeRefundCallbackSuccessCapture';
import { releaseRechargeRefundClosedCallbackResult } from './RechargeRefundCallbackClosedRelease';
import { claimRechargeRefundServiceQuery,claimAdminRechargeRefundQuery } from './RechargeRefundQueryClaim';
import { captureRechargeRefundSuccessFirstResult } from './RechargeRefundSuccessCapture';
import { releaseRechargeRefundClosedFirstResult } from './RechargeRefundClosedRelease';
import { captureRechargeRefundSuccessCountedFirstResult } from './RechargeRefundCountedFirstSuccessCapture';
import { releaseRechargeRefundClosedCountedFirstResult } from './RechargeRefundCountedFirstClosedRelease';
import { captureRechargeRefundSuccessQueryResult } from './RechargeRefundQuerySuccessCapture';
import { releaseRechargeRefundClosedQueryResult } from './RechargeRefundQueryClosedRelease';
import type { RechargeRefundQueryProviderStatus } from './RechargeRefundQueryCodec';
import { WechatPayService } from '@/services/wechat/WechatPayService';

export type RechargeRefundRecoveryResult =
 | {readonly operationId:string;readonly outcome:'not_requested'}
 | {readonly operationId:string;readonly outcome:'waiting';readonly nextQueryAt:number}
 | {readonly operationId:string;readonly outcome:'captured'|'released';readonly providerResultId:string;readonly replayed:boolean}
 | {readonly operationId:string;readonly outcome:'observed';readonly providerResultId:string;readonly providerStatus:RechargeRefundQueryProviderStatus};
const fail=():never=>{throw new ServiceUnavailableException('充值退款自动恢复暂不可核对，请保留原操作');};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
async function bounded(tx:DbClient){
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}
/** RR/RO inspection creates only a route. It never holds an operation, wallet
 * or payment lock while performing provider I/O. The subsequent claim and
 * economic author each independently establish their own fresh authority. */
async function route(root:DbClient,env:Pick<Env,'APP_KEY'>,operationId:string,role:'app'|'admin',actor?:AdminRechargeRefundActor):Promise<RechargeRefundRecoveryDecision>{
 return root.transaction(async raw=>{
  const tx=raw as unknown as DbClient;await bounded(tx);
  const scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,role,'read');
  if((role==='admin')!==(actor!==undefined))return fail();
  if(actor)await authorizeAdminRechargeRefundTx(tx,actor,'read');
  const [context]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('role')='none' AS ready`);
  if(context?.ready!==true)return fail();
  const operations=await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if(operations.length!==1)return fail();
  const operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',operations[0]);
  if(actor&&operation.admin_id!==actor.id)throw new AuthException('不能接管其他管理员的充值退款操作');
  if(operation.admission!=='reserved')return fail();
  const states=await tx.execute(sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${operationId}::uuid LIMIT 2`);
  if(states.length!==1)return fail();const state=captureRechargeRefundState(states[0],operation);
  const attempts=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${operationId}::uuid
   ORDER BY ordinal LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.attempts+1}`);
  const rawResults=await tx.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid
   ORDER BY created_at,result_id LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.results+2}`);
  if(rawResults.length>RECHARGE_QUERY_HISTORY_LIMITS.results+1)return fail();
  const results=Array.from(rawResults,row=>authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',row));
  if(!attempts.length){
   if(results.length||state.status!=='RESERVED'||state.wallet_state!=='held'||state.version!==0||state.attempt_count!==0
    ||state.lease_id!==null||state.lease_until!==null||state.next_query_at!==null||state.last_result_id!==null||state.provider_refund_id!==null)return fail();
   const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
   if(deadline?.ready!==true)return fail();
   return Object.freeze({action:'not_requested',operationId});
  }
  const first=parseRechargeRefundFirstRequest(env,scope,operation,attempts[0]);
  const policies=await tx.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy
   WHERE account_id=${first.payload.approval.accountId} ORDER BY revision LIMIT ${RECHARGE_QUERY_HISTORY_LIMITS.policies+1}`);
  const locals=results.filter(r=>['local_settlement','local_release','local_cancel'].includes(String(r.source)));
  if(locals.length>1||locals[0]?.source==='local_cancel')return fail();
  const local=locals[0]??null;
  // A local is removed only to route a terminal replay of that authenticated
  // exact row. Its complete family/physical artifacts are verified again by
  // the owning author; extra local or unsupported rows are not hidden; every callback is decoded.
  const provider=local?results.filter(r=>r.result_id!==local.result_id):results;
  if(local&&(state.last_result_id!==local.result_id||!['SUCCEEDED','FAILED'].includes(state.status)||!['captured','released'].includes(state.wallet_state)))return fail();
  const history=parseRechargeRefundCallbackProviderUniverse(env,scope,operation,Array.from(attempts),Array.from(policies),provider);
  const [clock]=await tx.execute<{now:string;ready:boolean}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now,
   pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
  if(clock?.ready!==true)return fail();
  return decideRechargeRefundMixedRecovery(history,state,Number(clock.now),local);
 },{isolationLevel:'repeatable read',accessMode:'read only'});
}
async function settle(container:Container,env:Env,decision:Extract<RechargeRefundRecoveryDecision,{action:'settle'}>,role:'app'|'admin'):Promise<RechargeRefundRecoveryResult>{
 const {operationId,providerResultId,source,status,firstReceiptVersion}=decision;
 if(source==='request'&&firstReceiptVersion!==1&&firstReceiptVersion!==2)return fail();
 if(status==='SUCCESS'){
  const result=await(source==='callback'?captureRechargeRefundSuccessCallbackResult:source==='query'?captureRechargeRefundSuccessQueryResult:firstReceiptVersion===2?captureRechargeRefundSuccessCountedFirstResult:captureRechargeRefundSuccessFirstResult)(container,env,role,operationId,providerResultId);
  return Object.freeze({operationId,outcome:'captured',providerResultId,replayed:result.replayed});
 }
 const result=await(source==='callback'?releaseRechargeRefundClosedCallbackResult:source==='query'?releaseRechargeRefundClosedQueryResult:firstReceiptVersion===2?releaseRechargeRefundClosedCountedFirstResult:releaseRechargeRefundClosedFirstResult)(container,env,role,operationId,providerResultId);
 return Object.freeze({operationId,outcome:'released',providerResultId,replayed:result.replayed});
}
/** The role is fixed, not read from HTTP or an argument. Financial-facing
 * APIs need their separate existing CustomerWork authorization scope. */
async function recover(container:Container,env:Env,operationId:unknown,role:'app'|'admin',actor?:AdminRechargeRefundActor):Promise<RechargeRefundRecoveryResult>{
 const root=container.db;
 if(!Object.hasOwn(root,'$client')||!uuid(operationId))return fail();
 const own={...container,db:root},decision=await route(root,env,operationId,role,actor);
 if(decision.action==='not_requested')return Object.freeze({operationId,outcome:'not_requested'});
 if(decision.action==='wait')return Object.freeze({operationId,outcome:'waiting',nextQueryAt:decision.nextQueryAt});
 if(decision.action==='settle')return settle(own,env,decision,role);
 const prepared=role==='admin'?await claimAdminRechargeRefundQuery(root,env,captureAdminRechargeRefundActor(actor!),operationId)
  :await claimRechargeRefundServiceQuery(root,env,'app',operationId);
 const service=new WechatPayService(own,env),verified=await service.queryRechargeRefund(prepared);
 const recorded=await service.persistRechargeRefundQueryResult(verified);
 if(recorded.status==='SUCCESS'||recorded.status==='CLOSED')return settle(own,env,{action:'settle',operationId,source:'query',
  status:recorded.status,providerResultId:recorded.resultId},role);
 // This describes only this independently recorded observation, not a claim
 // that a different concurrently settled local wallet is still held.
 return Object.freeze({operationId,outcome:'observed',providerResultId:recorded.resultId,providerStatus:recorded.status});
}

/** Private background recovery uses actual App LOGIN only. */
export function recoverAppRechargeRefund(container:Container,env:Env,operationId:unknown):Promise<RechargeRefundRecoveryResult>{
 return recover(container,env,operationId,'app');
}
/** Current original Admin only. HTTP code derives this actor from verified
 * context; another Admin, an expired session or a Financial root cannot adopt it. */
export function recoverAdminRechargeRefund(container:Container,env:Env,input:AdminRechargeRefundActor,operationId:unknown):Promise<RechargeRefundRecoveryResult>{
 return recover(container,env,operationId,'admin',captureAdminRechargeRefundActor(input));
}
/** An address-only read for the initial execution coordinator; never a permit
 * to send a first POST or trust a supplied status. The first claimant rechecks. */
export function inspectAdminRechargeRefundRecoveryRoute(container:Container,env:Pick<Env,'APP_KEY'>,input:AdminRechargeRefundActor,operationId:unknown):Promise<RechargeRefundRecoveryDecision>{
 if(!Object.hasOwn(container.db,'$client')||!uuid(operationId))return Promise.reject(new ServiceUnavailableException('充值退款操作标识无效'));
 return route(container.db,env,operationId,'admin',captureAdminRechargeRefundActor(input));
}
