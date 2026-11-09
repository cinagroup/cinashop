/** Bounded authenticated history, never a claim, transport or money permit.
 * Supplied rows in this pure decoder do not prove physical existence or RSA. */
import { Buffer } from 'node:buffer';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord,type RechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundScope,type RechargeRefundScope,type RechargeRefundJson } from './RechargeRefundJournalCodec';
import { parseRechargeRefundFirstRequest,rechargeRefundTransportApproval,type RechargeRefundFirstRequest } from './RechargeRefundFirstRequest';
import { parseRechargeRefundFirstProviderResult,type RechargeRefundFirstProviderObservation } from './RechargeRefundFirstProviderResult';
import { parseRechargeRefundQueryAttempt,parseRechargeRefundQueryResult,type RechargeRefundQueryAttempt,type RechargeRefundQueryObservation } from './RechargeRefundQueryCodec';
import { parseRechargeRoutineRefundAccountJournal,requireRechargeRoutineRefundPurpose,
 validateRechargeRoutineRefundAccountHistory,type RechargeRoutineRefundAccountJournal } from './RechargeRoutineRefundAccountCodec';
import { captureRechargeRefundState,type RechargeRefundStateRow } from './RechargeRefundAccounting';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

type Signing=Pick<Env,'APP_KEY'>;
/** Resource bounds, not retry deadlines: overflow requires manual handling.
 * It never marks a refund failed, releases its hold or deletes old evidence. */
export const RECHARGE_QUERY_HISTORY_LIMITS=Object.freeze({attempts:64,results:128,policies:64,
 attemptBytes:2_097_152,resultBytes:4_194_304,policyBytes:1_048_576});
export interface RechargeRefundHistoricalProviderResult {
 readonly record:RechargeRefundRecord;readonly ordinal:number;
 readonly observation:RechargeRefundFirstProviderObservation|RechargeRefundQueryObservation;
}
export interface RechargeRefundProviderHistory {
 readonly scope:RechargeRefundScope;readonly operation:RechargeRefundRecord;
 readonly first:RechargeRefundFirstRequest;readonly firstApproval:RechargeRoutineRefundAccountJournal;
 readonly attempts:readonly RechargeRefundRecord[];readonly queries:readonly RechargeRefundQueryAttempt[];
 readonly approvals:readonly RechargeRoutineRefundAccountJournal[];
 readonly results:readonly RechargeRefundHistoricalProviderResult[];
 readonly totalAttempts:number;readonly requestAttempts:1;readonly queryAttempts:number;
 readonly earliestNextQueryAt:number;readonly providerRefundIds:readonly string[];
 /** Provider evidence only. Even terminal_evidence does not prove local money. */
 readonly queryDisposition:'unresolved'|'terminal_evidence'|'manual_review';
}
export interface RechargeRefundQueryHistory extends RechargeRefundProviderHistory {readonly state:Readonly<RechargeRefundStateRow>}
const fail=():never=>{throw new ServiceUnavailableException('充值退款查询历史不完整或超过安全读取上限，请保留原操作人工核对');};
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const time=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_147_483_647;
function rows(input:unknown,limit:number):readonly unknown[]{
 if(!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length>limit)return fail();
 const d=Object.getOwnPropertyDescriptors(input);
 if(Reflect.ownKeys(d).length!==input.length+1)return fail();
 return Array.from({length:input.length},(_,i)=>{
  const field=d[String(i)];if(!field?.enumerable||!('value'in field))return fail();return field.value;
 });
}
function object(input:RechargeRefundJson):Readonly<Record<string,RechargeRefundJson>>{
 if(!input||typeof input!=='object'||Array.isArray(input))return fail();
 return input as Readonly<Record<string,RechargeRefundJson>>;
}
function byteLimit(values:readonly unknown[],limit:number):void{
 // All elements have already passed a closed copier/MAC decoder. Never run
 // JSON.stringify on caller-owned executable raw rows before authentication.
 let bytes=2;
 for(const value of values){bytes+=Buffer.byteLength(JSON.stringify(value),'utf8')+1;if(bytes>limit)return fail();}
}
function approvalFor(attempt:RechargeRefundRecord,byId:ReadonlyMap<string,RechargeRoutineRefundAccountJournal>):RechargeRoutineRefundAccountJournal{
 const ref=object(object(attempt.payload).approval).recordId;
 if(typeof ref!=='string')return fail();const row=byId.get(ref);if(!row)return fail();return row;
}

/** Complete provider-only history. Missing provider results are legal, but an
 * unsupported local/callback row is never filtered out to manufacture a basis.
 * Counts and fences derive from immutable attempts, not mutable state scalars.
 * This does not establish fresh approval, a due lease, actor or COMMIT authority. */
export function parseRechargeRefundProviderHistory(env:Signing,expectedScope:RechargeRefundScope,rawOperation:unknown,
 rawAttempts:unknown,rawPolicies:unknown,rawResults:unknown):RechargeRefundProviderHistory{
 const scope=captureRechargeRefundScope(expectedScope),operation=authenticateRechargeRefundRecord(env,scope,'recharge_refund_operation',rawOperation);
 const attempts=rows(rawAttempts,RECHARGE_QUERY_HISTORY_LIMITS.attempts).map(row=>authenticateRechargeRefundRecord(env,scope,'recharge_refund_attempt',row));
 if(!attempts.length)return fail();byteLimit(attempts,RECHARGE_QUERY_HISTORY_LIMITS.attemptBytes);
 const first=parseRechargeRefundFirstRequest(env,scope,operation,attempts[0]);
 const approvals=rows(rawPolicies,RECHARGE_QUERY_HISTORY_LIMITS.policies).map(row=>parseRechargeRoutineRefundAccountJournal(env,scope,row));
 byteLimit(approvals,RECHARGE_QUERY_HISTORY_LIMITS.policyBytes);
 validateRechargeRoutineRefundAccountHistory(approvals,first.payload.approval.accountId);
 const byPolicy=new Map<string,RechargeRoutineRefundAccountJournal>();
 for(const row of approvals){if(byPolicy.has(row.record_id))return fail();byPolicy.set(row.record_id,row);}
 const firstApproval=approvalFor(first.attempt,byPolicy);
 requireRechargeRoutineRefundPurpose(firstApproval,'refund_request',first.payload.issuedAt);
 if(firstApproval.created_at>first.payload.issuedAt||!same(rechargeRefundTransportApproval(firstApproval),first.payload.approval))return fail();
 const ids=new Set<string>(),leases=new Set<string>(),byAttempt=new Map<string,{row:RechargeRefundRecord;approval:RechargeRoutineRefundAccountJournal;ordinal:number}>();
 const queries:RechargeRefundQueryAttempt[]=[];let previousAt=0,earliestNextQueryAt=0;
 for(let i=0;i<attempts.length;i++){
  const row=attempts[i];
  if(row.ordinal!==i+1||row.operation_id!==operation.operation_id||typeof row.attempt_id!=='string'||typeof row.lease_id!=='string'
   ||ids.has(row.attempt_id)||leases.has(row.lease_id)||!time(row.created_at)||row.created_at>2_147_483_587
   ||i>0&&row.created_at<previousAt+60)return fail();
  const approval=approvalFor(row,byPolicy);
  if(i===0){if(row.kind!=='request')return fail();}
  else{
   const parsed=parseRechargeRefundQueryAttempt(env,scope,operation,first.attempt,firstApproval,row,approval);
   queries.push(parsed);
  }
  ids.add(row.attempt_id);leases.add(row.lease_id);byAttempt.set(row.attempt_id,{row,approval,ordinal:i+1});
  previousAt=row.created_at;earliestNextQueryAt=previousAt+60;
 }
 const resultRows=rows(rawResults,RECHARGE_QUERY_HISTORY_LIMITS.results).map(row=>authenticateRechargeRefundRecord(env,scope,'recharge_refund_result',row));
 byteLimit(resultRows,RECHARGE_QUERY_HISTORY_LIMITS.resultBytes);
 const results:RechargeRefundHistoricalProviderResult[]=[],resultIds=new Set<string>(),answered=new Set<string>(),providerIds=new Set<string>();
 let success=false,closed=false,firstPositiveAt=Number.POSITIVE_INFINITY,lastNotFoundAt=0;
 for(const row of resultRows){
  if(typeof row.result_id!=='string'||typeof row.attempt_id!=='string'||resultIds.has(row.result_id)||answered.has(row.attempt_id))return fail();
  const linked=byAttempt.get(row.attempt_id);if(!linked)return fail();
  let observation:RechargeRefundFirstProviderObservation|RechargeRefundQueryObservation;
  if(row.source==='request'){
   const parsed=parseRechargeRefundFirstProviderResult(env,scope,operation,linked.row,row,linked.approval);observation=parsed.observation;
  }else if(row.source==='query'){
   const parsed=parseRechargeRefundQueryResult(env,scope,operation,first.attempt,firstApproval,linked.row,linked.approval,row);observation=parsed.observation;
  }else return fail();
  resultIds.add(row.result_id);answered.add(row.attempt_id);
  if(observation.providerRefundId){providerIds.add(observation.providerRefundId);firstPositiveAt=Math.min(firstPositiveAt,observation.observedAt);}
  success||=observation.status==='SUCCESS';closed||=observation.status==='CLOSED';
  if(observation.status==='NOT_FOUND')lastNotFoundAt=Math.max(lastNotFoundAt,observation.observedAt);
  results.push(Object.freeze({record:row,ordinal:linked.ordinal,observation}));
 }
 const providerRefundIds=Object.freeze([...providerIds].sort());
 // A verified NOT_FOUND observed strictly before the first positive response
 // can be eventual visibility, including later PROCESSING. A negative at the
 // same/later observation time remains contradictory. Use verified observation
 // time, not ordinal or result arrival/persistence order: an older GET can
 // complete late. Terminal evidence only stops GET; it never authorizes money.
 const queryDisposition=providerIds.size>1||success&&closed||providerIds.size>0&&lastNotFoundAt>=firstPositiveAt
  ?'manual_review':success||closed?'terminal_evidence':'unresolved';
 return Object.freeze({scope,operation,first,firstApproval,attempts:Object.freeze(attempts),queries:Object.freeze(queries),
  approvals:Object.freeze(approvals),results:Object.freeze(results),totalAttempts:attempts.length,requestAttempts:1,
  queryAttempts:attempts.length-1,earliestNextQueryAt,providerRefundIds,queryDisposition});
}

/** Mutable query claim view over the same complete immutable provider closure.
 * The state-free parser above is also used by terminal replay; terminal state
 * is never rewritten as a fabricated held projection just to read history. */
export function parseRechargeRefundQueryHistory(env:Signing,expectedScope:RechargeRefundScope,rawOperation:unknown,
 rawAttempts:unknown,rawPolicies:unknown,rawResults:unknown,rawState:unknown):RechargeRefundQueryHistory{
 const h=parseRechargeRefundProviderHistory(env,expectedScope,rawOperation,rawAttempts,rawPolicies,rawResults),operation=h.operation;
 const state=captureRechargeRefundState(rawState,operation);
 if(state.wallet_state!=='held'||!['SUBMITTING','PROCESSING','UNKNOWN'].includes(state.status)||state.attempt_count!==h.attempts.length
  ||state.last_result_id!==null&&!h.results.some(r=>r.record.result_id===state.last_result_id)
  ||state.provider_refund_id!==null&&!h.providerRefundIds.includes(state.provider_refund_id))return fail();
 const tail=h.attempts[h.attempts.length-1],tailPayload=object(tail.payload);
 if(state.lease_id!==null&&(state.lease_id!==tail.lease_id||state.lease_until!==tailPayload.leaseUntil)
  ||state.next_query_at!==null&&state.next_query_at<h.earliestNextQueryAt)return fail();
 return Object.freeze({...h,state});
}
