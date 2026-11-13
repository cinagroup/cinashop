import { and, asc, eq, getTableColumns, sql, type SQLWrapper } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderRefund, storeOrderStatus } from '@/models/schema';
import { assertAdminOrderEditOperationReady } from '@/migrations/adminOrderEditOperation';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertOrderPromotionLedger } from '@/services/order/OrderPromotionLedgerSplit';
import { assertUnpaidOrderCashierEditSource, unpaidOrderCashierSourceKind } from '@/services/order/UnpaidOrderCashierSource';
import { readUnpaidOrderEditOperation } from '@/services/order/UnpaidOrderEditOperation';
import { gainEditSha256, legacyGainIntegralState, loadUnpaidOrderGainIntegralProof } from '@/services/order/UnpaidOrderGainIntegralProof';
import { planUnpaidOrderGainIntegralEdit } from '@/services/order/UnpaidOrderGainIntegralEdit';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { enqueueSupplierOrderPriceRevision, parseSupplierOrderPriceRevisionPayload } from '@/services/supplier/SupplierUnpaidOrderEditEffects';
import { supplierOrderEditCanonical } from '@/services/supplier/SupplierUnpaidOrderEditInput';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { assertAdminAuthoritySession, loadAdminAuthorityLiveActor, loadAdminAuthorityReadActor, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { computeAdminOrderPrice } from './AdminOrderPriceInput';
import { adminOrderEditId, adminOrderEditPoints, parseAdminOrderEditInput } from './AdminOrderEditInput';

const same = (a: unknown, b: unknown) => supplierOrderEditCanonical(a) === supplierOrderEditCanonical(b);
const conflict = () => new HttpApiException('订单、积分或操作记录已变化，请重新载入编辑表单', 409, 409);
const fingerprint = (column: SQLWrapper) => sql<string | null>`CASE WHEN ${column} IS NULL THEN NULL ELSE
  octet_length(${column})::text||':'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${column},'UTF8')),'hex') END`;
const columns = { ...getTableColumns(storeOrder), cartId: fingerprint(storeOrder.cartId), virtualInfo: fingerprint(storeOrder.virtualInfo),
  customForm: fingerprint(storeOrder.customForm), promotionsGive: fingerprint(storeOrder.promotionsGive), giveCoupon: fingerprint(storeOrder.giveCoupon),
  expressDump: fingerprint(storeOrder.expressDump), refundReasonWapImg: fingerprint(storeOrder.refundReasonWapImg) };
async function cartState(tx: DbClient, id: number) {
  const [row] = await tx.execute(sql`SELECT count(*)::text AS count,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(string_agg(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((to_jsonb(c)-'cart_info')::text,'UTF8')),'hex')||':'||
      CASE WHEN c.cart_info IS NULL THEN 'NULL' ELSE octet_length(c.cart_info)::text||':'||
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.cart_info,'UTF8')),'hex') END,'|' ORDER BY c.id),''),'UTF8')),'hex') AS hash
    FROM public.store_order_cart_info c WHERE c.oid=${id}`);
  return row;
}
type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
async function purchase(tx: DbClient, id: number): Promise<{ order: Order; carts: Cart[] }> {
  const [order] = await tx.select().from(storeOrder).where(and(eq(storeOrder.id, id), sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`));
  const carts = await tx.select().from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid, id),
    sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)<=65536`)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const count = await cartState(tx, id);
  if (!order || !carts.length || carts.length > 200 || String(carts.length) !== count.count
    || carts.some(row => row.uid !== order.uid) || carts.reduce((n, row) => n + new TextEncoder().encode(row.cartInfo ?? '').length, 0) > 8_388_608)
    throw new ValidateException('修改积分所需购买快照不完整或过大，请先核对');
  return { order, carts };
}
async function gainEligible(tx: DbClient, order: Order, carts: Cart[]) {
  if (order.paid !== 0 || order.status !== 0 || order.pid !== 0 || order.isDel !== 0 || order.isSystemDel !== 0
    || ![0, 2].includes(order.supplierAllocationStatus) || order.refundStatus !== 0 || order.refundType !== 0
    || order.refundPrice !== '0.00' || order.backIntegral !== '0.00'
    || carts.some(row => row.refundNum !== 0 || row.splitStatus !== 0 || row.splitSurplusNum !== row.cartNum || row.surplusNum !== row.cartNum || row.isWriteoff !== 0))
    throw new ValidateException('订单已支付、取消、拆分或售后，不能修改赠送积分');
  if ((await tx.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.pid, order.id)).limit(1)).length
    || (await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, order.id)).limit(1)).length)
    throw new ValidateException('订单已有拆分或售后记录，请先核对');
  await assertOrderPromotionLedger(tx, order, carts);
}

export class AdminOrderEditService {
  constructor(private readonly container: Container, private readonly appKey: string) {}
  private revision(actor: AdminAuthorityActor, order: unknown, carts: unknown) {
    if (!this.appKey) throw new ServiceUnavailableException('订单编辑签名尚未就绪');
    return createHmac('sha256', this.appKey).update('cinashop.admin-desktop-order-edit.revision.v1\0')
      .update(supplierOrderEditCanonical({ actor, order, carts })).digest('hex');
  }
  async form(value: unknown, actor: AdminAuthorityActor) {
    const id = adminOrderEditId(value); assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await loadAdminAuthorityReadActor(tx, actor, 'order.manage');
      const [order] = await tx.select(columns).from(storeOrder).where(eq(storeOrder.id, id));
      if (!order) throw new NotFoundException('订单不存在');
      const values = { order_id: order.orderId, total_price: order.totalPrice, total_postage: order.totalPostage,
        pay_postage: order.payPostage, pay_price: order.payPrice, gain_integral: order.gainIntegral };
      const rules = Object.entries(values).map(([field, value], index) => ({ field, value: index === 0 ? value : Number(value),
        title: ['订单编号', '商品总价', '原始邮费', '实际支付邮费', '实际支付金额', '赠送积分'][index],
        type: index === 0 ? 'input' : 'inputNumber', props: { ...(index > 0 ? { max: 9_999_999_999 } : {}), ...(index < 4 ? { disabled: true } : {}),
          ...(index === 1 || index === 2 || index === 4 ? { min: 0 } : {}), ...(index === 5 ? { precision: 0 } : {}) } }));
      await loadAdminAuthorityReadActor(tx, actor, 'order.manage');
      return { title: '修改订单', action: `/order/update/${id}`, method: 'PUT' as const, rules, values,
        revision: this.revision(actor, order, await cartState(tx, id)) };
    });
  }
  async save(value: unknown, body: Record<string, unknown>, actor: AdminAuthorityActor) {
    const id = adminOrderEditId(value), input = parseAdminOrderEditInput(body);
    return withAdminAuthorityWriteTx(this.container, actor, 'order.manage', async tx => {
      await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.store_order_refund,
        ONLY public.payment_reconciliation_case IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      const find = () => tx.select(columns).from(storeOrder).where(eq(storeOrder.id, id)).limit(1);
      const [preliminary] = await find(); if (!preliminary || preliminary.isDel !== 0 || preliminary.isSystemDel !== 0) throw new NotFoundException('订单不存在');
      await lockOrderSettlement(tx, preliminary.pid > 0 ? preliminary.pid : id);
      const [order] = await find().for('update', { noWait: true });
      if (!order || !same(order, preliminary)) throw conflict();
      if (order.paid !== 0) throw new ValidateException('订单已支付');
      if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw new ValidateException('支付已发起，修改前请先完成对账');
      if (order.orderId !== input.orderId || order.totalPrice !== input.totalPrice || order.totalPostage !== input.totalPostage || order.payPostage !== input.payPostage) throw conflict();
      const next = computeAdminOrderPrice(order.payPrice, order.changePrice, Number(BigInt(input.payPrice.replace('.', ''))));
      const gainChanged = order.gainIntegral !== input.gainIntegral, cartsBefore = await cartState(tx, id);
      if (!next.changed && !gainChanged) { await loadAdminAuthorityLiveActor(tx, actor, 'order.manage'); return { changed: false }; }
      if (input.revision !== undefined && !timingSafeEqual(new TextEncoder().encode(input.revision), new TextEncoder().encode(this.revision(actor, order, cartsBefore)))) throw conflict();
      await assertAdminOrderEditOperationReady(tx);
      const operationId = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
      const cashier = await unpaidOrderCashierSourceKind(tx, order) !== null;
      const source = gainChanged || cashier ? await purchase(tx, id) : null;
      if (source) await assertUnpaidOrderCashierEditSource(tx, source.order, source.carts);
      if (gainChanged) await gainEligible(tx, source!.order, source!.carts);
      const proof = gainChanged ? await loadUnpaidOrderGainIntegralProof(tx, source!.order, source!.carts) : null;
      const plan = gainChanged ? await planUnpaidOrderGainIntegralEdit(source!.order, source!.carts,
        { operationId, gainIntegral: adminOrderEditPoints(input.gainIntegral), realm: 'admin' }, proof) : null;
      const carts = source?.carts ?? [], expectedCarts = carts.map(row => ({ ...row, cartInfo: plan?.lines.find(line => line.rowId === row.id)?.afterCartInfo ?? row.cartInfo }));
      const expectedOrder = { ...order, payPrice: next.payPrice, changePrice: next.changePrice, gainIntegral: input.gainIntegral };
      const statuses = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id)).limit(1002);
      const outboxes = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id)).limit(1002);
      if (statuses.length > 1001 || outboxes.length > 1001) throw new ValidateException('订单操作历史过长，请先核对');
      const previousStatus = [...statuses].reverse().find(row => row.changeType === 'order_edit')?.id ?? null;
      const priorEvent = [...outboxes].reverse().find(row => row.eventType === 'order.price.revision');
      let previousOperationId: string | null = null;
      if (priorEvent) {
        const payload = parseSupplierOrderPriceRevisionPayload(priorEvent.payload), prior = await readUnpaidOrderEditOperation(tx, payload.operationId);
        if (payload.orderId !== id || priorEvent.eventKey !== `order.price.revision:${id}:${payload.operationId}` || prior.order_id !== id
          || prior.supplier_id !== order.supplierId || prior.evidence.status_id !== previousStatus || prior.result.order_id !== order.orderId
          || prior.result.pay_price !== order.payPrice || prior.result.change_price !== order.changePrice || prior.result.gain_integral !== order.gainIntegral) throw conflict();
        previousOperationId = payload.operationId;
      }
      const state = source ? await legacyGainIntegralState(order, carts) : null;
      const lines = plan?.evidence.lines ?? await Promise.all(carts.map(async row => {
        const hash = await gainEditSha256(row.cartInfo!), origin = await outRequestHash(row.cartInfo), info = JSON.parse(row.cartInfo!) as Record<string, unknown>;
        const points = String(info.gain_integral ?? '0'); if (!/^(0|[1-9]\d{0,9})(\.00)?$/.test(points)) throw conflict();
        return { row_id: row.id, cart_id: row.cartId, product_id: row.productId, quantity: row.cartNum, is_gift: row.isGift,
          before_sha256: hash, after_sha256: hash, before_origin_hash: origin, after_origin_hash: origin, before_gain_integral: Number(points), after_gain_integral: Number(points) };
      }));
      const evidence = { ...(plan?.evidence ?? { version: 'admin-unpaid-gain-edit-v1', operation_id: operationId, source_format: 'price-only',
        source: { order_id: id, buyer_id: order.uid, supplier_id: order.supplierId }, before_state_sha256: state?.hash ?? await gainEditSha256(JSON.stringify(cartsBefore)),
        after_state_sha256: state?.hash ?? await gainEditSha256(JSON.stringify(cartsBefore)), before_total: order.gainIntegral, after_total: order.gainIntegral, lines }),
        before_cash: { pay_price: order.payPrice, change_price: order.changePrice }, before_status_id: previousStatus, previous_operation_id: previousOperationId };
      for (const line of plan?.lines ?? []) if (line.afterCartInfo !== line.beforeCartInfo) {
        const saved = await tx.update(storeOrderCartInfo).set({ cartInfo: line.afterCartInfo }).where(and(eq(storeOrderCartInfo.id, line.rowId), eq(storeOrderCartInfo.oid, id), eq(storeOrderCartInfo.cartInfo, line.beforeCartInfo))).returning();
        if (!same(saved, [expectedCarts.find(row => row.id === line.rowId)])) throw conflict();
      }
      const updated = await tx.update(storeOrder).set({ payPrice: next.payPrice, changePrice: next.changePrice, gainIntegral: input.gainIntegral }).where(and(eq(storeOrder.id, id), eq(storeOrder.paid, 0))).returning({ id: storeOrder.id });
      if (!same(updated, [{ id }])) throw conflict();
      const values = { oid: id, changeType: 'order_edit', changeMessage: `商品总价为：${order.payPrice} 修改实际支付金额为：${next.payPrice}`, changeTime: now };
      const [status] = await tx.insert(storeOrderStatus).values(values).returning(); if (!status || !same(status, { id: status.id, ...values })) throw conflict();
      const outbox = await enqueueSupplierOrderPriceRevision(tx, { orderId: id, operationId }, now);
      const completeEvidence = { ...evidence, status_id: status.id }, result = { id, order_id: order.orderId, pay_price: next.payPrice, change_price: next.changePrice, gain_integral: input.gainIntegral, changed: true };
      const beforeHash = await gainEditSha256(JSON.stringify({ order, carts: cartsBefore, statuses, outboxes }));
      const afterHash = await gainEditSha256(JSON.stringify({ order: expectedOrder, carts: expectedCarts.length ? expectedCarts : cartsBefore, statuses: [...statuses, status], outboxes: [...outboxes, outbox] }));
      const requestHash = await gainEditSha256(supplierOrderEditCanonical({ id, actor, input }));
      await tx.execute(sql`INSERT INTO public.admin_order_edit_operation_v1
        (operation_id,actor_id,supplier_id,order_id,request_hash,state,before_hash,after_hash,evidence,result,created_at)
        VALUES (${operationId}::uuid,${actor.id},${order.supplierId},${id},${requestHash},'committed',${beforeHash},${afterHash},${JSON.stringify(completeEvidence)}::jsonb,${JSON.stringify(result)}::jsonb,${now})`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const finalCarts = carts.length ? await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(asc(storeOrderCartInfo.id)).limit(201) : null;
      const receipt = await readUnpaidOrderEditOperation(tx, operationId);
      if (!same(await find(), [expectedOrder]) || (finalCarts ? !same(finalCarts, expectedCarts) : !same(await cartState(tx, id), cartsBefore))
        || !same(await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)).orderBy(asc(storeOrderStatus.id)).limit(1003), [...statuses, status])
        || !same(await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType, 'order'), eq(storeOrderOutbox.aggregateId, id))).orderBy(asc(storeOrderOutbox.id)).limit(1003), [...outboxes, outbox])
        || receipt.kind !== 'admin-edit' || receipt.actor_id !== actor.id || receipt.supplier_id !== order.supplierId || receipt.order_id !== id
        || receipt.created_at !== now || receipt.request_hash !== requestHash || receipt.before_hash !== beforeHash || receipt.after_hash !== afterHash
        || !same(receipt.evidence, completeEvidence) || !same(receipt.result, result)) throw conflict();
      if (source) {
        const final = { ...source.order, payPrice: next.payPrice, changePrice: next.changePrice, gainIntegral: input.gainIntegral };
        await assertUnpaidOrderCashierEditSource(tx, final, expectedCarts);
        if (gainChanged) { await gainEligible(tx, final, expectedCarts); await loadUnpaidOrderGainIntegralProof(tx, final, expectedCarts); }
      }
      if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw conflict();
      await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
      return { changed: true };
    });
  }
}
