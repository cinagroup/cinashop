/** Historical format-7 authentication only; no current owner or send authority. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { capturePaidNoticeBusiness, paidNoticeEventKey, type PaidNoticeBusiness } from '../order/OrderPaidNoticeCodec';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import { parseRoutineSubscriptionAccountJournal, type RoutineSubscriptionScope, type RoutineSubscriptionAccountJournal } from '../payment/RoutinePurposeAccountEvidenceCodec';

export const PAID_SUBSCRIPTION_EVENT = 'order.pay.success.notice';
export interface PaidSubscriptionSelection {
  mode: 'routine-original' | 'unique-owner'; appId: string; ownershipId: string;
  bindingId: number; observationId: string; openid: string; ownershipDigest: string;
}
export interface RoutineSubscriptionPaidRequest {
  readonly format: 7; readonly requestId: string; readonly scope: RoutineSubscriptionScope;
  readonly actor: { role: string; roleOid: string }; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: PaidNoticeBusiness; readonly selection: PaidSubscriptionSelection;
  readonly familyDigest: string; readonly paymentDigest: string; readonly createdAt: number; readonly signature: string;
}
export type PaidSubscriptionPayment = { kind: 'routine-original'; evidenceId: string; evidenceSignature: string; relatedDigest: string; approvedUseDigest: string }
  | { kind: 'unique-identity'; payType: string; paymentDigest: string };
export interface RoutineSubscriptionPaidNoticeFacts {
  deliveryId: number; outboxId: number; eventKey: string; orderId: number; rootId: number; buyerUid: number;
  appId: string; ownershipId: string; bindingId: number; observationId: string;
  templateMark: '1927'; paymentEventId: number; paymentAdmissionNonce: string;
  familyDigest: string; ownershipDigest: string; payment: PaidSubscriptionPayment; sourceDigest: string;
}
export interface RoutineSubscriptionPaidIntent {
  format: 7; scope: RoutineSubscriptionScope; actor: { role: string; roleOid: string }; deliveryId: number;
  outboxId: number; eventKey: string; createdAt: number; requestSignature: string; source: RoutineSubscriptionPaidNoticeFacts;
  policy: RoutineSubscriptionAccountJournal; request: { touser: string; template_id: string; page: string; data: Record<string, { value: string }> }; signature: string;
}
export const paidSubscriptionUnavailable = (): never => { throw new ServiceUnavailableException('小程序付款通知账号归属、批准或证据尚未完整就绪'); };
export const paidSubscriptionInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
export const paidSubscriptionHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const paidSubscriptionUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const token = (v: unknown, n = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`, 'u').test(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
export function paidSubscriptionObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return paidSubscriptionUnavailable();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) return paidSubscriptionUnavailable();
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
/** Copy first: JSON serialization and freezing must never invoke input code. */
function copyJson(raw: unknown, max = 65536): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (v: string) => {
    if (v.length > max) return paidSubscriptionUnavailable();
    for (const c of v) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return paidSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(v, 'utf8'); if (bytes > max) return paidSubscriptionUnavailable(); return v;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return paidSubscriptionUnavailable();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : paidSubscriptionUnavailable();
    if (!value || typeof value !== 'object' || ancestors.has(value)) return paidSubscriptionUnavailable();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return paidSubscriptionUnavailable();
    const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string')) return paidSubscriptionUnavailable();
    ancestors.add(value);
    try {
      if (array) {
        const length = ds.length;
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 4095 || keys.length !== length.value + 1) return paidSubscriptionUnavailable();
        return Array.from({ length: length.value }, (_, i) => {
          const d = ds[String(i)]; if (!d?.enumerable || !('value' in d)) return paidSubscriptionUnavailable(); return copy(d.value, depth + 1);
        });
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const key of keys) { const d = ds[key as string]; if (!d?.enumerable || !('value' in d)) return paidSubscriptionUnavailable(); out[string(key as string)] = copy(d.value, depth + 1); }
      return out;
    } finally { ancestors.delete(value); }
  };
  const result = copy(raw, 0); if (Buffer.byteLength(JSON.stringify(result), 'utf8') > max) return paidSubscriptionUnavailable(); return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value); Object.freeze(value); }
  return value;
}
export function paidSubscriptionScope(v: unknown): RoutineSubscriptionScope {
  const r = paidSubscriptionObject(v, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return paidSubscriptionUnavailable();
  return r as unknown as RoutineSubscriptionScope;
}
export const paidSubscriptionSame = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
export const paidSubscriptionMac = (env: Pick<Env, 'APP_KEY'>, domain: string, value: unknown) => routineEvidenceHmac(env, 'subscription-' + domain, value);
function equal(a: unknown, b: string) { return paidSubscriptionHex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
export function capturePaidSubscriptionSelection(raw: unknown): PaidSubscriptionSelection {
  const r = paidSubscriptionObject(raw, ['mode', 'appId', 'ownershipId', 'bindingId', 'observationId', 'openid', 'ownershipDigest']);
  if (typeof r.mode !== 'string' || !['routine-original', 'unique-owner'].includes(r.mode) || !token(r.appId, 32) || !paidSubscriptionHex(r.ownershipId)
    || !paidSubscriptionInteger(r.bindingId) || !paidSubscriptionUuid(r.observationId) || !token(r.openid, 100) || !paidSubscriptionHex(r.ownershipDigest)) return paidSubscriptionUnavailable();
  return r as unknown as PaidSubscriptionSelection;
}
export function parseRoutineSubscriptionPaidRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionPaidRequest> {
  const r = paidSubscriptionObject(copyJson(raw, 16384), ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'selection', 'familyDigest', 'paymentDigest', 'createdAt', 'signature']);
  const s = paidSubscriptionScope(r.scope), actor = paidSubscriptionObject(r.actor, ['role', 'roleOid']);
  const body = capturePaidNoticeBusiness(r.body), selection = capturePaidSubscriptionSelection(r.selection);
  if (r.format !== 7 || !paidSubscriptionUuid(r.requestId) || !paidSubscriptionSame(s, paidSubscriptionScope(scope)) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === s.maintenance || actor.roleOid === s.maintenanceOid || body.userId === 0 || r.eventKey !== paidNoticeEventKey(body.orderId)
    || r.aggregateId !== body.orderId || r.eventTime !== body.occurredAt || !paidSubscriptionInteger(r.createdAt)
    || !paidSubscriptionHex(r.familyDigest) || !paidSubscriptionHex(r.paymentDigest) || Buffer.byteLength(JSON.stringify(r), 'utf8') > 16384) return paidSubscriptionUnavailable();
  const unsigned = { format: 7 as const, requestId: r.requestId, scope: s, actor, eventKey: r.eventKey, aggregateId: r.aggregateId,
    eventTime: r.eventTime, body, selection, familyDigest: r.familyDigest, paymentDigest: r.paymentDigest, createdAt: r.createdAt };
  if (!equal(r.signature, paidSubscriptionMac(env, 'paid-notice-request', unsigned))) return paidSubscriptionUnavailable();
  return freeze({ ...unsigned, signature: r.signature }) as Readonly<RoutineSubscriptionPaidRequest>;
}
export const PAID_SUBSCRIPTION_FACT_KEYS = ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'appId', 'ownershipId', 'bindingId',
  'observationId', 'templateMark', 'paymentEventId', 'paymentAdmissionNonce', 'familyDigest', 'ownershipDigest', 'payment', 'sourceDigest'] as const;
export function capturePaidSubscriptionFacts(raw: unknown): RoutineSubscriptionPaidNoticeFacts {
  const r = paidSubscriptionObject(raw, PAID_SUBSCRIPTION_FACT_KEYS);
  const payment = paidSubscriptionObject(r.payment, Object.getOwnPropertyDescriptor(r.payment ?? {}, 'kind')?.value === 'routine-original'
    ? ['kind', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest'] : ['kind', 'payType', 'paymentDigest']);
  if (!paidSubscriptionInteger(r.deliveryId) || !paidSubscriptionInteger(r.outboxId) || !paidSubscriptionInteger(r.orderId) || !paidSubscriptionInteger(r.rootId)
    || !paidSubscriptionInteger(r.buyerUid) || r.eventKey !== paidNoticeEventKey(r.orderId) || !token(r.appId, 32) || !paidSubscriptionHex(r.ownershipId)
    || !paidSubscriptionInteger(r.bindingId) || !paidSubscriptionUuid(r.observationId) || r.templateMark !== '1927'
    || !paidSubscriptionInteger(r.paymentEventId) || !paidSubscriptionUuid(r.paymentAdmissionNonce) || !paidSubscriptionHex(r.familyDigest)
    || !paidSubscriptionHex(r.ownershipDigest) || !paidSubscriptionHex(r.sourceDigest)) return paidSubscriptionUnavailable();
  if (payment.kind === 'routine-original' ? typeof payment.evidenceId !== 'string' || !payment.evidenceId || payment.evidenceId.length > 128
    || !paidSubscriptionHex(payment.evidenceSignature) || !paidSubscriptionHex(payment.relatedDigest) || !paidSubscriptionHex(payment.approvedUseDigest)
    : payment.kind !== 'unique-identity' || typeof payment.payType !== 'string' || !['yue', 'offline', 'cash', 'alipay', 'integral', 'weixin'].includes(payment.payType)
      || !paidSubscriptionHex(payment.paymentDigest)) return paidSubscriptionUnavailable();
  return { ...r, payment } as unknown as RoutineSubscriptionPaidNoticeFacts;
}
export function parseRoutineSubscriptionPaidIntent(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionPaidIntent> {
  const r = paidSubscriptionObject(copyJson(raw), ['format', 'scope', 'actor', 'deliveryId', 'outboxId', 'eventKey', 'createdAt', 'requestSignature', 'source', 'policy', 'request', 'signature']);
  const s = paidSubscriptionScope(r.scope), actor = paidSubscriptionObject(r.actor, ['role', 'roleOid']);
  const source = capturePaidSubscriptionFacts(r.source), q = paidSubscriptionObject(r.request, ['touser', 'template_id', 'page', 'data']);
  if (r.format !== 7 || !paidSubscriptionSame(s, scope) || !name(actor.role) || !oid(actor.roleOid) || !paidSubscriptionInteger(r.createdAt)
    || r.deliveryId !== source.deliveryId || r.outboxId !== source.outboxId || r.eventKey !== source.eventKey || !paidSubscriptionHex(r.requestSignature)
    || !token(q.touser, 100) || !token(q.template_id, 100) || typeof q.page !== 'string' || q.page.length > 512 || /[\u0000-\u001f\u007f]/u.test(q.page)) return paidSubscriptionUnavailable();
  const data = paidSubscriptionObject(q.data, ['character_string1', 'amount2', 'date3']);
  for (const value of Object.values(data)) {
    const d = paidSubscriptionObject(value, ['value']);
    if (typeof d.value !== 'string' || !d.value || d.value.length > 100 || /[\u0000-\u001f\u007f]/u.test(d.value)) return paidSubscriptionUnavailable();
  }
  const policy = parseRoutineSubscriptionAccountJournal(env, r.policy, scope);
  if (policy.payload.data.state !== 'active' || policy.payload.data.appId !== source.appId || r.createdAt < policy.created_at
    || r.createdAt < policy.payload.data.validFrom || r.createdAt >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === '1927' && t.templateId === q.template_id)) return paidSubscriptionUnavailable();
  const { signature, ...unsigned } = r;
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > 65536 || !equal(signature, paidSubscriptionMac(env, 'paid-notice-stage', unsigned))) return paidSubscriptionUnavailable();
  return freeze({ ...unsigned, signature }) as unknown as Readonly<RoutineSubscriptionPaidIntent>;
}

export function renderPaidSubscriptionData(body: PaidNoticeBusiness) {
  if (!paidSubscriptionInteger(body.occurredAt)) return paidSubscriptionUnavailable();
  const date = new Date((body.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { character_string1: body.orderNo, amount2: body.payPrice + '元', date3: date };
}
