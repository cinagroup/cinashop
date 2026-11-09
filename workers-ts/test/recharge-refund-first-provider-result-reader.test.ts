/** Synthetic signed-row decoder contracts only. These tests do not mint real
 * provider truth or establish physical rows/role/funds/dispatch authority. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundFirstProviderResult } from '@/services/payment/RechargeRefundFirstProviderResult';
import { rechargeFirstResultPureFixture,firstResultScope as scope,firstResultSigning as env,
 type RechargeFirstResultPureFixture } from './helpers/rechargeFirstProviderResultPure';
import { operationSourceUuid,sourceClone } from './helpers/rechargeRefundOperationSourcePure';
const parse=(f:RechargeFirstResultPureFixture,result:unknown=f.result(),operation:unknown=f.operation,attempt:unknown=f.attempt,approval:unknown=f.approval)=>
 parseRechargeRefundFirstProviderResult(env,scope,operation,attempt,result,approval);
describe('strict first provider result historical decoder',()=>{
 it.each(['SUCCESS','PROCESSING','CLOSED','ABNORMAL','UNKNOWN'] as const)('authenticates %s history without present-time expiry or registry access',status=>{
  const f=rechargeFirstResultPureFixture(status),parsed=parse(f);
  expect(parsed.observation.status).toBe(status);expect(parsed.record).toEqual(f.result());expect(Object.isFrozen(parsed.observation)).toBe(true);
 });
 const cases:Array<[string,(f:RechargeFirstResultPureFixture)=>unknown]>=[
  ['extra evidence',f=>f.result({extra:true})],['extra result',f=>f.result({result:{...f.evidence.result,extra:true}})],
  ['extra verification',f=>f.result({verification:{...f.evidence.verification,extra:true}})],
  ['extra approval',f=>f.result({approval:{...f.evidence.approval,extra:true}})],['extra request',f=>f.result({request:{...f.evidence.request,extra:true}})],
  ['purpose',f=>f.result({purpose:'routine_refund_provider_result'})],['format',f=>f.result({format:2})],
  ['scope',f=>f.result({scope:{...scope,adminOid:'56'}})],['operation MAC reference',f=>f.result({operationSignature:'0'.repeat(64)})],
  ['attempt MAC reference',f=>f.result({attemptSignature:'0'.repeat(64)})],['request hash',f=>f.result({requestHash:'0'.repeat(64)})],
  ['approval stamp',f=>f.result({approval:{...f.evidence.approval,credentialStamp:'0'.repeat(64)}})],
  ['wallet debit used as provider principal',f=>f.result({request:{...f.evidence.request,refundAmount:1150}})],
  ['source kind',f=>f.result({}, {source:'query'})],['source ID',f=>f.result({}, {source_id:operationSourceUuid(10)})],
  ['local result adoption',f=>f.result({}, {source:'local_settlement',attempt_id:null,caused_by_result_id:operationSourceUuid(10)})],
  ['attempt ID',f=>f.result({}, {attempt_id:operationSourceUuid(10)})],['operation ID',f=>f.result({}, {operation_id:operationSourceUuid(10)})],
  ['cause',f=>f.result({}, {caused_by_result_id:operationSourceUuid(10)})],['created/observed mismatch',f=>f.result({}, {created_at:1103})],
  ['row/payload status mismatch',f=>f.result({}, {status:'PROCESSING'})],
  ['generic FAILED adoption',f=>f.result({result:{...f.evidence.result,status:'FAILED'}},{status:'FAILED'})],
  ['empty refund ID',f=>f.result({result:{...f.evidence.result,providerRefundId:''}})],
  ['refund ID characters',f=>f.result({result:{...f.evidence.result,providerRefundId:'bad refund'}})],
  ['SUCCESS time missing',f=>f.result({result:{...f.evidence.result,successTime:0}})],
  ['SUCCESS before request clock window',f=>f.result({result:{...f.evidence.result,successTime:800}})],
  ['SUCCESS future window',f=>f.result({result:{...f.evidence.result,successTime:1403}})],
  ['known status error code',f=>f.result({result:{...f.evidence.result,errorCode:'FAILED'}})],
  ['known status negative HTTP',f=>f.result({verification:{...f.evidence.verification,httpStatus:500}})],
  ['digest',f=>f.result({verification:{...f.evidence.verification,responseDigest:'not-hex'}})],
  ['verifier key',f=>f.result({verification:{...f.evidence.verification,verifierKey:'bad key'}})],
  ['observation predates request',f=>f.result({verification:{...f.evidence.verification,observedAt:1099}},{created_at:1099})],
 ];
 it.each(cases)('rejects %s even with a newly valid enclosing synthetic MAC',(_name,mutate)=>{
  const f=rechargeFirstResultPureFixture();expect(()=>parse(f,mutate(f))).toThrow();
 });
 it.each([
  {state:'revoked'},{purposes:['refund_query']},{validUntil:1101},
 ])('requires the actual past request purpose/validity %#',patch=>{
  const f=rechargeFirstResultPureFixture('SUCCESS',patch);expect(()=>parse(f)).toThrow();
 });
 it('rejects an approval that did not exist at request issuance',()=>{
  const f=rechargeFirstResultPureFixture('SUCCESS',{},1102);expect(()=>parse(f)).toThrow();
 });
 it.each([
  {providerRefundId:'unexpected'},{successTime:1102},{errorCode:'not a code'},
 ])('rejects a negative HTTP UNKNOWN with positive/invalid business fields %#',patch=>{
  const f=rechargeFirstResultPureFixture('UNKNOWN');expect(()=>parse(f,f.result({result:{...f.evidence.result,...patch}}))).toThrow();
 });
 it('rejects UNKNOWN under a successful HTTP response and nonSUCCESS with a success time',()=>{
  const unknown=rechargeFirstResultPureFixture('UNKNOWN'),processing=rechargeFirstResultPureFixture('PROCESSING');
  expect(()=>parse(unknown,unknown.result({verification:{...unknown.evidence.verification,httpStatus:200}}))).toThrow();
  expect(()=>parse(processing,processing.result({result:{...processing.evidence.result,successTime:1102}}))).toThrow();
 });
 it('rejects operation/attempt/result/approval MAC tampering independently',()=>{
  const f=rechargeFirstResultPureFixture();
  expect(()=>parse(f,{...f.result(),signature:'0'.repeat(64)})).toThrow();
  expect(()=>parse(f,f.result(),{...f.operation,signature:'0'.repeat(64)})).toThrow();
  expect(()=>parse(f,f.result(),f.operation,{...f.attempt,signature:'0'.repeat(64)})).toThrow();
  expect(()=>parse(f,f.result(),f.operation,f.attempt,{...f.approval,signature:'0'.repeat(64)})).toThrow();
 });
 it('refuses a getter without invoking it or a fixture signer',()=>{
  const f=rechargeFirstResultPureFixture(),row=sourceClone(f.result()),evidence=row.evidence as Record<string,unknown>;let invoked=0;
  Object.defineProperty(evidence,'result',{enumerable:true,get(){invoked++;throw Error('getter must never run');}});
  expect(()=>parse(f,row)).toThrow();expect(invoked).toBe(0);
 });
 it('applies finite JSON limits directly to raw inputs without invoking a rejecting fixture signer first',()=>{
  const f=rechargeFirstResultPureFixture(),fractional=sourceClone(f.result()),oversized=sourceClone(f.result());
  ((fractional.evidence as Record<string,unknown>).verification as Record<string,unknown>).httpStatus=200.5;
  (oversized.evidence as Record<string,unknown>).extra='x'.repeat(16385);
  expect(()=>parse(f,fractional)).toThrow();expect(()=>parse(f,oversized)).toThrow();
 });
});
