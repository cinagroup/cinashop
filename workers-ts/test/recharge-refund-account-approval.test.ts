import { describe,expect,it } from 'vitest';
import { captureRechargeRoutineRefundAccountPolicy, parseRechargeRoutineRefundAccountJournal,
 rechargeRoutineRefundAccountId, requireRechargeRoutineRefundPurpose, signRechargeRoutineRefundAccountJournal,
 validateRechargeRoutineRefundAccountHistory } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';
const env={APP_KEY:'recharge-account-codec-owned-test-only'};
const scope:RechargeRefundScope={database:'codec_db',databaseOid:'101',maintenance:'owner',maintenanceOid:'102',app:'app',appOid:'103',
 admin:'admin',adminOid:'104',financial:'financial',financialOid:'105',manager:'manager',managerOid:'106'};
const pair={appId:'wx_original',merchantId:'123456789'};
const data=()=>({accountId:rechargeRoutineRefundAccountId(env,pair.appId,pair.merchantId),provider:'wechat' as const,profile:'routine' as const,
 state:'active' as const,...pair,credentialRef:'original_ref',credentialVersion:1,credentialStamp:'a'.repeat(64),
 purposes:['refund_request','refund_query'] as const,validFrom:100,validUntil:1000});
const unsigned=()=>({record_id:'00000000-0000-4000-8000-000000000001',account_id:data().accountId,revision:1,
 payload:{format:1,purpose:'recharge_routine_refund_account',scope,previousRecordId:'',data:data()},created_at:200});
const signed=()=>signRechargeRoutineRefundAccountJournal(env,scope,unsigned());
describe('independent recharge Routine refund approval codec',()=>{
 it('authenticates a SQL bigint round trip and freezes complete copied metadata',()=>{
  const row=signed(),raw=JSON.parse(JSON.stringify(row));raw.created_at='200';
  expect(parseRechargeRoutineRefundAccountJournal(env,scope,raw)).toEqual(row);
  expect(Object.isFrozen(row.payload.data.purposes)).toBe(true);expect(Object.isFrozen(row.payload.scope)).toBe(true);
 });
 it('derives one subject for the original pair and separates different apps, merchants and keys',()=>{
  const id=data().accountId;expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set([id,rechargeRoutineRefundAccountId(env,'wx_other',pair.merchantId),rechargeRoutineRefundAccountId(env,pair.appId,'999'),
   rechargeRoutineRefundAccountId({APP_KEY:'other'},pair.appId,pair.merchantId)]).size).toBe(4);
 });
 it.each([{provider:'alipay'},{profile:'app'},{appId:'wx_other'},{merchantId:'999'},{credentialVersion:0},
  {purposes:['query']},{purposes:['refund_query','refund_query']},{validUntil:100},{validUntil:100+367*86400},
  {state:'disabled'},{credentialStamp:'a'.repeat(63)}])('refuses another purpose/account or ambiguous approval %#',patch=>{
  expect(()=>captureRechargeRoutineRefundAccountPolicy(env,{...data(),...patch})).toThrow();
 });
 it('never invokes getters and rejects sparse/accessor/custom arrays or extra metadata',()=>{
  let called=false;const getter={...data(),get credentialRef(){called=true;return 'current';}};
  expect(()=>captureRechargeRoutineRefundAccountPolicy(env,getter)).toThrow();expect(called).toBe(false);
  const sparse=new Array(1),accessor=['refund_request'];Object.defineProperty(accessor,'0',{get(){called=true;return 'refund_request';},enumerable:true});
  for(const purposes of [sparse,accessor,Object.assign(['refund_query'],{extra:true})])expect(()=>captureRechargeRoutineRefundAccountPolicy(env,{...data(),purposes})).toThrow();
  expect(called).toBe(false);expect(()=>captureRechargeRoutineRefundAccountPolicy(env,{...data(),secret:'no'})).toThrow();
 });
 it('binds original pair, current credential commitment, full role/OID scope, purpose and timestamp',()=>{
  const row=signed();
  for(const patch of [{revision:2},{created_at:201},{signature:'b'.repeat(64)},
   {payload:{...row.payload,purpose:'routine_refund_account'}},
   {payload:{...row.payload,data:{...row.payload.data,credentialStamp:'b'.repeat(64)}}}])
   expect(()=>parseRechargeRoutineRefundAccountJournal(env,scope,{...row,...patch})).toThrow();
  for(const patch of [{databaseOid:'201'},{adminOid:'202'},{financial:'other_financial'},{managerOid:'203'}])
   expect(()=>parseRechargeRoutineRefundAccountJournal(env,{...scope,...patch},row)).toThrow();
 });
 it('validates the entire contiguous revision chain rather than just a latest approval',()=>{
  const first=signed(),second=signRechargeRoutineRefundAccountJournal(env,scope,{...unsigned(),record_id:'00000000-0000-4000-8000-000000000002',
   revision:2,payload:{...unsigned().payload,previousRecordId:first.record_id,data:{...data(),state:'revoked'}},created_at:201});
  expect(()=>validateRechargeRoutineRefundAccountHistory([first,second],first.account_id)).not.toThrow();
  for(const rows of [[second],[first,first],[second,first],[first,{...second,created_at:199}]])
   expect(()=>validateRechargeRoutineRefundAccountHistory(rows,first.account_id)).toThrow();
  expect(()=>validateRechargeRoutineRefundAccountHistory([first],rechargeRoutineRefundAccountId(env,'wx_other','999'))).toThrow();
 });
 it('keeps expired/revoked historical evidence readable while fresh purpose use fails',()=>{
  const first=signed();expect(()=>requireRechargeRoutineRefundPurpose(first,'refund_request',100)).not.toThrow();
  for(const now of [99,1000])expect(()=>requireRechargeRoutineRefundPurpose(first,'refund_request',now)).toThrow();
  expect(()=>requireRechargeRoutineRefundPurpose(first,'refund_notify',200)).toThrow();
  const revoked=signRechargeRoutineRefundAccountJournal(env,scope,{...unsigned(),payload:{...unsigned().payload,data:{...data(),state:'revoked'}}});
  expect(parseRechargeRoutineRefundAccountJournal(env,scope,revoked)).toEqual(revoked);
  expect(()=>requireRechargeRoutineRefundPurpose(revoked,'refund_request',200)).toThrow();
 });
});
