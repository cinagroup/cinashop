/** Synthetic signed-row contracts only. No SQL/role/COMMIT, actual RSA/404,
 * credential registry, ordinal continuity, query capability or funds proof. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundQueryAttempt,parseRechargeRefundQueryResult } from '@/services/payment/RechargeRefundQueryCodec';
import { rechargeRoutineRefundAccountId,parseRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { rechargeQueryPureFixture,queryScope as scope,querySigning as env,type RechargeQueryPureFixture } from './helpers/rechargeRefundQueryPure';
import { operationSourceUuid,sourceClone } from './helpers/rechargeRefundOperationSourcePure';

const attempt=(f:RechargeQueryPureFixture,row:unknown=f.attempt,approval:unknown=f.approval,firstApproval:unknown=f.first.approval)=>
 parseRechargeRefundQueryAttempt(env,scope,f.first.operation,f.first.attempt,firstApproval,row,approval);
const result=(f:RechargeQueryPureFixture,row:unknown=f.result())=>
 parseRechargeRefundQueryResult(env,scope,f.first.operation,f.first.attempt,f.first.approval,f.attempt,f.approval,row);

describe('closed recharge query historical codecs',()=>{
 it.each(['SUCCESS','PROCESSING','CLOSED','ABNORMAL','NOT_FOUND','UNKNOWN'] as const)('authenticates synthetic %s without current clock or credentials',status=>{
  const f=rechargeQueryPureFixture(status),parsed=result(f);
  expect(parsed.observation.status).toBe(status);expect(parsed.record).toEqual(f.result());
  expect(parsed.payload.request).toEqual({method:'GET',path:'/v3/refund/domestic/refunds/'+f.first.operation.out_refund_no,body:null});
  expect(Object.isFrozen(parsed.observation)).toBe(true);expect(Object.isFrozen(parsed.payload.original)).toBe(true);
 });
 it('pins rotated query credentials for the same original pair without requiring the old request credential',()=>{
  const f=rechargeQueryPureFixture(),parsed=attempt(f);
  expect(parsed.approval.payload.data.credentialVersion).toBe(2);
  expect(parsed.firstApproval.payload.data.credentialVersion).toBe(1);
  expect(parsed.payload.approval.appId).toBe(parsed.firstRequest.approval.appId);
 });
 it('accepts one independent recharge approval carrying both purposes rather than inventing a different-record rule',()=>{
  const f=rechargeQueryPureFixture('SUCCESS',{firstPolicy:{purposes:['refund_request','refund_query'],validUntil:4000},reuseFirstApproval:true});
  expect(attempt(f).approval.record_id).toBe(f.first.approval.record_id);
 });
 it('accepts an old SUCCESS before the query minus300 window, using the original POST lower bound',()=>{
  const f=rechargeQueryPureFixture(),parsed=result(f);
  expect(parsed.observation.successTime).toBe(1102);expect(parsed.observation.successTime).toBeLessThan(f.issuedAt-300);
 });
 it('decodes ordinal3 individually without pretending that its physical predecessor exists',()=>{
  const f=rechargeQueryPureFixture('PROCESSING',{ordinal:3,issuedAt:2061});expect(attempt(f).attempt.ordinal).toBe(3);
 });
 it('keeps the initial sixty-second query fence with an approval already valid on both sides',()=>{
  const options={queryPolicy:{validFrom:800},queryApprovalCreatedAt:1100};
  expect(attempt(rechargeQueryPureFixture('PROCESSING',{...options,issuedAt:1161})).payload.issuedAt).toBe(1161);
  expect(()=>attempt(rechargeQueryPureFixture('PROCESSING',{...options,issuedAt:1160}))).toThrow();
 });
 const attemptCases:Array<[string,(f:RechargeQueryPureFixture)=>unknown]>=[
  ['extra payload',f=>f.queryAttempt({unknown:true})],['format',f=>f.queryAttempt({format:2})],
  ['wrong purpose',f=>f.queryAttempt({purpose:'recharge-refund-first-request-v1'})],
  ['scope',f=>f.queryAttempt({scope:{...scope,adminOid:'56'}})],['operation ID',f=>f.queryAttempt({operationId:operationSourceUuid(99)})],
  ['operation signature',f=>f.queryAttempt({operationSignature:'0'.repeat(64)})],
  ['first attempt ID',f=>f.queryAttempt({firstAttemptId:operationSourceUuid(99)})],
  ['first attempt signature',f=>f.queryAttempt({firstAttemptSignature:'0'.repeat(64)})],
  ['first hash',f=>f.queryAttempt({firstRequestHash:'0'.repeat(64)})],['first issuedAt',f=>f.queryAttempt({firstIssuedAt:1102})],
  ['ordinal1',f=>f.queryAttempt({ordinal:1},{ordinal:1})],['ordinal mismatch',f=>f.queryAttempt({ordinal:3})],
  ['query kind',f=>f.queryAttempt({}, {kind:'request'})],['attempt ID reused from POST',f=>f.queryAttempt({}, {attempt_id:f.first.attempt.attempt_id})],
  ['row operation',f=>f.queryAttempt({}, {operation_id:operationSourceUuid(99)})],
  ['lease mismatch',f=>f.queryAttempt({leaseId:operationSourceUuid(99)})],
  ['POST lease reuse',f=>f.queryAttempt({leaseId:f.first.attempt.lease_id},{lease_id:f.first.attempt.lease_id})],
  ['lease length',f=>f.queryAttempt({leaseUntil:f.issuedAt+31})],['time mismatch',f=>f.queryAttempt({issuedAt:2001})],
  ['query scope approval metadata',f=>f.queryAttempt({approval:{...f.payload.approval,credentialStamp:'0'.repeat(64)}})],
  ['extra approval',f=>f.queryAttempt({approval:{...f.payload.approval,extra:true}})],
  ['original transaction',f=>f.queryAttempt({original:{...f.payload.original,transactionId:'other'}})],
  ['gift debit as principal',f=>f.queryAttempt({original:{...f.payload.original,refundAmount:1150}})],
  ['original total',f=>f.queryAttempt({original:{...f.payload.original,totalAmount:1150}})],
  ['original currency',f=>f.queryAttempt({original:{...f.payload.original,currency:'USD'}})],
  ['extra original',f=>f.queryAttempt({original:{...f.payload.original,extra:true}})],
  ['POST method',f=>f.queryAttempt({request:{...f.payload.request,method:'POST'}})],
  ['wrong refund URL',f=>f.queryAttempt({request:{...f.payload.request,path:'/v3/refund/domestic/refunds/other'}})],
  ['URL query suffix',f=>f.queryAttempt({request:{...f.payload.request,path:f.payload.request.path+'?retry=1'}})],
  ['absolute URL',f=>f.queryAttempt({request:{...f.payload.request,path:'https://api.mch.weixin.qq.com'+f.payload.request.path}})],
  ['nonempty GET body',f=>f.queryAttempt({request:{...f.payload.request,body:{}}})],
  ['extra request field',f=>f.queryAttempt({request:{...f.payload.request,notifyUrl:'https://other.example'}})],
  ['request hash',f=>f.queryAttempt({}, {request_hash:'0'.repeat(64)})],
 ];
 it.each(attemptCases)('rejects attempt %s with a valid new synthetic outer MAC/hash',(_name,mutate)=>{
  const f=rechargeQueryPureFixture();expect(()=>attempt(f,mutate(f))).toThrow();
 });
 const resultCases:Array<[string,(f:RechargeQueryPureFixture)=>unknown]>=[
  ['extra evidence',f=>f.result({extra:true})],['purpose',f=>f.result({purpose:'recharge-refund-first-provider-result-v1'})],
  ['format',f=>f.result({format:2})],['scope',f=>f.result({scope:{...scope,adminOid:'56'}})],
  ['operation signature',f=>f.result({operationSignature:'0'.repeat(64)})],
  ['first attempt ID',f=>f.result({firstAttemptId:operationSourceUuid(99)})],
  ['first signature',f=>f.result({firstAttemptSignature:'0'.repeat(64)})],['first hash',f=>f.result({firstRequestHash:'0'.repeat(64)})],
  ['query signature',f=>f.result({queryAttemptSignature:'0'.repeat(64)})],['query hash',f=>f.result({requestHash:'0'.repeat(64)})],
  ['approval',f=>f.result({approval:{...f.evidence.approval,credentialVersion:3}})],
  ['original amount',f=>f.result({original:{...f.evidence.original,totalAmount:1150}})],
  ['request body',f=>f.result({request:{...f.evidence.request,body:'null'}})],
  ['extra result',f=>f.result({result:{...f.evidence.result,extra:true}})],
  ['extra verification',f=>f.result({verification:{...f.evidence.verification,extra:true}})],
  ['source',f=>f.result({}, {source:'request'})],['source ID',f=>f.result({}, {source_id:operationSourceUuid(99)})],
  ['operation',f=>f.result({}, {operation_id:operationSourceUuid(99)})],['attempt',f=>f.result({}, {attempt_id:f.first.attempt.attempt_id})],
  ['cause',f=>f.result({}, {caused_by_result_id:operationSourceUuid(99)})],
  ['timestamp',f=>f.result({}, {created_at:2002})],['row status',f=>f.result({}, {status:'PROCESSING'})],
  ['FAILED',f=>f.result({result:{...f.evidence.result,status:'FAILED'}},{status:'FAILED'})],
  ['refund ID',f=>f.result({result:{...f.evidence.result,providerRefundId:''}})],
  ['success before original POST window',f=>f.result({result:{...f.evidence.result,successTime:800}})],
  ['success beyond observed window',f=>f.result({result:{...f.evidence.result,successTime:2302}})],
  ['success error',f=>f.result({result:{...f.evidence.result,errorCode:'SYSTEM_ERROR'}})],
  ['success HTTP error',f=>f.result({verification:{...f.evidence.verification,httpStatus:500}})],
  ['digest',f=>f.result({verification:{...f.evidence.verification,responseDigest:'bad'}})],
  ['verifier',f=>f.result({verification:{...f.evidence.verification,verifierKey:'bad key'}})],
  ['observed before query',f=>f.result({verification:{...f.evidence.verification,observedAt:1998}},{created_at:1998})],
 ];
 it.each(resultCases)('rejects result %s even with a valid new synthetic enclosing MAC',(_name,mutate)=>{
  const f=rechargeQueryPureFixture();expect(()=>result(f,mutate(f))).toThrow();
 });
 it.each([{state:'revoked'},{purposes:['refund_request']},{validFrom:2001},{validUntil:2000}])('requires query approval at query issuedAt %#',queryPolicy=>{
  const f=rechargeQueryPureFixture('SUCCESS',{queryPolicy});expect(()=>attempt(f)).toThrow();
 });
 it('rejects query approval created after issuance and original approval unavailable at original issuance',()=>{
  expect(()=>attempt(rechargeQueryPureFixture('SUCCESS',{queryApprovalCreatedAt:2001}))).toThrow();
  expect(()=>attempt(rechargeQueryPureFixture('SUCCESS',{firstApprovalCreatedAt:1102}))).toThrow();
  expect(()=>attempt(rechargeQueryPureFixture('SUCCESS',{firstPolicy:{purposes:['refund_query']}}))).toThrow();
 });
 it.each([{appId:'wx_other_pair'},{merchantId:'99887766'}])('rejects a valid recharge query approval for another original pair %#',patch=>{
  const base=rechargeQueryPureFixture(),pair={appId:base.approval.payload.data.appId,merchantId:base.approval.payload.data.merchantId,...patch};
  const queryPolicy={...pair,accountId:rechargeRoutineRefundAccountId(env,pair.appId,pair.merchantId)};
  const f=rechargeQueryPureFixture('SUCCESS',{queryPolicy}),data=f.approval.payload.data;
  expect(f.approval.account_id).toBe(rechargeRoutineRefundAccountId(env,data.appId,data.merchantId));
  expect(data.accountId).toBe(f.approval.account_id);
  expect(parseRechargeRoutineRefundAccountJournal(env,scope,f.approval)).toEqual(f.approval);
  expect(()=>attempt(f)).toThrow();
 });
 it.each([400,401,403,404,429,500,599])('accepts UNKNOWN HTTP%s with no positive business fields',httpStatus=>{
  const f=rechargeQueryPureFixture('UNKNOWN');expect(result(f,f.result({verification:{...f.evidence.verification,httpStatus}})).observation.status).toBe('UNKNOWN');
 });
 it('reserves 404 RESOURCE_NOT_EXISTS for NOT_FOUND, never a request rejection',()=>{
  const f=rechargeQueryPureFixture('NOT_FOUND');expect(result(f).observation.errorCode).toBe('RESOURCE_NOT_EXISTS');
  for(const patch of [{httpStatus:200},{httpStatus:500}])expect(()=>result(f,f.result({verification:{...f.evidence.verification,...patch}}))).toThrow();
  expect(()=>result(f,f.result({result:{...f.evidence.result,errorCode:'OTHER'}}))).toThrow();
  const u=rechargeQueryPureFixture('UNKNOWN');expect(()=>result(u,u.result({result:{...u.evidence.result,errorCode:'RESOURCE_NOT_EXISTS'},
   verification:{...u.evidence.verification,httpStatus:404}}))).toThrow();
 });
 it('rejects UNKNOWN under successful/invalid HTTP and any positive fields on negative results',()=>{
  for(const status of ['UNKNOWN','NOT_FOUND'] as const){
   const f=rechargeQueryPureFixture(status);
   for(const patch of [{providerRefundId:'unexpected'},{successTime:1102},{errorCode:'bad code'}])
    expect(()=>result(f,f.result({result:{...f.evidence.result,...patch}}))).toThrow();
  }
  const f=rechargeQueryPureFixture('UNKNOWN');for(const httpStatus of [200,399,600])
   expect(()=>result(f,f.result({verification:{...f.evidence.verification,httpStatus}}))).toThrow();
 });
 it('rejects success time on PROCESSING and lower/upper scalar bounds without changing retry policy',()=>{
  const f=rechargeQueryPureFixture('PROCESSING');expect(()=>result(f,f.result({result:{...f.evidence.result,successTime:1102}}))).toThrow();
  expect(()=>attempt(f,f.queryAttempt({ordinal:0},{ordinal:0}))).toThrow();
  const last=rechargeQueryPureFixture('PROCESSING',{issuedAt:2147483640,queryApprovalCreatedAt:2147483630,
   queryPolicy:{validFrom:2147483630,validUntil:2147483647}});
  expect(()=>attempt(last)).toThrow();
 });
 it('rejects operation, first attempt, both approvals, query attempt and result MAC tampering independently',()=>{
  const f=rechargeQueryPureFixture();
  for(const index of [0,1,2,3,4,5]){
   const rows:unknown[]=[f.first.operation,f.first.attempt,f.first.approval,f.attempt,f.approval,f.result()];
   rows[index]={...(rows[index] as Record<string,unknown>),signature:'0'.repeat(64)};
   expect(()=>parseRechargeRefundQueryResult(env,scope,rows[0],rows[1],rows[2],rows[3],rows[4],rows[5])).toThrow();
  }
 });
 it('does not invoke accessors or toJSON while rejecting raw executable metadata before any fixture signer',()=>{
  const f=rechargeQueryPureFixture();let calls=0;
  for(const key of ['result','toJSON']){
   const row=sourceClone(f.result()),e=row.evidence as Record<string,unknown>;
   if(key==='result')Object.defineProperty(e,key,{enumerable:true,get(){calls++;return f.evidence.result;}});
   else Object.defineProperty(e,key,{value:()=>{calls++;return f.evidence;}});
   expect(()=>result(f,row)).toThrow();
  }
  expect(calls).toBe(0);
 });
 it('applies finite raw JSON bounds and rejects unknown/symbol/nonplain metadata without a fixture signer',()=>{
  const f=rechargeQueryPureFixture();
  const values:unknown[]=[Symbol('unknown'),new Date(0),'x'.repeat(16385),[NaN],Array(1)];
  const cycle:Record<string,unknown>={};cycle.self=cycle;values.push(cycle);
  for(const extra of values){const row=sourceClone(f.result());(row.evidence as Record<string,unknown>).extra=extra;expect(()=>result(f,row)).toThrow();}
  const row=sourceClone(f.attempt);Object.defineProperty(row,'unknown',{value:true});expect(()=>attempt(f,row)).toThrow();
  const symbol=sourceClone(f.attempt);Object.defineProperty(symbol,Symbol('unknown'),{value:true});expect(()=>attempt(f,symbol)).toThrow();
 });
 it('returns copied deeply frozen history rather than a mutable caller-owned payload or a send capability',()=>{
  const f=rechargeQueryPureFixture(),raw=sourceClone(f.attempt),parsed=attempt(f,raw);
  ((raw.payload as Record<string,unknown>).request as Record<string,unknown>).path='changed';
  expect(parsed.payload.request.path).toBe(f.payload.request.path);expect(Object.isFrozen(parsed.payload.request)).toBe(true);
  expect(Object.keys(parsed)).toEqual(['scope','operation','firstAttempt','firstRequest','firstApproval','attempt','payload','approval']);
 });
});
