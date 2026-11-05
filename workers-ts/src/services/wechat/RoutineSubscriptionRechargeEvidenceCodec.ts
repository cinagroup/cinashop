/** Historical format-9 recharge authentication only; no current send authority. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { captureRechargePaidNoticeBusiness, rechargePaidNoticeEventKey, type RechargePaidNoticeBusiness } from '../order/RechargePaidNoticeCodec';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import { parseRoutineSubscriptionAccountJournal, type RoutineSubscriptionScope, type RoutineSubscriptionAccountJournal } from '../payment/RoutinePurposeAccountEvidenceCodec';

export const RECHARGE_SUBSCRIPTION_EVENT = 'recharge.pay.success.notice';
export interface RechargeSubscriptionSelection {
  mode: 'routine-original' | 'unique-owner'; appId: string; ownershipId: string;
  bindingId: number; observationId: string; openid: string; ownershipDigest: string;
}
export interface RoutineSubscriptionRechargeRequest {
  readonly format: 9; readonly requestId: string; readonly scope: RoutineSubscriptionScope;
  readonly actor: { role: string; roleOid: string }; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: RechargePaidNoticeBusiness; readonly selection: RechargeSubscriptionSelection;
  readonly settlementDigest: string; readonly paymentDigest: string; readonly createdAt: number; readonly signature: string;
}
export type RechargeSubscriptionPayment = { kind: 'routine-original'; evidenceId: string; evidenceSignature: string; relatedDigest: string; approvedUseDigest: string }
  | { kind: 'unique-identity'; payType: 'alipay'; paymentDigest: string };
export interface RoutineSubscriptionRechargeNoticeFacts {
  deliveryId: number; outboxId: number; eventKey: string; orderId: number; rootId: number; buyerUid: number;
  subjectDomain: 'recharge'; appId: string; ownershipId: string; bindingId: number; observationId: string;
  templateMark: '755'; settlementNonce: string; settlementDigest: string; ownershipDigest: string;
  payment: RechargeSubscriptionPayment; sourceDigest: string;
}
export interface RoutineSubscriptionRechargeIntent {
  format: 9; scope: RoutineSubscriptionScope; actor: { role: string; roleOid: string }; deliveryId: number;
  outboxId: number; eventKey: string; createdAt: number; requestSignature: string; source: RoutineSubscriptionRechargeNoticeFacts;
  policy: RoutineSubscriptionAccountJournal; request: { touser: string; template_id: string; page: string; data: Record<string, { value: string }> }; signature: string;
}
export const rechargeSubscriptionUnavailable = (): never => { throw new ServiceUnavailableException('小程序付款通知账号归属、批准或证据尚未完整就绪'); };
export const rechargeSubscriptionInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
export const rechargeSubscriptionHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const rechargeSubscriptionUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const token = (v: unknown, n = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`, 'u').test(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
export function rechargeSubscriptionObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return rechargeSubscriptionUnavailable();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) return rechargeSubscriptionUnavailable();
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
/** Copy first: JSON serialization and freezing must never invoke input code. */
function copyJson(raw: unknown, max = 65536): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (v: string) => {
    if (v.length > max) return rechargeSubscriptionUnavailable();
    for (const c of v) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return rechargeSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(v, 'utf8'); if (bytes > max) return rechargeSubscriptionUnavailable(); return v;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return rechargeSubscriptionUnavailable();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : rechargeSubscriptionUnavailable();
    if (!value || typeof value !== 'object' || ancestors.has(value)) return rechargeSubscriptionUnavailable();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return rechargeSubscriptionUnavailable();
    const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string')) return rechargeSubscriptionUnavailable();
    ancestors.add(value);
    try {
      if (array) {
        const length = ds.length;
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 4095 || keys.length !== length.value + 1) return rechargeSubscriptionUnavailable();
        return Array.from({ length: length.value }, (_, i) => {
          const d = ds[String(i)]; if (!d?.enumerable || !('value' in d)) return rechargeSubscriptionUnavailable(); return copy(d.value, depth + 1);
        });
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const key of keys) { const d = ds[key as string]; if (!d?.enumerable || !('value' in d)) return rechargeSubscriptionUnavailable(); out[string(key as string)] = copy(d.value, depth + 1); }
      return out;
    } finally { ancestors.delete(value); }
  };
  const result = copy(raw, 0); if (Buffer.byteLength(JSON.stringify(result), 'utf8') > max) return rechargeSubscriptionUnavailable(); return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value); Object.freeze(value); }
  return value;
}
export function rechargeSubscriptionScope(v: unknown): RoutineSubscriptionScope {
  const r = rechargeSubscriptionObject(v, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return rechargeSubscriptionUnavailable();
  return r as unknown as RoutineSubscriptionScope;
}
export const rechargeSubscriptionSame = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
export const rechargeSubscriptionMac = (env: Pick<Env, 'APP_KEY'>, domain: string, value: unknown) => routineEvidenceHmac(env, 'subscription-' + domain, value);
function equal(a: unknown, b: string) { return rechargeSubscriptionHex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
export function captureRechargeSubscriptionSelection(raw: unknown): RechargeSubscriptionSelection {
  const r = rechargeSubscriptionObject(raw, ['mode', 'appId', 'ownershipId', 'bindingId', 'observationId', 'openid', 'ownershipDigest']);
  if (typeof r.mode !== 'string' || !['routine-original', 'unique-owner'].includes(r.mode) || !token(r.appId, 32) || !rechargeSubscriptionHex(r.ownershipId)
    || !rechargeSubscriptionInteger(r.bindingId) || !rechargeSubscriptionUuid(r.observationId) || !token(r.openid, 100) || !rechargeSubscriptionHex(r.ownershipDigest)) return rechargeSubscriptionUnavailable();
  return r as unknown as RechargeSubscriptionSelection;
}
export function parseRoutineSubscriptionRechargeRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionRechargeRequest> {
  const r = rechargeSubscriptionObject(copyJson(raw, 16384), ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'selection', 'settlementDigest', 'paymentDigest', 'createdAt', 'signature']);
  const s = rechargeSubscriptionScope(r.scope), actor = rechargeSubscriptionObject(r.actor, ['role', 'roleOid']);
  const body = captureRechargePaidNoticeBusiness(r.body), selection = captureRechargeSubscriptionSelection(r.selection);
  if (r.format !== 9 || !rechargeSubscriptionUuid(r.requestId) || !rechargeSubscriptionSame(s, rechargeSubscriptionScope(scope)) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === s.maintenance || actor.roleOid === s.maintenanceOid || r.eventKey !== rechargePaidNoticeEventKey(body.orderId)
    || r.aggregateId !== body.orderId || r.eventTime !== body.occurredAt || !rechargeSubscriptionInteger(r.createdAt)
    || (body.payType === 'weixin' ? selection.mode !== 'routine-original' : selection.mode !== 'unique-owner')
    || !rechargeSubscriptionHex(r.settlementDigest) || !rechargeSubscriptionHex(r.paymentDigest) || Buffer.byteLength(JSON.stringify(r), 'utf8') > 16384) return rechargeSubscriptionUnavailable();
  const unsigned = { format: 9 as const, requestId: r.requestId, scope: s, actor, eventKey: r.eventKey, aggregateId: r.aggregateId,
    eventTime: r.eventTime, body, selection, settlementDigest: r.settlementDigest, paymentDigest: r.paymentDigest, createdAt: r.createdAt };
  if (!equal(r.signature, rechargeSubscriptionMac(env, 'recharge-notice-request', unsigned))) return rechargeSubscriptionUnavailable();
  return freeze({ ...unsigned, signature: r.signature }) as Readonly<RoutineSubscriptionRechargeRequest>;
}
export const RECHARGE_SUBSCRIPTION_FACT_KEYS = ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'subjectDomain', 'appId', 'ownershipId', 'bindingId',
  'observationId', 'templateMark', 'settlementNonce', 'settlementDigest', 'ownershipDigest', 'payment', 'sourceDigest'] as const;
export function captureRechargeSubscriptionFacts(raw: unknown): RoutineSubscriptionRechargeNoticeFacts {
  const r = rechargeSubscriptionObject(raw, RECHARGE_SUBSCRIPTION_FACT_KEYS);
  const payment = rechargeSubscriptionObject(r.payment, Object.getOwnPropertyDescriptor(r.payment ?? {}, 'kind')?.value === 'routine-original'
    ? ['kind', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest'] : ['kind', 'payType', 'paymentDigest']);
  if (!rechargeSubscriptionInteger(r.deliveryId) || !rechargeSubscriptionInteger(r.outboxId) || !rechargeSubscriptionInteger(r.orderId) || r.rootId !== r.orderId
    || !rechargeSubscriptionInteger(r.buyerUid) || r.subjectDomain !== 'recharge' || r.eventKey !== rechargePaidNoticeEventKey(r.orderId) || !token(r.appId, 32) || !rechargeSubscriptionHex(r.ownershipId)
    || !rechargeSubscriptionInteger(r.bindingId) || !rechargeSubscriptionUuid(r.observationId) || r.templateMark !== '755'
    || !rechargeSubscriptionUuid(r.settlementNonce) || !rechargeSubscriptionHex(r.settlementDigest)
    || !rechargeSubscriptionHex(r.ownershipDigest) || !rechargeSubscriptionHex(r.sourceDigest)) return rechargeSubscriptionUnavailable();
  if (payment.kind === 'routine-original' ? typeof payment.evidenceId !== 'string' || !payment.evidenceId || payment.evidenceId.length > 128
    || !rechargeSubscriptionHex(payment.evidenceSignature) || !rechargeSubscriptionHex(payment.relatedDigest) || !rechargeSubscriptionHex(payment.approvedUseDigest)
    : payment.kind !== 'unique-identity' || payment.payType !== 'alipay' || !rechargeSubscriptionHex(payment.paymentDigest)) return rechargeSubscriptionUnavailable();
  return { ...r, payment } as unknown as RoutineSubscriptionRechargeNoticeFacts;
}
export function parseRoutineSubscriptionRechargeIntent(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionRechargeIntent> {
  const r = rechargeSubscriptionObject(copyJson(raw), ['format', 'scope', 'actor', 'deliveryId', 'outboxId', 'eventKey', 'createdAt', 'requestSignature', 'source', 'policy', 'request', 'signature']);
  const s = rechargeSubscriptionScope(r.scope), actor = rechargeSubscriptionObject(r.actor, ['role', 'roleOid']);
  const source = captureRechargeSubscriptionFacts(r.source), q = rechargeSubscriptionObject(r.request, ['touser', 'template_id', 'page', 'data']);
  if (r.format !== 9 || !rechargeSubscriptionSame(s, scope) || !name(actor.role) || !oid(actor.roleOid) || !rechargeSubscriptionInteger(r.createdAt)
    || actor.role === s.maintenance || actor.roleOid === s.maintenanceOid
    || r.deliveryId !== source.deliveryId || r.outboxId !== source.outboxId || r.eventKey !== source.eventKey || !rechargeSubscriptionHex(r.requestSignature)
    || !token(q.touser, 100) || !token(q.template_id, 100) || typeof q.page !== 'string' || q.page.length > 512 || /[\u0000-\u001f\u007f]/u.test(q.page)) return rechargeSubscriptionUnavailable();
  const data = rechargeSubscriptionObject(q.data, ['character_string1', 'amount3', 'amount4', 'date5']);
  for (const value of Object.values(data)) {
    const d = rechargeSubscriptionObject(value, ['value']);
    if (typeof d.value !== 'string' || !d.value || d.value.length > 100 || /[\u0000-\u001f\u007f]/u.test(d.value)) return rechargeSubscriptionUnavailable();
  }
  const policy = parseRoutineSubscriptionAccountJournal(env, r.policy, scope);
  if (policy.payload.data.state !== 'active' || policy.payload.data.appId !== source.appId || r.createdAt < policy.created_at
    || r.createdAt < policy.payload.data.validFrom || r.createdAt >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === '755' && t.templateId === q.template_id)) return rechargeSubscriptionUnavailable();
  const { signature, ...unsigned } = r;
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > 65536 || !equal(signature, rechargeSubscriptionMac(env, 'recharge-notice-stage', unsigned))) return rechargeSubscriptionUnavailable();
  return freeze({ ...unsigned, signature }) as unknown as Readonly<RoutineSubscriptionRechargeIntent>;
}
export function renderRechargeSubscriptionData(body: RechargePaidNoticeBusiness) {
  const b = captureRechargePaidNoticeBusiness(body);
  const date = new Date((b.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { character_string1:b.orderNo,amount3:b.payPrice,amount4:b.postBalance,date5:date };
}

export type RechargeSubscriptionTransientSqlState = '55P03' | '57014' | '40001' | '40P01';
/** A bounded database-error cause walk only. Getter/unknown-code errors never
 * grant a retry, and this classification alone is not a send capability. */
export function rechargeSubscriptionTransientSqlState(error: unknown): RechargeSubscriptionTransientSqlState | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 5 && error && typeof error === 'object' && !seen.has(error); depth++) {
    seen.add(error);
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code) {
      if (!('value' in code)) return null;
      if (code.value !== undefined) return ['55P03', '57014', '40001', '40P01'].includes(code.value)
        ? code.value as RechargeSubscriptionTransientSqlState : null;
    }
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    if (!cause || !('value' in cause)) return null;
    error = cause.value;
  }
  return null;
}
