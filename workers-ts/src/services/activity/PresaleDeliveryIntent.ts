import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox } from '@/models/schema';
import { presaleDispatchBoundary } from './PresaleFulfillmentSnapshot';
import { parseVirtualDeliverySnapshot } from '@/services/order/VirtualProductDeliveryService';
import { capturePresaleRefundBaseline, type PresaleRefundBaseline } from './PresaleRefundBaseline';

// Registered with external 0161 / embedded 0167. Queue messages carry only
// the event reference; the immutable contract stays in PostgreSQL.
export const PRESALE_DELIVERY_EVENT = 'order.presale.fulfillment';
const VERSION = 'presale-virtual-delivery-v1';
const BASELINE_VERSION = 'presale-virtual-delivery-v2';
const MAX_INT = 2_147_483_647;
const MAX_LINES = 200;
const MAX_SNAPSHOT_BYTES = 65_536;
const MAX_INTENT_BYTES = 131_072;
const invalid = () => new Error('预售自动交付意图或订单凭据不一致');

export interface PresaleDeliveryLine {
  cartInfoId: number;
  productId: number;
  skuUnique: string;
  quantity: number;
  endsAt: number;
  /** Digest of delivery identity, boundary and immutable card/disk mode/content.
   * Not a substitute for validating refund partitions or current order identity. */
  contractDigest: string;
}

interface PresaleDeliveryFields {
  orderId: number;
  orderNo: string;
  paymentOrderId: number;
  buyerId: number;
  supplierId: number;
  storeId: number;
  dueAt: number;
  lines: PresaleDeliveryLine[];
}
export type PresaleDeliveryIntent = PresaleDeliveryFields & (
  { version: typeof VERSION } | { version: typeof BASELINE_VERSION; baseline: PresaleRefundBaseline }
);

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= MAX_INT;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw invalid();
  return row;
}

async function transaction(tx: DbClient) {
  if (Object.hasOwn(tx, '$client')) throw Error('Presale delivery intent requires a caller-owned transaction');
  await tx.execute(sql`SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
}

export function presaleDeliveryEventKey(orderId: number): string {
  if (!integer(orderId, 1)) throw invalid();
  return `${PRESALE_DELIVERY_EVENT}:${orderId}`;
}

/** Strict, canonical and bounded. Unknown versions/extra fields never silently
 * downgrade. Order/cart references and digests only: no card secrets or PII. */
export function readPresaleDeliveryIntent(value: unknown, aggregateId: number): PresaleDeliveryIntent {
  const upgraded = value !== null && typeof value === 'object' && 'version' in value && value.version === BASELINE_VERSION;
  const row = object(value, ['version', 'orderId', 'orderNo', 'paymentOrderId', 'buyerId', 'supplierId', 'storeId', 'dueAt', 'lines', ...(upgraded ? ['baseline'] : [])]);
  if (!integer(aggregateId, 1) || (row.version !== VERSION && row.version !== BASELINE_VERSION) || row.orderId !== aggregateId ||
    typeof row.orderNo !== 'string' || !row.orderNo || row.orderNo.length > 32 || row.orderNo.trim() !== row.orderNo ||
    /[\u0000-\u001f\u007f]/.test(row.orderNo) || !integer(row.paymentOrderId, 1) ||
    !integer(row.buyerId, 1) || !integer(row.supplierId) || !integer(row.storeId) || !integer(row.dueAt) ||
    !Array.isArray(row.lines) || !row.lines.length || row.lines.length > MAX_LINES) throw invalid();
  let previousId = 0, latestEnd = 0;
  const lines = row.lines.map(value => {
    const line = object(value, ['cartInfoId', 'productId', 'skuUnique', 'quantity', 'endsAt', 'contractDigest']);
    if (!integer(line.cartInfoId, 1) || line.cartInfoId <= previousId || !integer(line.productId, 1) ||
      typeof line.skuUnique !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(line.skuUnique) ||
      !integer(line.quantity, 1) || line.quantity > 32767 || !integer(line.endsAt) ||
      typeof line.contractDigest !== 'string' || !/^[0-9a-f]{64}$/.test(line.contractDigest)) throw invalid();
    previousId = line.cartInfoId;
    latestEnd = Math.max(latestEnd, line.endsAt);
    return { cartInfoId: line.cartInfoId, productId: line.productId, skuUnique: line.skuUnique,
      quantity: line.quantity, endsAt: line.endsAt, contractDigest: line.contractDigest };
  });
  if (latestEnd !== row.dueAt) throw invalid();
  let basis: { version: typeof VERSION } | { version: typeof BASELINE_VERSION; baseline: PresaleRefundBaseline } = { version: VERSION };
  if (upgraded) {
    const baseline = object(row.baseline, ['refundId', 'historyDigest']);
    if (!integer(baseline.refundId, 1) || typeof baseline.historyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(baseline.historyDigest)) throw invalid();
    basis = { version: BASELINE_VERSION, baseline: { refundId: baseline.refundId, historyDigest: baseline.historyDigest } };
  }
  const result: PresaleDeliveryIntent = { ...basis, orderId: aggregateId, orderNo: row.orderNo,
    paymentOrderId: row.paymentOrderId, buyerId: row.buyerId, supplierId: row.supplierId, storeId: row.storeId,
    dueAt: row.dueAt, lines };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_INTENT_BYTES) throw invalid();
  return result;
}

/** No live product/SKU lookup. Financial/refund snapshots may change on a proven
 * descendant; its fulfillment mode/content and presale boundary must not. */
export async function presaleDeliveryContractDigest(raw: string | null, productId: number, skuUnique: string): Promise<string> {
  const end = presaleDispatchBoundary(raw, productId);
  const delivery = parseVirtualDeliverySnapshot(raw);
  if (!delivery || !/^[A-Za-z0-9_-]{1,255}$/.test(skuUnique)) throw invalid();
  const bytes = new TextEncoder().encode(JSON.stringify([productId, skuUnique, end, delivery.diskInfo]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function databaseNow(tx: DbClient): Promise<number> {
  const [clock] = await tx.select({ now: sql<number>`floor(extract(epoch FROM clock_timestamp()))::integer` })
    .from(sql`(VALUES(1)) AS presale_intent_clock(n)`);
  if (!integer(clock?.now)) throw invalid();
  return clock.now;
}

/** Called after supplier allocation, inside the payment-effects transaction.
 * The caller already owns payment-root -> fulfillment-order locks. Reacquiring
 * the exact order and SHARE snapshot locks with NOWAIT adds no reverse wait edge.
 * This captures intent only; it never delivers, changes paid facts or calls Queue.
 * Refund reservations do not reduce this original quantity: only a separately
 * verified completed-refund generation may reduce eventual delivery entitlement. */
export async function enqueuePresaleDeliveryIntent(tx: DbClient,
  expected: { id: number; orderId: string }, paymentOrderId: number): Promise<{ id: number; eventKey: string; intent: PresaleDeliveryIntent }> {
  await transaction(tx);
  const eventKey = presaleDeliveryEventKey(expected.id);
  if (!integer(paymentOrderId, 1)) throw invalid();
  const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, expected.id)).limit(1).for('update', { noWait: true });
  if (!order || order.orderId !== expected.orderId || order.type !== 6 || order.productType !== 1 ||
    order.paid !== 1 || order.status !== 0 || order.refundStatus === 2 || order.isDel || order.isSystemDel || order.pid < 0 ||
    (order.pid || order.id) !== paymentOrderId || order.supplierAllocationStatus !== 2 || !integer(order.uid, 1)) throw invalid();
  if (order.pid > 0) {
    const [root] = await tx.select({ uid: storeOrder.uid, pid: storeOrder.pid, paid: storeOrder.paid,
      type: storeOrder.type, productType: storeOrder.productType, supplierAllocationStatus: storeOrder.supplierAllocationStatus,
    }).from(storeOrder).where(eq(storeOrder.id, paymentOrderId)).limit(1).for('share', { noWait: true });
    if (!root || root.uid !== order.uid || root.pid !== -1 || root.paid !== 1 || root.type !== 6 ||
      root.productType !== 1 || root.supplierAllocationStatus !== 2) throw invalid();
  }
  const rows = await tx.select({ ...getTableColumns(storeOrderCartInfo),
    cartInfo: sql<string | null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo}) <= ${MAX_SNAPSHOT_BYTES}
      THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`,
  }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(MAX_LINES + 1).for('share', { noWait: true });
  if (!rows.length || rows.length > MAX_LINES || rows.some(row => row.uid !== order.uid || row.productType !== 1) ||
    rows.reduce((sum, row) => sum + row.cartNum, 0) !== order.totalNum) throw invalid();
  const lines: PresaleDeliveryLine[] = [];
  for (const row of rows) {
    lines.push({ cartInfoId: row.id, productId: row.productId, skuUnique: row.skuUnique, quantity: row.cartNum,
      endsAt: presaleDispatchBoundary(row.cartInfo, row.productId),
      contractDigest: await presaleDeliveryContractDigest(row.cartInfo, row.productId, row.skuUnique) });
  }
  const baseline = await capturePresaleRefundBaseline(tx, order, rows, lines);
  const intent = readPresaleDeliveryIntent({ ...(baseline ? { version: BASELINE_VERSION, baseline } : { version: VERSION }), orderId: order.id, orderNo: order.orderId,
    paymentOrderId, buyerId: order.uid, supplierId: order.supplierId, storeId: order.storeId,
    dueAt: Math.max(...lines.map(line => line.endsAt)), lines }, order.id);
  const now = await databaseNow(tx);
  const [inserted] = await tx.insert(storeOrderOutbox).values({ eventKey, aggregateType: 'order', aggregateId: order.id,
    eventType: PRESALE_DELIVERY_EVENT, payload: intent, status: 'PENDING', availableTime: intent.dueAt,
    addTime: now, updateTime: now }).onConflictDoNothing({ target: storeOrderOutbox.eventKey }).returning({ id: storeOrderOutbox.id });
  if (inserted) return { id: inserted.id, eventKey, intent };
  const [existing] = await tx.select({ id: storeOrderOutbox.id, aggregateType: storeOrderOutbox.aggregateType,
    aggregateId: storeOrderOutbox.aggregateId, eventType: storeOrderOutbox.eventType,
    payload: boundedPayload(),
  }).from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey, eventKey)).limit(1).for('share', { noWait: true });
  if (!existing || existing.aggregateType !== 'order' || existing.aggregateId !== order.id || existing.eventType !== PRESALE_DELIVERY_EVENT ||
    JSON.stringify(readPresaleDeliveryIntent(existing.payload, order.id)) !== JSON.stringify(intent)) throw invalid();
  return { id: existing.id, eventKey, intent };
}

function boundedPayload() {
  return sql<unknown>`CASE WHEN octet_length(${storeOrderOutbox.payload}::text) <= ${MAX_INTENT_BYTES}
    THEN ${storeOrderOutbox.payload} ELSE NULL END`;
}

export type PresaleClaimPreparation =
  | { kind: 'ready'; intent: PresaleDeliveryIntent; now: number }
  | { kind: 'deferred' | 'already-completed' | 'busy' | 'dead' };

/** Pre-claim step, in the SAME transaction that will acquire the processing
 * lease. A ready result is timing/identity evidence, NOT delivery authority.
 * The eventual consumer must re-lock active orders/snapshots/refund generations.
 * Early Queue/replay deliveries are acknowledged after committing PENDING;
 * the durable scanner will revisit them. No attempt count is consumed here.
 * Never overwrite another unexpired processing lease, even for an early message. */
export async function preparePresaleDeliveryClaim(tx: DbClient,
  message: { outboxId: number; eventKey: string }): Promise<PresaleClaimPreparation> {
  await transaction(tx);
  if (!integer(message.outboxId, 1)) throw invalid();
  const [event] = await tx.select({ id: storeOrderOutbox.id, eventKey: storeOrderOutbox.eventKey,
    aggregateId: storeOrderOutbox.aggregateId, aggregateType: storeOrderOutbox.aggregateType,
    eventType: storeOrderOutbox.eventType, payload: boundedPayload(), status: storeOrderOutbox.status,
    availableTime: storeOrderOutbox.availableTime, leaseUntil: storeOrderOutbox.leaseUntil,
  }).from(storeOrderOutbox).where(eq(storeOrderOutbox.id, message.outboxId)).limit(1).for('update', { noWait: true });
  if (!event || event.eventKey !== message.eventKey || event.eventKey !== presaleDeliveryEventKey(event.aggregateId) ||
    event.aggregateType !== 'order' || event.eventType !== PRESALE_DELIVERY_EVENT) throw invalid();
  const intent = readPresaleDeliveryIntent(event.payload, event.aggregateId);
  if (event.status === 'COMPLETED') return { kind: 'already-completed' };
  if (event.status === 'DEAD') return { kind: 'dead' };
  if (!['PENDING', 'FAILED', 'ENQUEUING', 'ENQUEUED', 'PROCESSING'].includes(event.status) ||
    !integer(event.availableTime) || !integer(event.leaseUntil)) throw invalid();
  const now = await databaseNow(tx);
  if (event.status === 'PROCESSING' && event.leaseUntil > now) return { kind: 'busy' };
  const dueAt = Math.max(intent.dueAt, event.availableTime);
  if (now >= dueAt) return { kind: 'ready', intent, now };
  await tx.update(storeOrderOutbox).set({ status: 'PENDING', availableTime: dueAt, leaseUntil: 0,
    leaseToken: '', updateTime: now }).where(eq(storeOrderOutbox.id, event.id));
  return { kind: 'deferred' };
}
