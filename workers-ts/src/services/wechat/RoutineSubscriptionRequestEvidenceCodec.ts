import { parseRoutineSubscriptionPaidIntent, type RoutineSubscriptionPaidIntent } from './RoutineSubscriptionPaidEvidenceCodec';
/** Historical authentication only. These pure decoders do not issue records,
 * inspect a current LOGIN, select latest policies, obtain tokens or permit I/O. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import { parseRoutineSubscriptionAccountJournal, type RoutineSubscriptionAccountJournal,
  type RoutineSubscriptionScope } from '../payment/RoutinePurposeAccountEvidenceCodec';
import type { RoutineSubscriptionLegacyDeliveryNoticeFacts, RoutineSubscriptionNoticeRequest as DeliveryNoticeRequest } from './RoutineSubscriptionDeliveryNotice';
import { routineSubscriptionDeliveryKey, routineSubscriptionRefusalKey, routineSubscriptionPinkKey, routineSubscriptionRefundSuccessKey } from './RoutineSubscriptionNoticeKinds';

type Signing=Readonly<{APP_KEY?:string}>;
const routineSubscriptionUnavailable=():never=>{throw new ServiceUnavailableException('小程序原账号订阅通知批准、凭据或证据尚未完整就绪');};
const subscriptionHex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const subscriptionUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const subscriptionInteger=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
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
const subscriptionMac=(env:Pick<Env,'APP_KEY'>,domain:string,value:unknown)=>routineEvidenceHmac(env,'subscription-'+domain,value);
function subscriptionEqual(actual:unknown,expected:string){return subscriptionHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}

export interface NoticeBusiness {
 orderId:number;orderNo:string;userId:number;deliveryType:'express'|'send'|'fictitious'|'city_delivery';
 deliveryName:string;deliveryId:string;userAddress:string;cityDeliveryJobId?:number;
}
export interface RoutineSubscriptionNoticeRequest {
 readonly format:2;readonly requestId:string;readonly scope:Readonly<RoutineSubscriptionScope>;
 readonly actor:Readonly<{role:string;roleOid:string}>;readonly eventKey:string;readonly aggregateId:number;
 readonly eventTime:number;readonly body:Readonly<NoticeBusiness>;readonly createdAt:number;readonly signature:string;
}

export interface RefusalBusiness { orderId: number; orderNo: string; refundId: number; userId: number; payPrice: string }
export type RoutineSubscriptionRefusalBusiness = RefusalBusiness;
export interface RoutineSubscriptionRefusalDecision { readonly refuseReason: string; readonly refundedTime: number; readonly applicationDigest: string }
export interface RoutineSubscriptionRefusalRequest {
  readonly format: 3; readonly requestId: string; readonly scope: Readonly<RoutineSubscriptionScope>;
  readonly actor: Readonly<{ role: string; roleOid: string }>; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: Readonly<RefusalBusiness>; readonly decision: Readonly<RoutineSubscriptionRefusalDecision>;
  readonly createdAt: number; readonly signature: string;
}

export interface RoutineSubscriptionPinkBusiness { orderId: number; orderNo: string; userId: number; pinkId: number; people: number }
export interface RoutineSubscriptionPinkGroup {
  readonly pinkId: number; readonly combinationId: number; readonly productId: number; readonly people: number;
  readonly completedAt: number; readonly realMembers: number; readonly virtualMembers: number;
  readonly memberIds: readonly number[]; readonly membersDigest: string;
}
export interface RoutineSubscriptionPinkMember {
  readonly id: number; readonly uid: number; readonly orderId: number; readonly orderNo: string;
  readonly orderIdKey: string; readonly addTime: number;
}
export interface RoutineSubscriptionPinkRequest {
  readonly format: 4; readonly requestId: string; readonly scope: Readonly<RoutineSubscriptionScope>;
  readonly actor: Readonly<{ role: string; roleOid: string }>; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: Readonly<RoutineSubscriptionPinkBusiness>; readonly group: Readonly<RoutineSubscriptionPinkGroup>;
  readonly member: Readonly<RoutineSubscriptionPinkMember>; readonly createdAt: number; readonly signature: string;
}

/** Authenticated staging projection, never evidence of a POST or fresh send
 * authority. The immutable accepted intent remains the dispatch attempt. */
export interface RoutineSubscriptionLegacyNoticeIntent {
  format: 2 | 3 | 4 | 5 | 6; scope: RoutineSubscriptionScope; actor: { role: string; roleOid: string };
  deliveryId: number; outboxId: number; eventKey: string; createdAt: number; requestSignature: string;
  source: RoutineSubscriptionLegacyDeliveryNoticeFacts; policy: RoutineSubscriptionAccountJournal;
  request: Readonly<DeliveryNoticeRequest>; signature: string;
}
export type RoutineSubscriptionNoticeIntent = RoutineSubscriptionLegacyNoticeIntent | RoutineSubscriptionPaidIntent;

const noticeCodec = (() => {
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z_][a-z0-9_]{0,62}$/u.test(value)
 &&!value.startsWith('pg_')&&value!=='information_schema';
const oid=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/u.test(value)&&BigInt(value)<=4294967295n;
function text(value:unknown,max:number,required=false):value is string{
 if(typeof value!=='string'||required&&!value||value.length>max*2)return false;
 let count=0;for(const character of value){const point=character.codePointAt(0)!;if(++count>max||point>=0xd800&&point<=0xdfff)return false;}
 return true;
}
function signing(value:Signing|undefined):Readonly<Pick<Env,'APP_KEY'>>|undefined{
 if(!value||typeof value!=='object')return;
 const descriptor=Object.getOwnPropertyDescriptor(value,'APP_KEY');
 if(!descriptor||!descriptor.enumerable||!('value'in descriptor)||typeof descriptor.value!=='string'
  ||!descriptor.value||descriptor.value.length>8192)return;
 return Object.freeze({APP_KEY:descriptor.value});
}
function scopeValue(value:unknown):Readonly<RoutineSubscriptionScope>{
 const r=subscriptionObject(value,['database','databaseOid','maintenance','maintenanceOid']);
 if(!name(r.database)||!oid(r.databaseOid)||!name(r.maintenance)||!oid(r.maintenanceOid))return routineSubscriptionUnavailable();
 return Object.freeze({database:r.database,databaseOid:r.databaseOid,maintenance:r.maintenance,maintenanceOid:r.maintenanceOid});
}
/** Exact primitive copy, never an arbitrary payload spread. A guest/fictitious
 * body may be compared by a caller, but cannot become a signed Mini request. */
function captureRoutineSubscriptionNoticeBusiness(value:unknown):Readonly<NoticeBusiness>{
 if(!value||typeof value!=='object')return routineSubscriptionUnavailable();
 const keys=['orderId','orderNo','userId','deliveryType','deliveryName','deliveryId','userAddress'];
 if(Object.hasOwn(value,'cityDeliveryJobId'))keys.push('cityDeliveryJobId');
 const r=subscriptionObject(value,keys);
 if(!subscriptionInteger(r.orderId)||!text(r.orderNo,32,true)||!Number.isSafeInteger(r.userId)
  ||Number(r.userId)<0||Number(r.userId)>2147483647
  ||typeof r.deliveryType!=='string'||!['express','send','fictitious','city_delivery'].includes(r.deliveryType)
  ||!text(r.deliveryName,64)||!text(r.deliveryId,64)||!text(r.userAddress,100)
  ||(r.deliveryType==='city_delivery'?!subscriptionInteger(r.cityDeliveryJobId):Object.hasOwn(r,'cityDeliveryJobId')))
  return routineSubscriptionUnavailable();
 return Object.freeze({orderId:r.orderId,orderNo:r.orderNo,userId:r.userId as number,deliveryType:r.deliveryType as NoticeBusiness['deliveryType'],
  deliveryName:r.deliveryName,deliveryId:r.deliveryId,userAddress:r.userAddress,
  ...(r.deliveryType==='city_delivery'?{cityDeliveryJobId:r.cityDeliveryJobId as number}:{})});
}
function eventKey(body:Readonly<NoticeBusiness>){
 return `order.delivery.notice:${body.orderId}`+(body.deliveryType==='city_delivery'?`:city:${body.cityDeliveryJobId}`:'');
}
/** Historical signed provenance only. The writer need not still exist or remain
 * enabled today. This establishes no current owner, template approval, latest
 * policy, token or permission to POST; App admission proves those separately. */
function parseRoutineSubscriptionNoticeRequest(env:Pick<Env,'APP_KEY'>,raw:unknown,
 expectedScope:RoutineSubscriptionScope):Readonly<RoutineSubscriptionNoticeRequest>{
 const key=signing(env);if(!key)return routineSubscriptionUnavailable();
 const r=subscriptionObject(raw,['format','requestId','scope','actor','eventKey','aggregateId','eventTime','body','createdAt','signature']);
 const scope=scopeValue(r.scope),expected=scopeValue(expectedScope),actor=subscriptionObject(r.actor,['role','roleOid']);
 const business=captureRoutineSubscriptionNoticeBusiness(r.body);
 if(r.format!==2||!subscriptionUuid(r.requestId)||!subscriptionSame(scope,expected)||!name(actor.role)||!oid(actor.roleOid)
  ||actor.role===scope.maintenance||actor.roleOid===scope.maintenanceOid||r.eventKey!==eventKey(business)||r.aggregateId!==business.orderId
  ||!subscriptionInteger(business.userId)||business.deliveryType==='fictitious'||!subscriptionInteger(r.eventTime)||!subscriptionInteger(r.createdAt))
  return routineSubscriptionUnavailable();
 const body={format:2 as const,requestId:r.requestId,scope,actor:Object.freeze({role:actor.role,roleOid:actor.roleOid}),
  eventKey:r.eventKey as string,aggregateId:business.orderId,eventTime:r.eventTime,body:business,createdAt:r.createdAt};
 if(!subscriptionEqual(r.signature,subscriptionMac(key,'notice-request',body)))return routineSubscriptionUnavailable();
 return freezeSubscription({...body,signature:r.signature as string});
}

return parseRoutineSubscriptionNoticeRequest;
})();
export const parseRoutineSubscriptionNoticeRequest = noticeCodec;

const refusalCodec = (() => {
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
const zeroInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const money = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/u.test(v);
function text(v: unknown, max: number, nonempty = false): v is string {
  if (typeof v !== 'string' || nonempty && !v || v.length > max * 2) return false;
  let count = 0; for (const c of v) { const point = c.codePointAt(0)!; if (++count > max || point >= 0xd800 && point <= 0xdfff) return false; } return true;
}
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const key = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!key?.enumerable || !('value' in key) || typeof key.value !== 'string' || !key.value || key.value.length > 8192) return;
  return Object.freeze({ APP_KEY: key.value });
}
function scopeValue(raw: unknown): Readonly<RoutineSubscriptionScope> {
  const r = subscriptionObject(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return Object.freeze({ database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid });
}
function captureRoutineSubscriptionRefusalBusiness(raw: unknown): Readonly<RefusalBusiness> {
  const r = subscriptionObject(raw, ['orderId', 'orderNo', 'refundId', 'userId', 'payPrice']);
  if (!subscriptionInteger(r.orderId) || !subscriptionInteger(r.refundId) || !zeroInteger(r.userId) || !text(r.orderNo, 32, true) || !money(r.payPrice))
    return routineSubscriptionUnavailable();
  return Object.freeze({ orderId: r.orderId, orderNo: r.orderNo, refundId: r.refundId, userId: r.userId, payPrice: r.payPrice });
}
function decisionValue(raw: unknown, eventTime: number): Readonly<RoutineSubscriptionRefusalDecision> {
  const r = subscriptionObject(raw, ['refuseReason', 'refundedTime', 'applicationDigest']);
  if (!text(r.refuseReason, 255, true) || r.refuseReason !== r.refuseReason.trim() || !subscriptionInteger(r.refundedTime)
    || r.refundedTime !== eventTime || !subscriptionHex(r.applicationDigest)) return routineSubscriptionUnavailable();
  return Object.freeze({ refuseReason: r.refuseReason, refundedTime: r.refundedTime, applicationDigest: r.applicationDigest });
}
function parseRoutineSubscriptionRefusalRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown,
  expectedScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionRefusalRequest> {
  const key = signing(env); if (!key) return routineSubscriptionUnavailable();
  const r = subscriptionObject(raw, ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'decision', 'createdAt', 'signature']);
  const scope = scopeValue(r.scope), expected = scopeValue(expectedScope), actor = subscriptionObject(r.actor, ['role', 'roleOid']);
  const body = captureRoutineSubscriptionRefusalBusiness(r.body);
  if (r.format !== 3 || !subscriptionUuid(r.requestId) || !subscriptionSame(scope, expected) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === scope.maintenance || actor.roleOid === scope.maintenanceOid || !subscriptionInteger(body.userId)
    || r.eventKey !== `order.refund.refused.notice:${body.refundId}` || r.aggregateId !== body.orderId
    || !subscriptionInteger(r.eventTime) || !subscriptionInteger(r.createdAt)) return routineSubscriptionUnavailable();
  const decision = decisionValue(r.decision, r.eventTime);
  const unsigned = { format: 3 as const, requestId: r.requestId, scope, actor: Object.freeze({ role: actor.role, roleOid: actor.roleOid }),
    eventKey: r.eventKey as string, aggregateId: body.orderId, eventTime: r.eventTime, body, decision, createdAt: r.createdAt };
  if (!subscriptionEqual(r.signature, subscriptionMac(key, 'refusal-notice-request', unsigned))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...unsigned, signature: r.signature as string });
}

return parseRoutineSubscriptionRefusalRequest;
})();
export const parseRoutineSubscriptionRefusalRequest = refusalCodec;

const pinkCodec = (() => {
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
const zero = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const people = (v: unknown): v is number => subscriptionInteger(v) && v >= 2 && v <= 500;
function text(v: unknown, max: number, nonempty = false): v is string {
  if (typeof v !== 'string' || nonempty && !v || v.length > max * 2) return false;
  let count = 0; for (const c of v) { const point = c.codePointAt(0)!; if (++count > max || point >= 0xd800 && point <= 0xdfff) return false; } return true;
}
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const d = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192) return;
  return Object.freeze({ APP_KEY: d.value });
}
function scopeValue(raw: unknown): Readonly<RoutineSubscriptionScope> {
  const r = subscriptionObject(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return Object.freeze({ database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid });
}
function array(raw: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1)
    return routineSubscriptionUnavailable();
  const values: unknown[] = [];
  for (let i = 0; i < raw.length; i++) { const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable(); values.push(d.value); }
  return values;
}
function captureRoutineSubscriptionPinkBusiness(raw: unknown): Readonly<RoutineSubscriptionPinkBusiness> {
  const r = subscriptionObject(raw, ['orderId', 'orderNo', 'userId', 'pinkId', 'people']);
  if (!subscriptionInteger(r.orderId) || !text(r.orderNo, 32, true) || !subscriptionInteger(r.userId)
    || !subscriptionInteger(r.pinkId) || !people(r.people)) return routineSubscriptionUnavailable();
  return Object.freeze({ orderId: r.orderId, orderNo: r.orderNo, userId: r.userId, pinkId: r.pinkId, people: r.people });
}
function groupValue(raw: unknown): Readonly<RoutineSubscriptionPinkGroup> {
  const r = subscriptionObject(raw, ['pinkId', 'combinationId', 'productId', 'people', 'completedAt', 'realMembers', 'virtualMembers', 'memberIds', 'membersDigest']);
  const ids = array(r.memberIds, 500);
  if (!subscriptionInteger(r.pinkId) || !subscriptionInteger(r.combinationId) || !subscriptionInteger(r.productId) || !people(r.people)
    || !subscriptionInteger(r.completedAt) || !subscriptionInteger(r.realMembers) || !zero(r.virtualMembers)
    || r.realMembers + r.virtualMembers !== r.people || ids.length !== r.people || !subscriptionHex(r.membersDigest)
    || ids.some((id, i) => !subscriptionInteger(id) || i > 0 && (ids[i - 1] as number) >= id) || !ids.includes(r.pinkId)) return routineSubscriptionUnavailable();
  return freezeSubscription({ pinkId: r.pinkId, combinationId: r.combinationId, productId: r.productId, people: r.people,
    completedAt: r.completedAt, realMembers: r.realMembers, virtualMembers: r.virtualMembers, memberIds: ids as number[], membersDigest: r.membersDigest });
}
function memberValue(raw: unknown, body: Readonly<RoutineSubscriptionPinkBusiness>, group: Readonly<RoutineSubscriptionPinkGroup>): Readonly<RoutineSubscriptionPinkMember> {
  const r = subscriptionObject(raw, ['id', 'uid', 'orderId', 'orderNo', 'orderIdKey', 'addTime']);
  if (!subscriptionInteger(r.id) || !group.memberIds.includes(r.id) || r.uid !== body.userId || r.orderId !== body.orderId || r.orderNo !== body.orderNo
    || !text(r.orderIdKey, 32) || !subscriptionInteger(r.addTime) || r.addTime > group.completedAt) return routineSubscriptionUnavailable();
  return Object.freeze({ id: r.id, uid: body.userId, orderId: body.orderId, orderNo: body.orderNo, orderIdKey: r.orderIdKey, addTime: r.addTime });
}
/** Historical formation provenance only. Current owner, independent 3098
 * approval and each buyer's original payment remain fresh App/Queue checks. */
function parseRoutineSubscriptionPinkRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown,
  expectedScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionPinkRequest> {
  const key = signing(env); if (!key) return routineSubscriptionUnavailable();
  const r = subscriptionObject(raw, ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'group', 'member', 'createdAt', 'signature']);
  const scope = scopeValue(r.scope), expected = scopeValue(expectedScope), actor = subscriptionObject(r.actor, ['role', 'roleOid']);
  const body = captureRoutineSubscriptionPinkBusiness(r.body), group = groupValue(r.group), member = memberValue(r.member, body, group);
  if (r.format !== 4 || !subscriptionUuid(r.requestId) || !subscriptionSame(scope, expected) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === scope.maintenance || actor.roleOid === scope.maintenanceOid || r.eventKey !== `order.pink.success.notice:${body.orderId}`
    || r.aggregateId !== body.orderId || !subscriptionInteger(r.eventTime) || !subscriptionInteger(r.createdAt)
    || group.pinkId !== body.pinkId || group.people !== body.people) return routineSubscriptionUnavailable();
  const unsigned = { format: 4 as const, requestId: r.requestId, scope, actor: Object.freeze({ role: actor.role, roleOid: actor.roleOid }),
    eventKey: r.eventKey as string, aggregateId: body.orderId, eventTime: r.eventTime, body, group, member, createdAt: r.createdAt };
  if (!subscriptionEqual(r.signature, subscriptionMac(key, 'pink-notice-request', unsigned))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...unsigned, signature: r.signature as string });
}

return parseRoutineSubscriptionPinkRequest;
})();
export const parseRoutineSubscriptionPinkRequest = pinkCodec;

const intentCodec = (() => {
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
/** Bounded JSON snapshot before any serializer, coercion or recursive parser.
 * Reflection reads descriptors only; no getter/toJSON/prototype method is used.
 * A shared acyclic subtree is copied, while an ancestor cycle is rejected. */
function captureIntentJson(raw: unknown): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (value: string) => {
    if (value.length > 65536) return routineSubscriptionUnavailable();
    for (const c of value) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return routineSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(value, 'utf8'); if (bytes > 65536) return routineSubscriptionUnavailable(); return value;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return routineSubscriptionUnavailable();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : routineSubscriptionUnavailable();
    if (!value || typeof value !== 'object' || ancestors.has(value)) return routineSubscriptionUnavailable();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return routineSubscriptionUnavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string')) return routineSubscriptionUnavailable();
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors.length;
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 4095
          || keys.length !== length.value + 1) return routineSubscriptionUnavailable();
        const output: unknown[] = [];
        for (let i = 0; i < length.value; i++) {
          const d = descriptors[String(i)]; if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable();
          output.push(copy(d.value, depth + 1));
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        const d = descriptors[key as string];
        if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable();
        output[string(key as string)] = copy(d.value, depth + 1);
      }
      return output;
    } finally { ancestors.delete(value); }
  };
  const snapshot = copy(raw, 0);
  const encoded = JSON.stringify(snapshot);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 65536) return routineSubscriptionUnavailable();
  return snapshot;
}
const roleName = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const roleOid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
function captureIntentScope(raw: unknown): RoutineSubscriptionScope {
  const r = subscriptionObject(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!roleName(r.database) || !roleOid(r.databaseOid) || !roleName(r.maintenance) || !roleOid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return { database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid };
}
function parseRoutineSubscriptionNoticeIntent(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionNoticeIntent> {
  const snapshot = captureIntentJson(raw);
  if ((snapshot as { format?: unknown })?.format === 7) return parseRoutineSubscriptionPaidIntent(env, snapshot, scope);
  const r = subscriptionObject(snapshot, ['format', 'scope', 'actor', 'deliveryId', 'outboxId', 'eventKey', 'createdAt', 'requestSignature', 'source', 'policy', 'request', 'signature']);
  const expectedScope = captureIntentScope(scope), capturedScope = captureIntentScope(r.scope);
  const actor = subscriptionObject(r.actor, ['role', 'roleOid']);
  const source = subscriptionObject(r.source, ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'appId', 'ownershipId', 'bindingId',
    'observationId', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest', 'templateMark', 'sourceDigest']);
  const q = subscriptionObject(r.request, ['touser', 'template_id', 'page', 'data']);
  const success = r.format === 5 || r.format === 6;
  const refusal = r.format === 3;
  const pink = r.format === 4;
  if (r.format !== 2 && r.format !== 3 && r.format !== 4 && r.format !== 5 && r.format !== 6 || !subscriptionSame(capturedScope, expectedScope) || !roleName(actor.role) || !roleOid(actor.roleOid)
    || !subscriptionInteger(r.deliveryId) || !subscriptionInteger(r.outboxId) || !subscriptionInteger(r.createdAt)
    || !(success ? routineSubscriptionRefundSuccessKey(r.eventKey) : pink ? routineSubscriptionPinkKey(r.eventKey) : refusal ? routineSubscriptionRefusalKey(r.eventKey) : routineSubscriptionDeliveryKey(r.eventKey))
    || !subscriptionHex(r.requestSignature) || !subscriptionHex(r.signature) || r.deliveryId !== source.deliveryId || r.outboxId !== source.outboxId
    || r.eventKey !== source.eventKey || !subscriptionInteger(source.orderId) || !subscriptionInteger(source.rootId) || !subscriptionInteger(source.buyerUid)
    || !subscriptionInteger(source.bindingId) || !text(source.appId, 32) || !text(source.ownershipId, 128) || !text(source.observationId, 128)
    || !text(source.evidenceId, 128) || !subscriptionHex(source.evidenceSignature) || !subscriptionHex(source.relatedDigest)
    || !subscriptionHex(source.approvedUseDigest) || !subscriptionHex(source.sourceDigest) || typeof source.templateMark !== 'string'
    || !(pink ? source.templateMark === '3098' : refusal || success ? source.templateMark === '1451' : ['1458', '1128'].includes(source.templateMark))
    || !text(q.touser, 128) || !text(q.template_id, 100) || !text(q.page, 512) || !q.data || typeof q.data !== 'object' || Array.isArray(q.data)
    || Buffer.byteLength(JSON.stringify(r), 'utf8') > 65536) return routineSubscriptionUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(q.data), fields = Reflect.ownKeys(q.data);
  if (fields.length < 1 || fields.length > 16 || fields.some(key => typeof key !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(key)
    || !descriptors[key]?.enumerable || !('value' in descriptors[key]))) return routineSubscriptionUnavailable();
  for (const d of Object.values(descriptors)) {
    const value = subscriptionObject(d.value, ['value']);
    if (typeof value.value !== 'string' || value.value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value.value)) return routineSubscriptionUnavailable();
  }
  const policy = parseRoutineSubscriptionAccountJournal(env, r.policy, expectedScope);
  if (policy.payload.data.appId !== source.appId || policy.payload.data.state !== 'active' || r.createdAt < policy.created_at
    || r.createdAt < policy.payload.data.validFrom || r.createdAt >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === source.templateMark && t.templateId === q.template_id)) return routineSubscriptionUnavailable();
  const { signature, ...body } = r;
  if (!subscriptionEqual(signature, subscriptionMac(env, r.format === 6 ? 'materialized-refund-success-notice-stage' : success ? 'refund-success-notice-stage' : pink ? 'pink-notice-stage' : refusal ? 'refusal-notice-stage' : 'notice-stage', body))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...body, signature } as unknown as RoutineSubscriptionNoticeIntent);
}

return parseRoutineSubscriptionNoticeIntent;
})();
export const parseRoutineSubscriptionNoticeIntent = intentCodec;
