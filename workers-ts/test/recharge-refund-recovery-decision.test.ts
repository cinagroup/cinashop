/** Synthetic immutable-history comparisons, not SQL/transport/funds permits. */
import { describe,expect,it } from 'vitest';
import { decideRechargeRefundRecovery } from '@/services/payment/RechargeRefundRecoveryDecision';
import { parseRechargeRefundProviderHistory,type RechargeRefundProviderHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import type { RechargeRefundStateRow } from '@/services/payment/RechargeRefundAccounting';
import type { RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeQueryHistoryPureFixture,historyScope as scope,historySigning as env } from './helpers/rechargeRefundQueryHistoryPure';
import { rechargeQueryEconomicPureFixture } from './helpers/rechargeQueryEconomicPure';
import { rechargeLocalCapturePureFixture } from './helpers/rechargeLocalCapturePure';
import { rechargeLocalReleasePureFixture } from './helpers/rechargeLocalReleasePure';
import { operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';
function state(h:RechargeRefundProviderHistory):RechargeRefundStateRow{
 const tail=h.attempts.at(-1)!;
 return{operation_id:String(h.operation.operation_id),recharge_id:Number(h.operation.recharge_id),admission:'reserved',
  status:h.totalAttempts===1?'SUBMITTING':'UNKNOWN',wallet_state:'held',version:h.totalAttempts,attempt_count:h.totalAttempts,
  lease_id:String(tail.lease_id),lease_until:Number(tail.created_at)+30,next_query_at:Number(tail.created_at)+60,
  last_result_id:null,provider_refund_id:null,created_at:Number(h.operation.created_at),updated_at:Number(tail.created_at)};
}
function terminal(h:RechargeRefundProviderHistory,local:RechargeRefundRecord):RechargeRefundStateRow{
 const cause=h.results.find(r=>r.record.result_id===local.caused_by_result_id);if(!cause)throw Error('Synthetic cause missing');
 const capture=local.source==='local_settlement';return{...state(h),status:capture?'SUCCEEDED':'FAILED',wallet_state:capture?'captured':'released',
  version:h.totalAttempts+1,lease_id:null,lease_until:null,next_query_at:null,last_result_id:String(local.result_id),
  provider_refund_id:cause.observation.providerRefundId,updated_at:Number(local.created_at)};
}
function basic(count=2,statuses:Parameters<typeof rechargeQueryHistoryPureFixture>[1]=[],first:Parameters<typeof rechargeQueryHistoryPureFixture>[2]='UNKNOWN'){
 const f=rechargeQueryHistoryPureFixture(count,statuses,first);
 return parseRechargeRefundProviderHistory(env,scope,f.operation,f.attempts,f.policies,f.results);
}
describe('complete-history recharge recovery routing without capabilities',()=>{
 it.each([1,2,3])('waits until the immutable query fence for total%s without starting another POST',n=>{
  const h=basic(n),s=state(h),due=Number(h.attempts.at(-1)!.created_at)+60;
  expect(decideRechargeRefundRecovery(h,s,due-1)).toEqual({action:'wait',operationId:s.operation_id,nextQueryAt:due});
  const decision=decideRechargeRefundRecovery(h,s,due);expect(decision).toEqual({action:'query',operationId:s.operation_id});
  expect(Object.isFrozen(decision)).toBe(true);expect(decision).not.toHaveProperty('capability');
 });
 it.each(['SUCCESS','CLOSED']as const)('routes sole firstPOST %s to its distinct author without requiring a new query',status=>{
  const h=basic(1,[],status),s=state(h);
  expect(decideRechargeRefundRecovery(h,s,1102)).toEqual({action:'settle',operationId:s.operation_id,source:'request',status,providerResultId:h.results[0].record.result_id});
 });
 it.each(['SUCCESS','CLOSED']as const)('routes query %s to its query-specific author even before lease expiry',status=>{
  const h=basic(2,[status]),s=state(h);
  expect(decideRechargeRefundRecovery(h,s,2001)).toEqual({action:'settle',operationId:s.operation_id,source:'query',status,providerResultId:h.results[1].record.result_id});
 });
 it('selects a stable earlier query cause among consistent terminal money facts, independent of array order',()=>{
  const f=rechargeQueryHistoryPureFixture(3,['SUCCESS','SUCCESS']);
  for(const rows of [f.results,[...f.results].reverse()]){
   const h=parseRechargeRefundProviderHistory(env,scope,f.operation,f.attempts,f.policies,rows);
   expect(decideRechargeRefundRecovery(h,state(h),2200)).toMatchObject({action:'settle',source:'query',providerResultId:f.results[1].result_id});
  }
 });
 it.each([['SUCCESS','CLOSED'],['SUCCESS','NOT_FOUND']]as const)('refuses conflicting known query observations %s/%s without selecting a winner',(a,b)=>{
  const h=basic(3,[a,b]);expect(h.queryDisposition).toBe('manual_review');expect(()=>decideRechargeRefundRecovery(h,state(h),2200)).toThrow();
 });
 it('does not use a terminal first response with a later unresolved query as a first-only money universe',()=>{
  const h=basic(2,['UNKNOWN'],'SUCCESS');expect(()=>decideRechargeRefundRecovery(h,state(h),2200)).toThrow();
 });
 it('keeps the full64-attempt unresolved history for manual handling without FAILED or release',()=>{
  const h=basic(64),s=state(h);expect(()=>decideRechargeRefundRecovery(h,s,Number(h.attempts.at(-1)!.created_at)+61)).toThrow();
  expect(s.wallet_state).toBe('held');expect(s.status).toBe('UNKNOWN');
 });
 const mutations:Array<[string,(s:RechargeRefundStateRow)=>unknown]>=[
  ['foreign operation',s=>({...s,operation_id:operationSourceUuid(800)})],
  ['wrong immutable count',s=>({...s,attempt_count:1})],['inflated version',s=>({...s,version:99})],
  ['unsupported processing projection',s=>({...s,status:'PROCESSING'})],['cleared lease',s=>({...s,lease_id:null,lease_until:null})],
  ['other lease',s=>({...s,lease_id:operationSourceUuid(801)})],['other lease expiry',s=>({...s,lease_until:s.lease_until!+1})],
  ['other query fence',s=>({...s,next_query_at:s.next_query_at!+1})],['other update clock',s=>({...s,updated_at:s.updated_at+1})],
  ['scalar provider pointer',s=>({...s,provider_refund_id:'unproven'})],['scalar result pointer',s=>({...s,last_result_id:operationSourceUuid(802)})],
  ['terminal without receipt',s=>({...s,status:'SUCCEEDED',wallet_state:'captured',lease_id:null,lease_until:null,next_query_at:null})],
 ];
 it.each(mutations)('refuses %s rather than trusting a caller ready projection',(_name,change)=>{
  const h=basic(2);expect(()=>decideRechargeRefundRecovery(h,change(state(h)),2200)).toThrow();
 });
 for(const kind of ['capture','release']as const){
  it('routes a physically authenticated query '+kind+' receipt only back to its own author',()=>{
   const f=rechargeQueryEconomicPureFixture(kind==='capture'?'SUCCESS':'CLOSED'),h=parseRechargeRefundProviderHistory(env,scope,
    f.history.operation,f.history.attempts,f.history.policies,f.history.results),local=kind==='capture'?f.localCapture():f.localRelease();
   const s=terminal(h,local),p=decideRechargeRefundRecovery(h,s,2200,local);
   expect(p).toMatchObject({action:'settle',source:'query',status:kind==='capture'?'SUCCESS':'CLOSED',providerResultId:local.caused_by_result_id});
   expect(()=>decideRechargeRefundRecovery(h,{...s,last_result_id:operationSourceUuid(803)},2200,local)).toThrow();
   expect(()=>decideRechargeRefundRecovery(h,s,2200,{...local,caused_by_result_id:operationSourceUuid(804)})).toThrow();
  });
 }
 it.each(['capture','release']as const)('keeps the legacy first-only %s receipt in its own family',kind=>{
  const f=kind==='capture'?rechargeLocalCapturePureFixture():rechargeLocalReleasePureFixture(),raw=f.history;
  const local=f.local();
  const h=parseRechargeRefundProviderHistory(env,scope,raw.operation,[raw.attempt],[raw.approval],[raw.providerResult]);
  expect(decideRechargeRefundRecovery(h,terminal(h,local),2200,local)).toMatchObject({action:'settle',source:'request',providerResultId:raw.providerResult.result_id});
 });
 it.each([0,1998,2147483648,NaN])('refuses invalid/stale database clock%s',now=>{
  const h=basic(2);expect(()=>decideRechargeRefundRecovery(h,state(h),now)).toThrow();
 });
});
