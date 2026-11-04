/** Historical format-8 membership authentication only; no current send authority. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { captureMembershipPaidNoticeBusiness, membershipPaidNoticeEventKey, type MembershipPaidNoticeBusiness } from '../order/MembershipPaidNoticeCodec';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import { parseRoutineSubscriptionAccountJournal, type RoutineSubscriptionScope, type RoutineSubscriptionAccountJournal } from '../payment/RoutinePurposeAccountEvidenceCodec';

export const MEMBERSHIP_SUBSCRIPTION_EVENT = 'membership.pay.success.notice';
export interface MembershipSubscriptionSelection {
  mode: 'routine-original' | 'unique-owner'; appId: string; ownershipId: string;
  bindingId: number; observationId: string; openid: string; ownershipDigest: string;
}
export interface RoutineSubscriptionMembershipRequest {
  readonly format: 8; readonly requestId: string; readonly scope: RoutineSubscriptionScope;
  readonly actor: { role: string; roleOid: string }; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: MembershipPaidNoticeBusiness; readonly selection: MembershipSubscriptionSelection;
  readonly settlementDigest: string; readonly paymentDigest: string; readonly createdAt: number; readonly signature: string;
}
export type MembershipSubscriptionPayment = { kind: 'routine-original'; evidenceId: string; evidenceSignature: string; relatedDigest: string; approvedUseDigest: string }
  | { kind: 'unique-identity'; payType: 'yue' | 'alipay'; paymentDigest: string };
export interface RoutineSubscriptionMembershipNoticeFacts {
  deliveryId: number; outboxId: number; eventKey: string; orderId: number; rootId: number; buyerUid: number;
  subjectDomain: 'membership'; appId: string; ownershipId: string; bindingId: number; observationId: string;
  templateMark: '1927'; settlementNonce: string; settlementDigest: string; ownershipDigest: string;
  payment: MembershipSubscriptionPayment; sourceDigest: string;
}
export interface RoutineSubscriptionMembershipIntent {
  format: 8; scope: RoutineSubscriptionScope; actor: { role: string; roleOid: string }; deliveryId: number;
  outboxId: number; eventKey: string; createdAt: number; requestSignature: string; source: RoutineSubscriptionMembershipNoticeFacts;
  policy: RoutineSubscriptionAccountJournal; request: { touser: string; template_id: string; page: string; data: Record<string, { value: string }> }; signature: string;
}
export const membershipSubscriptionUnavailable = (): never => { throw new ServiceUnavailableException('小程序付款通知账号归属、批准或证据尚未完整就绪'); };
export const membershipSubscriptionInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
export const membershipSubscriptionHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const membershipSubscriptionUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const token = (v: unknown, n = 64): v is string => typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${n}}$`, 'u').test(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
export function membershipSubscriptionObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return membershipSubscriptionUnavailable();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) return membershipSubscriptionUnavailable();
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
/** Copy first: JSON serialization and freezing must never invoke input code. */
function copyJson(raw: unknown, max = 65536): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (v: string) => {
    if (v.length > max) return membershipSubscriptionUnavailable();
    for (const c of v) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return membershipSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(v, 'utf8'); if (bytes > max) return membershipSubscriptionUnavailable(); return v;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return membershipSubscriptionUnavailable();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : membershipSubscriptionUnavailable();
    if (!value || typeof value !== 'object' || ancestors.has(value)) return membershipSubscriptionUnavailable();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return membershipSubscriptionUnavailable();
    const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string')) return membershipSubscriptionUnavailable();
    ancestors.add(value);
    try {
      if (array) {
        const length = ds.length;
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 4095 || keys.length !== length.value + 1) return membershipSubscriptionUnavailable();
        return Array.from({ length: length.value }, (_, i) => {
          const d = ds[String(i)]; if (!d?.enumerable || !('value' in d)) return membershipSubscriptionUnavailable(); return copy(d.value, depth + 1);
        });
      }
      const out: Record<string, unknown> = Object.create(null);
      for (const key of keys) { const d = ds[key as string]; if (!d?.enumerable || !('value' in d)) return membershipSubscriptionUnavailable(); out[string(key as string)] = copy(d.value, depth + 1); }
      return out;
    } finally { ancestors.delete(value); }
  };
  const result = copy(raw, 0); if (Buffer.byteLength(JSON.stringify(result), 'utf8') > max) return membershipSubscriptionUnavailable(); return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value); Object.freeze(value); }
  return value;
}
export function membershipSubscriptionScope(v: unknown): RoutineSubscriptionScope {
  const r = membershipSubscriptionObject(v, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return membershipSubscriptionUnavailable();
  return r as unknown as RoutineSubscriptionScope;
}
export const membershipSubscriptionSame = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
export const membershipSubscriptionMac = (env: Pick<Env, 'APP_KEY'>, domain: string, value: unknown) => routineEvidenceHmac(env, 'subscription-' + domain, value);
function equal(a: unknown, b: string) { return membershipSubscriptionHex(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
export function captureMembershipSubscriptionSelection(raw: unknown): MembershipSubscriptionSelection {
  const r = membershipSubscriptionObject(raw, ['mode', 'appId', 'ownershipId', 'bindingId', 'observationId', 'openid', 'ownershipDigest']);
  if (typeof r.mode !== 'string' || !['routine-original', 'unique-owner'].includes(r.mode) || !token(r.appId, 32) || !membershipSubscriptionHex(r.ownershipId)
    || !membershipSubscriptionInteger(r.bindingId) || !membershipSubscriptionUuid(r.observationId) || !token(r.openid, 100) || !membershipSubscriptionHex(r.ownershipDigest)) return membershipSubscriptionUnavailable();
  return r as unknown as MembershipSubscriptionSelection;
}
export function parseRoutineSubscriptionMembershipRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionMembershipRequest> {
  const r = membershipSubscriptionObject(copyJson(raw, 16384), ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'selection', 'settlementDigest', 'paymentDigest', 'createdAt', 'signature']);
  const s = membershipSubscriptionScope(r.scope), actor = membershipSubscriptionObject(r.actor, ['role', 'roleOid']);
  const body = captureMembershipPaidNoticeBusiness(r.body), selection = captureMembershipSubscriptionSelection(r.selection);
  if (r.format !== 8 || !membershipSubscriptionUuid(r.requestId) || !membershipSubscriptionSame(s, membershipSubscriptionScope(scope)) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === s.maintenance || actor.roleOid === s.maintenanceOid || r.eventKey !== membershipPaidNoticeEventKey(body.orderId)
    || r.aggregateId !== body.orderId || r.eventTime !== body.occurredAt || !membershipSubscriptionInteger(r.createdAt)
    || (body.payType === 'weixin' ? selection.mode !== 'routine-original' : selection.mode !== 'unique-owner')
    || !membershipSubscriptionHex(r.settlementDigest) || !membershipSubscriptionHex(r.paymentDigest) || Buffer.byteLength(JSON.stringify(r), 'utf8') > 16384) return membershipSubscriptionUnavailable();
  const unsigned = { format: 8 as const, requestId: r.requestId, scope: s, actor, eventKey: r.eventKey, aggregateId: r.aggregateId,
    eventTime: r.eventTime, body, selection, settlementDigest: r.settlementDigest, paymentDigest: r.paymentDigest, createdAt: r.createdAt };
  if (!equal(r.signature, membershipSubscriptionMac(env, 'membership-notice-request', unsigned))) return membershipSubscriptionUnavailable();
  return freeze({ ...unsigned, signature: r.signature }) as Readonly<RoutineSubscriptionMembershipRequest>;
}
export const MEMBERSHIP_SUBSCRIPTION_FACT_KEYS = ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'subjectDomain', 'appId', 'ownershipId', 'bindingId',
  'observationId', 'templateMark', 'settlementNonce', 'settlementDigest', 'ownershipDigest', 'payment', 'sourceDigest'] as const;
export function captureMembershipSubscriptionFacts(raw: unknown): RoutineSubscriptionMembershipNoticeFacts {
  const r = membershipSubscriptionObject(raw, MEMBERSHIP_SUBSCRIPTION_FACT_KEYS);
  const payment = membershipSubscriptionObject(r.payment, Object.getOwnPropertyDescriptor(r.payment ?? {}, 'kind')?.value === 'routine-original'
    ? ['kind', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest'] : ['kind', 'payType', 'paymentDigest']);
  if (!membershipSubscriptionInteger(r.deliveryId) || !membershipSubscriptionInteger(r.outboxId) || !membershipSubscriptionInteger(r.orderId) || r.rootId !== r.orderId
    || !membershipSubscriptionInteger(r.buyerUid) || r.subjectDomain !== 'membership' || r.eventKey !== membershipPaidNoticeEventKey(r.orderId) || !token(r.appId, 32) || !membershipSubscriptionHex(r.ownershipId)
    || !membershipSubscriptionInteger(r.bindingId) || !membershipSubscriptionUuid(r.observationId) || r.templateMark !== '1927'
    || !membershipSubscriptionUuid(r.settlementNonce) || !membershipSubscriptionHex(r.settlementDigest)
    || !membershipSubscriptionHex(r.ownershipDigest) || !membershipSubscriptionHex(r.sourceDigest)) return membershipSubscriptionUnavailable();
  if (payment.kind === 'routine-original' ? typeof payment.evidenceId !== 'string' || !payment.evidenceId || payment.evidenceId.length > 128
    || !membershipSubscriptionHex(payment.evidenceSignature) || !membershipSubscriptionHex(payment.relatedDigest) || !membershipSubscriptionHex(payment.approvedUseDigest)
    : payment.kind !== 'unique-identity' || !['yue', 'alipay'].includes(String(payment.payType)) || !membershipSubscriptionHex(payment.paymentDigest)) return membershipSubscriptionUnavailable();
  return { ...r, payment } as unknown as RoutineSubscriptionMembershipNoticeFacts;
}
export function parseRoutineSubscriptionMembershipIntent(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionMembershipIntent> {
  const r = membershipSubscriptionObject(copyJson(raw), ['format', 'scope', 'actor', 'deliveryId', 'outboxId', 'eventKey', 'createdAt', 'requestSignature', 'source', 'policy', 'request', 'signature']);
  const s = membershipSubscriptionScope(r.scope), actor = membershipSubscriptionObject(r.actor, ['role', 'roleOid']);
  const source = captureMembershipSubscriptionFacts(r.source), q = membershipSubscriptionObject(r.request, ['touser', 'template_id', 'page', 'data']);
  if (r.format !== 8 || !membershipSubscriptionSame(s, scope) || !name(actor.role) || !oid(actor.roleOid) || !membershipSubscriptionInteger(r.createdAt)
    || actor.role === s.maintenance || actor.roleOid === s.maintenanceOid
    || r.deliveryId !== source.deliveryId || r.outboxId !== source.outboxId || r.eventKey !== source.eventKey || !membershipSubscriptionHex(r.requestSignature)
    || !token(q.touser, 100) || !token(q.template_id, 100) || typeof q.page !== 'string' || q.page.length > 512 || /[\u0000-\u001f\u007f]/u.test(q.page)) return membershipSubscriptionUnavailable();
  const data = membershipSubscriptionObject(q.data, ['character_string1', 'amount2', 'date3']);
  for (const value of Object.values(data)) {
    const d = membershipSubscriptionObject(value, ['value']);
    if (typeof d.value !== 'string' || !d.value || d.value.length > 100 || /[\u0000-\u001f\u007f]/u.test(d.value)) return membershipSubscriptionUnavailable();
  }
  const policy = parseRoutineSubscriptionAccountJournal(env, r.policy, scope);
  if (policy.payload.data.state !== 'active' || policy.payload.data.appId !== source.appId || r.createdAt < policy.created_at
    || r.createdAt < policy.payload.data.validFrom || r.createdAt >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === '1927' && t.templateId === q.template_id)) return membershipSubscriptionUnavailable();
  const { signature, ...unsigned } = r;
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > 65536 || !equal(signature, membershipSubscriptionMac(env, 'membership-notice-stage', unsigned))) return membershipSubscriptionUnavailable();
  return freeze({ ...unsigned, signature }) as unknown as Readonly<RoutineSubscriptionMembershipIntent>;
}
export function renderMembershipSubscriptionData(body: MembershipPaidNoticeBusiness) {
  const b = captureMembershipPaidNoticeBusiness(body);
  const date = new Date((b.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { character_string1: b.orderNo, amount2: b.payPrice + '元', date3: date };
}

export type MembershipSubscriptionTransientSqlState = '55P03' | '57014' | '40001' | '40P01';
/** A bounded database-error cause walk only. Getter/unknown-code errors never
 * grant a retry, and this classification alone is not a send capability. */
export function membershipSubscriptionTransientSqlState(error: unknown): MembershipSubscriptionTransientSqlState | null {
  const seen = new Set<object>();
  for (let depth = 0; depth < 5 && error && typeof error === 'object' && !seen.has(error); depth++) {
    seen.add(error);
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code) {
      if (!('value' in code)) return null;
      if (code.value !== undefined) return ['55P03', '57014', '40001', '40P01'].includes(code.value)
        ? code.value as MembershipSubscriptionTransientSqlState : null;
    }
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    if (!cause || !('value' in cause)) return null;
    error = cause.value;
  }
  return null;
}
