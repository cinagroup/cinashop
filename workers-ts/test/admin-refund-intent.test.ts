import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { makeRefundIntent, parseRefundIntent, readRefundIntent, writeRefundIntent, refundIntentOutcome, withRefundActionLock } from '../../view/admin-ts/src/utils/refundIntent';
import type { AdminRefundDetail } from '../../view/admin-ts/src/utils/refundDetail';
const detail = (changes: Partial<AdminRefundDetail> = {}) => ({ id:25, uid:11, storeOrderId:25, storeId:0, supplierId:0, orderId:'R25',
  refundPrice:'5.00', refundedPrice:'0.00', applyType:2, refundType:0, isCancel:0, isDel:0, providerStatus:null, refuseReason:'', ...changes } as AdminRefundDetail);
beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());
it('persists canonical immutable intent, then retains a tombstone that rejects an older null CAS',()=>{
  const intent=makeRefundIntent(100,detail(),'return','',false),raw=writeRefundIntent(intent,null);
  expect(readRefundIntent(100,25)).toEqual({raw,legacy:false,intent});
  const tombstone=writeRefundIntent({...intent,phase:'resolved'},raw);
  expect(()=>writeRefundIntent(intent,null)).toThrow('其他标签页');expect(readRefundIntent(100,25).raw).toBe(tombstone);
});
it.each([{actorId:101},{refundId:26},{nonce:'bad'},{reason:'x'},{initialStatus:5},{applyType:1},{review:{uid:11}},{phase:'unknown'}])('rejects corrupted original operation %j',change=>{
  const intent=makeRefundIntent(100,detail(),'return','',false);expect(()=>parseRefundIntent({...intent,...change},100,25)).toThrow();
});
it('requires a legal receipt stage and actual acknowledgement for monetary return refunds',()=>{
  expect(()=>makeRefundIntent(100,detail(),'refund','',true)).toThrow();
  expect(()=>makeRefundIntent(100,detail({refundType:5}),'refund','',false)).toThrow();
  expect(makeRefundIntent(100,detail({applyType:3,refundType:4}),'refund','',true).received).toBe(true);
});
it('does not treat a foreign row, amount drift, cancellation or deletion as an approval outcome',()=>{
  const intent=makeRefundIntent(100,detail(),'return','',false);
  for(const change of [{uid:12},{refundPrice:'6.00'},{storeId:9},{isCancel:1},{isDel:1},{applyType:3}]) expect(refundIntentOutcome(intent,detail({refundType:4,...change})).matched).toBe(false);
  for(const refundType of [4,5,6]) expect(refundIntentOutcome(intent,detail({refundType})).matched).toBe(true);
});
it('requires exact refusal reason and a non-active provider state',()=>{
  const intent=makeRefundIntent(100,detail(),'refuse','原拒绝原因',false);
  expect(refundIntentOutcome(intent,detail({refundType:3,refuseReason:'其他原因'})).matched).toBe(false);
  expect(refundIntentOutcome(intent,detail({refundType:3,refuseReason:'原拒绝原因',providerStatus:'PROCESSING'})).matched).toBe(false);
  expect(refundIntentOutcome(intent,detail({refundType:3,refuseReason:'原拒绝原因'})).matched).toBe(true);
});
it('requires completed state, exact settled amount and no pending provider for a refund outcome',()=>{
  const intent=makeRefundIntent(100,detail({refundType:5}),'refund','',true);
  for(const change of [{refundType:5},{refundedPrice:'4.00'},{providerStatus:'PROCESSING'},{providerStatus:'FAILED'}]) expect(refundIntentOutcome(intent,detail({refundType:6,refundedPrice:'5.00',...change})).matched).toBe(false);
  expect(refundIntentOutcome(intent,detail({refundType:6,refundedPrice:'5.00',providerStatus:'SUCCESS'})).matched).toBe(true);
});
it('preserves legacy pending IDs and rejects malformed or oversized records',()=>{
  localStorage.setItem('admin-refund-pending-v1:100','[25]');expect(readRefundIntent(100,25).legacy).toBe(true);
  for(const raw of ['broken','{}','[0]',' '.repeat(12001)]) {localStorage.setItem('admin-refund-pending-v1:100',raw);expect(()=>readRefundIntent(100,25)).toThrow();}
});
it('uses non-queued exclusive entity locks and holds the lock until work settles',async()=>{
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});let locked=false;
  const request=vi.fn(async(name:string,_options:unknown,callback:(lock:unknown)=>Promise<unknown>)=>{if(locked)return callback(null);locked=true;try{return await callback({name});}finally{locked=false;}});
  vi.stubGlobal('navigator',{locks:{request}});const first=withRefundActionLock(25,()=>held);
  await expect(withRefundActionLock(25,async()=>{})).rejects.toThrow('另一标签页');expect(locked).toBe(true);
  release();await first;expect(locked).toBe(false);expect(request.mock.calls[0].slice(0,2)).toEqual(['admin-refund-action:25',{mode:'exclusive',ifAvailable:true}]);
});
