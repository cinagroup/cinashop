/** Synthetic MAC fixtures for PURE contract tests only. No RSA/AES, physical
 * PostgreSQL row, runtime role, actual payment or provider authority is proved. */
import type { RechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';
import { signRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { routineEvidenceHmac,type RoutineProviderFacts } from '@/services/payment/RoutineProviderObservation';
import { parseRoutineOriginalEvidence,type RoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidenceCodec';
import { parseRoutineApprovedUse } from '@/services/payment/RoutineApprovedPaymentEvidenceCodec';

export const operationSourceSigning={APP_KEY:'synthetic-operation-source-contract-key'};
export const operationSourceScope:RechargeRefundScope={database:'operation_source_only',databaseOid:'41',
 maintenance:'source_owner',maintenanceOid:'51',app:'source_app',appOid:'52',admin:'source_admin',adminOid:'53',
 financial:'source_financial',financialOid:'54',manager:'source_manager',managerOid:'55'};
export const operationSourceUuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const operationSourceFacts:RoutineProviderFacts={appId:'wx_original_a',merchantId:'1234567890',orderNo:'czSourcePure',
 transactionId:'source_original_transaction',amountCents:1000,currency:'CNY',tradeState:'SUCCESS',tradeType:'JSAPI',payerId:'source_original_payer',providerEventTime:950};
const base={database:operationSourceScope.database,databaseOid:operationSourceScope.databaseOid,
 maintenance:operationSourceScope.maintenance,maintenanceOid:operationSourceScope.maintenanceOid};
const mac=(domain:string,value:unknown)=>routineEvidenceHmac(operationSourceSigning,domain,value);
export const sourceClone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));

export function sourceOriginal(n=1,facts:RoutineProviderFacts=operationSourceFacts,localPatch:Record<string,unknown>={}) {
 const observationBody={format:1,purpose:'routine_provider_original',source:'callback',sourceId:'source_contract_callback_'+n,
  facts,verifiedAt:1000,verifierKey:'SYNTHETIC_CONTRACT_ONLY',responseDigest:'a'.repeat(64)};
 const observation={...observationBody,signature:mac('provider-observation',observationBody)};
 const body={evidence_id:mac('evidence-key',['callback',observation.sourceId]),order_no:facts.orderNo,transaction_id:facts.transactionId,
  source:'callback',source_id:observation.sourceId,format_version:1,payload:{format:1,binding:{state:'bound',local:{domain:'recharge',
   orderId:31,buyerUid:51,orderNo:facts.orderNo,amountCents:facts.amountCents,paid:0,payType:'weixin',tradeNo:'',...localPatch}},
   sourceDigest:'b'.repeat(64),observation},created_at:1000};
 return parseRoutineOriginalEvidence(operationSourceSigning,{...body,signature:mac('evidence-record',body)});
}
export function sourceUse(original:RoutineOriginalEvidence,revision=1) {
 const policyBody={record_id:operationSourceUuid(100+revision),kind:'account',subject_id:'source_payment_account',revision,
  payload:{format:1,scope:base,previousRecordId:revision===1?'':operationSourceUuid(99+revision),data:{
   accountId:'source_payment_account',state:'active',appId:original.payload.observation.facts.appId,
   merchantId:original.payload.observation.facts.merchantId,credentialRef:'synthetic_contract_only',credentialVersion:revision,
   credentialStamp:'c'.repeat(64),purposes:['notify','query'],validFrom:800,validUntil:1500}},created_at:900};
 const account={...policyBody,signature:mac('approved-account-policy',policyBody)};
 const authorizationBody={format:1,purpose:'routine_approved_provider',account,query:null,observation:original.payload.observation,issuedAt:1000};
 const authorization={...authorizationBody,signature:mac('approved-account-authorization',authorizationBody)};
 const body={use_id:mac('approved-account-use-key',[original.evidence_id,account.record_id,'']),evidence_id:original.evidence_id,
  payload:{format:1,evidenceSignature:original.signature,scopeMatches:true,authorization},created_at:1000};
 return parseRoutineApprovedUse(operationSourceSigning,{...body,signature:mac('approved-account-use-record',body)},base,original);
}
export function sourceFirstSettlement(original:RoutineOriginalEvidence){
 const business={format:1,domain:'recharge',settlementNonce:operationSourceUuid(3),orderId:31,orderNo:operationSourceFacts.orderNo,userId:51,
  payType:'weixin',payPrice:'10.00',giftPrice:'1.50',creditedAmount:'11.50',postBalance:'11.50',billId:71,payTime:950,
  creationTime:900,tradeNo:operationSourceFacts.transactionId,phone:'',sendName:'',occurredAt:951};
 const bill={id:71,uid:51,linkId:business.orderNo,eventKey:'recharge_external_payment',pm:1,category:'now_money',type:'recharge',
  number:business.creditedAmount,balance:business.postBalance,status:1,addTime:business.payTime};
 const provider={kind:'callback',id:11,replayKey:operationSourceUuid(4),provider:'wechat',profile:'routine',providerEventId:original.source_id,
  payloadHash:'d'.repeat(64),orderNo:business.orderNo,transactionId:business.tradeNo,tradeState:'SUCCESS',amountCents:1000,currency:'CNY'};
 const body={scope:base,business,bill,provider};
 return{...body,signature:mac('subscription-recharge-paid-settlement-v1',body)};
}
export function operationSourcePureFixture(){
 const first=sourceOriginal(),use=sourceUse(first);
 const original={format:2,domain:'recharge',firstSettlement:sourceFirstSettlement(first),originals:[first],
  approvedUseRefs:[{useId:use.use_id,signature:use.signature}],approvedUseDigest:mac('recharge-refund-approved-use-set',[use])};
 const operation=(source:unknown=original,patch:Record<string,unknown>={})=>signRechargeRefundRecord(operationSourceSigning,operationSourceScope,'recharge_refund_operation',{
  operation_id:operationSourceUuid(1),admin_id:7,request_key:operationSourceUuid(2),request_hash:'e'.repeat(64),recharge_id:31,buyer_uid:51,
  order_no:operationSourceFacts.orderNo,provider:'wechat',payment_profile:'routine',transaction_id:operationSourceFacts.transactionId,
  payment_source:{original:source,holdBillId:72,refundApproval:{recordId:operationSourceUuid(5),signature:'f'.repeat(64)}},
  payment_signature:mac('recharge-refund-original-source-v1',{scope:operationSourceScope,source}),principal_cents:1000,gift_cents:150,
  reclaim_gift:true,debit_cents:1150,wallet_before:1150,wallet_after:0,admission:'reserved',
  out_refund_no:'CNSCR'+operationSourceUuid(1).replaceAll('-',''),created_at:1100,...patch});
 return{first,use,original,operation};
}
