import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { parseAdminRefundDetail } from '../../view/admin-ts/src/utils/refundDetail';
import { makeRefundIntent, writeRefundIntent } from '../../view/admin-ts/src/utils/refundIntent';
import { applyOperationResult, makeRefundOperation, operationBody, operationMessage, operationVersion,
  parseOperationResult, parseRefundOperation, readRefundOperation, refundOperationKey, verifyRefundOperation,
  writeRefundOperation, type RefundOperation, type OperationOutcome, type OperationReceipt } from '../../view/admin-ts/src/utils/refundOperation';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
const detail = () => parseAdminRefundDetail({ id:25,storeOrderId:28,orderId:'R25',originalOrderId:'O28',uid:11,storeId:0,supplierId:0,applyType:2,applyPrice:'5.00',refundType:5,refundNum:1,
  refundPrice:'0005.00',refundedPrice:'0.00',refundReason:'本地原因',isCancel:0,isDel:0,addTime:1700000000,refundedTime:0,payType:'yue',providerStatus:null,
  refundExplain:'申请说明',refuseReason:'',refundExpress:'LOCAL-25',refundExpressName:'本地快递',refundPhone:'000000',refundGoodsExplain:'备注',
  returnImages:[],returnImagesError:'',returnContact:{source:'platform',name:'本地收件人',phone:'000000',address:'本地地址'} }, 25);
const make = () => makeRefundOperation(100, detail(), 'refund', '', true);
function receipt(intent: RefundOperation, outcome: OperationOutcome = 'balance-settled'): OperationReceipt {
  return { version:operationVersion,adminId:intent.actorId,requestKey:intent.nonce,requestHash:intent.requestHash,refundId:intent.refundId,action:intent.action,outcome };
}
it.each(['refund','refuse','return'] as const)('hashes the original %s decision exactly like the server canonicalizer, with normalized cents', async action => {
  const row = detail(); row.refundType = action === 'refund' ? 5 : 0;
  const intent = await makeRefundOperation(100, row, action, action === 'refuse' ? ' 原因 \n' : '', true);
  expect(intent.requestHash).toBe(await outRequestHash({ ...operationBody(intent), refundId:25, reason:intent.reason, review:{...intent.review,refundPrice:'5.00'} }));
  expect(operationBody(intent).review.refundPrice).toBe('0005.00');
  expect(JSON.stringify(intent)).not.toMatch(/token|password/i);
});
it('copies original fields before asynchronous hashing; later caller mutations cannot change the decision', async () => {
  const row = detail(), promise = makeRefundOperation(100, row, 'refund', '', true);
  row.refundPrice = '99.00'; row.uid = 12;
  const intent = await promise;
  expect(intent.review.refundPrice).toBe('0005.00'); expect(intent.review.uid).toBe(11);
});
it('verifies a pending record and preserves a terminal tombstone with compare-and-swap', async () => {
  const intent = await make(), raw = writeRefundOperation(intent, null);
  expect((await readRefundOperation(100,25)).intent).toEqual(intent);
  const settled = applyOperationResult(intent, { receipt:receipt(intent), execution:null });
  const resolved = writeRefundOperation(settled, raw);
  expect((await readRefundOperation(100,25)).intent?.phase).toBe('resolved');
  expect(() => writeRefundOperation(intent, null)).toThrow();
  expect(localStorage.getItem(refundOperationKey(100,25))).toBe(resolved);
});
it.each(['adminId','requestKey','requestHash','refundId','action','version','outcome'])('rejects a mismatched %s even in a successful envelope', async field => {
  const intent = await make();
  expect(() => parseOperationResult({version:operationVersion,receipt:{...receipt(intent),[field]:'wrong'}},intent,'receipt')).toThrow();
});
it.each([null,{}, {version:operationVersion,receipt:null,replayed:false}, {version:operationVersion,receipt:null,extra:1}])('rejects incomplete/extra response shape %j', async value => {
  const intent = await make(); expect(() => parseOperationResult(value,intent,'abandon')).toThrow();
});
it('null lookup never releases the original; explicit abandoned evidence does, but never claims execution', async () => {
  const intent = await make();
  const missing = applyOperationResult(intent,parseOperationResult({version:operationVersion,receipt:null},intent,'receipt'));
  expect(missing.phase).toBe('pending'); expect(operationMessage(missing)).toContain('迟到请求');
  const abandoned = applyOperationResult(missing,parseOperationResult({version:operationVersion,receipt:receipt(intent,'abandoned')},intent,'abandon'));
  expect(abandoned.phase).toBe('resolved'); expect(operationMessage(abandoned)).toContain('不是撤销');
  expect(() => parseOperationResult({version:operationVersion,receipt:receipt(intent,'abandoned'),replayed:true,execution:{completed:true,status:'SUCCESS'}},intent,'execute')).toThrow();
});
it('admitted provider results stay pending on lookup or abandonment, and only valid execute SUCCESS resolves', async () => {
  const intent = await make(), evidence = receipt(intent,'provider-admitted');
  for (const mode of ['receipt','abandon'] as const) {
    const result = applyOperationResult(intent,parseOperationResult({version:operationVersion,receipt:evidence},intent,mode));
    expect(result.phase).toBe('pending'); expect(operationMessage(result)).toContain('尚未确认');
  }
  const completed = applyOperationResult(intent,parseOperationResult({version:operationVersion,receipt:evidence,replayed:true,execution:{completed:true,status:'SUCCESS'}},intent,'execute'));
  expect(completed.phase).toBe('resolved');
  expect(() => applyOperationResult(completed,{receipt:null,execution:null})).toThrow();
  expect(() => applyOperationResult(completed,{receipt:receipt(intent,'abandoned'),execution:null})).toThrow();
});
it.each([{completed:true,status:'PROCESSING'},{completed:false,status:'SUCCESS'},{completed:true,status:'BALANCE_SUCCESS'},null])('rejects invalid provider execution %j', async execution => {
  const intent = await make();
  expect(() => parseOperationResult({version:operationVersion,receipt:receipt(intent,'provider-admitted'),replayed:false,execution},intent,'execute')).toThrow();
});
it('rejects changed decision content despite a syntactically correct persisted hash and receipt', async () => {
  const intent = await make(), raw = writeRefundOperation(intent,null);
  localStorage.setItem(refundOperationKey(100,25),raw.replace('0005.00','0006.00'));
  await expect(readRefundOperation(100,25)).rejects.toThrow();
  await expect(verifyRefundOperation({...intent,received:false},100,25)).rejects.toThrow();
  expect(() => parseRefundOperation({...intent,phase:'resolved'},100,25)).toThrow();
});
it.each(['pending','resolved'] as const)('keeps old v2 %s markers unchanged and refuses a new v3 write', async phase => {
  const old = makeRefundIntent(100,detail(),'refund','',true), oldRaw = writeRefundIntent({...old,phase},null);
  const state = await readRefundOperation(100,25); expect(state.legacy).toBe(true); expect(state.intent).toBeNull();
  const next = await make(); expect(() => writeRefundOperation(next,null)).toThrow();
  expect(localStorage.getItem('admin-refund-intent-v2:100:25')).toBe(oldRaw);
});
