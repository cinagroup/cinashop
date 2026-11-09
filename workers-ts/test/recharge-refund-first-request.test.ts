/** Synthetic signed-row contracts only. Native tests separately establish the
 * actual payment, role, first claim and COMMIT/WeakMap boundaries. */
import { createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { parseRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { signRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeRoutineRefundAccountId } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { routineEvidenceCanonical } from '@/services/payment/RoutineProviderObservation';
import { operationSourcePureFixture,operationSourceScope as scope,operationSourceSigning as env,
 operationSourceFacts,operationSourceUuid,sourceClone,sourceOriginal } from './helpers/rechargeRefundOperationSourcePure';

function fixture(){
 const f=operationSourcePureFixture();
 const attempt=(operation=f.operation(),patch:Record<string,unknown>={})=>{
  const payment=operation.payment_source as Record<string,unknown>,ref=payment.refundApproval as Record<string,unknown>;
  const approval={recordId:ref.recordId,signature:ref.signature,
   accountId:rechargeRoutineRefundAccountId(env,operationSourceFacts.appId,operationSourceFacts.merchantId),
   appId:operationSourceFacts.appId,merchantId:operationSourceFacts.merchantId,
   credentialRef:'synthetic_source_contract',credentialVersion:1,credentialStamp:'a'.repeat(64),...patch};
  const request={outTradeNo:operation.order_no,transactionId:operation.transaction_id,outRefundNo:operation.out_refund_no,
   refundAmount:operation.principal_cents,totalAmount:operation.principal_cents,reason:'充值原路退款'};
  const notifyUrl='https://refund-contract.example/api/pay/notify/recharge-refund/'+operation.operation_id;
  const payload={format:1,purpose:'recharge-refund-first-request-v1',scope,operationId:operation.operation_id,operationSignature:operation.signature,
   paymentSignature:operation.payment_signature,holdBillId:payment.holdBillId,adminId:operation.admin_id,approval,
   leaseId:operationSourceUuid(7),issuedAt:1101,leaseUntil:1131,request,notifyUrl};
  const requestHash=createHash('sha256').update(routineEvidenceCanonical({method:'POST',path:'/v3/refund/domestic/refunds',
   appId:approval.appId,merchantId:approval.merchantId,request,notifyUrl})).digest('hex');
  return signRechargeRefundRecord(env,scope,'recharge_refund_attempt',{attempt_id:operationSourceUuid(6),operation_id:operation.operation_id,
   ordinal:1,kind:'request',lease_id:operationSourceUuid(7),request_hash:requestHash,payload,created_at:1101});
 };
 return{...f,attempt};
}
describe('recharge first request exact historical parser',()=>{
 it('authenticates a complete old request without consulting a current merchant registry or current time',()=>{
  const f=fixture(),operation=f.operation();expect(parseRechargeRefundFirstRequest(env,scope,operation,f.attempt(operation)).payload)
   .toMatchObject({operationId:operation.operation_id,request:{totalAmount:1000,refundAmount:1000}});
 });
 it.each([{appId:'wx_other_b'},{merchantId:'99887766'}])('rejects an authenticated attempt for a different original pair %#',patch=>{
  const f=fixture(),operation=f.operation(),pair={appId:operationSourceFacts.appId,merchantId:operationSourceFacts.merchantId,...patch};
  const row=f.attempt(operation,{...pair,accountId:rechargeRoutineRefundAccountId(env,pair.appId,pair.merchantId)});
  expect(()=>parseRechargeRefundFirstRequest(env,scope,operation,row)).toThrow();
 });
 it('rejects an arbitrary account subject even when the pair and outer attempt MAC are valid',()=>{
  const f=fixture(),operation=f.operation();expect(()=>parseRechargeRefundFirstRequest(env,scope,operation,f.attempt(operation,{accountId:'0'.repeat(64)}))).toThrow();
 });
 it('does not require first-settlement revalidation to decode already signed immutable request bindings',()=>{
  // Such a malformed nested source cannot authorize a fresh claim. This PURE
  // receipt decoder is intentionally narrower: provider truth must not be
  // discarded because the stronger source/first-settlement layer refuses.
  const f=fixture(),source=sourceClone(f.original);source.firstSettlement.signature='0'.repeat(64);
  const operation=f.operation(source);expect(parseRechargeRefundFirstRequest(env,scope,operation,f.attempt(operation)).payload.operationId).toBe(operation.operation_id);
 });
 it.each([{domain:'membership'},{buyerUid:52}])('matches the selected immutable original local domain and buyer %#',patch=>{
  const f=fixture(),other=sourceOriginal(1,operationSourceFacts,patch),operation=f.operation({...f.original,originals:[other]});
  expect(()=>parseRechargeRefundFirstRequest(env,scope,operation,f.attempt(operation))).toThrow();
 });
 it('rejects a valid outer operation/request amount that contradicts the original principal',()=>{
  const f=fixture(),operation=f.operation(f.original,{principal_cents:1,gift_cents:0,reclaim_gift:false,debit_cents:1,wallet_after:1149});
  expect(()=>parseRechargeRefundFirstRequest(env,scope,operation,f.attempt(operation))).toThrow();
 });
});
