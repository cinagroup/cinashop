/** Three independent purpose-journal decoders. Their domains and exception semantics remain separate. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
export type RoutineRefundScope = { database: string; databaseOid: string; maintenance: string; maintenanceOid: string };
export type RoutineRefundPurpose = 'refund_request' | 'refund_query' | 'refund_notify';
export interface RoutineRefundAccountPolicy {
  accountId: string;
  state: 'active' | 'revoked';
  appId: string;
  merchantId: string;
  credentialRef: string;
  credentialVersion: number;
  credentialStamp: string;
  purposes: RoutineRefundPurpose[];
  validFrom: number;
  validUntil: number;
}
export interface RoutineRefundAccountJournal {
  record_id: string;
  account_id: string;
  revision: number;
  payload: { format: 1; purpose: 'routine_refund_account'; scope: RoutineRefundScope; previousRecordId: string; data: RoutineRefundAccountPolicy };
  created_at: number;
  signature: string;
}

export interface RoutineShippingScope { database:string; databaseOid:string; maintenance:string; maintenanceOid:string }
export interface RoutineShippingAccountPolicy {
 accountId:string;state:'active'|'revoked';appId:string;merchantId:string;credentialRef:string;credentialVersion:number;
 credentialStamp:string;purposes:['shipping_upload'];validFrom:number;validUntil:number;
}
export interface RoutineShippingAccountJournal {
 record_id:string;account_id:string;revision:number;payload:{format:1;scope:RoutineShippingScope;previousRecordId:string;data:RoutineShippingAccountPolicy};created_at:number;signature:string;
}
export interface RoutineSubscriptionScope { database:string; databaseOid:string; maintenance:string; maintenanceOid:string }
export interface RoutineSubscriptionTemplate { mark:string;templateId:string }
export interface RoutineSubscriptionAccountPolicy {
 accountId:string;state:'active'|'revoked';appId:string;credentialRef:string;credentialVersion:number;
 credentialStamp:string;purposes:['subscription_send'];templates:RoutineSubscriptionTemplate[];validFrom:number;validUntil:number;
}
export interface RoutineSubscriptionAccountJournal {
 record_id:string;account_id:string;revision:number;payload:{format:1;scope:RoutineSubscriptionScope;previousRecordId:string;data:RoutineSubscriptionAccountPolicy};created_at:number;signature:string;
}

const refundCodec = (() => {
const fail = (): never => { throw new ServiceUnavailableException('原账号退款批准或维护权限尚未完整就绪'); };
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const token = (v: unknown, max = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`, 'u').test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const mac = (env: Signing, value: unknown) => routineEvidenceHmac(env, 'routine-refund-account-policy-v1', value);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
function equal(a: unknown, b: string) {
  return hex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))
    || Object.entries(descriptors).some(([key, d]) => !keys.includes(key) || !d.enumerable || !('value' in d))) return fail();
  return value as Record<string, unknown>;
}
function parse(value: unknown): RoutineRefundAccountPolicy {
  const r = object(value, ['accountId', 'state', 'appId', 'merchantId', 'credentialRef', 'credentialVersion',
    'credentialStamp', 'purposes', 'validFrom', 'validUntil']);
  const purpose = (p: unknown): p is RoutineRefundPurpose => p === 'refund_request' || p === 'refund_query' || p === 'refund_notify';
  if (!token(r.accountId) || r.state !== 'active' && r.state !== 'revoked' || !token(r.appId, 32)
    || typeof r.merchantId !== 'string' || !/^[0-9]{1,32}$/u.test(r.merchantId)
    || !token(r.credentialRef) || !positive(r.credentialVersion) || !hex(r.credentialStamp)
    || !positive(r.validFrom) || !positive(r.validUntil) || r.validUntil <= r.validFrom
    || r.validUntil - r.validFrom > 366 * 86400 || !Array.isArray(r.purposes) || !r.purposes.length
    || r.purposes.length > 3) return fail();
  // Copy only primitive own data elements. Sparse/accessor/custom arrays must
  // not be normalized into a different approval or invoke caller coercions.
  const descriptors = Object.getOwnPropertyDescriptors(r.purposes);
  if (Object.getPrototypeOf(r.purposes) !== Array.prototype || Reflect.ownKeys(r.purposes).length !== r.purposes.length + 1
    || Array.from({ length: r.purposes.length }, (_, i) => descriptors[String(i)])
      .some(d => !d || !d.enumerable || !('value' in d) || !purpose(d.value))) return fail();
  const purposes = Array.from({ length: r.purposes.length }, (_, i) => descriptors[String(i)].value as RoutineRefundPurpose);
  if (new Set(purposes).size !== purposes.length) return fail();
  return { accountId: r.accountId, state: r.state, appId: r.appId, merchantId: r.merchantId,
    credentialRef: r.credentialRef, credentialVersion: r.credentialVersion, credentialStamp: r.credentialStamp,
    purposes: purposes.sort(), validFrom: r.validFrom, validUntil: r.validUntil };
}
function journal(env: Signing, value: unknown, expectedScope: RoutineRefundScope): RoutineRefundAccountJournal {
  const r = object(value, ['record_id', 'account_id', 'revision', 'payload', 'created_at', 'signature']);
  const p = object(r.payload, ['format', 'purpose', 'scope', 'previousRecordId', 'data']);
  const s = object(p.scope, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  const created = typeof r.created_at === 'string' && /^[1-9][0-9]*$/u.test(r.created_at) ? Number(r.created_at) : r.created_at;
  const data = parse(p.data);
  if (!uuid(r.record_id) || r.account_id !== data.accountId || !positive(r.revision) || r.revision > 64
    || p.format !== 1 || p.purpose !== 'routine_refund_account' || !same(s, expectedScope)
    || p.previousRecordId !== '' && !uuid(p.previousRecordId) || !positive(created)) return fail();
  const body = { record_id: r.record_id, account_id: data.accountId, revision: r.revision,
    payload: { format: 1 as const, purpose: 'routine_refund_account' as const, scope: { ...expectedScope },
      previousRecordId: p.previousRecordId as string, data }, created_at: created };
  if (!equal(r.signature, mac(env, body))) return fail();
  return freeze({ ...body, signature: r.signature as string });
}
function validateHistory(decoded: readonly RoutineRefundAccountJournal[], accountId: string): void {
  for (let i = 0; i < decoded.length; i++) {
    const current = decoded[i], prior = decoded[i - 1];
    if (current.account_id !== accountId || current.revision !== i + 1
      || current.payload.previousRecordId !== (prior?.record_id ?? '') || prior && current.created_at < prior.created_at) return fail();
  }
}
return { policy: parse, journal, validateHistory };
})();
const shippingCodec = (() => {
const routineShippingUnavailable=():never=>{throw new ServiceUnavailableException('小程序原账号发货批准、凭据或证据尚未完整就绪');};
const shippingHex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const shippingUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const shippingInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
function shippingObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return routineShippingUnavailable();
 const ds=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return routineShippingUnavailable();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function freezeShipping<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freezeShipping(d.value);Object.freeze(value);}return value;
}
const shippingSame=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const shippingMac=(env:Signing,domain:string,value:unknown)=>routineEvidenceHmac(env,'shipping-'+domain,value);
function shippingEqual(actual:unknown,expected:string){return shippingHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
function routineShippingAccountId(env:Signing,appId:string,merchantId:string){
 if(!token(appId,32)||typeof merchantId!=='string'||!/^[0-9]{1,32}$/u.test(merchantId))return routineShippingUnavailable();
 return shippingMac(env,'account-subject',[appId,merchantId]);
}
function policy(env:Signing,value:unknown):RoutineShippingAccountPolicy{
 const r=shippingObject(value,['accountId','state','appId','merchantId','credentialRef','credentialVersion','credentialStamp','purposes','validFrom','validUntil']);
 if(!token(r.appId,32)||typeof r.merchantId!=='string'||!/^[0-9]{1,32}$/u.test(r.merchantId)
  ||r.accountId!==routineShippingAccountId(env,r.appId,r.merchantId)||!token(r.credentialRef)||!shippingInteger(r.credentialVersion)||!shippingHex(r.credentialStamp)
  ||r.state!=='active'&&r.state!=='revoked'||!shippingInteger(r.validFrom)||!shippingInteger(r.validUntil)||r.validUntil<=r.validFrom||r.validUntil-r.validFrom>366*86400)return routineShippingUnavailable();
 const p=r.purposes;
 if(!Array.isArray(p)||Object.getPrototypeOf(p)!==Array.prototype||p.length!==1||Reflect.ownKeys(p).length!==2
  ||!Object.getOwnPropertyDescriptor(p,'0')?.enumerable||!('value'in Object.getOwnPropertyDescriptor(p,'0')!)||p[0]!=='shipping_upload')return routineShippingUnavailable();
 return{accountId:r.accountId as string,state:r.state,appId:r.appId,merchantId:r.merchantId,credentialRef:r.credentialRef,
  credentialVersion:r.credentialVersion,credentialStamp:r.credentialStamp,purposes:['shipping_upload'],validFrom:r.validFrom,validUntil:r.validUntil};
}
function parseRoutineShippingAccountJournal(env:Signing,raw:unknown,scope:RoutineShippingScope):RoutineShippingAccountJournal{
 const r=shippingObject(raw,['record_id','account_id','revision','payload','created_at','signature']),p=shippingObject(r.payload,['format','scope','previousRecordId','data']);
 const s=shippingObject(p.scope,['database','databaseOid','maintenance','maintenanceOid']);
 const created=typeof r.created_at==='string'&&/^[0-9]+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!shippingUuid(r.record_id)||!shippingHex(r.account_id)||!shippingInteger(r.revision)||!shippingInteger(created)||p.format!==1||!shippingSame(s,scope)
  ||p.previousRecordId!==''&&!shippingUuid(p.previousRecordId)||!shippingHex(r.signature))return routineShippingUnavailable();
 const data=policy(env,p.data);if(data.accountId!==r.account_id)return routineShippingUnavailable();
 const body={record_id:r.record_id,account_id:r.account_id,revision:r.revision,payload:{format:1 as const,scope:{...scope},previousRecordId:p.previousRecordId as string,data},created_at:created};
 if(!shippingEqual(r.signature,shippingMac(env,'account-policy',body)))return routineShippingUnavailable();
 return freezeShipping({...body,signature:r.signature});
}
function validateHistory(decoded: readonly RoutineShippingAccountJournal[], id: string): void {
 for(let i=0;i<decoded.length;i++)if(decoded[i].account_id!==id||decoded[i].revision!==i+1
  ||decoded[i].payload.previousRecordId!==(i?decoded[i-1].record_id:'')||i>0&&decoded[i].created_at<decoded[i-1].created_at)return routineShippingUnavailable();
}
return { policy, journal: parseRoutineShippingAccountJournal, validateHistory };
})();
const subscriptionCodec = (() => {
const routineSubscriptionUnavailable=():never=>{throw new ServiceUnavailableException('小程序原账号订阅通知批准、凭据或证据尚未完整就绪');};
const subscriptionHex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const subscriptionUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const subscriptionInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const token=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`,'u').test(v);
function subscriptionObject(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return routineSubscriptionUnavailable();
 const ds=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!ds[k]?.enumerable||!('value'in ds[k])))return routineSubscriptionUnavailable();
 return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function freezeSubscription<T>(value:T):T{
 if(value&&typeof value==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(value)))if('value'in d)freezeSubscription(d.value);Object.freeze(value);}return value;
}
const subscriptionSame=(a:unknown,b:unknown)=>routineEvidenceCanonical(a)===routineEvidenceCanonical(b);
const subscriptionMac=(env:Signing,domain:string,value:unknown)=>routineEvidenceHmac(env,'subscription-'+domain,value);
function subscriptionEqual(actual:unknown,expected:string){return subscriptionHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}
function routineSubscriptionAccountId(env:Signing,appId:string){
 if(!token(appId,32))return routineSubscriptionUnavailable();
 return subscriptionMac(env,'account-subject',[appId]);
}
function templates(value:unknown):RoutineSubscriptionTemplate[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||!value.length||value.length>16
  ||Reflect.ownKeys(value).length!==value.length+1)return routineSubscriptionUnavailable();
 const output:RoutineSubscriptionTemplate[]=[];
 for(let i=0;i<value.length;i++){
  const d=Object.getOwnPropertyDescriptor(value,String(i));
  if(!d?.enumerable||!('value'in d))return routineSubscriptionUnavailable();
  const entry=subscriptionObject(d.value,['mark','templateId']);
  if(!token(entry.mark)||!token(entry.templateId,128)||i>0&&output[i-1].mark>=entry.mark)return routineSubscriptionUnavailable();
  output.push({mark:entry.mark,templateId:entry.templateId});
 }
 return output;
}
function policy(env:Signing,value:unknown):RoutineSubscriptionAccountPolicy{
 const r=subscriptionObject(value,['accountId','state','appId','credentialRef','credentialVersion','credentialStamp','purposes','templates','validFrom','validUntil']);
 if(!token(r.appId,32)||r.accountId!==routineSubscriptionAccountId(env,r.appId)||!token(r.credentialRef)||!subscriptionInteger(r.credentialVersion)||!subscriptionHex(r.credentialStamp)
  ||r.state!=='active'&&r.state!=='revoked'||!subscriptionInteger(r.validFrom)||!subscriptionInteger(r.validUntil)||r.validUntil<=r.validFrom||r.validUntil-r.validFrom>366*86400)return routineSubscriptionUnavailable();
 const p=r.purposes;
 if(!Array.isArray(p)||Object.getPrototypeOf(p)!==Array.prototype||p.length!==1||Reflect.ownKeys(p).length!==2
  ||!Object.getOwnPropertyDescriptor(p,'0')?.enumerable||!('value'in Object.getOwnPropertyDescriptor(p,'0')!)||p[0]!=='subscription_send')return routineSubscriptionUnavailable();
 return{accountId:r.accountId as string,state:r.state,appId:r.appId,credentialRef:r.credentialRef,
  credentialVersion:r.credentialVersion,credentialStamp:r.credentialStamp,purposes:['subscription_send'],templates:templates(r.templates),validFrom:r.validFrom,validUntil:r.validUntil};
}
function parseRoutineSubscriptionAccountJournal(env:Signing,raw:unknown,scope:RoutineSubscriptionScope):RoutineSubscriptionAccountJournal{
 const r=subscriptionObject(raw,['record_id','account_id','revision','payload','created_at','signature']),p=subscriptionObject(r.payload,['format','scope','previousRecordId','data']);
 const s=subscriptionObject(p.scope,['database','databaseOid','maintenance','maintenanceOid']);
 const created=typeof r.created_at==='string'&&/^[0-9]+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!subscriptionUuid(r.record_id)||!subscriptionHex(r.account_id)||!subscriptionInteger(r.revision)||!subscriptionInteger(created)||p.format!==1||!subscriptionSame(s,scope)
  ||p.previousRecordId!==''&&!subscriptionUuid(p.previousRecordId)||!subscriptionHex(r.signature))return routineSubscriptionUnavailable();
 const data=policy(env,p.data);if(data.accountId!==r.account_id)return routineSubscriptionUnavailable();
 const body={record_id:r.record_id,account_id:r.account_id,revision:r.revision,payload:{format:1 as const,scope:{...scope},previousRecordId:p.previousRecordId as string,data},created_at:created};
 if(!subscriptionEqual(r.signature,subscriptionMac(env,'account-policy',body)))return routineSubscriptionUnavailable();
 return freezeSubscription({...body,signature:r.signature});
}
function validateHistory(decoded: readonly RoutineSubscriptionAccountJournal[], id: string): void {
 for(let i=0;i<decoded.length;i++)if(decoded[i].account_id!==id||decoded[i].revision!==i+1
  ||decoded[i].payload.previousRecordId!==(i?decoded[i-1].record_id:'')||i>0&&decoded[i].created_at<decoded[i-1].created_at)return routineSubscriptionUnavailable();
}
return { policy, journal: parseRoutineSubscriptionAccountJournal, validateHistory };
})();

export const parseRoutineRefundAccountPolicy = refundCodec.policy;
export const parseRoutineRefundAccountJournal = refundCodec.journal;
export const validateRoutineRefundAccountHistory = refundCodec.validateHistory;
export const parseRoutineShippingAccountPolicy = shippingCodec.policy;
export const parseRoutineShippingAccountJournal = shippingCodec.journal;
export const validateRoutineShippingAccountHistory = shippingCodec.validateHistory;
export const parseRoutineSubscriptionAccountPolicy = subscriptionCodec.policy;
export const parseRoutineSubscriptionAccountJournal = subscriptionCodec.journal;
export const validateRoutineSubscriptionAccountHistory = subscriptionCodec.validateHistory;
