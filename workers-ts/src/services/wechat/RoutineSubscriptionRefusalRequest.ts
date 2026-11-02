import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { readRoutineSubscriptionNoticeWriterTx } from './RoutineSubscriptionNoticeRequest';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionEqual, subscriptionHex, subscriptionInteger,
  subscriptionMac, subscriptionObject, subscriptionSame, subscriptionUuid, type RoutineSubscriptionScope } from './RoutineSubscriptionAccount';

type Query = Pick<DbClient, 'execute'>;
type Signing = Readonly<{ APP_KEY?: string }>;
export interface RefusalBusiness { orderId: number; orderNo: string; refundId: number; userId: number; payPrice: string }
export type RoutineSubscriptionRefusalBusiness = RefusalBusiness;
export interface RoutineSubscriptionRefusalDecision { readonly refuseReason: string; readonly refundedTime: number; readonly applicationDigest: string }
export interface RoutineSubscriptionRefusalRequest {
  readonly format: 3; readonly requestId: string; readonly scope: Readonly<RoutineSubscriptionScope>;
  readonly actor: Readonly<{ role: string; roleOid: string }>; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: Readonly<RefusalBusiness>; readonly decision: Readonly<RoutineSubscriptionRefusalDecision>;
  readonly createdAt: number; readonly signature: string;
}
export interface RoutineSubscriptionRefusalUnavailable { readonly format: 3; readonly unavailable: true }
export type RoutineSubscriptionRefusalRequestOutcome = { readonly kind: 'legacy' } | {
  readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionRefusalRequest | RoutineSubscriptionRefusalUnavailable>;
};
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 3 as const, unavailable: true as const }) });
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
export function captureRoutineSubscriptionRefusalBusiness(raw: unknown): Readonly<RefusalBusiness> {
  const r = subscriptionObject(raw, ['orderId', 'orderNo', 'refundId', 'userId', 'payPrice']);
  if (!subscriptionInteger(r.orderId) || !subscriptionInteger(r.refundId) || !zeroInteger(r.userId) || !text(r.orderNo, 32, true) || !money(r.payPrice))
    return routineSubscriptionUnavailable();
  return Object.freeze({ orderId: r.orderId, orderNo: r.orderNo, refundId: r.refundId, userId: r.userId, payPrice: r.payPrice });
}
const applicationKeys = ['id', 'storeOrderId', 'orderId', 'uid', 'storeId', 'supplierId', 'applyType', 'applyPrice', 'refundNum',
  'refundPrice', 'refundReason', 'refundExplain', 'refundImg', 'cartInfo', 'addTime'] as const;
const decisionKeys = ['refundType', 'refuseReason', 'refundedTime', 'isCancel', 'isDel'] as const;
/** A full ORM refund row may contain other public columns, but none is spread
 * into this contract. Only these own primitive descriptors are copied. Mutable
 * remarks, order state, future applications and current cart holds are omitted. */
function publicRefund(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return routineSubscriptionUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.length > 64 || keys.some(k => typeof k !== 'string') || Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) return routineSubscriptionUnavailable();
  const selected: Record<string, unknown> = Object.create(null);
  for (const key of [...applicationKeys, ...decisionKeys]) {
    const d = descriptors[key]; if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable(); selected[key] = d.value;
  }
  return selected;
}
function boundedRaw(v: unknown, bytes: number): v is string | null {
  return v === null || typeof v === 'string' && v.length <= bytes && text(v, bytes) && Buffer.byteLength(v, 'utf8') <= bytes;
}
/** Public historical application identity and the particular refusal decision.
 * It is not payment, owner, template or provider authority. A new application
 * may hold the same current cart without changing this old application's MAC. */
export function captureRoutineSubscriptionRefusalDecision(env: Pick<Env, 'APP_KEY'>, refundRow: unknown,
  body: Readonly<RefusalBusiness>, eventTime: number): Readonly<RoutineSubscriptionRefusalDecision> {
  const key = signing(env), b = captureRoutineSubscriptionRefusalBusiness(body), r = publicRefund(refundRow);
  if (!key || !subscriptionInteger(b.userId) || !subscriptionInteger(eventTime) || r.id !== b.refundId || r.storeOrderId !== b.orderId || r.uid !== b.userId
    || !subscriptionInteger(r.id) || !subscriptionInteger(r.storeOrderId) || !subscriptionInteger(r.uid) || !text(r.orderId, 50, true)
    || !zeroInteger(r.storeId) || !zeroInteger(r.supplierId) || !subscriptionInteger(r.applyType) || r.applyType > 4
    || !money(r.applyPrice) || !subscriptionInteger(r.refundNum) || !money(r.refundPrice) || !text(r.refundReason, 255) || !text(r.refundExplain, 255)
    || !boundedRaw(r.refundImg, 262144) || !boundedRaw(r.cartInfo, 65536) || !subscriptionInteger(r.addTime)
    || r.refundType !== 3 || r.isCancel !== 0 || r.isDel !== 0 || !text(r.refuseReason, 255, true) || r.refuseReason !== r.refuseReason.trim()
    || !subscriptionInteger(r.refundedTime) || r.refundedTime !== eventTime) return routineSubscriptionUnavailable();
  const application = Object.fromEntries(applicationKeys.map(k => [k, r[k]]));
  if (Buffer.byteLength(JSON.stringify(application), 'utf8') > 1048576) return routineSubscriptionUnavailable();
  return Object.freeze({ refuseReason: r.refuseReason, refundedTime: r.refundedTime,
    applicationDigest: subscriptionMac(key, 'refusal-application', application) });
}
function decisionValue(raw: unknown, eventTime: number): Readonly<RoutineSubscriptionRefusalDecision> {
  const r = subscriptionObject(raw, ['refuseReason', 'refundedTime', 'applicationDigest']);
  if (!text(r.refuseReason, 255, true) || r.refuseReason !== r.refuseReason.trim() || !subscriptionInteger(r.refundedTime)
    || r.refundedTime !== eventTime || !subscriptionHex(r.applicationDigest)) return routineSubscriptionUnavailable();
  return Object.freeze({ refuseReason: r.refuseReason, refundedTime: r.refundedTime, applicationDigest: r.applicationDigest });
}
/** The caller parses the signed request first and supplies its actual fresh
 * refund row. There is no read of another application or current cart counter. */
export function assertRoutineSubscriptionRefusalDecision(env: Pick<Env, 'APP_KEY'>, request: Readonly<RoutineSubscriptionRefusalRequest>, refundRow: unknown) {
  const expected = captureRoutineSubscriptionRefusalDecision(env, refundRow, request.body, request.eventTime);
  if (!subscriptionSame(expected, decisionValue(request.decision, request.eventTime))) return routineSubscriptionUnavailable(); return expected;
}
function capture(raw: { eventKey: string; aggregateId: number; payload: RefusalBusiness; now: number }) {
  const r = subscriptionObject(raw, ['eventKey', 'aggregateId', 'payload', 'now']), body = captureRoutineSubscriptionRefusalBusiness(r.payload);
  if (r.eventKey !== `order.refund.refused.notice:${body.refundId}` || r.aggregateId !== body.orderId || !subscriptionInteger(r.now)) return routineSubscriptionUnavailable();
  return Object.freeze({ eventKey: r.eventKey as string, aggregateId: body.orderId, body, eventTime: r.now });
}
/** Candidate for the actual first INSERT only. Namespace absence is legacy;
 * drift/missing material is unavailable3, never current-App fallback. Actual
 * SQL faults propagate to the caller's real optional SAVEPOINT. */
export async function createRoutineSubscriptionRefusalRequestTx(tx: Query, env: Signing | undefined,
  raw: { eventKey: string; aggregateId: number; payload: RefusalBusiness; now: number }): Promise<RoutineSubscriptionRefusalRequestOutcome> {
  const captured = capture(raw), key = signing(env);
  const catalog = await inspectRoutineSubscriptionDeliveryCatalog(tx), binding = catalog.binding;
  if (!catalog.present) return Object.freeze({ kind: 'legacy' as const });
  if (!catalog.ready || !binding?.app || !binding.appOid || !key || Object.hasOwn(tx, '$client') || captured.body.userId === 0) return UNAVAILABLE;
  const writer = await readRoutineSubscriptionNoticeWriterTx(tx, binding); if (!writer) return UNAVAILABLE;
  const b = captured.body;
  const rows = await tx.execute<{ refund: unknown; order: unknown; resolution: boolean }>(sql`SELECT
    pg_catalog.jsonb_build_object('id',r.id,'storeOrderId',r.store_order_id,'orderId',r.order_id,'uid',r.uid,'storeId',r.store_id,'supplierId',r.supplier_id,
      'applyType',r.apply_type,'applyPrice',r.apply_price::text,'refundNum',r.refund_num,'refundPrice',r.refund_price::text,
      'refundReason',r.refund_reason,'refundExplain',r.refund_explain,'refundImg',r.refund_img,'cartInfo',r.cart_info,'addTime',r.add_time,
      'refundType',r.refund_type,'refuseReason',r.refuse_reason,'refundedTime',r.refunded_time,'isCancel',r.is_cancel,'isDel',r.is_del) AS refund,
    pg_catalog.jsonb_build_object('id',o.id,'orderNo',o.order_id,'uid',o.uid,'storeId',o.store_id,'supplierId',o.supplier_id,
      'payPrice',o.pay_price::text,'paid',o.paid,'isDel',o.is_del,'isSystemDel',o.is_system_del) AS "order",
    pg_catalog.to_regclass('store_order_refund')=pg_catalog.to_regclass('public.store_order_refund')
      AND pg_catalog.to_regclass('store_order')=pg_catalog.to_regclass('public.store_order') AS resolution
    FROM public.store_order_refund r JOIN public.store_order o ON o.id=r.store_order_id WHERE r.id=${b.refundId} AND o.id=${b.orderId}
      AND pg_catalog.octet_length(COALESCE(r.cart_info,''))<=65536 AND pg_catalog.octet_length(COALESCE(r.refund_img,''))<=262144
    LIMIT 2 FOR SHARE OF r,o NOWAIT`);
  if (rows.length !== 1) return UNAVAILABLE;
  let decision: Readonly<RoutineSubscriptionRefusalDecision>;
  try {
    const row = subscriptionObject(rows[0], ['refund', 'order', 'resolution']);
    const order = subscriptionObject(row.order, ['id', 'orderNo', 'uid', 'storeId', 'supplierId', 'payPrice', 'paid', 'isDel', 'isSystemDel']);
    const refund = publicRefund(row.refund);
    if (row.resolution !== true || order.id !== b.orderId || order.orderNo !== b.orderNo || order.uid !== b.userId || order.payPrice !== b.payPrice
      || order.paid !== 1 || order.isDel !== 0 || order.isSystemDel !== 0 || order.storeId !== refund.storeId || order.supplierId !== refund.supplierId) return UNAVAILABLE;
    decision = captureRoutineSubscriptionRefusalDecision(key, refund, b, captured.eventTime);
  } catch { return UNAVAILABLE; }
  const body = { format: 3 as const, requestId: randomUUID(), scope: writer.scope, actor: writer.actor,
    eventKey: captured.eventKey, aggregateId: captured.aggregateId, eventTime: captured.eventTime, body: b, decision, createdAt: writer.createdAt };
  return Object.freeze({ kind: 'original' as const, request: freezeSubscription({ ...body, signature: subscriptionMac(key, 'refusal-notice-request', body) }) });
}
/** Authentication of historical public provenance only; no current writer
 * liveness, owner, template, latest policy or send capability is implied. */
export function parseRoutineSubscriptionRefusalRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown,
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
