/** Recharge-only account approval. Old goods refund/payment approvals cannot
 * substitute for this journal, even when the app/merchant pair is identical. */
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundJson, captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';

type Signing = Pick<Env,'APP_KEY'>;
export type RechargeRoutineRefundPurpose = 'refund_request'|'refund_query'|'refund_notify';
export interface RechargeRoutineRefundAccountPolicy {
 readonly accountId:string; readonly provider:'wechat'; readonly profile:'routine';
 readonly state:'active'|'revoked'; readonly appId:string; readonly merchantId:string;
 readonly credentialRef:string; readonly credentialVersion:number; readonly credentialStamp:string;
 readonly purposes:readonly RechargeRoutineRefundPurpose[]; readonly validFrom:number; readonly validUntil:number;
}
export interface RechargeRoutineRefundAccountJournal {
 readonly record_id:string; readonly account_id:string; readonly revision:number;
 readonly payload:{ readonly format:1; readonly purpose:'recharge_routine_refund_account';
  readonly scope:Readonly<RechargeRefundScope>; readonly previousRecordId:string;
  readonly data:Readonly<RechargeRoutineRefundAccountPolicy> };
 readonly created_at:number; readonly signature:string;
}
const fail=():never=>{throw new ServiceUnavailableException('充值原账号退款批准或凭据未完整就绪');};
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`).test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_147_483_647;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const same=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const data=value as Record<string,unknown>;
 if(Reflect.ownKeys(data).length!==keys.length||keys.some(key=>!Object.hasOwn(data,key)))return fail();
 return data;
}
export function rechargeRoutineRefundAccountId(env:Signing,appId:string,merchantId:string):string {
 if(!token(appId,32)||typeof merchantId!=='string'||!/^[0-9]{1,32}$/.test(merchantId))return fail();
 return routineEvidenceHmac(env,'recharge-routine-refund-account-subject-v1',{provider:'wechat',profile:'routine',appId,merchantId});
}
export function captureRechargeRoutineRefundAccountPolicy(env:Signing,input:unknown):Readonly<RechargeRoutineRefundAccountPolicy> {
 const r=object(captureRechargeRefundJson(input),['accountId','provider','profile','state','appId','merchantId',
  'credentialRef','credentialVersion','credentialStamp','purposes','validFrom','validUntil']);
 if(!token(r.appId,32)||typeof r.merchantId!=='string'||!/^[0-9]{1,32}$/.test(r.merchantId)
  ||r.accountId!==rechargeRoutineRefundAccountId(env,r.appId,r.merchantId)||r.provider!=='wechat'||r.profile!=='routine'
  ||r.state!=='active'&&r.state!=='revoked'||!token(r.credentialRef)||!integer(r.credentialVersion)||!hex(r.credentialStamp)
  ||!integer(r.validFrom)||!integer(r.validUntil)||r.validUntil<=r.validFrom||r.validUntil-r.validFrom>366*86400
  ||!Array.isArray(r.purposes)||!r.purposes.length||r.purposes.length>3
  ||r.purposes.some(p=>!['refund_request','refund_query','refund_notify'].includes(p))
  ||new Set(r.purposes).size!==r.purposes.length)return fail();
 const purposes=Object.freeze([...(r.purposes as RechargeRoutineRefundPurpose[])].sort());
 return Object.freeze({...r,purposes}) as unknown as Readonly<RechargeRoutineRefundAccountPolicy>;
}
function body(env:Signing,scope:RechargeRefundScope,input:unknown) {
 const r=object(captureRechargeRefundJson(input),['record_id','account_id','revision','payload','created_at']);
 const p=object(r.payload,['format','purpose','scope','previousRecordId','data']);
 const expectedScope=captureRechargeRefundScope(scope),actualScope=captureRechargeRefundScope(p.scope);
 const data=captureRechargeRoutineRefundAccountPolicy(env,p.data);
 const created=typeof r.created_at==='string'&&/^[1-9]\d*$/.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!uuid(r.record_id)||r.account_id!==data.accountId||!integer(r.revision)||r.revision>64||!integer(created)
  ||p.format!==1||p.purpose!=='recharge_routine_refund_account'||!same(expectedScope,actualScope)
  ||p.previousRecordId!==''&&!uuid(p.previousRecordId))return fail();
 return Object.freeze({record_id:r.record_id,account_id:data.accountId,revision:r.revision,
  payload:Object.freeze({format:1 as const,purpose:'recharge_routine_refund_account' as const,
   scope:expectedScope,previousRecordId:p.previousRecordId as string,data}),created_at:created});
}
export function signRechargeRoutineRefundAccountJournal(env:Signing,scope:RechargeRefundScope,input:unknown):RechargeRoutineRefundAccountJournal {
 const unsigned=body(env,scope,input);
 return Object.freeze({...unsigned,signature:routineEvidenceHmac(env,'recharge-routine-refund-account-journal-v1',unsigned)});
}
export function parseRechargeRoutineRefundAccountJournal(env:Signing,scope:RechargeRefundScope,input:unknown):RechargeRoutineRefundAccountJournal {
 const r=object(captureRechargeRefundJson(input),['record_id','account_id','revision','payload','created_at','signature']);
 if(!hex(r.signature))return fail();
 const {signature,...raw}=r,expected=signRechargeRoutineRefundAccountJournal(env,scope,raw);
 if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected.signature,'hex')))return fail();
 return expected;
}
export function validateRechargeRoutineRefundAccountHistory(rows:readonly RechargeRoutineRefundAccountJournal[],accountId:string):void {
 if(!hex(accountId)||rows.length>64)return fail();
 for(let i=0;i<rows.length;i++) {
  const row=rows[i],prior=rows[i-1];
  if(row.account_id!==accountId||row.revision!==i+1||row.payload.previousRecordId!==(prior?.record_id??'')
   ||prior&&row.created_at<prior.created_at)return fail();
 }
}
/** Latest live approval metadata only. Fresh credentials and immutable original
 * facts must still be independently matched by the SQL consumer. */
export function requireRechargeRoutineRefundPurpose(row:RechargeRoutineRefundAccountJournal,purpose:RechargeRoutineRefundPurpose,now:number):void {
 const data=row.payload.data;
 if(!integer(now)||!['refund_request','refund_query','refund_notify'].includes(purpose)||data.state!=='active'
  ||now<data.validFrom||now>=data.validUntil||!data.purposes.includes(purpose))return fail();
}
