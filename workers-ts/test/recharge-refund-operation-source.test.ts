/** Synthetic pure decoder contracts, not native/payment/provider acceptance. */
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundOperationSource,reconcileRechargeRefundOperationSourceHistory } from '@/services/payment/RechargeRefundOperationSource';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';
import { operationSourcePureFixture,operationSourceScope as scope,operationSourceSigning as env,operationSourceFacts,
 sourceOriginal,sourceUse,sourceClone } from './helpers/rechargeRefundOperationSourcePure';

describe('recharge operation pinned historical source pure contracts',()=>{
 it('authenticates and freezes all original, first-settlement and full five-role scope facts without issuing a capability',()=>{
  const f=operationSourcePureFixture(),parsed=parseRechargeRefundOperationSource(env,scope,sourceClone(f.operation()));
  expect(parsed).toMatchObject({holdBillId:72,appId:operationSourceFacts.appId,merchantId:operationSourceFacts.merchantId,
   operation:{wallet_after:0},approvedUseRefs:[{useId:f.use.use_id,signature:f.use.signature}]});
  expect(Object.isFrozen(parsed)).toBe(true);expect(Object.isFrozen(parsed.originals[0].payload.observation.facts)).toBe(true);
  expect(parsed).not.toHaveProperty('materials');expect(parsed).not.toHaveProperty('lease');
 });
 it.each(Object.keys(scope))('rejects a record copied into another actual scope field %s',key=>{
  const f=operationSourcePureFixture(),changed={...scope,[key]:key.endsWith('Oid')?'99':'copied_'+scope[key as keyof typeof scope]};
  expect(()=>parseRechargeRefundOperationSource(env,changed,f.operation())).toThrow();
 });
 it.each(['principal_cents','wallet_before','wallet_after','buyer_uid','recharge_id','transaction_id','created_at','signature'])
  ('rejects unsigned operation changes to %s',field=>{
   const f=operationSourcePureFixture(),raw=sourceClone(f.operation()) as Record<string,unknown>;raw[field]=field==='signature'?'a'.repeat(64):1;
   expect(()=>parseRechargeRefundOperationSource(env,scope,raw)).toThrow();
  });
 it('requires exactly the reserved three-field source and refuses old two-field holds for new transport',()=>{
  const f=operationSourcePureFixture(),normal=f.operation().payment_source as Record<string,unknown>;
  for(const payment of [{original:normal.original,holdBillId:normal.holdBillId},{...normal,ready:true}])
   expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation(f.original,{payment_source:payment}))).toThrow();
 });
 it.each([{format:1},{domain:'membership'},{approvedUseDigest:'0'.repeat(64)},{extra:true}])
  ('rejects re-signed source drift or wrong fixed digest %#',patch=>{
   const f=operationSourcePureFixture(),source={...f.original,...patch};
   if('approvedUseDigest'in patch)expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(source),[f.first],[f.use])).toThrow();
   else expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation(source))).toThrow();
  });
 it('checks both nested first-settlement and original envelope MACs even when the enclosing operation/source is re-signed',()=>{
  const f=operationSourcePureFixture(),settled=sourceClone(f.original);settled.firstSettlement.signature='0'.repeat(64);
  expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation(settled))).toThrow();
  const original=sourceClone(f.original);original.originals[0].signature='0'.repeat(64);
  expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation(original))).toThrow();
 });
 it.each([{domain:'membership'},{buyerUid:52},{orderId:32},{amountCents:999},{tradeNo:'another_transaction'},{paid:1,payType:'alipay'}])
  ('rejects a valid-MAC original bound to incompatible local facts %#',patch=>{
   const f=operationSourcePureFixture(),other=sourceOriginal(1,operationSourceFacts,patch);
   expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation({...f.original,originals:[other]}))).toThrow();
  });
 it('matches the first-settlement principal and gift to the signed operation rather than trusting a valid outer MAC',()=>{
  const f=operationSourcePureFixture();
  expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation(f.original,{gift_cents:149,debit_cents:1149,wallet_after:1}))).toThrow();
 });
 it('never reads a current merchant credential registry during pure historical decoding',()=>{
  const f=operationSourcePureFixture();let invoked=false;
  const retired={APP_KEY:env.APP_KEY,get ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS(){invoked=true;throw Error('retired');}};
  expect(parseRechargeRefundOperationSource(retired,scope,f.operation()).appId).toBe(operationSourceFacts.appId);expect(invoked).toBe(false);
 });
 it('accepts lawful later originals and use revisions while preserving the admission subset, source and digest',()=>{
  const f=operationSourcePureFixture(),extra=sourceOriginal(2),newUse=sourceUse(f.first,2),extraUse=sourceUse(extra);
  const originals=[f.first,extra].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  const uses=[f.use,newUse,extraUse].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id)||a.use_id.localeCompare(b.use_id));
  // All created_at values are identical. No timestamp boundary can select the
  // old one; exact IDs+signatures identify the first immutable subset.
  expect(newUse.created_at).toBe(f.use.created_at);
  const result=reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),originals,uses);
  expect(result.pinnedUses).toEqual([f.use]);expect(result.uses).toHaveLength(3);
  expect(result.pinned.original).toEqual(f.original);expect(result.pinned.approvedUseDigest).toBe(f.original.approvedUseDigest);
  expect(routineEvidenceHmac(env,'recharge-refund-approved-use-set',uses)).not.toBe(f.original.approvedUseDigest);
 });
 it('requires each pinned original and use to physically remain in supplied row sets with the same signature',()=>{
  const f=operationSourcePureFixture(),other=sourceOriginal(2),revision=sourceUse(f.first,2);
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),[other],[sourceUse(other)])).toThrow();
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),[f.first],[revision])).toThrow();
  const source={...f.original,approvedUseRefs:[{useId:f.use.use_id,signature:'0'.repeat(64)}]};
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(source),[f.first],[f.use])).toThrow();
 });
 it('authenticates every later related original and use instead of checking only the pinned subset',()=>{
  const f=operationSourcePureFixture(),badPair=sourceOriginal(2,{...operationSourceFacts,appId:'wx_other_account'});
  const originals=[f.first,badPair].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),originals,[f.use])).toThrow();
  const extra=sourceUse(f.first,2);extra.signature='0'.repeat(64);
  const uses=[f.use,extra].sort((a,b)=>a.use_id.localeCompare(b.use_id));
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),[f.first],uses)).toThrow();
 });
 it('does not let a re-signed fixed ref claim a use from an original that was absent from the admission source',()=>{
  const f=operationSourcePureFixture(),extra=sourceOriginal(2),extraUse=sourceUse(extra),source={...f.original,
   approvedUseRefs:[{useId:extraUse.use_id,signature:extraUse.signature}],approvedUseDigest:routineEvidenceHmac(env,'recharge-refund-approved-use-set',[extraUse])};
  const originals=[f.first,extra].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  const uses=[f.use,extraUse].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id)||a.use_id.localeCompare(b.use_id));
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(source),originals,uses)).toThrow();
 });
 it('rejects duplicate references and does not silently reorder the signed original evidence/query order',()=>{
  const f=operationSourcePureFixture();
  expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation({...f.original,approvedUseRefs:[...f.original.approvedUseRefs,...f.original.approvedUseRefs]}))).toThrow();
  const second=sourceOriginal(2),ordered=[f.first,second].sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
  expect(()=>parseRechargeRefundOperationSource(env,scope,f.operation({...f.original,originals:ordered.reverse()}))).toThrow();
 });
 it('retains an explicitly empty authenticated pre-addon use subset without inferring provider authority',()=>{
  const f=operationSourcePureFixture(),source={...f.original,approvedUseRefs:[],approvedUseDigest:routineEvidenceHmac(env,'recharge-refund-approved-use-set',[])};
  expect(reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(source),[f.first],[]).pinnedUses).toEqual([]);
 });
 it('rejects getters without invoking them and keeps the source 16KiB and physical history 64-row bounds',()=>{
  const f=operationSourcePureFixture();let invoked=false;
  const operation=sourceClone(f.operation()) as Record<string,unknown>;
  const payment=operation.payment_source as Record<string,unknown>;
  payment.original={...f.original,get approvedUseRefs(){invoked=true;return[];}};
  expect(()=>parseRechargeRefundOperationSource(env,scope,operation)).toThrow();expect(invoked).toBe(false);
  expect(()=>f.operation({...f.original,padding:'é'.repeat(8193)})).toThrow();
  const rows=new Array(1);Object.defineProperty(rows,'0',{enumerable:true,get(){invoked=true;return f.first;}});
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),rows,[f.use])).toThrow();expect(invoked).toBe(false);
  expect(()=>reconcileRechargeRefundOperationSourceHistory(env,scope,f.operation(),Array(65).fill(f.first),[f.use])).toThrow();
 });
});
