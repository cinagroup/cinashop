import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { parseAdminRefundCreation, adminRefundCreationNumber } from '../src/services/admin/AdminRefundCreationProtocol';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { applyCreationFinancialResult, applyCreationResponse, creationFinancialIntent, creationIntentKey, creationMessage,
  creationSelection, creationVersion, makeCreationIntent, parseCreationBody, parseCreationIntent, parseCreationQuote,
  readCreationIntent, verifyCreationIntent, withCreationLock, writeCreationIntent, type CreationIntent } from '../../view/admin-ts/src/utils/refundCreation';
import { operationBody } from '../../view/admin-ts/src/utils/refundOperation';

beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());
const request=()=>creationSelection(1,'remaining');
const quote=()=>parseCreationQuote({version:'admin-refund-creation-quote-v1',review:{id:1,orderId:'order_1',uid:11,storeId:0,supplierId:0,payPrice:'0010.00',totalNum:3,status:0,refundPrice:'0.00',payType:'yue'},
  mode:'remaining',items:[{cartId:502,cartNum:1},{cartId:501,cartNum:2}],quotedPrice:'10.00',refundNum:3,refundTimeDays:0,receivedAt:null,quoteFingerprint:'a'.repeat(64)},request());
const make=()=>makeCreationIntent(100,quote(),'3.00',' 主动测试退款 ');
it.each([null,0,1700000000])('accepts server receipt time %j without inventing a delivery date',receivedAt=>{
  expect(parseCreationQuote({...quote(),receivedAt},request()).receivedAt).toBe(receivedAt);
});
const receipt=(intent:CreationIntent,outcome='created')=>({version:creationVersion,adminId:intent.actorId,requestKey:intent.nonce,requestHash:intent.requestHash,orderId:intent.orderId,outcome,refundId:outcome==='created'?75:null});
async function created(intent:CreationIntent) {return applyCreationResponse(intent,{version:creationVersion,receipt:receipt(intent),replayed:false},'create');}
async function executed(intent:CreationIntent,outcome='balance-settled',execution:unknown={completed:true,status:'BALANCE_SUCCESS'}) {
  const operation=await creationFinancialIntent(await created(intent));
  return applyCreationResponse(intent,{version:creationVersion,creation:{receipt:receipt(intent),replayed:false},operation:{replayed:false,
    receipt:{version:'admin-refund-operation-v1',adminId:100,requestKey:intent.nonce,requestHash:operation.requestHash,refundId:75,action:'refund',outcome},execution}},'execute');
}
it.each(['remaining','items'] as const)('matches server canonical creation and composed financial hashes for %s',async mode=>{
  const q=quote();q.mode=mode;
  const intent=await makeCreationIntent(100,q,'03.00',' 理由 ');
  expect(intent.requestHash).toBe(await outRequestHash(parseAdminRefundCreation(intent.body)));
  expect(intent.body.items).toEqual(mode==='remaining'?[]:[{cartId:501,cartNum:2},{cartId:502,cartNum:1}]);
  const operation=await creationFinancialIntent(await created(intent));
  expect(operation.nonce).toBe(intent.nonce);expect(operation.review.orderId).toBe(adminRefundCreationNumber(100,intent.nonce));
  expect(operation.requestHash).toBe(await outRequestHash({...operationBody(operation),refundId:75,reason:''}));
  expect(operation.requestHash).not.toBe(intent.requestHash);expect(JSON.stringify(intent)).not.toMatch(/token|password/i);
});
it('copies quote identity and selections before the first asynchronous digest',async()=>{
  const q=quote();q.mode='items';const pending=makeCreationIntent(100,q,'3.00','测试');q.review.uid=22;q.items[0].cartNum=99;
  const intent=await pending;expect(intent.body.review.uid).toBe(11);expect(intent.body.items[0].cartNum).toBe(2);
});
it.each(['actorId','orderId','nonce','requestHash','phase','version'])('rejects changed persisted %s',async field=>{
  const intent=await make();await expect(verifyCreationIntent({...intent,[field]:'wrong'},100,1)).rejects.toThrow();
});
it.each(['adminId','orderId','requestKey','requestHash','refundId','outcome','version'])('rejects unbound creation receipt %s',async field=>{
  const intent=await make();await expect(applyCreationResponse(intent,{version:creationVersion,receipt:{...receipt(intent),[field]:'wrong'}},'receipt')).rejects.toThrow();
});
it('null lookup keeps pending; SQL creation alone is not settlement; only financial receipt resolves balance',async()=>{
  const intent=await make();const missing=await applyCreationResponse(intent,{version:creationVersion,receipt:null},'receipt');
  expect(missing.phase).toBe('pending');expect(creationMessage(missing)).toContain('迟到请求');
  const accepted=await created(missing);expect(accepted.phase).toBe('pending');expect(creationMessage(accepted)).toContain('尚未确认资金');
  const operation=await creationFinancialIntent(accepted);
  const complete=await applyCreationFinancialResult(accepted,{receipt:{version:'admin-refund-operation-v1',adminId:100,requestKey:intent.nonce,requestHash:operation.requestHash,refundId:75,action:'refund',outcome:'balance-settled'},execution:null});
  expect(complete.phase).toBe('resolved');await expect(verifyCreationIntent(complete,100,1)).resolves.toEqual(complete);
});
it('abandonment fences only uncreated requests; created abandonment does not resolve funds',async()=>{
  const intent=await make(),abandoned=await applyCreationResponse(intent,{version:creationVersion,receipt:receipt(intent,'abandoned')},'abandon');
  expect(abandoned.phase).toBe('resolved');expect(creationMessage(abandoned)).toContain('不是取消');
  const accepted=await created(intent);expect((await applyCreationResponse(accepted,{version:creationVersion,receipt:receipt(intent)},'abandon')).phase).toBe('pending');
  await expect(applyCreationResponse(accepted,{version:creationVersion,receipt:receipt(intent,'abandoned')},'abandon')).rejects.toThrow();
});
it('provider admission remains pending and explicit success retains monotonic evidence',async()=>{
  const intent=await make(),admitted=await executed(intent,'provider-admitted',{completed:false,status:'PROCESSING'});
  expect(admitted.phase).toBe('pending');expect(creationMessage(admitted)).toContain('尚未确认');
  const completed=await executed(admitted,'provider-admitted',{completed:true,status:'SUCCESS'});expect(completed.phase).toBe('resolved');
  const reread=await applyCreationResponse(completed,{version:creationVersion,receipt:receipt(intent)},'receipt');expect(reread.operation?.execution?.completed).toBe(true);
  await expect(executed(completed,'provider-admitted',{completed:false,status:'PROCESSING'})).rejects.toThrow();
  await expect(applyCreationResponse(completed,{version:creationVersion,receipt:null},'receipt')).rejects.toThrow();
});
it.each([null,{}, {completed:true,status:'PROCESSING'},{completed:false,status:'SUCCESS'},{completed:true,status:'BALANCE_SUCCESS'}])('rejects invalid admitted execution %j',async execution=>{
  await expect(executed(await make(),'provider-admitted',execution)).rejects.toThrow();
});
it('rejects tampered body, detached financial intent, extra fields and wrong entity ownership',async()=>{
  const intent=await executed(await make());
  await expect(verifyCreationIntent({...intent,body:{...intent.body,reason:'changed'}},100,1)).rejects.toThrow();
  await expect(verifyCreationIntent({...intent,operation:{...intent.operation,requestHash:'b'.repeat(64)}},100,1)).rejects.toThrow();
  expect(()=>parseCreationIntent({...intent,operation:{...intent.operation,nonce:crypto.randomUUID()}},100,1)).toThrow();
  expect(()=>parseCreationIntent({...intent,extra:1},100,1)).toThrow();expect(()=>parseCreationIntent(intent,101,1)).toThrow();
});
it('retains terminal tombstones and rejects stale CAS, oversized storage and failed verification writes',async()=>{
  const intent=await make(),raw=writeCreationIntent(intent,null);expect((await readCreationIntent(100,1)).intent).toEqual(intent);
  const done=await executed(intent),saved=writeCreationIntent(done,raw);expect(()=>writeCreationIntent(intent,null)).toThrow();
  expect(localStorage.getItem(creationIntentKey(100,1))).toBe(saved);
  localStorage.setItem(creationIntentKey(100,1),'x'.repeat(32769));await expect(readCreationIntent(100,1)).rejects.toThrow();
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});expect(()=>writeCreationIntent(intent,null)).toThrow();
});
it('detects a storage change while verifying and refuses Web Lock fallback',async()=>{
  const intent=await make(),raw=JSON.stringify(intent);let count=0;
  vi.stubGlobal('localStorage',{getItem:()=>++count===1?raw:null});await expect(readCreationIntent(100,1)).rejects.toThrow();
  vi.stubGlobal('navigator',{});await expect(withCreationLock(1,async()=>true)).rejects.toThrow('Web Locks');
  const work=vi.fn();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,cb:(lock:null)=>unknown)=>cb(null)}});
  await expect(withCreationLock(1,work)).rejects.toThrow('另一标签页');expect(work).not.toHaveBeenCalled();
});
it('rejects invalid selections and unreviewed or excessive money',()=>{
  expect(()=>creationSelection(1,'remaining',[{cartId:1,cartNum:1}])).toThrow();
  expect(()=>creationSelection(1,'items',[])).toThrow();expect(()=>creationSelection(1,'items',[{cartId:1,cartNum:1},{cartId:1,cartNum:2}])).toThrow();
  const q=quote();expect(()=>parseCreationQuote({...q,refundNum:4},request())).toThrow();
  expect(()=>parseCreationQuote({...q,mode:'items'},creationSelection(1,'items',[{cartId:501,cartNum:1}]))).toThrow();
  expect(()=>parseCreationBody({version:creationVersion,review:q.review,mode:'remaining',items:[],quotedPrice:q.quotedPrice,refundPrice:'10.01',reason:'x',quoteFingerprint:q.quoteFingerprint})).toThrow();
});
