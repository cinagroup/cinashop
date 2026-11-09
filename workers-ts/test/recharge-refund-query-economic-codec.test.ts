/** Pure synthetic history only; SQL/financial acceptance is a separate suite. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundProviderHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundQueryEconomicBasis } from '@/services/payment/RechargeRefundQueryEconomicHistory';
import { parseRechargeRefundQueryLocalCaptureResult,parseRechargeRefundQuerySuccessNoticeIntent } from '@/services/payment/RechargeRefundQueryLocalCaptureCodec';
import { parseRechargeRefundQueryLocalReleaseResult } from '@/services/payment/RechargeRefundQueryLocalReleaseCodec';
import { parseRechargeRefundLocalCaptureResult } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import { parseRechargeRefundLocalReleaseResult } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { rechargeQueryEconomicPureFixture as fixture,queryEconomicScope as scope,queryEconomicSigning as env } from './helpers/rechargeQueryEconomicPure';
import { historyResign } from './helpers/rechargeRefundQueryHistoryPure';
import { sourceClone,operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';
const obj=(v:unknown)=>v as Record<string,unknown>;
describe('separate complete query economic receipt family',()=>{
 for(const gift of [true,false])for(const count of [2,3]){
  it('captures query SUCCESS without another wallet debit, gift='+gift+', attempts='+count,()=>{
   const f=fixture('SUCCESS',gift,count),p=parseRechargeRefundQueryLocalCaptureResult(env,scope,f.history,f.localCapture(),f.noticeRow());
   expect(p.facts.wallet).toEqual({beforeCents:-25,afterCents:-25});expect(p.facts.flow.priceCents).toBe(-1000);
   expect(p.facts.projection).toEqual({beforeVersion:count,afterVersion:count+1,totalAttempts:count});
   expect(p.facts.request.attemptId).not.toBe(p.facts.query.attemptId);expect(p.facts.query.ordinal).toBe(count);
   expect(p.notice.payload.business.postBalanceCents).toBe(gift?0:150);expect(p.notice.payload.query).toEqual(p.facts.query);
   expect(p.record.caused_by_result_id).toBe(f.history.providerResultId);
  });
  it('releases query CLOSED exactly once against a later balance, gift='+gift+', attempts='+count,()=>{
   const f=fixture('CLOSED',gift,count),p=parseRechargeRefundQueryLocalReleaseResult(env,scope,f.history,f.localRelease());
   expect(p.facts.wallet).toEqual({beforeCents:1700,afterCents:gift?2850:2700});expect(p.facts.recharge.refundAfterCents).toBe(0);
   expect(p.facts.projection.totalAttempts).toBe(count);expect(p.record.caused_by_result_id).toBe(f.history.providerResultId);
  });
 }
 it.each(['UNKNOWN','NOT_FOUND','ABNORMAL','PROCESSING']as const)('never promotes authenticated %s to an economic cause',status=>{
  const f=fixture(status);expect(()=>f.cause()).toThrow();
 });
 it('reads immutable terminal provider history without manufacturing a mutable held state',()=>{
  const f=fixture(),h=f.history;
  const p=parseRechargeRefundProviderHistory(env,scope,h.operation,h.attempts,h.policies,h.results);
  expect(p.queryDisposition).toBe('terminal_evidence');expect(p).not.toHaveProperty('state');
 });
 it.each(['request','local','orphan']as const)('refuses %s as caller-selected query cause',kind=>{
  const f=fixture(),id=kind==='request'?f.history.results[0].result_id:kind==='local'?f.localCapture().result_id:operationSourceUuid(990);
  expect(()=>parseRechargeRefundQueryEconomicBasis(env,scope,{...f.history,providerResultId:id})).toThrow();
 });
 it('does not filter a local or callback record to manufacture fresh economics',()=>{
  const f=fixture();for(const source of ['local_settlement','callback']){
   const extra=historyResign('recharge_refund_result',f.history.results[0],{result_id:operationSourceUuid(991),attempt_id:null,source});
   expect(()=>parseRechargeRefundQueryEconomicBasis(env,scope,{...f.history,results:[...f.history.results,extra]})).toThrow();
  }
 });
 it('does not let a terminal response mask a newer contradictory negative during economic closure',()=>{
  const f=fixture('SUCCESS',true,3),row=f.history.results[1],e=obj(row.evidence),at=Number(f.history.results[2].created_at)+10;
  const negative=historyResign('recharge_refund_result',row,{created_at:at,evidence:{...e,verification:{...obj(e.verification),observedAt:at}}});
  expect(()=>parseRechargeRefundQueryEconomicBasis(env,scope,{...f.history,results:[f.history.results[0],negative,f.history.results[2]]})).toThrow();
 });
 const changes:Array<[string,(v:Record<string,unknown>)=>Record<string,unknown>]>=[
  ['queryUUID',v=>({query:{...obj(v.query),attemptId:operationSourceUuid(992)}})],
  ['queryMAC',v=>({query:{...obj(v.query),signature:'0'.repeat(64)}})],
  ['queryHash',v=>({query:{...obj(v.query),requestHash:'0'.repeat(64)}})],
  ['queryOrdinal',v=>({query:{...obj(v.query),ordinal:1}})],
  ['approvalUUID',v=>({query:{...obj(v.query),approvalId:operationSourceUuid(992)}})],
  ['approvalMAC',v=>({query:{...obj(v.query),approvalSignature:'0'.repeat(64)}})],
  ['missingAttemptCount',_v=>({projection:{beforeVersion:2,afterVersion:3}})],
  ['inflatedVersion',_v=>({projection:{beforeVersion:99,afterVersion:100,totalAttempts:2}})],
  ['wrongCount',v=>({projection:{...obj(v.projection),totalAttempts:3}})],
  ['anotherFirstPOST',v=>({request:{...obj(v.request),attemptId:obj(v.query).attemptId}})],
  ['anotherProvider',v=>({provider:{...obj(v.provider),resultId:operationSourceUuid(992)}})],
 ];
 it.each(changes)('rejects altered %s for both separate receipt families',(_name,patch)=>{
  const a=fixture(),b=fixture('CLOSED');expect(()=>a.capture(a.captureFacts(patch(a.captureFacts())))).toThrow();
  expect(()=>b.release(b.releaseFacts(1700,patch(b.releaseFacts())))).toThrow();
 });
 it.each(['2100',2100.5,null,{}])('rejects a non-integer local clock before comparing it to the authenticated query tail %#',clock=>{
  const a=fixture(),b=fixture('CLOSED'),capture=a.captureFacts(),release=b.releaseFacts();
  expect(()=>a.capture(a.captureFacts({capturedAt:clock,flow:{...obj(capture.flow),addTime:clock}}))).toThrow();
  expect(()=>b.release(b.releaseFacts(1700,{releasedAt:clock,bill:{...obj(release.bill),addTime:clock}}))).toThrow();
 });
 it('cannot debit the current wallet again or turn gifted balance into external cash',()=>{
  const f=fixture();expect(()=>f.capture(f.captureFacts({wallet:{beforeCents:-25,afterCents:-1175}}))).toThrow();
  expect(()=>f.capture(f.captureFacts({recharge:{...obj(f.captureFacts().recharge),refundAfterCents:1150}}))).toThrow();
 });
 it('cannot clamp the current release wallet or return only a partial original hold',()=>{
  const f=fixture('CLOSED');expect(()=>f.release(f.releaseFacts(-1200,{wallet:{beforeCents:-1200,afterCents:0}}))).toThrow();
  expect(()=>f.release(f.releaseFacts(1700,{wallet:{beforeCents:1700,afterCents:1800}}))).toThrow();
 });
 it('keeps first-only codecs closed instead of reinterpreting a query as its first POST',()=>{
  const a=fixture(),b=fixture('CLOSED');
  const h=(f:ReturnType<typeof fixture>)=>({operation:f.history.operation,attempt:f.history.attempts[0],approval:f.history.policies[0],providerResult:f.history.results[1]});
  expect(()=>parseRechargeRefundLocalCaptureResult(env,scope,h(a),a.localCapture(),a.noticeRow())).toThrow();
  expect(()=>parseRechargeRefundLocalReleaseResult(env,scope,h(b),b.localRelease())).toThrow();
 });
 it('authenticates the distinct notice query binding and MAC independently',()=>{
  const f=fixture(),row=f.noticeRow();
  expect(()=>parseRechargeRefundQuerySuccessNoticeIntent(env,scope,f.history,f.captureFacts(),{...f.notice(),query:{...f.notice().query,ordinal:1}})).toThrow();
  expect(()=>parseRechargeRefundQueryLocalCaptureResult(env,scope,f.history,f.localCapture(),{...row,payload:{...row.payload,signature:'0'.repeat(64)}})).toThrow();
 });
 it('rejects getters on the independent history boundary without invoking them',()=>{
  const f=fixture();let calls=0;const h={...f.history};Object.defineProperty(h,'results',{enumerable:true,get(){calls++;return f.history.results;}});
  expect(()=>parseRechargeRefundQueryEconomicBasis(env,scope,h)).toThrow();expect(calls).toBe(0);
 });
 it('returns independent frozen facts and rejects another closed scope',()=>{
  const f=fixture(),raw=sourceClone(f.captureFacts()),p=f.capture(raw);expect(Object.isFrozen(p.facts.query)).toBe(true);
  expect(()=>parseRechargeRefundQueryEconomicBasis(env,{...scope,financialOid:'56'},f.history)).toThrow();
 });
});
