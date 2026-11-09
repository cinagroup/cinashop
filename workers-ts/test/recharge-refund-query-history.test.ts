/** Synthetic closed-MAC history tests; not genuine SQL or query evidence. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundQueryHistory,RECHARGE_QUERY_HISTORY_LIMITS,type RechargeRefundQueryHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundQueryAttempt } from '@/services/payment/RechargeRefundQueryCodec';
import { signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { historyScope as scope,historySigning as env,rechargeQueryHistoryPureFixture,historyResign,type QueryHistoryPureFixture } from './helpers/rechargeRefundQueryHistoryPure';
import { operationSourceUuid,sourceClone } from './helpers/rechargeRefundOperationSourcePure';
interface Inputs {readonly attempts?:unknown;readonly policies?:unknown;readonly results?:unknown;readonly state?:unknown;readonly operation?:unknown}
function read(f:QueryHistoryPureFixture,input:Inputs={}):RechargeRefundQueryHistory{
 return parseRechargeRefundQueryHistory(env,scope,input.operation??f.operation,input.attempts??f.attempts,input.policies??f.policies,input.results??f.results,input.state??f.state);
}
describe('complete bounded recharge query history',()=>{
 it.each([1,2,3,64])('derives total%s and lifetimePOST1 from every contiguous authenticated row',count=>{
  const f=rechargeQueryHistoryPureFixture(count),p=read(f);
  expect(p.totalAttempts).toBe(count);expect(p.requestAttempts).toBe(1);expect(p.queryAttempts).toBe(count-1);
  expect(p.earliestNextQueryAt).toBe(Number(f.attempts.at(-1)!.created_at)+60);
  expect(p.attempts.length).toBe(count);expect(p.results.length).toBe(count);expect(p.queryDisposition).toBe('unresolved');
 });
 it('allows missing results without turning them into NOT_FOUND or permission for another POST',()=>{
  const f=rechargeQueryHistoryPureFixture(3),p=read(f,{results:[]});
  expect(p.results.length).toBe(0);expect(p.requestAttempts).toBe(1);expect(p.totalAttempts).toBe(3);
  expect(p.queryDisposition).toBe('unresolved');expect(Object.hasOwn(p,'capability')).toBe(false);
 });
 it('preserves signed NOT_FOUND and UNKNOWN as held unresolved observations',()=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND','UNKNOWN']),p=read(f);
  expect(p.queryDisposition).toBe('unresolved');expect(p.state.wallet_state).toBe('held');
  expect(p.results.map(r=>r.observation.status)).toEqual(['UNKNOWN','NOT_FOUND','UNKNOWN']);
 });
 it('retains an older NOT_FOUND and later SUCCESS, but supplies no local settlement proof',()=>{
  const p=read(rechargeQueryHistoryPureFixture(3,['NOT_FOUND','SUCCESS']));
  expect(p.queryDisposition).toBe('terminal_evidence');expect(p.state.wallet_state).toBe('held');expect(p.requestAttempts).toBe(1);
 });
 it.each(['PROCESSING','ABNORMAL'] as const)('keeps an older NOT_FOUND then later %s queryable without releasing or capturing the hold',status=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND',status]),p=read(f);
  expect(p.queryDisposition).toBe('unresolved');expect(p.providerRefundIds.length).toBe(1);
  expect(p.results.map(row=>row.observation.status)).toEqual(['UNKNOWN','NOT_FOUND',status]);
  expect(p.state.wallet_state).toBe('held');expect(p.requestAttempts).toBe(1);expect(p.queryAttempts).toBe(2);
  expect(Object.hasOwn(p,'capability')).toBe(false);
 });
 it.each(['same observation time','late older GET'] as const)('retains %s NOT_FOUND for manual review even when its ordinal precedes a positive response',kind=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND','PROCESSING']),row=f.results[1],e=row.evidence as Record<string,unknown>;
  const positiveVerification=(f.results[2].evidence as Record<string,unknown>).verification as Record<string,unknown>;
  const observedAt=Number(positiveVerification.observedAt)+(kind==='late older GET'?10:0);
  const changed=historyResign('recharge_refund_result',row,{created_at:observedAt,
   evidence:{...e,verification:{...(e.verification as Record<string,unknown>),observedAt}}});
  expect(read(f,{results:[f.results[0],changed,f.results[2]]}).queryDisposition).toBe('manual_review');
 });
 it('does not let array or result persistence order change eventual visibility',()=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND','PROCESSING']);
  expect(read(f,{results:[...f.results].reverse()}).queryDisposition).toBe('unresolved');
  const conflict=rechargeQueryHistoryPureFixture(2,['NOT_FOUND'],'PROCESSING');
  expect(read(conflict,{results:[...conflict.results].reverse()}).queryDisposition).toBe('manual_review');
 });
 it.each(['SUCCESS','CLOSED'] as const)('retains an earlier NOT_FOUND before later %s as terminal evidence without money authority',status=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND',status]);
  for(const results of [f.results,[...f.results].reverse()]){
   const parsed=read(f,{results});expect(parsed.queryDisposition).toBe('terminal_evidence');
   expect(parsed.state.wallet_state).toBe('held');expect(parsed.requestAttempts).toBe(1);
  }
 });
 it.each(['SUCCESS','CLOSED'] as const)('does not let firstPOST %s mask a later contradictory NOT_FOUND',status=>{
  const f=rechargeQueryHistoryPureFixture(2,['NOT_FOUND'],status);
  for(const results of [f.results,[...f.results].reverse()]){
   const parsed=read(f,{results});expect(parsed.queryDisposition).toBe('manual_review');
   expect(parsed.state.wallet_state).toBe('held');expect(parsed.results.length).toBe(2);
  }
 });
 it.each([
  ['SUCCESS','same observation time'],['SUCCESS','late older GET'],
  ['CLOSED','same observation time'],['CLOSED','late older GET'],
 ] as const)('does not let query %s mask %s NOT_FOUND even from an earlier ordinal', (status,kind)=>{
  const f=rechargeQueryHistoryPureFixture(3,['NOT_FOUND',status]),row=f.results[1],e=row.evidence as Record<string,unknown>;
  const positiveVerification=(f.results[2].evidence as Record<string,unknown>).verification as Record<string,unknown>;
  const observedAt=Number(positiveVerification.observedAt)+(kind==='late older GET'?10:0);
  const changed=historyResign('recharge_refund_result',row,{created_at:observedAt,
   evidence:{...e,verification:{...(e.verification as Record<string,unknown>),observedAt}}});
  const retained=[f.results[0],changed,f.results[2]];
  for(const results of [retained,[...retained].reverse()]){
   const parsed=read(f,{results});expect(parsed.queryDisposition).toBe('manual_review');
   expect(parsed.state.wallet_state).toBe('held');expect(parsed.results.length).toBe(3);
  }
 });
 it.each(['SUCCESS','CLOSED'] as const)('recognizes firstPOST %s evidence without treating mutable held state as settled money',status=>{
  const p=read(rechargeQueryHistoryPureFixture(1,[],status));expect(p.queryDisposition).toBe('terminal_evidence');expect(p.state.wallet_state).toBe('held');
 });
 it('reports multiple positive provider IDs for manual review without choosing a latest winner',()=>{
  const p=read(rechargeQueryHistoryPureFixture(2,['PROCESSING'],'PROCESSING'));
  expect(p.queryDisposition).toBe('manual_review');expect(p.providerRefundIds.length).toBe(2);expect(p.results.length).toBe(2);
 });
 it('reports positive provider evidence plus NOT_FOUND for manual review',()=>{
  expect(read(rechargeQueryHistoryPureFixture(2,['NOT_FOUND'],'PROCESSING')).queryDisposition).toBe('manual_review');
 });
 it('reports conflicting SUCCESS/CLOSED even for the same provider ID',()=>{
  const f=rechargeQueryHistoryPureFixture(2,['SUCCESS'],'CLOSED'),last=f.results[1],e=last.evidence as Record<string,unknown>;
  const result=e.result as Record<string,unknown>;
  const changed=historyResign('recharge_refund_result',last,{evidence:{...e,result:{...result,providerRefundId:'refund_contract_1'}}});
  expect(read(f,{results:[f.results[0],changed]}).queryDisposition).toBe('manual_review');
 });
 it('validates all past approval rows while accepting later revocation without current credentials',()=>{
  const f=rechargeQueryHistoryPureFixture(3),prior=f.policies.at(-1)!;
  const revoked=signRechargeRoutineRefundAccountJournal(env,scope,{record_id:operationSourceUuid(400),account_id:prior.account_id,revision:3,
   payload:{...prior.payload,previousRecordId:prior.record_id,data:{...prior.payload.data,state:'revoked'}},created_at:2200});
  expect(read(f,{policies:[...f.policies,revoked]}).totalAttempts).toBe(3);
 });
 const badHistories:Array<[string,(f:QueryHistoryPureFixture)=>Inputs]>=[
  ['no first POST',()=>({attempts:[]})],
  ['missing ordinal2',f=>({attempts:[f.attempts[0],f.attempts[2]]})],
  ['reordered rows',f=>({attempts:[f.attempts[1],f.attempts[0],f.attempts[2]]})],
  ['duplicate attempt',f=>({attempts:[...f.attempts,f.attempts[2]]})],
  ['total scalar mismatch',f=>({state:{...f.state,attempt_count:2}})],
  ['missing first policy',f=>({policies:f.policies.slice(1)})],
  ['missing query policy',f=>({policies:f.policies.slice(0,1)})],
  ['empty policies',()=>({policies:[]})],
  ['unknown last-result pointer',f=>({state:{...f.state,last_result_id:operationSourceUuid(700)}})],
  ['unknown provider pointer',f=>({state:{...f.state,provider_refund_id:'invented'}})],
  ['earlier mutable query fence',f=>({state:{...f.state,next_query_at:Number(f.attempts[2].created_at)+59}})],
  ['wrong physical lease',f=>({state:{...f.state,lease_id:operationSourceUuid(701)}})],
  ['wrong physical lease expiry',f=>({state:{...f.state,lease_until:3000}})],
  ['duplicate provider result',f=>({results:[...f.results,historyResign('recharge_refund_result',f.results[1],{result_id:operationSourceUuid(702)})]})],
  ['orphan provider result',f=>({results:[historyResign('recharge_refund_result',f.results[1],{attempt_id:operationSourceUuid(703)})]})],
  ['local result not filtered',f=>({results:[...f.results,historyResign('recharge_refund_result',f.results[0],{result_id:operationSourceUuid(704),attempt_id:null,source:'local_release'})]})],
  ['callback not filtered',f=>({results:[...f.results,historyResign('recharge_refund_result',f.results[0],{result_id:operationSourceUuid(705),attempt_id:null,source:'callback'})]})],
 ];
 it.each(badHistories)('refuses %s before it can become a query basis',(_name,mutate)=>{
  const f=rechargeQueryHistoryPureFixture(3),bad=mutate(f);expect(()=>read(f,bad)).toThrow();
 });
 it('derives the immutable fence even when a future projection clears its mutable timer',()=>{
  const f=rechargeQueryHistoryPureFixture(3),p=read(f,{state:{...f.state,lease_id:null,lease_until:null,next_query_at:null}});
  expect(p.earliestNextQueryAt).toBe(2120);expect(p.queryDisposition).toBe('unresolved');
 });
 it('checks adjacent query spacing beyond the pure single-query firstPOST bound',()=>{
  const f=rechargeQueryHistoryPureFixture(3),row=f.attempts[2],payload=row.payload as Record<string,unknown>;
  const changed=historyResign('recharge_refund_attempt',row,{created_at:2059,payload:{...payload,issuedAt:2059,leaseUntil:2089}});
  expect(parseRechargeRefundQueryAttempt(env,scope,f.operation,f.first.attempt,f.first.approval,changed,f.policies[1]).payload.issuedAt).toBe(2059);
  expect(()=>read(f,{attempts:[f.attempts[0],f.attempts[1],changed],results:[],state:{...f.state,lease_until:2089,next_query_at:2119,updated_at:2059}})).toThrow();
 });
 it('refuses a reused query lease even when the single-query decoder accepts its closed row',()=>{
  const f=rechargeQueryHistoryPureFixture(3),row=f.attempts[2],p=row.payload as Record<string,unknown>,lease=f.attempts[1].lease_id;
  const changed=historyResign('recharge_refund_attempt',row,{lease_id:lease,payload:{...p,leaseId:lease}});
  expect(parseRechargeRefundQueryAttempt(env,scope,f.operation,f.first.attempt,f.first.approval,changed,f.policies[1]).attempt.ordinal).toBe(3);
  expect(()=>read(f,{attempts:[f.attempts[0],f.attempts[1],changed],results:[]})).toThrow();
 });
 it('rejects overflow instead of truncating to a safe-looking prefix',()=>{
  const f=rechargeQueryHistoryPureFixture(64),overflow=rechargeQueryHistoryPureFixture(65);
  expect(read(f).totalAttempts).toBe(RECHARGE_QUERY_HISTORY_LIMITS.attempts);
  expect(()=>read(overflow)).toThrow();expect(()=>read(f,{results:Array(129).fill(f.results[0])})).toThrow();
  expect(()=>read(f,{policies:Array(65).fill(f.policies[0])})).toThrow();
 });
 it('rejects executable or sparse raw batches without invoking their getters/toJSON',()=>{
  const f=rechargeQueryHistoryPureFixture(3);let calls=0;
  const getter=Array.from(f.attempts);Object.defineProperty(getter,'1',{enumerable:true,get(){calls++;return f.attempts[1];}});
  const custom=Array.from(f.attempts);Object.defineProperty(custom,'toJSON',{value(){calls++;return f.attempts;}});
  for(const attempts of [getter,custom,Array(3),Object.assign(Array.from(f.attempts),{unknown:true})])expect(()=>read(f,{attempts})).toThrow();
  expect(calls).toBe(0);
 });
 it('rejects independently tampered row MACs and copied scope',()=>{
  const f=rechargeQueryHistoryPureFixture(3);
  expect(()=>read(f,{attempts:[f.attempts[0],{...f.attempts[1],signature:'0'.repeat(64)},f.attempts[2]]})).toThrow();
  expect(()=>read(f,{results:[{...f.results[0],signature:'0'.repeat(64)}]})).toThrow();
  expect(()=>read(f,{policies:[{...f.policies[0],signature:'0'.repeat(64)},f.policies[1]]})).toThrow();
  expect(()=>parseRechargeRefundQueryHistory(env,{...scope,adminOid:'55'},f.operation,f.attempts,f.policies,f.results,f.state)).toThrow();
 });
 it('returns copied frozen data, while refusing a terminal scalar without its physical local receipt',()=>{
  const f=rechargeQueryHistoryPureFixture(3),raw=sourceClone(f.attempts),p=read(f,{attempts:raw});
  expect(Object.isFrozen(p.attempts)).toBe(true);expect(Object.isFrozen(p.queries[0].payload)).toBe(true);
  expect(()=>read(f,{state:{...f.state,status:'SUCCEEDED',wallet_state:'captured',lease_id:null,lease_until:null,next_query_at:null}})).toThrow();
 });
});
