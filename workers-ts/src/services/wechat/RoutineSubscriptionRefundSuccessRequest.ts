import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { readRoutineSubscriptionNoticeWriterTx } from './RoutineSubscriptionNoticeRequest';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionInteger, subscriptionMac, subscriptionObject } from './RoutineSubscriptionAccount';
import { captureRoutineSubscriptionRefundSuccessBusiness, captureRoutineSubscriptionRefundSuccessDecision,
  type RoutineSubscriptionRefundSuccessBusiness, type RoutineSubscriptionRefundSuccessDecision,
  type RoutineSubscriptionRefundSuccessRequest } from './RoutineSubscriptionRefundSuccessEvidenceCodec';

export { captureRoutineSubscriptionRefundSuccessBusiness, captureRoutineSubscriptionRefundSuccessDecision,
  assertRoutineSubscriptionRefundSuccessDecision, parseRoutineSubscriptionRefundSuccessRequest } from './RoutineSubscriptionRefundSuccessEvidenceCodec';
export type { RoutineSubscriptionRefundSuccessBusiness, RoutineSubscriptionRefundSuccessDecision,
  RoutineSubscriptionRefundSuccessRequest } from './RoutineSubscriptionRefundSuccessEvidenceCodec';

type Query = Pick<DbClient, 'execute'>;
type Signing = Readonly<{ APP_KEY?: string }>;
export interface RoutineSubscriptionRefundSuccessUnavailable { readonly format: 5; readonly unavailable: true }
export type RoutineSubscriptionRefundSuccessRequestOutcome = { readonly kind: 'legacy' } | {
  readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionRefundSuccessRequest | RoutineSubscriptionRefundSuccessUnavailable>;
};
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 5 as const, unavailable: true as const }) });
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const d = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192) return;
  return Object.freeze({ APP_KEY: d.value });
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || !value || value.length > max * 2) return false;
  let count = 0;
  for (const c of value) { const point = c.codePointAt(0)!; if (++count > max || point >= 0xd800 && point <= 0xdfff) return false; }
  return true;
}
function capture(raw: { eventKey: string; aggregateId: number; payload: RoutineSubscriptionRefundSuccessBusiness; now: number }) {
  const r = subscriptionObject(raw, ['eventKey', 'aggregateId', 'payload', 'now']), body = captureRoutineSubscriptionRefundSuccessBusiness(r.payload);
  if (r.eventKey !== `order.refund.success.notice:${body.refundId}` || r.aggregateId !== body.orderId || !subscriptionInteger(r.now)) {
    return routineSubscriptionUnavailable();
  }
  return Object.freeze({ eventKey: r.eventKey as string, aggregateId: body.orderId, body, eventTime: r.now });
}
/** A new event candidate only. No private payment/identity/policy table is read,
 * and a signed completed public refund is never provider-success authority.
 * Entire namespace absence is legacy; all present-but-unready cases retain5.
 * SQL faults propagate for isolation by the caller's actual optional SAVEPOINT. */
export async function createRoutineSubscriptionRefundSuccessRequestTx(tx: Query, env: Signing | undefined,
  raw: { eventKey: string; aggregateId: number; payload: RoutineSubscriptionRefundSuccessBusiness; now: number }): Promise<RoutineSubscriptionRefundSuccessRequestOutcome> {
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
      'refundType',r.refund_type,'refundedPrice',r.refunded_price::text,'refundedTime',r.refunded_time,'isCancel',r.is_cancel,'isDel',r.is_del) AS refund,
    pg_catalog.jsonb_build_object('id',o.id,'orderNo',o.order_id,'uid',o.uid,'storeId',o.store_id,'supplierId',o.supplier_id,
      'payPrice',o.pay_price::text,'paid',o.paid,'payType',o.pay_type,'pid',o.pid,'type',o.type,'totalNum',o.total_num,
      'refundStatus',o.refund_status,'refundType',o.refund_type,'refundPrice',o.refund_price::text,'isDel',o.is_del,'isSystemDel',o.is_system_del,
      'hasChildren',EXISTS(SELECT 1 FROM public.store_order child WHERE child.pid=o.id),
      'hasOtherCompleted',EXISTS(SELECT 1 FROM public.store_order_refund prior WHERE prior.store_order_id=o.id AND prior.id<>r.id AND prior.refund_type=6)) AS "order",
    pg_catalog.to_regclass('store_order_refund')=pg_catalog.to_regclass('public.store_order_refund')
      AND pg_catalog.to_regclass('store_order')=pg_catalog.to_regclass('public.store_order') AS resolution
    FROM public.store_order_refund r JOIN public.store_order o ON o.id=r.store_order_id WHERE r.id=${b.refundId} AND o.id=${b.orderId}
      AND pg_catalog.octet_length(COALESCE(r.cart_info,''))<=65536 AND pg_catalog.octet_length(COALESCE(r.refund_img,''))<=262144
    LIMIT 2 FOR SHARE OF r,o NOWAIT`);
  if (rows.length !== 1) return UNAVAILABLE;
  let decision: Readonly<RoutineSubscriptionRefundSuccessDecision>;
  try {
    const row = subscriptionObject(rows[0], ['refund', 'order', 'resolution']);
    const order = subscriptionObject(row.order, ['id', 'orderNo', 'uid', 'storeId', 'supplierId', 'payPrice', 'paid', 'payType', 'pid', 'type', 'totalNum',
      'refundStatus', 'refundType', 'refundPrice', 'isDel', 'isSystemDel', 'hasChildren', 'hasOtherCompleted']);
    // The displayed refund number is checked by captureDecision against r.order_id.
    // The independent physical order number is bounded but is never substituted.
    if (row.resolution !== true || order.id !== b.orderId || !text(order.orderNo, 32) || order.uid !== b.userId || order.payPrice !== b.payPrice
      || order.paid !== 1 || order.payType !== 'weixin' || order.pid !== 0 || order.type !== 0 || !subscriptionInteger(order.totalNum)
      || order.refundStatus !== 2 || order.refundType !== 6 || order.refundPrice !== b.payPrice || order.isDel !== 0 || order.isSystemDel !== 0
      || order.hasChildren !== false || order.hasOtherCompleted !== false) return UNAVAILABLE;
    const ds = Object.getOwnPropertyDescriptors(row.refund as object);
    if (!ds.storeId || !('value' in ds.storeId) || !ds.supplierId || !('value' in ds.supplierId)
      || !ds.refundNum || !('value' in ds.refundNum) || order.storeId !== ds.storeId.value || order.supplierId !== ds.supplierId.value
      || order.totalNum !== ds.refundNum.value) return UNAVAILABLE;
    decision = captureRoutineSubscriptionRefundSuccessDecision(key, row.refund, b, captured.eventTime);
  } catch { return UNAVAILABLE; }
  const body = { format: 5 as const, requestId: randomUUID(), scope: writer.scope, actor: writer.actor,
    eventKey: captured.eventKey, aggregateId: captured.aggregateId, eventTime: captured.eventTime, body: b, decision, createdAt: writer.createdAt };
  return Object.freeze({ kind: 'original' as const, request: freezeSubscription({ ...body,
    signature: subscriptionMac(key, 'refund-success-notice-request', body) }) });
}
