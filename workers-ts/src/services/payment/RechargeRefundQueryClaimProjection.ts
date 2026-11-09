/** Pure projection comparison only. Supplied history is never live SQL authority. */
import { ServiceUnavailableException } from '@/utils/errors';
import { RECHARGE_QUERY_HISTORY_LIMITS,type RechargeRefundQueryHistory } from './RechargeRefundQueryHistoryCodec';
export interface RechargeRefundQueryClaimProjection {
 readonly previousStatus:'SUBMITTING'|'UNKNOWN';readonly previousVersion:number;readonly totalAttempts:number;
 readonly previousLeaseId:string;readonly previousLeaseUntil:number;readonly nextQueryAt:number;readonly updatedAt:number;
 readonly nextOrdinal:number;
}
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询状态未闭合或已到历史读取上限，请保留原操作人工核对');};
/** First claim and this author's own untouched query projections only. Future
 * result projection protocols must define their own closed successor rather
 * than accepting arbitrary PROCESSING/version>=N or cleared leases. */
export function rechargeRefundQueryClaimProjection(h:RechargeRefundQueryHistory):RechargeRefundQueryClaimProjection{
 const s=h.state,n=h.totalAttempts,tail=h.attempts.at(-1);
 if(!tail||h.queryDisposition!=='unresolved'||h.requestAttempts!==1||n<1||n>=RECHARGE_QUERY_HISTORY_LIMITS.attempts
  ||h.attempts.length!==n||s.attempt_count!==n||s.version!==n||s.wallet_state!=='held'
  ||s.status!==(n===1?'SUBMITTING':'UNKNOWN')||s.provider_refund_id!==null||s.last_result_id!==null
  ||s.lease_id!==tail.lease_id||typeof s.lease_id!=='string'||typeof s.lease_until!=='number'||s.lease_until!==Number(tail.created_at)+30
  ||typeof s.next_query_at!=='number'||s.next_query_at!==h.earliestNextQueryAt||s.next_query_at!==Number(tail.created_at)+60
  ||s.updated_at!==tail.created_at)return fail();
 return Object.freeze({previousStatus:s.status as 'SUBMITTING'|'UNKNOWN',previousVersion:s.version,totalAttempts:n,
  previousLeaseId:s.lease_id,previousLeaseUntil:s.lease_until,nextQueryAt:s.next_query_at,updatedAt:s.updated_at,nextOrdinal:n+1});
}
