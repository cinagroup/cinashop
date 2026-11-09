/** Synthetic MAC history only; no SQL/claim/provider/time/COMMIT evidence. */
import { signRechargeRefundRecord,type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import type { RechargeRefundStateRow } from '@/services/payment/RechargeRefundAccounting';
import type { RechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundFirstProviderStatus } from '@/services/payment/RechargeRefundFirstProviderResult';
import type { RechargeRefundQueryProviderStatus } from '@/services/payment/RechargeRefundQueryCodec';
import { rechargeQueryPureFixture,queryScope as scope,querySigning as env } from './rechargeRefundQueryPure';
import { rechargeFirstResultPureFixture,type RechargeFirstResultPureFixture } from './rechargeFirstProviderResultPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { queryScope as historyScope,querySigning as historySigning } from './rechargeRefundQueryPure';
export interface QueryHistoryPureFixture {
 readonly first:RechargeFirstResultPureFixture;readonly operation:RechargeRefundRecord;
 readonly attempts:RechargeRefundRecord[];readonly policies:RechargeRoutineRefundAccountJournal[];
 readonly results:RechargeRefundRecord[];readonly state:RechargeRefundStateRow;
}
export function historyResign(table:'recharge_refund_attempt'|'recharge_refund_result',row:RechargeRefundRecord,
 patch:Record<string,unknown>):RechargeRefundRecord{
 const {signature:_,...unsigned}=row;return signRechargeRefundRecord(env,scope,table,{...unsigned,...patch});
}
export function rechargeQueryHistoryPureFixture(count=2,statuses:readonly RechargeRefundQueryProviderStatus[]=[],
 firstStatus:RechargeRefundFirstProviderStatus='UNKNOWN'):QueryHistoryPureFixture{
 const first=rechargeFirstResultPureFixture(firstStatus),attempts=[first.attempt],results=[first.result()];
 const policies=[first.approval];
 for(let ordinal=2;ordinal<=count;ordinal++){
  const f=rechargeQueryPureFixture(statuses[ordinal-2]??'UNKNOWN',{ordinal,issuedAt:2000+(ordinal-2)*60,queryPolicy:{validUntil:10000}});
  const lease=operationSourceUuid(100+ordinal),attempt=f.queryAttempt({leaseId:lease},{attempt_id:operationSourceUuid(200+ordinal),lease_id:lease});
  if(ordinal===2)policies.push(f.approval);
  attempts.push(attempt);
  results.push(historyResign('recharge_refund_result',f.result(),{result_id:operationSourceUuid(300+ordinal),attempt_id:attempt.attempt_id,
   source_id:attempt.attempt_id,evidence:{...f.evidence,queryAttemptSignature:attempt.signature}}));
 }
 const tail=attempts[attempts.length-1],payload=tail.payload as Record<string,unknown>,n=attempts.length;
 const state:RechargeRefundStateRow={operation_id:String(first.operation.operation_id),recharge_id:Number(first.operation.recharge_id),admission:'reserved',
  status:n===1?'SUBMITTING':'UNKNOWN',wallet_state:'held',version:n,lease_id:String(tail.lease_id),lease_until:Number(payload.leaseUntil),
  provider_refund_id:null,attempt_count:n,next_query_at:Number(tail.created_at)+60,last_result_id:null,
  created_at:Number(first.operation.created_at),updated_at:Number(tail.created_at)};
 return{first,operation:first.operation,attempts,policies,results,state};
}
