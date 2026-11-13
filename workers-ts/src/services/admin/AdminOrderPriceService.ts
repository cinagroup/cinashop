import { and, asc, eq, getTableColumns, sql, type SQLWrapper } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus } from '@/models/schema';
import { assertAdminOrderPriceOperationReady } from '@/migrations/adminOrderPriceOperation';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertUnpaidOrderCashierEditSource, unpaidOrderCashierSourceKind } from '@/services/order/UnpaidOrderCashierSource';
import { readUnpaidOrderEditOperation } from '@/services/order/UnpaidOrderEditOperation';
import { gainEditSha256, legacyGainIntegralState } from '@/services/order/UnpaidOrderGainIntegralProof';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { enqueueSupplierOrderPriceRevision, parseSupplierOrderPriceRevisionPayload } from '@/services/supplier/SupplierUnpaidOrderEditEffects';
import { supplierOrderEditCanonical } from '@/services/supplier/SupplierUnpaidOrderEditInput';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';
import { loadAdminAuthorityLiveActor, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { computeAdminOrderPrice, parseAdminOrderPriceInput } from './AdminOrderPriceInput';

const same = (a: unknown, b: unknown) => supplierOrderEditCanonical(a) === supplierOrderEditCanonical(b);
const conflict = () => new HttpApiException('订单价格、购买快照或操作记录已变化，请刷新后重试', 409, 409);
const fingerprint = (column: SQLWrapper) => sql<string | null>`CASE WHEN ${column} IS NULL THEN NULL ELSE
  octet_length(${column})::text||':'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${column},'UTF8')),'hex') END`;
const orderColumns = { ...getTableColumns(storeOrder), cartId: fingerprint(storeOrder.cartId), virtualInfo: fingerprint(storeOrder.virtualInfo),
  customForm: fingerprint(storeOrder.customForm), promotionsGive: fingerprint(storeOrder.promotionsGive), giveCoupon: fingerprint(storeOrder.giveCoupon),
  expressDump: fingerprint(storeOrder.expressDump), refundReasonWapImg: fingerprint(storeOrder.refundReasonWapImg) };

/** Hash all SQL columns and distinguish NULL/empty/large JSON without fetching
 * historical purchase content into the Worker. The table SHARE lock prevents
 * concurrent insert/delete phantoms until the final proof has committed. */
async function cartState(tx: DbClient, id: number) {
  const [row] = await tx.execute(sql`SELECT count(*)::text AS count,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(string_agg(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((to_jsonb(c)-'cart_info')::text,'UTF8')),'hex')||':'||
      CASE WHEN c.cart_info IS NULL THEN 'NULL' ELSE octet_length(c.cart_info)::text||':'||
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.cart_info,'UTF8')),'hex') END,'|' ORDER BY c.id),''),'UTF8')),'hex') AS hash
    FROM public.store_order_cart_info c WHERE c.oid=${id}`);
  return row;
}

export class AdminOrderPriceService {
  constructor(private readonly container: Container) {}

  changePrice(actor: AdminAuthorityActor, body: Record<string, unknown>) {
    const input = parseAdminOrderPriceInput(body);
    return withAdminAuthorityWriteTx(this.container, actor, 'order.manage', async tx => {
      const find = () => tx.select(orderColumns).from(storeOrder).where(and(eq(storeOrder.orderId, input.orderId),
        eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).orderBy(asc(storeOrder.id)).limit(2);
      const preliminary = await find();
      if (preliminary.length !== 1) throw new NotFoundException('订单不存在或编号不唯一');
      const rootId = preliminary[0].pid > 0 ? preliminary[0].pid : preliminary[0].id;
      await lockOrderSettlement(tx, rootId);
      const rows = await find().for('update', { noWait: true });
      if (rows.length !== 1 || rows[0].id !== preliminary[0].id || rows[0].pid !== preliminary[0].pid) throw conflict();
      const order = rows[0];
      if (order.paid !== 0) throw new ValidateException('订单已支付');
      if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw new ValidateException('扫码支付已发起，改价前请先人工对账');
      const next = computeAdminOrderPrice(order.payPrice, order.changePrice, input.priceCents);
      if (!next.changed) { await loadAdminAuthorityLiveActor(tx, actor, 'order.manage'); return { changed: false }; }
      await assertAdminOrderPriceOperationReady(tx);
      // The existing cart writer privilege permits a real phantom barrier.
      // Audit/outbox remain SELECT/INSERT-only and are proved again at the tail.
      await tx.execute(sql`LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT`);
      const cartsBefore = await cartState(tx, order.id);
      const statuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, order.id)).orderBy(asc(storeOrderStatus.id)).limit(1002);
      const outboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'),
        eq(storeOrderOutbox.aggregateId, order.id))).orderBy(asc(storeOrderOutbox.id)).limit(1002);
      if (statuses.length > 1001 || outboxes.length > 1001) throw new ValidateException('订单操作历史过长，请先核对');
      const previousStatus = [...statuses].reverse().find(row => row.changeType === 'order_edit')?.id ?? null;
      const priorEvent = [...outboxes].reverse().find(row => row.eventType === 'order.price.revision');
      let previousOperationId: string | null = null;
      if (priorEvent) {
        const payload = parseSupplierOrderPriceRevisionPayload(priorEvent.payload);
        if (payload.orderId !== order.id || priorEvent.eventKey !== `order.price.revision:${order.id}:${payload.operationId}`) throw conflict();
        const prior = await readUnpaidOrderEditOperation(tx, payload.operationId);
        if (prior.order_id !== order.id || prior.supplier_id !== order.supplierId || prior.evidence.status_id !== previousStatus
          || prior.result.order_id !== order.orderId || prior.result.pay_price !== order.payPrice
          || prior.result.change_price !== order.changePrice || prior.result.gain_integral !== order.gainIntegral) throw conflict();
        previousOperationId = payload.operationId;
      }
      const possibleCashier = await unpaidOrderCashierSourceKind(tx, order) !== null;
      let source: typeof storeOrder.$inferSelect | undefined, carts: typeof storeOrderCartInfo.$inferSelect[] = [];
      if (possibleCashier) {
        [source] = await tx.select().from(storeOrder).where(eq(storeOrder.id, order.id));
        carts = await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
        if (carts.length > 200 || carts.reduce((n, row) => n + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8_388_608) throw conflict();
        await assertUnpaidOrderCashierEditSource(tx, source, carts);
      }
      const operationId = crypto.randomUUID(), now = Math.floor(Date.now() / 1000), expectedOrder = { ...order, payPrice: next.payPrice, changePrice: next.changePrice };
      const result = { id: order.id, order_id: order.orderId, pay_price: next.payPrice, change_price: next.changePrice, gain_integral: order.gainIntegral, changed: true };
      const state = carts.length ? await legacyGainIntegralState(order, carts) : null;
      const lines = await Promise.all(carts.map(async row => {
        const hash = await gainEditSha256(row.cartInfo!), origin = await outRequestHash(row.cartInfo);
        const info = JSON.parse(row.cartInfo!) as Record<string, unknown>, points = String(info.gain_integral ?? '0');
        if (!/^(0|[1-9]\d{0,9})(\.00)?$/.test(points)) throw conflict();
        return { row_id: row.id, cart_id: row.cartId, product_id: row.productId, quantity: row.cartNum, is_gift: row.isGift,
          before_sha256: hash, after_sha256: hash, before_origin_hash: origin, after_origin_hash: origin,
          before_gain_integral: Number(points), after_gain_integral: Number(points) };
      }));
      const evidence = { version: 'admin-unpaid-price-v1', operation_id: operationId, source_format: 'price-only',
        source: { order_id: order.id, buyer_id: order.uid, supplier_id: order.supplierId },
        before_state_sha256: state?.hash ?? await gainEditSha256(JSON.stringify(cartsBefore)), after_state_sha256: state?.hash ?? await gainEditSha256(JSON.stringify(cartsBefore)),
        before_total: order.gainIntegral, after_total: order.gainIntegral, before_cash: { pay_price: order.payPrice, change_price: order.changePrice },
        before_status_id: previousStatus, previous_operation_id: previousOperationId, lines };
      const updated = await tx.update(storeOrder).set({ payPrice: next.payPrice, changePrice: next.changePrice })
        .where(and(eq(storeOrder.id, order.id), eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).returning({ id: storeOrder.id });
      if (updated.length !== 1 || updated[0].id !== order.id) throw conflict();
      const values = { oid: order.id, changeType: 'order_edit', changeMessage: `商品总价为：${order.payPrice} 修改实际支付金额为：${next.payPrice}`, changeTime: now };
      const [status] = await tx.insert(storeOrderStatus).values(values).returning();
      if (!status || !same(status, { id: status.id, ...values })) throw conflict();
      const outbox = await enqueueSupplierOrderPriceRevision(tx, { orderId: order.id, operationId }, now);
      const completeEvidence = { ...evidence, status_id: status.id };
      const beforeHash = await gainEditSha256(JSON.stringify({ order, carts: cartsBefore, statuses, outboxes }));
      const afterHash = await gainEditSha256(JSON.stringify({ order: expectedOrder, carts: cartsBefore, statuses: [...statuses, status], outboxes: [...outboxes, outbox] }));
      const requestHash = await gainEditSha256(JSON.stringify(input));
      await tx.execute(sql`INSERT INTO public.admin_order_price_operation_v1
        (operation_id,actor_id,supplier_id,order_id,request_hash,state,before_hash,after_hash,evidence,result,created_at)
        VALUES (${operationId}::uuid,${actor.id},${order.supplierId},${order.id},${requestHash},'committed',
          ${beforeHash},${afterHash},${JSON.stringify(completeEvidence)}::jsonb,${JSON.stringify(result)}::jsonb,${now})`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const finalRows = await find();
      const finalStatuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, order.id)).orderBy(asc(storeOrderStatus.id)).limit(1003);
      const finalOutboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, order.id))).orderBy(asc(storeOrderOutbox.id)).limit(1003);
      const receipt = await readUnpaidOrderEditOperation(tx, operationId);
      if (!same(finalRows, [expectedOrder]) || !same(await cartState(tx, order.id), cartsBefore)
        || !same(finalStatuses, [...statuses, status]) || !same(finalOutboxes, [...outboxes, outbox])
        || receipt.actor_id !== actor.id || receipt.order_id !== order.id || receipt.supplier_id !== order.supplierId
        || receipt.kind !== 'admin' || receipt.created_at !== now || receipt.request_hash !== requestHash
        || receipt.before_hash !== beforeHash || receipt.after_hash !== afterHash || !same(receipt.evidence, JSON.parse(JSON.stringify(completeEvidence)))
        || !same(receipt.result, JSON.parse(JSON.stringify(result)))) throw conflict();
      if (source) await assertUnpaidOrderCashierEditSource(tx, { ...source, payPrice: next.payPrice, changePrice: next.changePrice }, carts);
      if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw conflict();
      await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
      return { changed: true };
    });
  }
}
