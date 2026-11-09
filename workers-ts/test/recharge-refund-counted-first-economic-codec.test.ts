/** Synthetic MAC contracts only. Actual SQL/funds/worker evidence is separate. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundCountedFirstEconomicBasis as basis } from '@/services/payment/RechargeRefundCountedFirstEconomicHistory';
import { parseRechargeRefundCountedFirstLocalCaptureResult as capture,parseRechargeRefundCountedFirstSuccessNoticeIntent as notice } from '@/services/payment/RechargeRefundCountedFirstLocalCaptureCodec';
import { parseRechargeRefundCountedFirstLocalReleaseResult as release } from '@/services/payment/RechargeRefundCountedFirstLocalReleaseCodec';
import { parseRechargeRefundQueryEconomicBasis } from '@/services/payment/RechargeRefundQueryEconomicHistory';
import { parseRechargeRefundLocalCaptureResult } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import { parseRechargeRefundLocalReleaseResult } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { decideRechargeRefundMixedRecovery as decide } from '@/services/payment/RechargeRefundMixedRecoveryDecision';
import { rechargeCountedFirstEconomicPureFixture as fixture,countedFirstSigning as env,countedFirstScope as scope } from './helpers/rechargeCountedFirstEconomicPure';
import { mixedUniverse,mixedHeldState,mixedTerminalState,appendPureCallback } from './helpers/rechargeMixedRecoveryPure';
import { historyResign } from './helpers/rechargeRefundQueryHistoryPure';
import { operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';
const obj=(v:unknown)=>v as Record<string,unknown>;
describe('original POST terminal truth after actual GET claims, distinct receipt family',()=>{
 for(const status of ['SUCCESS','CLOSED'] as const)for(const count of [2,3])for(const gift of [true,false]){
  it(status+' original cause binds actualN='+count+', gift='+gift,()=>{
   const f=fixture(status,gift,count),h=f.cause(),local=status==='SUCCESS'?f.localCapture():f.localRelease();
   const p=status==='SUCCESS'?capture(env,scope,f.history,local,f.noticeRow()):release(env,scope,f.history,local);
   expect(h.record.source).toBe('request');expect(h.claimTail.payload.ordinal).toBe(count);
   expect(p.facts.request.attemptId).not.toBe(p.facts.claimTail.attemptId);expect(local.caused_by_result_id).toBe(f.history.results[0].result_id);
   expect(p.facts.projection).toEqual({beforeVersion:count,afterVersion:count+1,totalAttempts:count});
   expect(p.facts.wallet).toEqual(status==='SUCCESS'?{beforeCents:-25,afterCents:-25}:{beforeCents:1700,afterCents:gift?2850:2700});
   const u=mixedUniverse(f.history),s=mixedHeldState(u),now=Math.max(8000,s.updated_at+61);
   expect(decide(u,s,now)).toMatchObject({action:'settle',source:'request',firstReceiptVersion:2,providerResultId:local.caused_by_result_id});
   expect(decide(u,mixedTerminalState(u,local),now,local)).toMatchObject({source:'request',firstReceiptVersion:2});
  });
 }
 for(const status of ['SUCCESS','CLOSED'] as const)for(const gift of [true,false]){
  it('checks bounded N64 '+status+' money facts independently, gift='+gift,()=>{
   const f=fixture(status,gift,64),p=status==='SUCCESS'?f.capture().facts:f.release();
   expect(p.claimTail.ordinal).toBe(64);expect(p.projection).toEqual({beforeVersion:64,afterVersion:65,totalAttempts:64});
  });
  it('routes complete original cause at bounded N64 '+status+', gift='+gift,()=>{
   const f=fixture(status,gift,64),u=mixedUniverse(f.history),s=mixedHeldState(u);
   expect(decide(u,s,8000)).toMatchObject({source:'request',firstReceiptVersion:2,providerResultId:f.history.providerResultId});
  });
 }
 it.each(['SUCCESS','CLOSED'] as const)('never reinterprets counted first %s as old N1 or query cause',status=>{
  const f=fixture(status),h={operation:f.history.operation,attempt:f.history.attempts[0],providerResult:f.history.results[0],approval:f.history.policies[0]};
  expect(()=>status==='SUCCESS'?parseRechargeRefundLocalCaptureResult(env,scope,h,f.localCapture(),f.noticeRow()):parseRechargeRefundLocalReleaseResult(env,scope,h,f.localRelease())).toThrow();
  expect(()=>parseRechargeRefundQueryEconomicBasis(env,scope,f.history)).toThrow();
  expect(()=>basis(env,scope,{...f.history,providerResultId:f.history.results[1].result_id})).toThrow();
 });
 it.each(['N1','missing-tail','orphan','unknown-request','opposite-query','bad-MAC','wrong-id'])('rejects incomplete/conflicting%s history',kind=>{
  const f=fixture(),h={...f.history,attempts:[...f.history.attempts],results:[...f.history.results]};
  if(kind==='N1'){h.attempts=h.attempts.slice(0,1);h.results=h.results.slice(0,1);}
  if(kind==='missing-tail')h.attempts=h.attempts.slice(0,1);
  if(kind==='orphan')h.providerResultId=operationSourceUuid(999);
  if(kind==='unknown-request')h.results[0]=historyResign('recharge_refund_result',h.results[0],{status:'UNKNOWN'});
  if(kind==='opposite-query'){const r=h.results[1],e=obj(r.evidence);h.results[1]=historyResign('recharge_refund_result',r,{status:'CLOSED',evidence:{...e,result:{...obj(e.result),status:'CLOSED'}}});}
  if(kind==='bad-MAC')h.attempts[1]={...h.attempts[1],signature:'0'.repeat(64)};
  if(kind==='wrong-id'){const r=h.results[1],e=obj(r.evidence);h.results[1]=historyResign('recharge_refund_result',r,{evidence:{...e,result:{...obj(e.result),providerRefundId:'another-refund'}}});}
  expect(()=>basis(env,scope,h)).toThrow();
 });
 const changes:Array<[string,(v:Record<string,unknown>)=>Record<string,unknown>]>=[
  ['tailUUID',v=>({claimTail:{...obj(v.claimTail),attemptId:operationSourceUuid(998)}})],
  ['tailMAC',v=>({claimTail:{...obj(v.claimTail),signature:'0'.repeat(64)}})],
  ['tailHash',v=>({claimTail:{...obj(v.claimTail),requestHash:'0'.repeat(64)}})],
  ['tailOrdinal',v=>({claimTail:{...obj(v.claimTail),ordinal:1}})],
  ['approval',v=>({claimTail:{...obj(v.claimTail),approvalId:operationSourceUuid(998)}})],
  ['approvalMAC',v=>({claimTail:{...obj(v.claimTail),approvalSignature:'0'.repeat(64)}})],
  ['counter',v=>({projection:{...obj(v.projection),totalAttempts:3}})],
  ['version',_=>({projection:{beforeVersion:1,afterVersion:2,totalAttempts:2}})],
  ['cause',v=>({provider:{...obj(v.provider),resultId:operationSourceUuid(998)}})],
  ['first',v=>({request:{...obj(v.request),attemptId:obj(v.claimTail).attemptId}})],
  ['wrongDomain',v=>({purpose:String(v.purpose).replace('counted-first','query')})]
 ];
 it.each(changes)('refuses altered%s in both money families',(_name,patch)=>{
  const a=fixture(),b=fixture('CLOSED');expect(()=>a.capture(a.captureFacts(patch(a.captureFacts())))).toThrow();
  expect(()=>b.release(b.releaseFacts(1700,patch(b.releaseFacts())))).toThrow();
 });
 it('does not debit SUCCESS again, cash out gift, clamp CLOSED, or partially release',()=>{
  const a=fixture(),b=fixture('CLOSED');expect(()=>a.capture(a.captureFacts({wallet:{beforeCents:-25,afterCents:-1175}}))).toThrow();
  expect(()=>a.capture(a.captureFacts({recharge:{...obj(a.captureFacts().recharge),refundAfterCents:1150}}))).toThrow();
  expect(()=>b.release(b.releaseFacts(-1200,{wallet:{beforeCents:-1200,afterCents:0}}))).toThrow();
  expect(()=>b.release(b.releaseFacts(1700,{wallet:{beforeCents:1700,afterCents:1800}}))).toThrow();
 });
 it('binds the passive notice to this first cause and actual tail',()=>{
  const f=fixture();expect(()=>notice(env,scope,f.history,f.captureFacts(),{...f.notice(),claimTail:{...f.notice().claimTail,ordinal:1}})).toThrow();
 });
 it.each(['SUCCESS','CLOSED'] as const)('keeps actual %s first local cause after later consistent callback',status=>{
  const f=fixture(status),local=status==='SUCCESS'?f.localCapture():f.localRelease(),{callback:_,...h}=appendPureCallback(f.history,status);
  expect(status==='SUCCESS'?capture(env,scope,{...h,providerResultId:f.history.providerResultId},local,f.noticeRow()).record:release(env,scope,{...h,providerResultId:f.history.providerResultId},local).record).toEqual(local);
 });
 it('refuses an unknown local purpose instead of falling back to an old decoder',()=>{
  const f=fixture(),u=mixedUniverse(f.history),local=f.localCapture(),wrong=historyResign('recharge_refund_result',local,{evidence:{...obj(local.evidence),purpose:'unknown'}});
  expect(()=>decide(u,mixedTerminalState(u,wrong),8000,wrong)).toThrow();
 });
 it('does not invoke getters on the independent complete-history boundary',()=>{
  const f=fixture();let calls=0;const h={...f.history};Object.defineProperty(h,'results',{enumerable:true,get(){calls++;return f.history.results;}});
  expect(()=>basis(env,scope,h)).toThrow();expect(calls).toBe(0);
 });
});
