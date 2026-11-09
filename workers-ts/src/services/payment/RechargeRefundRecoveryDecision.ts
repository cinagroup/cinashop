/** Routing addresses only. These decisions never grant transport or funds
 * authority: each owning claim/settlement transaction rereads actual history. */
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundState } from './RechargeRefundAccounting';
import type { RechargeRefundRecord } from './RechargeRefundLedger';
import type { RechargeRefundProviderHistory } from './RechargeRefundQueryHistoryCodec';
import { rechargeRefundQueryClaimProjection } from './RechargeRefundQueryClaimProjection';

export type RechargeRefundRecoveryDecision =
 | {readonly action:'not_requested';readonly operationId:string}
 | {readonly action:'wait';readonly operationId:string;readonly nextQueryAt:number}
 | {readonly action:'query';readonly operationId:string}
 | {readonly action:'settle';readonly operationId:string;readonly source:'request'|'query';readonly status:'SUCCESS'|'CLOSED';readonly providerResultId:string};
const fail=():never=>{throw new ServiceUnavailableException('充值退款恢复依据未闭合，请保留原操作人工核对');};
/** Pure comparison over a decoded provider universe. A supplied history is
 * not proof that any row exists, or that an authorization remains current. */
export function decideRechargeRefundRecovery(h:RechargeRefundProviderHistory,rawState:unknown,now:number,
 local:RechargeRefundRecord|null=null):RechargeRefundRecoveryDecision{
 const s=captureRechargeRefundState(rawState,h.operation),id=String(h.operation.operation_id),n=h.totalAttempts,tail=h.attempts.at(-1);
 if(!Number.isSafeInteger(now)||now<1||now>2147483647||!tail||now<Number(tail.created_at)-1
  ||s.attempt_count!==n||h.queryDisposition==='manual_review')return fail();
 if(local){
  const cause=h.results.find(r=>r.record.result_id===local.caused_by_result_id);
  const capture=local.source==='local_settlement',release=local.source==='local_release';
  if(!cause||(!capture&&!release)||local.operation_id!==id||local.attempt_id!==null||local.status!=='SUCCESS'
   ||local.source_id!==(capture?'settle:':'release:')+id||s.last_result_id!==local.result_id
   ||s.status!==(capture?'SUCCEEDED':'FAILED')||s.wallet_state!==(capture?'captured':'released')
   ||s.version!==n+1||s.updated_at!==local.created_at||s.provider_refund_id!==cause.observation.providerRefundId
   ||s.lease_id!==null||s.lease_until!==null||s.next_query_at!==null
   ||cause.observation.status!==(capture?'SUCCESS':'CLOSED')||!['request','query'].includes(String(cause.record.source)))return fail();
  return Object.freeze({action:'settle',operationId:id,source:cause.record.source as 'request'|'query',
   status:capture?'SUCCESS':'CLOSED',providerResultId:String(cause.record.result_id)});
 }
 if(s.wallet_state!=='held'||s.status!==(n===1?'SUBMITTING':'UNKNOWN')||s.version!==n||s.provider_refund_id!==null||s.last_result_id!==null
  ||s.lease_id!==tail.lease_id||s.lease_until!==Number(tail.created_at)+30||s.next_query_at!==Number(tail.created_at)+60
  ||s.updated_at!==tail.created_at)return fail();
 if(h.queryDisposition==='terminal_evidence'){
  // Prefer an actual query cause when a query exists. Ordering is only a
  // stable address choice among already consistent terminal money facts,
  // never a latest-row winner that discards contradictory evidence.
  const terminals=h.results.filter(r=>['SUCCESS','CLOSED'].includes(r.observation.status))
   .sort((a,b)=>Number(b.record.source==='query')-Number(a.record.source==='query')||a.ordinal-b.ordinal);
  const cause=terminals[0];
  if(!cause||!['request','query'].includes(String(cause.record.source))||cause.record.source==='request'&&n!==1)return fail();
  return Object.freeze({action:'settle',operationId:id,source:cause.record.source as 'request'|'query',
   status:cause.observation.status as 'SUCCESS'|'CLOSED',providerResultId:String(cause.record.result_id)});
 }
 const projection=rechargeRefundQueryClaimProjection({...h,state:s});
 const next=Math.max(projection.nextQueryAt,projection.previousLeaseUntil);
 return now<next?Object.freeze({action:'wait',operationId:id,nextQueryAt:next}):Object.freeze({action:'query',operationId:id});
}
