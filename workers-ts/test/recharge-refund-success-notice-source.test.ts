/** MAC/source decoding contracts only; actual App, funds and provider I/O are
 * proved separately. These fixtures never grant sending authority. */
import {describe,expect,it}from 'vitest';
import {parseRechargeRefundSuccessNoticeHistory as parse}from '@/services/payment/RechargeRefundSuccessNoticeSource';
import {rechargeLocalCapturePureFixture}from './helpers/rechargeLocalCapturePure';
import {rechargeQueryEconomicPureFixture}from './helpers/rechargeQueryEconomicPure';
import {rechargeCallbackEconomicPureFixture}from './helpers/rechargeCallbackEconomicPure';
import {rechargeCountedFirstEconomicPureFixture}from './helpers/rechargeCountedFirstEconomicPure';
import {appendPureCallback,mixedUniverse,mixedTerminalState,mixedScope as scope,mixedSigning as env}from './helpers/rechargeMixedRecoveryPure';
import {operationSourceUuid}from './helpers/rechargeRefundOperationSourcePure';
type Family='first'|'counted-first'|'query'|'callback';
function fixture(family:Family,gift=true,count=2){
 const f=family==='first'?rechargeLocalCapturePureFixture(gift):family==='query'?rechargeQueryEconomicPureFixture('SUCCESS',gift,count)
  :family==='counted-first'?rechargeCountedFirstEconomicPureFixture('SUCCESS',gift,count):rechargeCallbackEconomicPureFixture('SUCCESS',gift,count);
 const h=f.history,history='attempts'in h?{operation:h.operation,attempts:h.attempts,policies:h.policies,results:h.results}
  :{operation:h.operation,attempts:[h.attempt],policies:[h.approval],results:[h.providerResult]};
 // Construct synthetic signed facts once. This retains the entire measured
 // fixture and actual decoder within the 5s case; no setup/cache hides work.
 const facts='captureFacts'in f?f.captureFacts():f.facts();
 const local='localCapture'in f?f.localCapture(facts):f.local(facts),notice='noticeRow'in f?f.noticeRow(facts):f.row(facts);
 return{...history,local,notice,state:mixedTerminalState(mixedUniverse(history),local)};
}
describe('refund success notice selects its original distinct settlement family',()=>{
 for(const family of ['first','counted-first','query','callback']as const)for(const gift of [true,false]){
  for(const count of family==='first'?[1]:family==='callback'?[1,2,3,64]:[2,3,64]){
   it(`${family} N${count} gift=${gift}`,()=>{const raw=fixture(family,gift,count),v=parse(env,scope,raw);
    expect(v.family).toBe(family);expect(v.state.last_result_id).toBe(raw.local.result_id);expect(v.local.caused_by_result_id).toBe(v.cause.result_id);
    expect(v.state.attempt_count).toBe(count);expect(v.facts.recharge.principalCents).toBe(1000);expect(v.facts.recharge.debitCents).toBe(gift?1150:1000);
    expect(v.facts.recharge.postReservationBalanceCents).toBe(gift?0:150);expect(Object.isFrozen(v)).toBe(true);expect(v).not.toHaveProperty('capability');
   });
  }
 }
 for(const family of ['first','counted-first','query']as const){
  it(`keeps ${family} cause after a late consistent callback`,()=>{const raw=fixture(family),late=appendPureCallback(raw,'SUCCESS');
   const {callback:_,...h}=late,after=parse(env,scope,{...raw,...h});expect(after.local).toEqual(raw.local);expect(after.family).toBe(family);expect(after.universe.callbacks).toHaveLength(1);
  });
  it.each(['opposite','refund-id','success-time','MAC'])(`rejects ${family} late %s conflict`,mutation=>{
   const raw=fixture(family),{callback:_,...h}=appendPureCallback(raw,mutation==='opposite'?'CLOSED':'SUCCESS',mutation==='refund-id'?{providerRefundId:'other'}:mutation==='success-time'?{successTime:1103}:{});
   if(mutation==='MAC')h.results[h.results.length-1]={...h.results.at(-1)!,signature:'0'.repeat(64)};
   expect(()=>parse(env,scope,{...raw,...h})).toThrow();
  });
 }
 it.each(['local-pointer','cause-pointer','version','counter','wallet','status','lease','next-query','provider','timestamp','notice-MAC','local-MAC','notice-family'])(
  'refuses changed %s',field=>{const raw=fixture('callback'),s=raw.state;
   const state={...s,...(field==='local-pointer'?{last_result_id:operationSourceUuid(888)}:field==='version'?{version:s.version+1}:field==='counter'?{attempt_count:s.attempt_count+1}
    :field==='wallet'?{wallet_state:'held'}:field==='status'?{status:'UNKNOWN'}:field==='lease'?{lease_id:operationSourceUuid(889)}
     :field==='next-query'?{next_query_at:2700}:field==='provider'?{provider_refund_id:'other'}:field==='timestamp'?{updated_at:s.updated_at+1}:{})};
   const local=field==='cause-pointer'?{...raw.local,caused_by_result_id:operationSourceUuid(887)}:field==='local-MAC'?{...raw.local,signature:'0'.repeat(64)}:raw.local;
   const notice=field==='notice-MAC'?{...raw.notice,payload:{...raw.notice.payload,signature:'0'.repeat(64)}}:field==='notice-family'?fixture('first').notice:raw.notice;
   expect(()=>parse(env,scope,{...raw,state,local,notice})).toThrow();
  });
 it('rejects getters and extra outer data before evaluating it',()=>{let reads=0;const raw=fixture('first');
  const getter={...raw};Object.defineProperty(getter,'local',{enumerable:true,get(){reads++;throw Error('must not read');}});
  expect(()=>parse(env,scope,getter)).toThrow();expect(reads).toBe(0);const extra={...raw,currentWallet:999};expect(()=>parse(env,scope,extra)).toThrow();
 });
 it('rejects a foreign scope and signing key',()=>{const raw=fixture('query');expect(()=>parse({APP_KEY:'different-inert-key'},scope,raw)).toThrow();expect(()=>parse(env,{...scope,databaseOid:'999'},raw)).toThrow();});
});
