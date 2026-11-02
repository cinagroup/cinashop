/** Fact-only assignment reads shared by authenticated Admin and Manager
 * transactions. Callers supply their own actual-principal admission and root
 * authority. Hashes are stale-review fences, never authorization/signatures. */
import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo } from '@/models/schema';
import { merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { assertNoConflictingCustomerCityJob } from './CustomerCityFulfillmentFence';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { amountToCents } from '@/services/payment/RefundGateway';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { ASSIGNMENT_CHAIN_BYTES, ASSIGNMENT_CHAIN_LIMIT, assignmentBytes, assignmentId,
  assignmentSame, captureAssignmentSource, decodeAssignmentEvent,
  type AssignmentEvent, type AssignmentSource } from './FulfillmentAssignmentProtocol';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
export type AssignmentCurrentSource = Readonly<{ order: Order; source: AssignmentSource; orderRevision: string; sourceHash: string }>;
export interface AssignmentSourceLocks {
  /** Trusted SQL-only port; must acquire an actual SHARE-or-stronger waybill
   * table lock in this same transaction. Its result does not authorize an actor. */
  waybillFence?: (tx: DbClient) => Promise<void>;
}
const unavailable = (m = '分配账本或订单来源尚未完整就绪，请保留原请求核对') => new ServiceUnavailableException(m);
export const ASSIGNMENT_EVENT_COLUMNS = sql.raw(`operation_id::text AS operation_id,format_version,kind,actor_id,root_order_id,order_id,
  target_store_id,customer_uid,financial_store_id,ordinal,previous_ref::text AS previous_ref,
  order_revision,payload_hash,source_hash,source,created_at::text AS created_at`);

function safeCount(v: unknown): number {
  const n = typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/u.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || Number(n) < 0) throw unavailable();
  return Number(n);
}
export async function decodeStoredAssignment(value: unknown): Promise<AssignmentEvent> {
  try { return await decodeAssignmentEvent(value); }
  catch (cause) { throw Object.assign(unavailable('原分配回执不符合正式作者合同，请人工核对'), { cause }); }
}
export async function readOperation(tx: DbClient, id: string): Promise<AssignmentEvent | null> {
  const rows = await tx.execute(sql`SELECT ${ASSIGNMENT_EVENT_COLUMNS} FROM public.store_order_fulfillment_assignment
    WHERE operation_id=${id}::uuid LIMIT 2`);
  if (rows.length > 1) throw unavailable();
  return rows.length ? decodeStoredAssignment(rows[0]) : null;
}
/** Read 65 to detect overflow; never truncate a chain and treat the tail as a
 * new genesis. Old source hashes are past author captures, not current facts. */
export async function readChain(tx: DbClient, orderId: number): Promise<readonly AssignmentEvent[]> {
  const [size] = await tx.execute<{ count: number; bytes: string }>(sql`SELECT pg_catalog.count(*)::integer AS count,
    COALESCE(pg_catalog.sum(pg_catalog.octet_length(pg_catalog.to_jsonb(t)::text)),0)::text AS bytes
    FROM (SELECT ${ASSIGNMENT_EVENT_COLUMNS} FROM public.store_order_fulfillment_assignment WHERE order_id=${orderId}
      ORDER BY ordinal LIMIT ${ASSIGNMENT_CHAIN_LIMIT + 1}) t`);
  if (!size || safeCount(size.count) > ASSIGNMENT_CHAIN_LIMIT || safeCount(size.bytes) > ASSIGNMENT_CHAIN_BYTES) throw unavailable('分配历史超过核对容量，请人工维护');
  const rows = await tx.execute(sql`SELECT ${ASSIGNMENT_EVENT_COLUMNS} FROM public.store_order_fulfillment_assignment
    WHERE order_id=${orderId} ORDER BY ordinal LIMIT ${ASSIGNMENT_CHAIN_LIMIT + 1}`);
  if (rows.length > ASSIGNMENT_CHAIN_LIMIT || rows.length !== size.count || assignmentBytes(rows) > ASSIGNMENT_CHAIN_BYTES) throw unavailable();
  const chain: AssignmentEvent[] = [], ids = new Set<string>();
  for (const raw of rows) {
    const r = await decodeStoredAssignment(raw), p = chain.at(-1);
    if (r.order_id !== orderId || r.root_order_id !== orderId || r.ordinal !== chain.length + 1 || ids.has(r.operation_id)
      || r.previous_ref !== (p?.operation_id ?? null) || p && (r.customer_uid !== p.customer_uid || r.created_at < p.created_at)) throw unavailable('分配链断裂或身份发生变化');
    if (r.kind === 'revoke' && (!p || p.kind !== 'grant' || r.target_store_id !== p.target_store_id
      || r.source_hash !== p.source_hash || r.order_revision !== p.order_revision || !assignmentSame(r.source, p.source))) throw unavailable('原撤销回执与批准不一致');
    if (r.kind === 'grant' && p?.kind === 'grant' && r.target_store_id === p.target_store_id) throw unavailable('分配链包含未定义的重复批准');
    ids.add(r.operation_id); chain.push(r);
  }
  return Object.freeze(chain);
}
/** Preflight size is computed in SQL so an unbounded text/cart snapshot is not
 * transferred just to discover that it exceeds the author's capacity. */
export async function orderSnapshot(tx: DbClient, id: number): Promise<Order> {
  // The caller owns either the complete RR/RO review snapshot or rootIdentity's
  // real63842 plus the physical root row. This helper takes no new root lock.
  const [size] = await tx.execute<{ id: number; bytes: number }>(sql`SELECT id,pg_catalog.octet_length(pg_catalog.to_jsonb(o)::text) AS bytes
    FROM public.store_order o WHERE id=${id}`);
  if (!size) throw new NotFoundException('订单不存在');
  if (size.id !== id || safeCount(size.bytes) > 262144) throw new ValidateException('订单来源超过当前分配容量');
  const rows = await tx.select().from(storeOrder).where(eq(storeOrder.id, id)).limit(2);
  if (rows.length !== 1 || rows[0].id !== id || assignmentBytes(rows[0]) > 262144) throw unavailable();
  return rows[0];
}
function assertWhole(order: Order): void {
  if (order.pid !== 0 || order.uid <= 0 || order.storeId !== 0 || order.supplierId !== 0 || order.paid !== 1
    || order.status !== 0 || order.isDel !== 0 || order.isSystemDel !== 0 || order.shippingType !== 1 || order.productType !== 0
    || order.type !== 0 || ![0, 2].includes(order.supplierAllocationStatus) || order.refundStatus !== 0
    || ![0, 3].includes(order.refundType) || amountToCents(order.refundPrice) !== 0
    || order.deliveryType !== '' || order.deliveryId !== '' || order.deliveryCode !== '' || order.deliveryName !== ''
    || order.deliveryUid !== 0 || order.isStockUp !== 0 || order.kuaidiTaskId !== '' || order.kuaidiOrderId !== 0)
    throw new ValidateException('当前分配仅接入未发货的已付款平台普通整单快递；旧单或其他来源须另行维护');
  assignmentId(order.uid); assignmentId(order.totalNum);
}
async function sourceConflicts(tx: DbClient, id: number, uid: number, lock: boolean, locks?: AssignmentSourceLocks): Promise<void> {
  if (lock) {
    // Protect zero-row predicates as well as current rows. These existing Admin
    // tables carry the existing UPDATE authority used for their table fences.
    await tx.execute(sql`LOCK TABLE ONLY public.store_order_cart_info, ONLY public.store_order_refund IN SHARE MODE NOWAIT`);
    if (locks?.waybillFence) await locks.waybillFence(tx);
    else await tx.execute(sql`LOCK TABLE ONLY public.order_waybill_job IN SHARE MODE NOWAIT`);
    const [fence] = await tx.execute<{ ready: boolean }>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
      WHERE pid=pg_catalog.pg_backend_pid() AND relation='public.order_waybill_job'::regclass AND granted
        AND mode IN('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) AS ready`);
    if (fence?.ready !== true) throw unavailable('面单来源缺少同事务物理写入栅栏');
  }
  const [r] = await tx.execute<{ child: boolean; refund: boolean; invalidRefund: boolean; waybill: boolean; invalidWaybill: boolean; generation: boolean; notice: boolean }>(sql`SELECT
    EXISTS(SELECT 1 FROM public.store_order WHERE pid=${id}) AS child,
    EXISTS(SELECT 1 FROM public.store_order_refund WHERE store_order_id=${id} AND is_cancel=0 AND is_del=0 AND refund_type IN(0,1,2,4,5,6)) AS refund,
    EXISTS(SELECT 1 FROM public.store_order_refund WHERE store_order_id=${id}
      AND(uid<>${uid} OR store_id<>0 OR supplier_id<>0 OR refund_type NOT IN(0,1,2,3,4,5,6))) AS "invalidRefund",
    EXISTS(SELECT 1 FROM public.order_waybill_job WHERE root_order_id=${id}
      AND status IN('PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','SENT','UNKNOWN','DEAD')) AS waybill,
    EXISTS(SELECT 1 FROM public.order_waybill_job WHERE root_order_id=${id} AND
      (status NOT IN('PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','SENT','UNKNOWN','DEAD','CLOSED')
        OR order_id<>${id} OR store_id<>0 OR supplier_id<>0)) AS "invalidWaybill",
    (EXISTS(SELECT 1 FROM public.store_order_refund_split WHERE source_order_id=${id} OR payment_order_id=${id}
       OR selected_order_id=${id} OR remaining_order_id=${id})
      OR EXISTS(SELECT 1 FROM public.store_order_fulfillment_branch WHERE source_order_id=${id} OR payment_order_id=${id} OR child_order_id=${id})) AS generation,
    EXISTS(SELECT 1 FROM public.store_order_outbox WHERE aggregate_type='order' AND aggregate_id=${id} AND event_type='order.delivery.notice') AS notice`);
  if (!r || Object.values(r).some(v => typeof v !== 'boolean')) throw unavailable();
  if (r.child || r.generation) throw new ValidateException('当前分配尚未接入拆单或退款物化来源');
  if (r.refund || r.invalidRefund) throw new ValidateException('订单售后来源须先核对');
  if (r.waybill || r.invalidWaybill || r.notice) throw new ValidateException('订单已有面单或发货通知来源，请先恢复原履约');
  // The physical root row serializes existing root-first family/evidence
  // writers as well as63842 peers. Supplier allocation uses its older one-int
  // advisory namespace but still locks this root FOR UPDATE before children.
  // Append-only evidence receives NO new UPDATE/table-lock grants here.
  if (lock) await assertNoConflictingCustomerCityJob(tx, id);
}
export async function cartsSnapshot(tx: DbClient, order: Order, lock: boolean): Promise<Cart[]> {
  const [size] = await tx.execute<{ count: number; bytes: string; largest: number; infoLargest: number }>(sql`SELECT
    pg_catalog.count(*)::integer AS count,COALESCE(pg_catalog.sum(pg_catalog.octet_length(pg_catalog.to_jsonb(c)::text)),0)::text AS bytes,
    COALESCE(pg_catalog.max(pg_catalog.octet_length(pg_catalog.to_jsonb(c)::text)),0) AS largest,
    COALESCE(pg_catalog.max(pg_catalog.octet_length(c.cart_info)),0) AS "infoLargest"
    FROM public.store_order_cart_info c WHERE oid=${order.id}`);
  if (!size || safeCount(size.count) < 1 || safeCount(size.count) > 200 || safeCount(size.bytes) > 1048576
    || safeCount(size.largest) > 131072 || safeCount(size.infoLargest) > 65536) throw new ValidateException('订单商品超过当前分配核对容量');
  const q = tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const carts = await (lock ? q.for('share', { noWait: true }) : q);
  if (carts.length !== size.count || carts.length > 200 || assignmentBytes(carts) > 1048576) throw unavailable();
  const ids = new Set<string>(); let physicalQuantity = 0;
  for (const row of carts) {
    assignmentId(row.id); assignmentId(row.productId); assignmentId(row.cartNum);
    if (row.oid !== order.id || row.uid !== order.uid || ids.has(row.cartId) || row.productType !== 0 || ![0, 1].includes(row.type)
      || !Number.isSafeInteger(row.relationId) || row.relationId < 0 || row.type === 1 && row.relationId <= 0
      || ![0, 1].includes(row.isGift) || row.refundNum !== 0 || row.surplusNum !== row.cartNum
      || row.splitSurplusNum !== row.cartNum || row.splitStatus !== 0 || row.oldCartId !== ''
      || row.isWriteoff !== 0 || row.writeoffTime !== 0 || !/^[a-f0-9]{32}$/u.test(row.unique))
      throw new ValidateException('当前分配仅接入平台或门店商品的完整真实快照；旧计数或供应商来源须另行维护');
    ids.add(row.cartId); physicalQuantity += row.cartNum;
    if (typeof row.cartInfo !== 'string' || new TextEncoder().encode(row.cartInfo).byteLength > 65536) throw new ValidateException('原商品快照不可完整核对');
    let parsed: unknown;
    try { parsed = JSON.parse(row.cartInfo); } catch { throw new ValidateException('原商品快照格式错误'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidateException('原商品快照格式错误');
    const info = parsed as Record<string, unknown>;
    // Both the normal checkout writer and its gift writer persist this exact
    // finance version. Presence of financial_version alone is not a refund
    // marker. Legacy projections and genuine refund generations stay closed.
    if (Object.hasOwn(info, 'refund_order_generation') || Object.hasOwn(info, 'legacy_php_financial_source')
      || info.financial_version !== 'checkout-line-finance-v1')
      throw new ValidateException('当前分配仅接入正式 TS 下单快照，退款代次或旧来源须另行维护');
    if (info.id !== row.cartId || info.cart_num !== row.cartNum)
      throw new ValidateException('原商品快照与实际购物车行不一致');
  }
  // StoreOrderCreateService :2685 initially excludes gifts for the purchase
  // trigger; :3122-3127 then restores the final physical total including gifts.
  if (!Number.isSafeInteger(physicalQuantity) || physicalQuantity !== order.totalNum) throw new ValidateException('订单与商品数量须先核对');
  return carts;
}
export async function currentSource(tx: DbClient, order: Order, lock: boolean, locks?: AssignmentSourceLocks): Promise<AssignmentCurrentSource> {
  assertWhole(order);
  await sourceConflicts(tx, order.id, order.uid, lock, locks);
  const carts = await cartsSnapshot(tx, order, lock);
  return assignmentSourceSnapshot(order, carts);
}
/** Pure source encoding. Callers must independently establish source/locks. */
export async function assignmentSourceSnapshot(order: Order, carts: readonly Cart[]): Promise<AssignmentCurrentSource> {
  const orderRevision = await merchantOrderRevision(order);
  const source = captureAssignmentSource({ cart_rows: carts.map(c => ({ row_id: c.id, cart_id: c.cartId,
    product_id: c.productId, unique: c.skuUnique, quantity: c.cartNum })) });
  const cartFacts = [];
  for (const c of carts) cartFacts.push({ id: c.id, oid: c.oid, uid: c.uid, cartId: c.cartId, type: c.type,
    relationId: c.relationId, productId: c.productId, productType: c.productType, skuUnique: c.skuUnique,
    isGift: c.isGift, cartNum: c.cartNum, refundNum: c.refundNum, surplusNum: c.surplusNum, oldCartId: c.oldCartId,
    splitSurplusNum: c.splitSurplusNum, splitStatus: c.splitStatus, unique: c.unique, settlePrice: c.settlePrice,
    promotionsId: c.promotionsId, isSupportRefund: c.isSupportRefund, writeTimes: c.writeTimes, writeSurplusTimes: c.writeSurplusTimes,
    writeStart: c.writeStart, writeEnd: c.writeEnd, isWriteoff: c.isWriteoff, writeoffTime: c.writeoffTime,
    cartInfoHash: await outRequestHash({ version: 'assignment-cart-info-v1', value: c.cartInfo }) });
  const sourceHash = await outRequestHash({ version: 'store-order-fulfillment-assignment-source-v1', orderRevision,
    route: { realName: order.realName, userPhone: order.userPhone, province: order.province, userAddress: order.userAddress,
      userLocation: order.userLocation }, carts: cartFacts, source });
  return Object.freeze({ order, source, orderRevision, sourceHash });
}
