import {captureRoutineSubscriptionRechargeRefundFacts,RECHARGE_REFUND_SUBSCRIPTION_FACT_KEYS}from './RoutineSubscriptionRechargeRefundEvidenceCodec';
import {captureRechargeSubscriptionFacts,RECHARGE_SUBSCRIPTION_FACT_KEYS} from './RoutineSubscriptionRechargeEvidenceCodec';
import { captureMembershipSubscriptionFacts, MEMBERSHIP_SUBSCRIPTION_FACT_KEYS } from './RoutineSubscriptionMembershipEvidenceCodec';
import { capturePaidSubscriptionFacts, PAID_SUBSCRIPTION_FACT_KEYS } from './RoutineSubscriptionPaidEvidenceCodec';
/** Historical authentication only. These pure decoders do not issue records,
 * inspect a current LOGIN, select latest policies, obtain tokens or permit I/O. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import { parseRoutineSubscriptionAccountJournal, type RoutineSubscriptionAccountJournal,
  type RoutineSubscriptionScope } from '../payment/RoutinePurposeAccountEvidenceCodec';
import type { RoutineSubscriptionNoticeIntent } from './RoutineSubscriptionRequestEvidenceCodec';
import { routineSubscriptionNoticeKey, routineSubscriptionRechargeRefundKey, routineSubscriptionPaidKey, routineSubscriptionRechargeKey, routineSubscriptionMembershipKey, routineSubscriptionRefusalKey, routineSubscriptionPinkKey, routineSubscriptionRefundSuccessKey } from './RoutineSubscriptionNoticeKinds';
type RoutineSubscriptionDeliveryNoticeFacts = RoutineSubscriptionNoticeIntent['source'];
type RoutineSubscriptionNoticeRequest = RoutineSubscriptionNoticeIntent['request'];
type Signing = Pick<Env, 'APP_KEY'>;
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
const subscriptionMac=(env:Signing,domain:string,value:unknown)=>routineEvidenceHmac(env,'subscription-'+domain,value);
function subscriptionEqual(actual:unknown,expected:string){return subscriptionHex(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}

export interface RoutineSubscriptionAttemptPayload {
  format: 1; purpose: 'routine_subscription_send'; scope: RoutineSubscriptionScope;
  actor: { role: string; roleOid: string }; previousAttemptId: string; intentDigest: string;
  claim: { eventKey: string; leaseToken: string; attemptCount: number; leaseUntil: number };
  facts: RoutineSubscriptionDeliveryNoticeFacts; policy: RoutineSubscriptionAccountJournal;
  request: Readonly<RoutineSubscriptionNoticeRequest>;
}
export interface RoutineSubscriptionAttempt {
  attempt_id: string; delivery_id: number; attempt_no: number; source_key: string;
  payload: RoutineSubscriptionAttemptPayload; created_at: number; signature: string;
}
export interface RoutineSubscriptionResult {
  result_id: string; attempt_id: string; payload: { format: 1; purpose: 'routine_subscription_result';
    scope: RoutineSubscriptionScope; attemptSignature: string; result: RoutineSubscriptionAcceptedResult };
  created_at: number; signature: string;
}
export interface RoutineSubscriptionAcceptedResult { code: number; httpStatus: number; rawDigest: string; requestStartedAt: number; verifiedAt: number }
export interface RoutineSubscriptionHistoricalActor { role: string; roleOid: string }
type AttemptPayload = RoutineSubscriptionAttemptPayload;
type Attempt = RoutineSubscriptionAttempt;
type Receipt = RoutineSubscriptionResult;
const invalidToken = (code: number) => [40001, 40014, 42001].includes(code);
const retryable = (code: number) => invalidToken(code) || [-1, 45009, 45011, 45028].includes(code);
const number = (v: unknown) => typeof v === 'string' && /^[0-9]+$/u.test(v) ? Number(v) : v;
const time = (v: unknown): v is number => subscriptionInteger(v);
const sourceKey = (env: Signing, c: {id:number;eventKey:string;leaseToken:string}) => subscriptionMac(env, 'delivery-source-key', [c.eventKey, 'wechat_routine']);
export function parseRoutineSubscriptionAttemptForActor(env: Signing, raw: unknown, scope: RoutineSubscriptionScope, actor: { role: string; roleOid: string }): Attempt {
  const r = subscriptionObject(raw, ['attempt_id', 'delivery_id', 'attempt_no', 'source_key', 'payload', 'created_at', 'signature']);
  const p = subscriptionObject(r.payload, ['format', 'purpose', 'scope', 'actor', 'previousAttemptId', 'intentDigest', 'claim', 'facts', 'policy', 'request']);
  const c = subscriptionObject(p.claim, ['eventKey', 'leaseToken', 'attemptCount', 'leaseUntil']);
  const rechargeRefund=routineSubscriptionRechargeRefundKey(c.eventKey),recharge=routineSubscriptionRechargeKey(c.eventKey), membership = routineSubscriptionMembershipKey(c.eventKey), paid = routineSubscriptionPaidKey(c.eventKey);
  if(rechargeRefund)captureRoutineSubscriptionRechargeRefundFacts(p.facts);
  if(recharge)captureRechargeSubscriptionFacts(p.facts);
  if (membership) captureMembershipSubscriptionFacts(p.facts);
  if (paid) capturePaidSubscriptionFacts(p.facts);
  const f = subscriptionObject(p.facts, rechargeRefund ? RECHARGE_REFUND_SUBSCRIPTION_FACT_KEYS : recharge ? RECHARGE_SUBSCRIPTION_FACT_KEYS : membership ? MEMBERSHIP_SUBSCRIPTION_FACT_KEYS : paid ? PAID_SUBSCRIPTION_FACT_KEYS : ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'appId', 'ownershipId', 'bindingId',
    'observationId', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest', 'templateMark', 'sourceDigest']);
  const q = subscriptionObject(p.request, ['touser', 'template_id', 'page', 'data']);
  const created = number(r.created_at);
  if (!subscriptionUuid(r.attempt_id) || !subscriptionInteger(r.delivery_id) || !subscriptionInteger(r.attempt_no) || r.attempt_no > 5
    || !subscriptionHex(r.source_key) || !time(created) || !subscriptionHex(r.signature) || p.format !== 1 || p.purpose !== 'routine_subscription_send'
    || !subscriptionSame(p.scope, scope) || !subscriptionSame(p.actor, actor) || !subscriptionHex(p.intentDigest)
    || p.previousAttemptId !== '' && !subscriptionUuid(p.previousAttemptId) || !subscriptionUuid(c.leaseToken)
    || c.attemptCount !== r.attempt_no || !time(c.leaseUntil) || created >= c.leaseUntil
    || c.eventKey !== f.eventKey || r.delivery_id !== f.deliveryId || typeof c.eventKey !== 'string'
    || !routineSubscriptionNoticeKey(c.eventKey) || typeof f.templateMark !== 'string'
    || !(rechargeRefund||recharge ? f.templateMark==='755' : membership || paid ? f.templateMark === '1927' : routineSubscriptionPinkKey(c.eventKey) ? f.templateMark === '3098' : routineSubscriptionRefusalKey(c.eventKey) || routineSubscriptionRefundSuccessKey(c.eventKey) ? f.templateMark === '1451' : ['1458', '1128'].includes(f.templateMark))
    || r.source_key !== sourceKey(env, { id: r.delivery_id, eventKey: c.eventKey, leaseToken: c.leaseToken })
    || !subscriptionInteger(f.orderId) || !subscriptionInteger(f.rootId) || !subscriptionInteger(f.buyerUid)
    || !subscriptionHex(f.sourceDigest) || !paid && !membership && !recharge && !rechargeRefund && (!subscriptionHex(f.relatedDigest) || !subscriptionHex(f.approvedUseDigest) || !subscriptionHex(f.evidenceSignature)) || typeof q.touser !== 'string' || typeof q.template_id !== 'string'
    || typeof q.page !== 'string' || Buffer.byteLength(JSON.stringify(p), 'utf8') > 65536) return routineSubscriptionUnavailable();
  const policy = parseRoutineSubscriptionAccountJournal(env, p.policy, scope);
  if (policy.payload.data.state !== 'active' || f.appId !== policy.payload.data.appId || created < policy.created_at
    || created < policy.payload.data.validFrom || created >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === f.templateMark && t.templateId === q.template_id)) return routineSubscriptionUnavailable();
  const body = { attempt_id: r.attempt_id, delivery_id: r.delivery_id, attempt_no: r.attempt_no, source_key: r.source_key,
    payload: p as unknown as AttemptPayload, created_at: created };
  if (!subscriptionEqual(r.signature, subscriptionMac(env, 'delivery-attempt', body))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...body, signature: r.signature });
}
function parseReceipt(env: Signing, raw: unknown, a: Attempt, scope: RoutineSubscriptionScope): Receipt {
  const r = subscriptionObject(raw, ['result_id', 'attempt_id', 'payload', 'created_at', 'signature']);
  const p = subscriptionObject(r.payload, ['format', 'purpose', 'scope', 'attemptSignature', 'result']);
  const result = subscriptionObject(p.result, ['code', 'httpStatus', 'rawDigest', 'requestStartedAt', 'verifiedAt']);
  const created = number(r.created_at);
  if (!subscriptionHex(r.result_id) || r.attempt_id !== a.attempt_id || !subscriptionHex(r.signature) || !time(created)
    || p.format !== 1 || p.purpose !== 'routine_subscription_result' || !subscriptionSame(p.scope, scope) || p.attemptSignature !== a.signature
    || !Number.isInteger(result.code) || Number(result.code) < -2147483648 || Number(result.code) > 2147483647
    || !Number.isInteger(result.httpStatus) || Number(result.httpStatus) < 100 || Number(result.httpStatus) > 599
    || result.code === 0 && (Number(result.httpStatus) < 200 || Number(result.httpStatus) >= 300)
    || !subscriptionHex(result.rawDigest) || !time(result.requestStartedAt) || !time(result.verifiedAt)
    || result.verifiedAt < result.requestStartedAt || result.verifiedAt - result.requestStartedAt > 9
    || result.requestStartedAt < a.created_at - 60 || result.verifiedAt > created + 60
    || created < a.created_at || created - a.created_at > 90
    || r.result_id !== subscriptionMac(env, 'delivery-result-id', [a.attempt_id, a.signature])) return routineSubscriptionUnavailable();
  const body = { result_id: r.result_id, attempt_id: r.attempt_id, payload: p as unknown as Receipt['payload'], created_at: created };
  if (!subscriptionEqual(r.signature, subscriptionMac(env, 'delivery-result', body))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...body, signature: r.signature });
}
function captureDispatchJson(raw: unknown, maxBytes = 67584): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (value: string) => {
    if (value.length > maxBytes) return routineSubscriptionUnavailable();
    for (const c of value) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return routineSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(value, 'utf8'); if (bytes > maxBytes) return routineSubscriptionUnavailable(); return value;
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
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > maxBytes) return routineSubscriptionUnavailable();
  return snapshot;
}

const roleName = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const roleOid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
function historicalScope(value: unknown): RoutineSubscriptionScope {
  const r = subscriptionObject(value, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!roleName(r.database) || !roleOid(r.databaseOid) || !roleName(r.maintenance) || !roleOid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return { database:r.database, databaseOid:r.databaseOid, maintenance:r.maintenance, maintenanceOid:r.maintenanceOid };
}
/** The captured actor is authenticated historical provenance. Its role need not
 * still exist or retain LOGIN today; this entry never admits a runtime send. */
export function parseRoutineSubscriptionAttempt(env: Signing, raw: unknown, actualScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionAttempt> {
  const captured = captureDispatchJson(raw);
  const r = subscriptionObject(captured, ['attempt_id', 'delivery_id', 'attempt_no', 'source_key', 'payload', 'created_at', 'signature']);
  const p = subscriptionObject(r.payload, ['format', 'purpose', 'scope', 'actor', 'previousAttemptId', 'intentDigest', 'claim', 'facts', 'policy', 'request']);
  const actor = subscriptionObject(p.actor, ['role', 'roleOid']), scope = historicalScope(actualScope);
  historicalScope(p.scope);
  if (!roleName(actor.role) || !roleOid(actor.roleOid) || actor.role === scope.maintenance || actor.roleOid === scope.maintenanceOid) return routineSubscriptionUnavailable();
  return parseRoutineSubscriptionAttemptForActor(env, captured, scope, {role:actor.role,roleOid:actor.roleOid});
}
/** A receipt authenticates only its bound historical attempt and bounded HTTP
 * result. It does not re-open current policy or repeat the provider request. */
export function parseRoutineSubscriptionResult(env: Signing, raw: unknown, a: RoutineSubscriptionAttempt,
  actualScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionResult> {
  return parseReceipt(env, captureDispatchJson(raw, 32768), a, actualScope);
}
export interface RoutineSubscriptionAttemptChainIdentity { deliveryId:number; eventKey:string }
export interface RoutineSubscriptionAttemptChain {
  readonly state:'complete'|'unknown'; readonly attempts:readonly Readonly<RoutineSubscriptionAttempt>[];
  readonly results:readonly Readonly<RoutineSubscriptionResult>[]; readonly missingAttemptIds:readonly string[];
}
function rows(raw: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max
    || Reflect.ownKeys(raw).length !== raw.length + 1) return routineSubscriptionUnavailable();
  const output:unknown[] = [];
  for (let i=0;i<raw.length;i++) { const d=Object.getOwnPropertyDescriptor(raw,String(i));
    if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable(); output.push(d.value); }
  return output;
}
/** Authenticates a whole bounded history, including conflict/orphan rows. It
 * checks historical policy validity at each attempt, never latest policy or
 * current LOGIN. An absent final result is UNKNOWN and cannot admit a retry. */
export function validateRoutineSubscriptionAttemptChain(env: Signing, attemptRows: unknown, resultRows: unknown,
  actualScope: RoutineSubscriptionScope, identity: RoutineSubscriptionAttemptChainIdentity): Readonly<RoutineSubscriptionAttemptChain> {
  const target=subscriptionObject(identity,['deliveryId','eventKey']),scope=historicalScope(actualScope);
  if (!subscriptionInteger(target.deliveryId) || !routineSubscriptionNoticeKey(target.eventKey)) return routineSubscriptionUnavailable();
  const capturedAttempts=rows(attemptRows,5).map(row=>captureDispatchJson(row));
  if (Buffer.byteLength(JSON.stringify(capturedAttempts),'utf8')>327680) return routineSubscriptionUnavailable();
  const attempts=capturedAttempts.map(row=>parseRoutineSubscriptionAttempt(env,row,scope)).sort((a,b)=>a.attempt_no-b.attempt_no);
  const results:Readonly<RoutineSubscriptionResult>[]=[];
  const missing:string[]=[];
  const saved=new Map<string,unknown>();
  for (const row of rows(resultRows,5)) {
    const captured=captureDispatchJson(row), r=subscriptionObject(captured,['result_id','attempt_id','payload','created_at','signature']);
    if (typeof r.attempt_id!=='string' || saved.has(r.attempt_id) || !attempts.some(a=>a.attempt_id===r.attempt_id)
      || Buffer.byteLength(JSON.stringify(captured),'utf8')>32768) return routineSubscriptionUnavailable();
    saved.set(r.attempt_id,captured);
  }
  const key=subscriptionMac(env,'delivery-source-key',[target.eventKey,'wechat_routine']);
  for (let i=0;i<attempts.length;i++) {
    const a=attempts[i]!;
    if (a.delivery_id!==target.deliveryId || a.source_key!==key || a.attempt_no!==i+1 || a.payload.claim.eventKey!==target.eventKey
      || a.payload.previousAttemptId!==(attempts[i-1]?.attempt_id??'')
      || i>0 && (!subscriptionSame(a.payload.request,attempts[0]!.payload.request) || a.payload.intentDigest!==attempts[0]!.payload.intentDigest)
      || attempts.some((other,j)=>j!==i && other.attempt_id===a.attempt_id)) return routineSubscriptionUnavailable();
    if (!saved.has(a.attempt_id)) {
      if (i<attempts.length-1) return routineSubscriptionUnavailable();
      missing.push(a.attempt_id); continue;
    }
    const result=parseRoutineSubscriptionResult(env,saved.get(a.attempt_id),a,scope); results.push(result);
    if (i<attempts.length-1 && (!retryable(result.payload.result.code) || result.payload.result.code===0)) return routineSubscriptionUnavailable();
  }
  return freezeSubscription({state:missing.length?'unknown' as const:'complete' as const,attempts,results,missingAttemptIds:missing});
}
