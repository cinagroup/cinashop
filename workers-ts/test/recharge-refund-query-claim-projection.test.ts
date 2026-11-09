/** Synthetic closed history only, no SQL/lease/COMMIT/provider claim evidence. */
import { describe,expect,it } from 'vitest';
import { rechargeRefundQueryClaimProjection } from '@/services/payment/RechargeRefundQueryClaimProjection';
import { parseRechargeRefundQueryHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { historyScope as scope,historySigning as env,rechargeQueryHistoryPureFixture } from './helpers/rechargeRefundQueryHistoryPure';
describe('closed query claim projections',()=>{
 function history(n=1){const f=rechargeQueryHistoryPureFixture(n);return parseRechargeRefundQueryHistory(env,scope,f.operation,f.attempts,f.policies,f.results,f.state);}
 it.each([1,2,3,63])('accepts only first or ownquery projection%s with lifetimePOST1',n=>{
  const h=history(n),p=rechargeRefundQueryClaimProjection(h);
  expect(p).toMatchObject({totalAttempts:n,nextOrdinal:n+1,previousVersion:n,previousStatus:n===1?'SUBMITTING':'UNKNOWN'});
  expect(h.requestAttempts).toBe(1);expect(p.nextQueryAt).toBe(h.earliestNextQueryAt);expect(Object.isFrozen(p)).toBe(true);
 });
 it.each([
  ['version',{version:4}],['PROCESSING',{status:'PROCESSING'}],['clearedlease',{lease_id:null,lease_until:null}],
  ['futuretimer',{next_query_at:9000}],['missingtimer',{next_query_at:null}],['differentupdate',{updated_at:9000}],
  ['providerpointer',{provider_refund_id:'invented'}],['resultpointer',{last_result_id:'invented'}],['count',{attempt_count:1}],
 ] as const)('rejects unsupported mutable %s without upgrading it to claim permission',(_name,patch)=>{
  const h=history(2);expect(()=>rechargeRefundQueryClaimProjection({...h,state:{...h.state,...patch} as typeof h.state})).toThrow();
 });
 it.each(['terminal_evidence','manual_review'] as const)('refuses observed %s even with an untouched scalar',queryDisposition=>{
  const h=history();expect(()=>rechargeRefundQueryClaimProjection({...h,queryDisposition})).toThrow();
 });
 it('keeps a full64 history readable but requires manual handling rather than truncating or writingFAILED',()=>{
  const h=history(64);expect(h.totalAttempts).toBe(64);expect(()=>rechargeRefundQueryClaimProjection(h)).toThrow();
  expect(h.state.wallet_state).toBe('held');expect(h.state.status).toBe('UNKNOWN');
 });
 it('does not let an UNKNOWN firstPOST or SUBMITTING query projection invent an author chain',()=>{
  const a=history(),b=history(2);
  expect(()=>rechargeRefundQueryClaimProjection({...a,state:{...a.state,status:'UNKNOWN'}})).toThrow();
  expect(()=>rechargeRefundQueryClaimProjection({...b,state:{...b.state,status:'SUBMITTING'}})).toThrow();
 });
});
