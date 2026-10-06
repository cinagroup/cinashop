import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { AdminNthDiscountService } from '../src/services/admin/AdminNthDiscountService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { materializeCompletedRefundOrder } from '../src/services/order/RefundOrderMaterialization';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { grantPaidPromotionLabels } from '../src/services/order/OrderRewardService';
import { planOrderFinancialSplit } from '../src/services/order/OrderSplitFinance';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { storeOrderRefundSplit } from '../src/models/schema/order_refund_split';
import { agentLevel, orderWaybillJob, printDocument, storeCart, storeCouponIssue, storeCouponUser,
  storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderOutbox, storeOrderPromotions,
  storeOrderRefund, storeOrderRefundPayment, storeOrderStatus, storeProduct, storeProductAttrValue,
  storeProductCategory, storePromotions, storePromotionsAuxiliary, supplierFlowingWater,
  supplierTransactions, systemLog, userBrokerage, userLabel, userLabelRelation } from '../src/models/schema';

const shanghai = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const adminPayload = () => ({ name: '第二件半价', section_time: [shanghai(-1), shanghai(24)],
  n_piece_n_discount: 1, threshold: 2, discount: 50,
  is_label: 1, label_id: [31], is_overlay: 1, overlay: [5],
  product_partake_type: 2, product_id: [{ product_id: 70, unique: ['qared001'] }],
  brand_id: [], store_label_id: [], status: 1, sort: 0, request_id: crypto.randomUUID() });
const cents = (value: unknown) => {
  const [yuan, fraction] = String(value).split('.');
  if (!/^(?:0|[1-9]\d*)$/.test(yuan) || !/^\d{2}$/.test(fraction ?? '')) {
    throw new Error(`Invalid test money: ${String(value)}`);
  }
  return Number(yuan) * 100 + Number(fraction);
};
const delivery = { deliveryType: 'express' as const, deliveryName: 'Local test shipping',
  deliveryCode: 'local', deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 };

describe('nth-piece discount through real admin creation, cart and checkout finance', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let rootId: number;
  let sequence = 0;
  const request = { cartIds: [1], addressId: 11, shippingType: 1, useIntegral: false };
  const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([printDocument, storeOrderStatus, storeOrderPromotions,
      storeCouponIssue, storeCouponUser, userLabel, userLabelRelation, storeProductCategory, systemLog,
      ...(native ? [agentLevel, storeOrderInvoice, storeOrderOutbox, storeOrderRefund,
        storeOrderRefundPayment, orderWaybillJob, userBrokerage, supplierFlowingWater,
        supplierTransactions] : [])]);
    if (native) {
      await f.exec(REFUND_ORDER_SPLIT_SQL);
      await f.exec('CREATE UNIQUE INDEX nth_discount_outbox_event ON store_order_outbox(event_key)');
    }
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ price: '19.99', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '19.99', vipPrice: '10.00' });
    await f.db.update(storeCart).set({ cartNum: 3 });
    await f.db.insert(userLabel).values({ id: 31, name: '第N件成交客户', type: 0, relationId: 0 });
    rootId = (await new AdminNthDiscountService(f.container)
      .mutate('create', 0, adminPayload(), { id: 9 })).id;
  }, 30_000);
  afterEach(async () => f?.close());

  const confirm = async (couponId?: number) => {
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11' },
    body: JSON.stringify({ ...request, couponId }) }, f.env);
    const body = await response.json() as { status: number; msg: string; data: { orderKey: string;
      quoteToken: string; cartInfo: Array<Record<string, unknown>>; priceGroup: Record<string, string> } };
    expect(body.status, body.msg).toBe(200);
    return body.data;
  };
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }, couponId?: number) =>
    StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { CONFIG_KV: f.env.CONFIG_KV,
      requireConfirmation: true, nextOrderId: async () => `nth_discount_${++sequence}` }, {
      ...request, uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken,
      couponId, userIp: '127.0.0.1' });
  const createPaidOrder = async () => {
    const created = await create(f.db, await confirm());
    const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' })
      .where(eq(storeOrder.orderId, created.orderId)).returning();
    if (!order) throw new Error('Expected paid nth-discount order');
    return order;
  };

  it('projects an admin-authored cheapest-item rule into the real cart and confirmation', async () => {
    const roots = await f.db.select().from(storePromotions).where(eq(storePromotions.id, rootId));
    const children = await f.db.select().from(storePromotions).where(eq(storePromotions.pid, rootId));
    const links = await f.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.promotionsId, rootId));
    expect(roots).toMatchObject([{ promotionsType: 2, promotionsCate: 1,
      thresholdType: 2, threshold: '2.00', discountType: 2,
      nPieceNDiscount: 1, discount: '50.00', productPartakeType: 2 }]);
    expect(children).toEqual([]);
    expect(links).toMatchObject([{ productPartakeType: 2, productId: 70, unique: 'qared001' }]);

    const [cart] = await new StoreCartService(f.container, f.env).list(11,
      { mode: 'buy', ids: [1] }) as Array<Record<string, unknown>>;
    expect(cart).toMatchObject({ trueSumPrice: '49.98', priceType: 'promotions', promotion: {
      totalPriceCents: 4998, promotionSavingsCents: 999,
      couponEligibleGrossCents: 4998, promotionIds: [rootId] } });
    const receipt = await confirm();
    expect(receipt.priceGroup).toMatchObject({ sumPrice: '59.97', totalPrice: '49.98',
      pay_price: '49.98', promotionsPrice: '9.99' });
    expect(receipt.cartInfo[0]).toMatchObject({ totalPriceCents: 4998, promotion: {
      promotionAllocations: [{ promotionId: rootId, savingsCents: 999, labelIds: [31] }] } });
    expect((await f.snapshot()).orders).toEqual([]);
  });

  it('honors the buy-one-get-one preset and coupon overlay without repeating at three pieces', async () => {
    const detail = (await new AdminNthDiscountService(f.container).detail(rootId)).info;
    await new AdminNthDiscountService(f.container).mutate('update', rootId, {
      ...adminPayload(), n_piece_n_discount: 2, threshold: 2, discount: 0,
      revision: detail.revision,
    }, { id: 9 });
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1,
      couponPrice: '1.00', useMinPrice: '10.00' });
    const receipt = await confirm(41);
    expect(receipt.priceGroup).toMatchObject({ totalPrice: '39.98', couponPrice: '1.00',
      pay_price: '38.98', promotionsPrice: '19.99' });
    expect(receipt.cartInfo[0]).toMatchObject({ promotion: {
      couponEligibleGrossCents: 3998, promotionIds: [rootId] } });
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('creates the exact ledger and grants configured labels only after payment', async () => {
    const receipt = await confirm();
    const created = await create(f.db, receipt);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(order).toMatchObject({ totalPrice: '49.98', payPrice: '49.98', promotionsPrice: '9.99' });
    expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ promotion_line_price: '49.98',
      promotion_line_savings: '9.99', promotion_discount_quantity: 0,
      promotion_line_member_savings: '0.00', sum_true_price: '49.98' });
    expect(await f.db.select().from(storeOrderPromotions)).toMatchObject([{
      oid: order.id, promotionsId: rootId, productId: 70, promotionsPrice: '9.99' }]);
    expect(await f.db.select().from(userLabelRelation)).toEqual([]);
    const plan = planOrderFinancialSplit(order, lines, new Map([[lines[0].cartId, 1]]));
    if (!plan) throw new Error('Expected selected financial split');
    expect(cents(plan.selected.totalPrice) + cents(plan.remaining.totalPrice)).toBe(4998);
    expect(cents(plan.selected.promotionsPrice) + cents(plan.remaining.promotionsPrice)).toBe(999);
    await withTx(f.container, async tx => {
      await tx.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, order.id));
      await grantPaidPromotionLabels(tx, { ...order, paid: 1 });
      await grantPaidPromotionLabels(tx, { ...order, paid: 1 });
    });
    expect(await f.db.select().from(userLabelRelation)).toMatchObject([{ uid: 11, labelId: 31 }]);
  });

  it.runIf(native)('materializes a real one-piece fulfillment split with exact type-2 child ledgers', async () => {
    const source = await createPaidOrder();
    const [sourceCart] = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, source.id));
    const plan = planOrderFinancialSplit(source, [sourceCart], new Map([[sourceCart.cartId, 1]]));
    if (!plan) throw new Error('Expected nth-discount finance plan');

    const result = await new SupplierFulfillmentService(f.container, f.env)
      .splitDelivery(0, source.id, delivery, [{ cartId: sourceCart.cartId, cartNum: 1 }]);
    expect(result).toMatchObject({ split: true });
    const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, source.id));
    const [selected] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, result.order_id));
    const [remaining] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.id, result.remaining_order_id!));
    expect(root.pid).toBe(-1);
    expect(selected).toMatchObject({ pid: source.id, totalNum: 1, status: 1,
      totalPrice: plan.selected.totalPrice, promotionsPrice: plan.selected.promotionsPrice });
    expect(remaining).toMatchObject({ pid: source.id, totalNum: 2, status: 0,
      totalPrice: plan.remaining.totalPrice, promotionsPrice: plan.remaining.promotionsPrice });
    expect(cents(selected.totalPrice) + cents(remaining.totalPrice)).toBe(4998);
    expect(cents(selected.promotionsPrice) + cents(remaining.promotionsPrice)).toBe(999);
    expect(cents(selected.payPrice) + cents(remaining.payPrice)).toBe(4998);

    const childCarts = await f.db.select().from(storeOrderCartInfo);
    for (const [child, quantity] of [[selected, 1], [remaining, 2]] as const) {
      const [cart] = childCarts.filter(row => row.oid === child.id);
      expect(cart).toMatchObject({ productId: 70, cartNum: quantity,
        promotionsId: String(rootId) });
      const snapshot = JSON.parse(cart.cartInfo!);
      expect(snapshot).toMatchObject({ promotion_quote_version: 'order-promotion-quote-v1',
        promotion_line_price: child.totalPrice, promotion_line_savings: child.promotionsPrice,
        promotion_discount_quantity: 0 });
      expect(snapshot.promotion_allocations).toMatchObject([{
        promotionId: rootId, savingsCents: cents(child.promotionsPrice), type: 2 }]);
      expect(snapshot.promotion_segments.reduce((sum: number, segment: { quantity: number }) =>
        sum + segment.quantity, 0)).toBe(quantity);
    }
    const ledgers = await f.db.select().from(storeOrderPromotions);
    for (const child of [selected, remaining]) {
      expect(ledgers.filter(row => row.oid === child.id)).toMatchObject([{
        promotionsId: rootId, productId: 70, promotionsPrice: child.promotionsPrice }]);
    }
    expect(ledgers.filter(row => row.oid === source.id)).toMatchObject([{
      promotionsId: rootId, promotionsPrice: '9.99' }]);
  });

  it.runIf(native)('materializes completed partial refunds into exact type-2 generation ledgers', async () => {
    const source = await createPaidOrder();
    const [sourceCart] = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, source.id));
    const applied = await applyOrderRefund(f.container, { uid: 11, orderId: source.orderId,
      applyType: 1, applicationOrderId: `nth_discount_refund_${++sequence}`,
      refundReason: 'Local nth-discount materialization', refundExplain: '',
      cartSelections: [{ cartId: Number(sourceCart.cartId), cartNum: 1 }] });
    await finalizeStoreOrderRefund(f.container, applied.refundId);
    const [refund] = await f.db.select().from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, applied.refundId));
    expect(refund.refundedPrice).toBe('16.66');
    const result = await withTx(f.container, tx => materializeCompletedRefundOrder(
      tx, refund, Math.floor(Date.now() / 1000)));
    expect(result).toMatchObject({ disposition: 'split', sourceOrderId: source.id,
      paymentOrderId: source.id, replayed: false });
    const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, source.id));
    const [selected] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.id, result.selectedOrderId));
    const [remaining] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.id, result.remainingOrderId!));
    expect(root.pid).toBe(-1);
    expect(selected).toMatchObject({ pid: source.id, totalNum: 1, refundStatus: 2,
      refundType: 6, promotionsPrice: expect.any(String) });
    expect(remaining).toMatchObject({ pid: source.id, totalNum: 2, refundStatus: 0,
      promotionsPrice: expect.any(String) });
    expect(cents(selected.promotionsPrice) + cents(remaining.promotionsPrice)).toBe(999);
    expect(cents(selected.totalPrice) + cents(remaining.totalPrice)).toBe(4998);

    const carts = await f.db.select().from(storeOrderCartInfo);
    const ledgers = await f.db.select().from(storeOrderPromotions);
    for (const [child, quantity] of [[selected, 1], [remaining, 2]] as const) {
      const [cart] = carts.filter(row => row.oid === child.id);
      expect(cart).toMatchObject({ cartNum: quantity, productId: 70 });
      const snapshot = JSON.parse(cart.cartInfo!);
      expect(snapshot).toMatchObject({ financial_version: 'refund-order-line-finance-v1',
        promotion_quote_version: 'order-promotion-quote-v1',
        promotion_line_price: child.totalPrice, promotion_line_savings: child.promotionsPrice });
      expect(ledgers.filter(row => row.oid === child.id)).toMatchObject([{
        promotionsId: rootId, productId: 70, promotionsPrice: child.promotionsPrice }]);
    }
    expect(await f.db.select().from(storeOrderRefundSplit)).toMatchObject([{
      refundId: refund.id, selectedOrderId: selected.id, remainingOrderId: remaining.id }]);

    const [secondCart] = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, remaining.id));
    const secondApplied = await applyOrderRefund(f.container, { uid: 11, orderId: remaining.orderId,
      applyType: 1, applicationOrderId: `nth_discount_refund_${++sequence}`,
      refundReason: 'Second local nth-discount refund', refundExplain: '',
      cartSelections: [{ cartId: Number(secondCart.cartId), cartNum: 1 }] });
    await finalizeStoreOrderRefund(f.container, secondApplied.refundId);
    const [secondRefund] = await f.db.select().from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, secondApplied.refundId));
    expect(secondRefund.refundedPrice).toBe('16.66');
    const secondResult = await withTx(f.container, tx => materializeCompletedRefundOrder(
      tx, secondRefund, Math.floor(Date.now() / 1000)));
    expect(secondResult).toMatchObject({ disposition: 'split', sourceOrderId: remaining.id,
      remainingOrderId: remaining.id, replayed: false });
    const [secondSelected] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.id, secondResult.selectedOrderId));
    const [lastActive] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.id, remaining.id));
    expect([selected, secondSelected, lastActive].map(row => row.totalNum)).toEqual([1, 1, 1]);
    expect([selected, secondSelected, lastActive].reduce((sum, row) => sum + cents(row.totalPrice), 0)).toBe(4998);
    expect([selected, secondSelected, lastActive].reduce((sum, row) => sum + cents(row.promotionsPrice), 0)).toBe(999);
    const afterSecond = await f.db.select().from(storeOrderPromotions);
    for (const child of [selected, secondSelected, lastActive]) {
      expect(afterSecond.filter(row => row.oid === child.id)).toMatchObject([{
        promotionsId: rootId, productId: 70, promotionsPrice: child.promotionsPrice }]);
    }

    const [lastCart] = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, remaining.id));
    const thirdApplied = await applyOrderRefund(f.container, { uid: 11, orderId: remaining.orderId,
      applyType: 1, applicationOrderId: `nth_discount_refund_${++sequence}`,
      refundReason: 'Final local nth-discount refund', refundExplain: '',
      cartSelections: [{ cartId: Number(lastCart.cartId), cartNum: 1 }] });
    await finalizeStoreOrderRefund(f.container, thirdApplied.refundId);
    const [thirdRefund] = await f.db.select().from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, thirdApplied.refundId));
    expect(thirdRefund.refundedPrice).toBe('16.66');
    const thirdResult = await withTx(f.container, tx => materializeCompletedRefundOrder(
      tx, thirdRefund, Math.floor(Date.now() / 1000)));
    expect(thirdResult).toMatchObject({ disposition: 'whole', sourceOrderId: remaining.id,
      selectedOrderId: remaining.id, remainingOrderId: null, replayed: false });
    expect([refund, secondRefund, thirdRefund].reduce((sum, row) =>
      sum + cents(row.refundedPrice), 0)).toBe(4998);
    expect(await f.db.select().from(storeOrderRefundSplit)).toHaveLength(3);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('reconfirms after a changed admin status', async () => {
    const receipt = await confirm(), before = await f.snapshot();
    const service = new AdminNthDiscountService(f.container);
    const detail = (await service.detail(rootId)).info;
    await service.mutate('status', rootId, { status: 0, revision: detail.revision,
      request_id: crypto.randomUUID() }, { id: 9 });
    await expect(create(f.db, receipt)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
    expect(await f.snapshot()).toEqual(before);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('waits for the shared catalog writer before re-quote', async () => {
    const receipt = await confirm(), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      await writer.exec('BEGIN');
      await writer.db.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext('time_discount_catalog'), hashtext('platform_type_1'))`);
      await writer.db.update(storePromotions).set({ discount: '80.00' })
        .where(eq(storePromotions.id, rootId));
      const buying = outcome(create(buyer.db, receipt));
      await waitForFinanceBlock(f.db, buyer.pid, writer.pid);
      await writer.exec('COMMIT');
      const result = await buying;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    expect(await f.snapshot()).toEqual(before);
  }, 15_000);
});
