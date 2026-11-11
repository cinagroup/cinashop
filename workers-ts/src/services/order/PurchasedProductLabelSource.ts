/** Actual paid-allocation author and replay source fence. No live label
 * configuration or membership effects are read in the payment transaction. */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox } from '@/models/schema';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { assertPurchasedLabelRuntimeTx } from '@/migrations/purchasedProductLabelRuntime';
import { capturePurchasedLabelIntent, purchasedProductLabelEventKey, type PurchasedLabelCart, type PurchasedLabelIntent } from './PurchasedProductLabelCodec';
import { captureOrderPaidSourcePayload } from './OrderPaidNoticeCodec';
import type { SupplierAllocationResult } from './OrderSupplierAllocationService';
import type { PurchasedLabelRuntimeDeclaration } from './PurchasedProductLabelRuntimeDeclaration';
type PaidEvent = typeof storeOrderOutbox.$inferSelect;
type Order = typeof storeOrder.$inferSelect;
type Cart = Pick<typeof storeOrderCartInfo.$inferSelect, 'id'|'oid'|'uid'|'cartId'|'productId'|'productType'|'type'|'relationId'|'skuUnique'|'cartNum'|'isGift'|'cartInfo'>;
export interface PurchasedLabelIntentRow {
  taskId: string; eventKey: string; paymentEventId: number; paymentOrderId: number;
  orderId: number; userId: number; sourceHash: string; source: unknown; createdAt: number;
}
const sourceError = () => Error('购买标签真实付款或商品来源不一致，须维护核对');
export function purchasedLabelPaymentImage(event: PaidEvent) {
  const payload = captureOrderPaidSourcePayload(event.payload);
  if (event.eventType !== 'order.paid' || event.aggregateType !== 'order' || event.aggregateId !== payload.orderId
    || event.eventKey !== `order.paid:${payload.orderId}` || !Number.isSafeInteger(event.id) || event.id <= 0
    || !Number.isSafeInteger(event.addTime) || event.addTime < 0) throw sourceError();
  return { id: event.id, eventKey: event.eventKey, aggregateType: event.aggregateType, aggregateId: event.aggregateId,
    eventType: event.eventType, payload, addTime: event.addTime };
}
function cartIdentity(row: Cart, order: Order): PurchasedLabelCart {
  if (row.oid !== order.id || row.uid !== order.uid) throw sourceError();
  let productId = row.productId;
  if (productId === 0) {
    if (!row.cartInfo || new TextEncoder().encode(row.cartInfo).byteLength > 262144) throw sourceError();
    const raw: unknown = JSON.parse(row.cartInfo);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw sourceError();
    const value: unknown = (raw as Record<string, unknown>).product_id;
    productId = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : typeof value === 'number' ? value : 0;
  }
  return { rowId: row.id, cartId: row.cartId, productId, productType: row.productType, ownerType: row.type,
    ownerId: row.relationId, skuUnique: row.skuUnique, quantity: row.cartNum, isGift: row.isGift };
}
async function carts(tx: DbClient, order: Order): Promise<PurchasedLabelCart[]> {
  const rows = await tx.select({ id: storeOrderCartInfo.id, oid: storeOrderCartInfo.oid, uid: storeOrderCartInfo.uid,
    cartId: storeOrderCartInfo.cartId, productId: storeOrderCartInfo.productId, productType: storeOrderCartInfo.productType,
    type: storeOrderCartInfo.type, relationId: storeOrderCartInfo.relationId, skuUnique: storeOrderCartInfo.skuUnique,
    cartNum: storeOrderCartInfo.cartNum, isGift: storeOrderCartInfo.isGift,
    cartInfo: sql<string | null>`CASE WHEN ${storeOrderCartInfo.productId}=0 AND octet_length(${storeOrderCartInfo.cartInfo})<=262144 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
  }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('share', { noWait: true });
  if (!rows.length || rows.length > 200) throw sourceError();
  return rows.map(r => cartIdentity(r, order));
}
async function assertFamily(tx: DbClient, root: Order, order: Order) {
  if (root.paid !== 1 || root.pid > 0 || order.paid !== 1 || order.uid !== root.uid || root.uid <= 0) throw sourceError();
  const seen = new Set<number>(); let node = order;
  while (node.id !== root.id) {
    if (seen.size >= 64 || seen.has(node.id) || node.pid <= 0 || node.uid !== root.uid || node.paid !== 1) throw sourceError();
    seen.add(node.id);
    const [parent] = await tx.select().from(storeOrder).where(eq(storeOrder.id, node.pid)).limit(1).for('share', { noWait: true });
    if (!parent) throw sourceError(); node = parent;
  }
}
export async function captureActualPurchasedLabelIntent(tx: DbClient, event: PaidEvent, root: Order, order: Order, occurredAt: number) {
  const image = purchasedLabelPaymentImage(event);
  if (image.aggregateId !== root.id || image.payload.orderNo !== root.orderId) throw sourceError();
  await assertFamily(tx, root, order);
  return capturePurchasedLabelIntent({ format: 1, paymentEventId: event.id, paymentOrderId: root.id, paymentOrderNo: root.orderId,
    paymentSourceHash: await outRequestHash(image), orderId: order.id, orderNo: order.orderId, userId: order.uid,
    financialStoreId: order.storeId, supplierId: order.supplierId, orderType: order.type, activityId: order.activityId,
    totalNum: order.totalNum, occurredAt, carts: await carts(tx, order) });
}
export async function readPurchasedLabelIntent(tx: DbClient, taskId: string): Promise<PurchasedLabelIntentRow | undefined> {
  const [row] = await tx.execute<PurchasedLabelIntentRow & Record<string, unknown>>(sql`SELECT task_id::text AS "taskId",event_key AS "eventKey",
    payment_event_id AS "paymentEventId",payment_order_id AS "paymentOrderId",order_id AS "orderId",customer_uid AS "userId",
    source_hash AS "sourceHash",source,created_at AS "createdAt" FROM public.purchased_product_label_intent WHERE task_id=${taskId}::uuid`);
  return row;
}
export async function verifyPurchasedLabelIntent(row: PurchasedLabelIntentRow): Promise<PurchasedLabelIntent> {
  const intent = capturePurchasedLabelIntent(row.source);
  if (row.eventKey !== purchasedProductLabelEventKey(intent.paymentOrderId, intent.orderId) || row.paymentEventId !== intent.paymentEventId
    || row.paymentOrderId !== intent.paymentOrderId || row.orderId !== intent.orderId || row.userId !== intent.userId
    || row.createdAt !== intent.occurredAt || await outRequestHash(intent) !== row.sourceHash) throw sourceError();
  return intent;
}
/** The genuine OrderOutboxService invokes this after its actual allocation in
 * the same paid-effects transaction. Missing declaration remains inactive. */
export async function enqueuePurchasedProductLabelsTx(tx: DbClient, event: PaidEvent, allocation: SupplierAllocationResult,
  declaration: PurchasedLabelRuntimeDeclaration | undefined, now: number) {
  if (!declaration) return;
  await assertPurchasedLabelRuntimeTx(tx, declaration.target, 'produce');
  const image = purchasedLabelPaymentImage(event);
  const [parent] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)).limit(1).for('share', { noWait: true });
  if (!parent || parent.status !== 'PROCESSING' || !parent.leaseToken || parent.leaseToken !== event.leaseToken
    || await outRequestHash(purchasedLabelPaymentImage(parent)) !== await outRequestHash(image)) throw sourceError();
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, allocation.paymentOrder.id)).limit(1).for('share', { noWait: true });
  if (!root || root.id !== image.aggregateId || root.orderId !== image.payload.orderNo || root.paid !== 1
    || root.uid !== allocation.paymentOrder.uid || root.pid > 0) throw sourceError();
  if (root.uid === 0) return; // The paid author has already validated the assisted-guest origin.
  const ids = allocation.fulfillmentOrders.map(o => o.id);
  if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length) throw sourceError();
  const orders = await tx.select().from(storeOrder).where(inArray(storeOrder.id, ids)).orderBy(asc(storeOrder.id)).limit(65).for('share', { noWait: true });
  if (orders.length !== ids.length || orders.reduce((sum, o) => sum + o.totalNum, 0) !== root.totalNum
    || (orders.length > 1 && orders.some(o => o.id === root.id))) throw sourceError();
  for (const order of orders) {
    const intent = await captureActualPurchasedLabelIntent(tx, parent, root, order, now);
    const key = purchasedProductLabelEventKey(root.id, order.id), sourceHash = await outRequestHash(intent);
    const prior = await tx.execute<{ taskId: string }>(sql`SELECT task_id::text AS "taskId" FROM public.purchased_product_label_intent WHERE event_key=${key}`);
    if (prior.length) {
      const row = await readPurchasedLabelIntent(tx, prior[0]!.taskId);
      if (!row || row.sourceHash !== sourceHash || await outRequestHash(await verifyPurchasedLabelIntent(row)) !== sourceHash) throw sourceError();
      const [state] = await tx.execute<{ safe: boolean }>(sql`SELECT status='PENDING' AND dispatch_count=0 AND attempt_count=0 AND replay_count=0
        AND lease_until=0 AND lease_token='' AND processed_at=0 AND NOT EXISTS(SELECT 1 FROM public.purchased_product_label_result r WHERE r.task_id=s.task_id) AS safe
        FROM public.purchased_product_label_state s WHERE task_id=${row.taskId}::uuid`);
      if (state?.safe !== true) throw sourceError();
      continue;
    }
    const taskId = crypto.randomUUID();
    await tx.execute(sql`INSERT INTO public.purchased_product_label_intent
      (task_id,event_key,payment_event_id,payment_order_id,order_id,customer_uid,source_hash,source,created_at)
      VALUES(${taskId}::uuid,${key},${parent.id},${root.id},${order.id},${order.uid},${sourceHash},${JSON.stringify(intent)}::jsonb,${now})`);
    await tx.execute(sql`INSERT INTO public.purchased_product_label_state(task_id,available_at,updated_at) VALUES(${taskId}::uuid,${now},${now})`);
  }
}
/** Re-run the same actual identity fence before first grant. Later refund and
 * deletion flags do not revoke a genuine historical purchase label occurrence. */
export async function verifyActualPurchasedLabelSource(tx: DbClient, intent: PurchasedLabelIntent) {
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, intent.paymentEventId)).limit(1).for('share', { noWait: true });
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, intent.paymentOrderId)).limit(1).for('share', { noWait: true });
  const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, intent.orderId)).limit(1).for('share', { noWait: true });
  if (!event || event.status !== 'COMPLETED' || !root || !order) throw sourceError();
  const current = await captureActualPurchasedLabelIntent(tx, event, root, order, intent.occurredAt);
  if (await outRequestHash(current) !== await outRequestHash(intent)) throw sourceError();
}
