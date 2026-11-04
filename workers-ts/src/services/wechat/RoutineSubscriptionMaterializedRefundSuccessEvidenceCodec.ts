/** Public completed-refund provenance only. This codec neither authenticates a
 * provider result nor grants ownership, template approval or permission to send. */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../env';
import { ServiceUnavailableException } from '../../utils/errors';
import { routineEvidenceCanonical, routineEvidenceHmac } from '../payment/RoutineProviderObservation';
import type { RoutineSubscriptionScope } from '../payment/RoutinePurposeAccountEvidenceCodec';

export interface RoutineSubscriptionMaterializedRefundSuccessBusiness {
  orderId: number; orderNo: string; refundId: number; userId: number; payPrice: string;
  materializedRefund: Readonly<{ sourceOrderId: number; paymentOrderId: number; refundAmount: string }>;
}
export interface RoutineSubscriptionMaterializedRefundSuccessDecision {
  readonly refundType: 6; readonly refundedTime: number; readonly refundAmount: string; readonly applicationDigest: string;
  readonly materializationDigest: string; readonly selectedDigest: string;
}
export interface RoutineSubscriptionMaterializedRefundSuccessRequest {
  readonly format: 6; readonly requestId: string; readonly scope: Readonly<RoutineSubscriptionScope>;
  readonly actor: Readonly<{ role: string; roleOid: string }>; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: Readonly<RoutineSubscriptionMaterializedRefundSuccessBusiness>;
  readonly decision: Readonly<RoutineSubscriptionMaterializedRefundSuccessDecision>; readonly createdAt: number; readonly signature: string;
}

export interface RoutineSubscriptionMaterializedRefundSuccessSource {
  readonly materializationDigest: string; readonly selectedDigest: string;
}

type Signing = Readonly<{ APP_KEY?: string }>;
const unavailable = (): never => { throw new ServiceUnavailableException('小程序原账号订阅通知批准、凭据或证据尚未完整就绪'); };
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const zeroInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const money = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/u.test(v);
const cents = (v: string) => BigInt(v.replace('.', ''));
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
const mac = (env: Pick<Env, 'APP_KEY'>, domain: string, value: unknown) => routineEvidenceHmac(env, 'subscription-' + domain, value);
function equal(actual: unknown, expected: string) {
  return hex(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) return unavailable();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value);
    Object.freeze(value);
  }
  return value;
}
function text(value: unknown, max: number, nonempty = false): value is string {
  if (typeof value !== 'string' || nonempty && !value || value.length > max * 2) return false;
  let count = 0;
  for (const c of value) { const point = c.codePointAt(0)!; if (++count > max || point >= 0xd800 && point <= 0xdfff) return false; }
  return true;
}
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const d = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192) return;
  return Object.freeze({ APP_KEY: d.value });
}
function scopeValue(raw: unknown): Readonly<RoutineSubscriptionScope> {
  const r = object(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return unavailable();
  return Object.freeze({ database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid });
}

/** The physical display order is the selected refund entity. Its paid amount
 * is independent from the actual cash refund; the original application and
 * provider payment remain associated with the source/payment order IDs. */
export function captureRoutineSubscriptionMaterializedRefundSuccessBusiness(raw: unknown): Readonly<RoutineSubscriptionMaterializedRefundSuccessBusiness> {
  const r = object(raw, ['orderId', 'orderNo', 'refundId', 'userId', 'payPrice', 'materializedRefund']);
  const m = object(r.materializedRefund, ['sourceOrderId', 'paymentOrderId', 'refundAmount']);
  if (!integer(r.orderId) || !integer(r.refundId) || !zeroInteger(r.userId) || !text(r.orderNo, 50, true) || !money(r.payPrice)
    || !integer(m.sourceOrderId) || !integer(m.paymentOrderId) || !money(m.refundAmount) || m.refundAmount === '0.00'
    || cents(m.refundAmount) > cents(r.payPrice)) return unavailable();
  return Object.freeze({ orderId: r.orderId, orderNo: r.orderNo, refundId: r.refundId, userId: r.userId, payPrice: r.payPrice,
    materializedRefund: Object.freeze({ sourceOrderId: m.sourceOrderId, paymentOrderId: m.paymentOrderId, refundAmount: m.refundAmount }) });
}
function sourceValue(raw: unknown): Readonly<RoutineSubscriptionMaterializedRefundSuccessSource> {
  const r = object(raw, ['materializationDigest', 'selectedDigest']);
  if (!hex(r.materializationDigest) || !hex(r.selectedDigest)) return unavailable();
  return Object.freeze({ materializationDigest: r.materializationDigest, selectedDigest: r.selectedDigest });
}

const applicationKeys = ['id', 'storeOrderId', 'orderId', 'uid', 'storeId', 'supplierId', 'applyType', 'applyPrice', 'refundNum',
  'refundPrice', 'refundReason', 'refundExplain', 'refundImg', 'cartInfo', 'addTime'] as const;
const decisionKeys = ['refundType', 'refundedPrice', 'refundedTime', 'isCancel', 'isDel'] as const;
/** Ignore unrelated public ORM columns without spreading them or evaluating a
 * getter. All retained values are primitives and have separate size bounds. */
function publicRefund(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) return unavailable();
  const selected: Record<string, unknown> = Object.create(null);
  for (const key of [...applicationKeys, ...decisionKeys]) {
    const d = descriptors[key]; if (!d?.enumerable || !('value' in d)) return unavailable(); selected[key] = d.value;
  }
  return selected;
}
function boundedRaw(value: unknown, bytes: number): value is string | null {
  return value === null || typeof value === 'string' && value.length <= bytes && text(value, bytes) && Buffer.byteLength(value, 'utf8') <= bytes;
}
function array(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || !raw.length || raw.length > 100
    || Reflect.ownKeys(raw).length !== raw.length + 1) return unavailable();
  return Array.from({ length: raw.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(raw, String(i)); if (!d?.enumerable || !('value' in d)) return unavailable(); return d.value;
  });
}
/** A genuine materialized application carries a server-selected v2 contract
 * or customer physical-row v3 contract. Neither an unversioned JSON selection
 * nor a v1 application can be upgraded by constructing a format6 candidate. */
function materializedReservation(refund: Record<string, unknown>) {
  if (typeof refund.cartInfo !== 'string') return unavailable();
  let decoded: unknown; try { decoded = JSON.parse(refund.cartInfo); } catch { return unavailable(); }
  const snapshot = object(decoded, ['cartIds', 'quantityReservation']);
  const reservation = object(snapshot.quantityReservation, ['version', 'orderId', 'uid', 'items']);
  const rowNamespace = reservation.version === 'refund-quantity-customer-row-v3';
  if (!rowNamespace && reservation.version !== 'refund-quantity-materialization-v2'
    || reservation.orderId !== refund.storeOrderId || reservation.uid !== refund.uid) return unavailable();
  const sourceCart = (value: unknown): value is string => text(value, 128, true) && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  const selected = array(snapshot.cartIds).map(raw => {
    const r = object(raw, ['cartId', 'cartNum', ...(rowNamespace ? ['sourceCartId'] : [])]);
    if (!integer(r.cartId) || !integer(r.cartNum) || rowNamespace && !sourceCart(r.sourceCartId)) return unavailable();
    return { cartId: r.cartId, cartNum: r.cartNum, sourceCartId: rowNamespace ? r.sourceCartId : undefined };
  }).sort((a, b) => a.cartId - b.cartId);
  const items = array(reservation.items).map(raw => {
    const r = object(raw, ['rowId', 'cartId', 'cartNum', 'beforeRefundNum', 'totalNum', ...(rowNamespace ? ['sourceCartId'] : [])]);
    if (!integer(r.rowId) || !integer(r.cartId) || !integer(r.cartNum) || !zeroInteger(r.beforeRefundNum) || !integer(r.totalNum)
      || r.beforeRefundNum + r.cartNum > r.totalNum || rowNamespace && (r.rowId !== r.cartId || !sourceCart(r.sourceCartId))) return unavailable();
    return { rowId: r.rowId, cartId: r.cartId, cartNum: r.cartNum, sourceCartId: rowNamespace ? r.sourceCartId : undefined };
  }).sort((a, b) => a.cartId - b.cartId);
  if (selected.length !== items.length || new Set(selected.map(r => r.cartId)).size !== selected.length
    || new Set(items.map(r => r.rowId)).size !== items.length || new Set(items.map(r => r.cartId)).size !== items.length
    || items.some((r, i) => r.cartId !== selected[i].cartId || r.cartNum !== selected[i].cartNum || r.sourceCartId !== selected[i].sourceCartId)
    || items.reduce((sum, r) => sum + r.cartNum, 0) !== refund.refundNum) return unavailable();
}

/** This is the public application and completed local decision only. A mutable
 * refundType6 or payment SUCCESS cannot prove a provider refund to this codec. */
export function captureRoutineSubscriptionMaterializedRefundSuccessDecision(env: Pick<Env, 'APP_KEY'>, refundRow: unknown,
  body: Readonly<RoutineSubscriptionMaterializedRefundSuccessBusiness>, eventTime: number,
  source: Readonly<RoutineSubscriptionMaterializedRefundSuccessSource>): Readonly<RoutineSubscriptionMaterializedRefundSuccessDecision> {
  const key = signing(env), b = captureRoutineSubscriptionMaterializedRefundSuccessBusiness(body), r = publicRefund(refundRow), proof = sourceValue(source);
  if (!key || !integer(b.userId) || !integer(eventTime) || r.id !== b.refundId || r.storeOrderId !== b.materializedRefund.sourceOrderId || r.orderId !== b.orderNo || r.uid !== b.userId
    || !integer(r.id) || !integer(r.storeOrderId) || !integer(r.uid) || !text(r.orderId, 50, true)
    || !zeroInteger(r.storeId) || !zeroInteger(r.supplierId) || !integer(r.applyType) || r.applyType > 4
    || !money(r.applyPrice) || !integer(r.refundNum) || !money(r.refundPrice) || !text(r.refundReason, 255) || !text(r.refundExplain, 255)
    || !boundedRaw(r.refundImg, 262144) || !boundedRaw(r.cartInfo, 65536) || !integer(r.addTime) || r.addTime > eventTime
    || r.refundType !== 6 || r.isCancel !== 0 || r.isDel !== 0 || !integer(r.refundedTime) || r.refundedTime !== eventTime
    || !money(r.refundedPrice) || r.refundedPrice === '0.00' || r.refundedPrice !== r.refundPrice
    || cents(r.applyPrice) < cents(r.refundedPrice) || r.refundedPrice !== b.materializedRefund.refundAmount) return unavailable();
  materializedReservation(r);
  const application = Object.fromEntries(applicationKeys.map(k => [k, r[k]]));
  if (Buffer.byteLength(JSON.stringify(application), 'utf8') > 1048576) return unavailable();
  return Object.freeze({ refundType: 6, refundedTime: r.refundedTime, refundAmount: r.refundedPrice,
    applicationDigest: mac(key, 'materialized-refund-success-application', application), ...proof });
}
function decisionValue(raw: unknown, eventTime: number, refundAmount: string): Readonly<RoutineSubscriptionMaterializedRefundSuccessDecision> {
  const r = object(raw, ['refundType', 'refundedTime', 'refundAmount', 'applicationDigest', 'materializationDigest', 'selectedDigest']);
  if (r.refundType !== 6 || !integer(r.refundedTime) || r.refundedTime !== eventTime || !money(r.refundAmount)
    || r.refundAmount === '0.00' || r.refundAmount !== refundAmount || !hex(r.applicationDigest) || !hex(r.materializationDigest) || !hex(r.selectedDigest)) return unavailable();
  return Object.freeze({ refundType: 6, refundedTime: r.refundedTime, refundAmount: r.refundAmount, applicationDigest: r.applicationDigest, materializationDigest: r.materializationDigest, selectedDigest: r.selectedDigest });
}
/** Caller first authenticates the request and supplies the actual fresh public
 * refund row. Order eligibility and private provider evidence remain separate. */
export function assertRoutineSubscriptionMaterializedRefundSuccessDecision(env: Pick<Env, 'APP_KEY'>,
  request: Readonly<RoutineSubscriptionMaterializedRefundSuccessRequest>, refundRow: unknown,
  source: Readonly<RoutineSubscriptionMaterializedRefundSuccessSource>) {
  const expected = captureRoutineSubscriptionMaterializedRefundSuccessDecision(env, refundRow, request.body, request.eventTime, source);
  if (!same(expected, decisionValue(request.decision, request.eventTime, request.body.materializedRefund.refundAmount))) return unavailable();
  return expected;
}
/** Historical signature authentication only: no current actor LOGIN, latest
 * approval, current configuration, token or provider request is consulted. */
export function parseRoutineSubscriptionMaterializedRefundSuccessRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown,
  expectedScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionMaterializedRefundSuccessRequest> {
  const key = signing(env); if (!key) return unavailable();
  const r = object(raw, ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'decision', 'createdAt', 'signature']);
  const scope = scopeValue(r.scope), expected = scopeValue(expectedScope), actor = object(r.actor, ['role', 'roleOid']);
  const body = captureRoutineSubscriptionMaterializedRefundSuccessBusiness(r.body);
  if (r.format !== 6 || !uuid(r.requestId) || !same(scope, expected) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === scope.maintenance || actor.roleOid === scope.maintenanceOid || !integer(body.userId)
    || r.eventKey !== `order.refund.success.notice:${body.refundId}` || r.aggregateId !== body.orderId
    || !integer(r.eventTime) || !integer(r.createdAt)) return unavailable();
  const decision = decisionValue(r.decision, r.eventTime, body.materializedRefund.refundAmount);
  const unsigned = { format: 6 as const, requestId: r.requestId, scope, actor: Object.freeze({ role: actor.role, roleOid: actor.roleOid }),
    eventKey: r.eventKey as string, aggregateId: body.orderId, eventTime: r.eventTime, body, decision, createdAt: r.createdAt };
  if (!equal(r.signature, mac(key, 'materialized-refund-success-notice-request', unsigned))) return unavailable();
  return freeze({ ...unsigned, signature: r.signature as string });
}
