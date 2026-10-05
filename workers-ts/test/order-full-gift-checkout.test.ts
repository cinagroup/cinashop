import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { withFinancePeers } from './helpers/financePeers';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { AdminFullGiftService } from '../src/services/admin/AdminFullGiftService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { enqueueOrderPaidEvent, OrderOutboxService } from '../src/services/order/OrderOutboxService';
import type { OrderMessage } from '../src/env';
import { readOrderPromotionGiftIntent } from '../src/services/activity/OrderPromotionGiftSnapshot';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { runOrderPromotionGiftReceipt } from '../src/migrations/runOrderPromotionGiftReceipt';
import { inspectPurchaseCancellationEvidence,
  runPurchaseCancellationEvidenceSchema } from '../src/migrations/runPurchaseCancellationEvidence';
import { inspectPurchaseCancellationGiftEvidence,
  runPurchaseCancellationGiftEvidence } from '../src/migrations/runPurchaseCancellationGiftEvidence';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { agentLevel, luckLottery, orderWaybillJob, printDocument, storeCart, storeCouponIssue,
  storeCouponIssueUser, storeCouponUser, storeOrder, storeOrderCartInfo,
  storeOrderEconomize, storeOrderInvoice,
  storeOrderOutbox, storeOrderProductCouponReward, storeProductCoupon,
  storeOrderPromotionGiftCouponReward,
  storeOrderRefund, storeOrderRefundPayment, storeOrderStatus, storeProduct,
  storeProductAttrValue, storeProductCategory, supplierFlowingWater,
  supplierTransactions, systemLog, user, userBill, userBrokerage,
  userAddress, userLabel, userLabelRelation, storePromotionsAuxiliary } from '../src/models/schema';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const shanghai = (hours: number) => {
  const d = new Date(Date.now() + (hours + 8) * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const payload = () => ({ name: '满送实物券积分', section_time: [shanghai(-1), shanghai(24)],
  promotions_cate: 2, threshold_type: 1, promotions: [{ threshold: 10, give_integral: 3,
    give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
    give_product_id: [{ give_product_id: 71, unique: 'gift80', give_product_num: 10 }] }],
  is_label: 1, label_id: [31], product_partake_type: 2,
  product_id: [{ product_id: 70, unique: ['qared001'] },
    { product_id: 72, unique: ['paid0072'] }], brand_id: [], store_label_id: [],
  status: 1, sort: 0, request_id: crypto.randomUUID() });

describe('admin-created full gifts through confirmation and the real order lifecycle', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let rootId: number;
  let serial = 0;
  const params = { cartIds: [1], addressId: 11, shippingType: 1, useIntegral: false };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([printDocument, storeOrderStatus, storeCouponIssue,
      storeCouponIssueUser, storeCouponUser, userLabel, userLabelRelation, storeProductCategory, systemLog,
      ...(native ? [agentLevel, luckLottery, storeOrderInvoice, storeOrderOutbox, storeOrderRefund,
        storeOrderRefundPayment, orderWaybillJob, userBrokerage, supplierFlowingWater,
        supplierTransactions, storeOrderEconomize,
        storeOrderProductCouponReward, storeProductCoupon] : [])]);
    if (native) {
      await f.exec('CREATE INDEX soi_order ON store_order_invoice(order_id)');
      await f.exec('CREATE INDEX soi_uid_state_time ON store_order_invoice(uid,is_del,is_refund,add_time)');
      await f.exec('CREATE INDEX soi_issue_state_time ON store_order_invoice(is_pay,is_del,is_invoice,add_time)');
      await f.exec(REFUND_ORDER_SPLIT_SQL);
      await f.exec('CREATE UNIQUE INDEX full_gift_outbox_event ON store_order_outbox(event_key)');
      await f.exec('CREATE INDEX full_gift_status_oid ON store_order_status(oid)');
      await f.exec('CREATE INDEX full_gift_bill_category_type_link ON user_bill(category,type,link_id)');
      await runOrderPromotionGiftReceipt(f.db);
      const cancellationSource = await inspectPurchaseCancellationEvidence(f.db);
      expect(cancellationSource.sourcesReady).toBe(true);
      await runPurchaseCancellationEvidenceSchema(f.db);
      await runPurchaseCancellationGiftEvidence(f.db);
      expect((await inspectPurchaseCancellationGiftEvidence(f.db)).state).toBe('gift-v1');
    }
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ deliveryType: '1', price: '10.00', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '10.00', vipPrice: '9.00' });
    await f.db.update(storeCart).set({ cartNum: 2 });
    await f.db.insert(storeProduct).values({ id: 71, storeName: '订单实物赠品', stock: 20,
      image: '/gift.png', isShow: 1, isVerify: 1, deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values({ id: 71, productId: 71, type: 0,
      unique: 'gift80', suk: '礼盒', stock: 20 });
    await f.db.insert(storeProduct).values({ id: 72, storeName: '并发另一原价商品',
      stock: 8, price: '10.00', isShow: 1, isVerify: 1, isVip: 1,
      deliveryType: '1', freight: 1, tempId: 0, image: '/paid72.png' });
    await f.db.insert(storeProductAttrValue).values({ id: 72, productId: 72,
      type: 0, unique: 'paid0072', suk: '蓝色', stock: 8,
      price: '10.00', vipPrice: '9.00' });
    await f.db.insert(userLabel).values({ id: 31, name: '满送成交客户', type: 0,
      relationId: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 41, couponTitle: '满送优惠券',
      type: 1, couponPrice: '2.00', useMinPrice: '5.00', receiveType: 3,
      status: 1, remainCount: 20, totalCount: 20, day: 7 });
    rootId = (await new AdminFullGiftService(f.container).mutate('create', 0, payload(), { id: 9 })).id;
  }, 30_000);
  afterEach(async () => f?.close());

  const confirmFor = async (uid: number, request: typeof params) => {
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': String(uid) },
    body: JSON.stringify(request) }, f.env);
    const body = await response.json() as { status: number; msg: string; data: {
      orderKey: string; quoteToken: string; cartInfo: Array<Record<string, unknown>>;
      give_coupon: Array<Record<string, unknown>>; give_integral: number;
      promotions_detail: Array<Record<string, unknown>>; priceGroup: Record<string, string> } };
    expect(body.status, body.msg).toBe(200);
    return body.data;
  };
  const confirm = () => confirmFor(11, params);
  const createFor = (db: DbClient, uid: number, request: typeof params,
    receipt: { orderKey: string; quoteToken: string }) =>
    StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), {
      CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true,
      nextOrderId: async () => `full_gift_${++serial}` }, {
      ...request, uid, key: receipt.orderKey, quoteToken: receipt.quoteToken,
      userIp: '127.0.0.1' });
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    createFor(db, 11, params, receipt);
  const paid = async () => {
    const created = await create(f.db, await confirm());
    const now = Math.floor(Date.now() / 1000);
    const event = await withTx(f.container, async tx => {
      const [order] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: now })
        .where(eq(storeOrder.orderId, created.orderId)).returning();
      return enqueueOrderPaidEvent(tx, order, now);
    });
    const queue = { sendBatch: async () => ({ successful: 1 }), send: async () => {} };
    const service = new OrderOutboxService(f.container,
      { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
    expect(await service.processMessage({ action: 'processOrderPaidOutbox',
      outboxId: event.id, eventKey: event.eventKey })).toBe('completed');
    const [order] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.orderId, created.orderId));
    return order;
  };

  it('shows the zero-priced physical gift and frozen points/coupon before checkout writes', async () => {
    const receipt = await confirm();
    expect(receipt.cartInfo).toHaveLength(2);
    expect(receipt.cartInfo[0].isGift).not.toBe(1);
    expect(receipt.cartInfo[1]).toMatchObject({ isGift: 1, is_gift: 1,
      productId: 71, cartNum: 2, trueSumPrice: '0.00', promotions_id: rootId });
    expect((receipt.cartInfo[1].productInfo as { attrInfo: { unique: string } }).attrInfo.unique)
      .toBe('gift80');
    expect(String(receipt.cartInfo[1].id)).toMatch(/^\d+$/);
    expect(receipt.give_integral).toBe(6);
    expect(receipt.give_coupon).toMatchObject([{ id: 41, price: '2.00' }]);
    expect(receipt.promotions_detail).toMatchObject([{ id: rootId, repetitions: 2 }]);
    expect(receipt.priceGroup.pay_price).toBe('20.00');
    expect((await f.snapshot()).orders).toEqual([]);
  });

  it.runIf(native)('admits only one of two independently confirmed buyers when a shared gift runs out', async () => {
    await f.db.insert(user).values({ uid: 22, account: 'other-local-buyer',
      nickname: '另一买家', isEverLevel: 1, integral: 100 });
    await f.db.insert(userAddress).values({ id: 22, uid: 22, realName: '另一买家',
      phone: '00000000000', province: '本地省', city: '测试甲市', district: '测试甲区',
      cityId: 101, detail: '隔离样本二号', isDefault: 1 });
    await f.db.insert(storeCart).values({ id: 2, uid: 22, productId: 72,
      productAttrUnique: 'paid0072', cartNum: 2, isNew: 1, status: 1 });
    await f.db.update(storeProduct).set({ stock: 2 }).where(eq(storeProduct.id, 71));
    await f.db.update(storeProductAttrValue).set({ stock: 2 })
      .where(eq(storeProductAttrValue.id, 71));
    await f.db.update(storePromotionsAuxiliary).set({ limitNum: 2, surplusNum: 2 })
      .where(eq(storePromotionsAuxiliary.type, 3));

    const secondParams = { ...params, cartIds: [2], addressId: 22 };
    const firstReceipt = await confirmFor(11, params);
    const secondReceipt = await confirmFor(22, secondParams);
    expect(firstReceipt.cartInfo[1]).toMatchObject({ isGift: 1, productId: 71, cartNum: 2 });
    expect(secondReceipt.cartInfo[1]).toMatchObject({ isGift: 1, productId: 71, cartNum: 2 });
    expect(await f.db.select().from(storeOrder)).toHaveLength(0);

    // The peers prove two independent PG backends. Paid SKU and cart rows are
    // disjoint, while gift stock and its campaign pool cover only one order.
    const settled = await withFinancePeers(f.db, ([first, second]) => Promise.allSettled([
      createFor(first.db, 11, params, firstReceipt),
      createFor(second.db, 22, secondParams, secondReceipt),
    ]));
    const winners = settled.filter(result => result.status === 'fulfilled');
    const losers = settled.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toMatch(/满送赠品库存不足/);

    const [order] = await f.db.select().from(storeOrder);
    expect(order).toBeDefined();
    expect((await f.db.select().from(storeOrder))).toHaveLength(1);
    const winnerUid = order.uid;
    const loserUid = winnerUid === 11 ? 22 : 11;
    const carts = await f.db.select().from(storeCart);
    expect(carts.find(cart => cart.uid === winnerUid)?.isPay).toBe(1);
    expect(carts.find(cart => cart.uid === loserUid)?.isPay).toBe(0);
    const paidProducts = await f.db.select().from(storeProduct);
    expect(paidProducts.find(product => product.id === (winnerUid === 11 ? 70 : 72))?.stock).toBe(6);
    expect(paidProducts.find(product => product.id === (winnerUid === 11 ? 72 : 70))?.stock).toBe(8);
    expect(paidProducts.find(product => product.id === 71)?.stock).toBe(0);
    const skus = await f.db.select().from(storeProductAttrValue);
    expect(skus.find(sku => sku.id === (winnerUid === 11 ? 1 : 72))?.stock).toBe(6);
    expect(skus.find(sku => sku.id === (winnerUid === 11 ? 72 : 1))?.stock).toBe(8);
    expect(skus.find(sku => sku.id === 71)?.stock).toBe(0);
    const pools = await f.db.select().from(storePromotionsAuxiliary);
    expect(pools.find(pool => pool.type === 2)?.surplusNum).toBe(9);
    expect(pools.find(pool => pool.type === 3)?.surplusNum).toBe(0);
    expect((await f.db.select().from(storeCouponIssue)
      .where(eq(storeCouponIssue.id, 41)))[0].remainCount).toBe(19);
    expect(await f.db.select().from(storeOrderCartInfo)
      .orderBy(asc(storeOrderCartInfo.id))).toMatchObject([
      { oid: order.id, uid: winnerUid, isGift: 0, cartNum: 2 },
      { oid: order.id, uid: winnerUid, isGift: 1, productId: 71, cartNum: 2 },
    ]);
  });

  it.runIf(native)('reserves physical and campaign stock, then unpaid cancellation returns each once', async () => {
    const receipt = await confirm();
    const created = await create(f.db, receipt);
    const [order] = await f.db.select().from(storeOrder)
      .where(eq(storeOrder.orderId, created.orderId));
    const intent = readOrderPromotionGiftIntent(order.promotionsGive)!;
    const lines = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id));
    expect(order).toMatchObject({ totalNum: 4, giveIntegral: 6, giveCoupon: '41' });
    expect(order.cartId?.split(',')).toHaveLength(2);
    expect(lines).toMatchObject([{ isGift: 0, productId: 70, cartNum: 2,
      promotionsId: String(rootId) }, { isGift: 1, productId: 71, cartNum: 2,
      cartId: intent.promotions[0].products[0].cart_id }]);
    const [giftStock] = await f.db.select().from(storeProduct)
      .where(eq(storeProduct.id, 71));
    expect(giftStock.stock).toBe(18);
    expect((await f.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.id, 71)))[0].stock).toBe(18);
    const pools = await f.db.select().from(storePromotionsAuxiliary);
    expect(pools.find(row => row.type === 2)?.surplusNum).toBe(9);
    expect(pools.find(row => row.type === 3)?.surplusNum).toBe(8);
    await cancelStoreOrder(f.container, { uid: 11, orderId: created.orderId });
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: created.orderId })).rejects.toThrow();
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(20);
    expect((await f.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.id, 71)))[0].stock).toBe(20);
    const restored = await f.db.select().from(storePromotionsAuxiliary);
    expect(restored.find(row => row.type === 2)?.surplusNum).toBe(10);
    expect(restored.find(row => row.type === 3)?.surplusNum).toBe(10);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 41)))[0].remainCount).toBe(20);
  });

  it.runIf(native)('grants one owned coupon, exact points and labels after payment, preserving pool consumption', async () => {
    const order = await paid();
    expect(await f.db.select().from(storeOrderPromotionGiftCouponReward)).toMatchObject([{
      orderId: order.id, uid: 11, rootId, issueCouponId: 41 }]);
    expect(await f.db.select().from(storeCouponUser)).toMatchObject([{ uid: 11,
      issueCouponId: 41, couponPrice: '2.00', receiveSource: 'order' }]);
    expect((await f.db.select().from(userBill)).filter(row =>
      row.eventKey === 'order_promotions_give_integral')).toMatchObject([{
      number: '6.00', pm: 1, linkId: String(order.id) }]);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(106);
    expect(await f.db.select().from(userLabelRelation)).toMatchObject([{ uid: 11, labelId: 31 }]);
    const pools = await f.db.select().from(storePromotionsAuxiliary);
    expect(pools.find(row => row.type === 2)?.surplusNum).toBe(9);
    expect(pools.find(row => row.type === 3)?.surplusNum).toBe(8);
  });

  it.runIf(native)('runs the actual paid outbox once and replays its durable gift receipts', async () => {
    await f.db.insert(storeCouponIssue).values({ id: 42, couponTitle: '赠品不得触发的商品券',
      type: 1, couponPrice: '1.00', useMinPrice: '0.00', receiveType: 3,
      status: 1, remainCount: 10, totalCount: 10, day: 7 });
    await f.db.insert(storeProductCoupon).values({ productId: 71, issueCouponId: 42 });
    const created = await create(f.db, await confirm());
    const now = Math.floor(Date.now() / 1000);
    const event = await withTx(f.container, async tx => {
      const [order] = await tx.update(storeOrder)
        .set({ paid: 1, payType: 'offline', payTime: now })
        .where(eq(storeOrder.orderId, created.orderId)).returning();
      return enqueueOrderPaidEvent(tx, order, now);
    });
    const queue = { sendBatch: async () => ({ successful: 1 }), send: async () => {} };
    const service = new OrderOutboxService(f.container,
      { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
    const message = { action: 'processOrderPaidOutbox' as const,
      outboxId: event.id, eventKey: event.eventKey };
    expect(await service.processMessage(message)).toBe('completed');
    expect(await service.processMessage(message)).toBe('already-completed');
    expect(await f.db.select().from(storeOrderPromotionGiftCouponReward)).toHaveLength(1);
    expect(await f.db.select().from(storeCouponUser)).toHaveLength(1);
    expect(await f.db.select().from(storeOrderProductCouponReward)).toHaveLength(0);
    expect((await f.db.select().from(userBill)).filter(row =>
      row.eventKey === 'order_promotions_give_integral')).toHaveLength(1);
    expect(await f.db.select().from(userLabelRelation)).toMatchObject([{ uid: 11, labelId: 31 }]);
  });

  it.runIf(native)('refunds every purchased and gift unit through the atomic materialization path', async () => {
    const order = await paid();
    const carts = await f.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, order.id));
    const applied = await applyOrderRefundWithMaterialization(f.container, { uid: 11,
      orderId: order.orderId, applyType: 1,
      applicationOrderId: `full_gift_refund_${++serial}`,
      refundReason: 'Whole full-gift fixture refund', refundExplain: '',
      cartSelections: carts.map(cart => ({ cartId: Number(cart.cartId), cartNum: cart.cartNum })) });
    await finalizeStoreOrderRefund(f.container, applied.refundId);
    const [refunded] = await f.db.select().from(storeOrderRefund)
      .where(eq(storeOrderRefund.id, applied.refundId));
    expect(refunded.refundType).toBe(6);
    const [after] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id));
    expect(after.refundStatus).toBe(2);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(20);
    expect((await f.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.id, 71)))[0].stock).toBe(20);
    expect((await f.db.select().from(storeCouponUser)).length).toBe(1);
    expect((await f.db.select().from(storeOrderPromotionGiftCouponReward)).length).toBe(1);
    expect((await f.db.select().from(userBill)).filter(row =>
      row.eventKey === 'order_promotions_integral_refund')).toMatchObject([{
      number: '6.00', pm: 0, linkId: String(order.id) }]);
    await finalizeStoreOrderRefund(f.container, applied.refundId);
    expect((await f.db.select().from(userBill)).filter(row =>
      row.eventKey === 'order_promotions_integral_refund')).toHaveLength(1);
  });
});
