import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { integralBatchActor, integralBatchFixture } from './helpers/integralBatchFixture';
import { outcome, withFinancePeers, waitForFinanceBlock } from './helpers/financePeers';
import { ActivityService } from '../src/services/activity/ActivityService';
import { adminActivityStatus } from '../src/controllers/api/v1/AdminCrudController';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService, cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import type { OrderMessage } from '../src/env';
import { storeCart, storeIntegral, storeOrder, storeOrderCartInfo, storeOrderOutbox,
  storeOrderRefund, storeProduct, storeProductAttrValue, user, userBill } from '../src/models/schema';

const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));

native('integral bulk replay on independent native PostgreSQL backends', () => {
  let f: Awaited<ReturnType<typeof integralBatchFixture>>;
  beforeEach(async () => { f = await integralBatchFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  it('serializes an identical cross-connection UUID into one complete two-product graph', async () => {
    const input = await f.input();
    const results = await withFinancePeers(f.db, async ([first, second, blocker]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731671,1)');
      const one = outcome(f.serviceFor(first.db).create(input, integralBatchActor));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const two = outcome(f.serviceFor(second.db).create(input, integralBatchActor));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec('COMMIT');
      const outcomes = await Promise.all([one, two]);
      for (const result of outcomes) if (!result.ok) throw result.error;
      return outcomes.map(result => result.ok ? result.value : undefined);
    });
    expect(results[1]).toEqual(results[0]);
    const state = await f.snapshot();
    expect(state.integrals).toHaveLength(2);
    expect(state.skus.filter(s => s.type === 4)).toHaveLength(3);
    expect(state.logs).toHaveLength(3);
    expect(await f.serviceFor().receipt(input.request_id, integralBatchActor)).toEqual(results[0]);
  });

  it('refuses a cross-actor collision on the same UUID without a second graph', async () => {
    const input = await f.input();
    const results = await withFinancePeers(f.db, ([first, second]) => Promise.all([
      outcome(f.serviceFor(first.db).create(input, integralBatchActor)),
      outcome(f.serviceFor(second.db).create(input, { id: 8 })),
    ]));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toHaveLength(1);
    expect((await f.snapshot()).integrals).toHaveLength(2);
    expect((await f.snapshot()).logs).toHaveLength(3);
  });

  it('refuses a source-SKU lock held by an independent stock writer with no partial graph', async () => {
    const input = await f.input(), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, admin]) => {
      await writer.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=82 FOR UPDATE');
      try { expect((await outcome(f.serviceFor(admin.db).create(input, integralBatchActor))).ok).toBe(false); }
      finally { await writer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual(before);
    expect((await f.serviceFor().create(input, integralBatchActor)).count).toBe(2);
  });
});

/** Uses actual bulk creation -> activity SKU lookup -> cart add -> HTTP quote ->
 * immutable order snapshots -> payment/outbox/refund services. Only UID, KV and
 * local Queue are synthetic; no externally confirmed provider claim is made. */
native('bulk-created integral graphs through real type-4 consumers', () => {
  let f: Awaited<ReturnType<typeof integralBatchFixture>>;
  let sequence = 0;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden in integral consumer fixture'));
    f = await integralBatchFixture(true); sequence = 0;
    f.checkout!.app.post('/api/admin/activity/status', adminActivityStatus);
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  async function setVirtualSource(productType: 1 | 2) {
    await f.db.update(storeProduct).set({ productType, freight: 1, postage: '0.00', tempId: 0 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ productType,
      diskInfo: productType === 1 ? 'test-owned-immutable-virtual-delivery' : '' })
      .where(and(eq(storeProductAttrValue.productId, 70), eq(storeProductAttrValue.type, 0)));
  }

  async function consumerState() {
    return { graph: await f.snapshot(), users: await f.db.select().from(user),
      carts: await f.db.select().from(storeCart), orders: await f.db.select().from(storeOrder),
      lines: await f.db.select().from(storeOrderCartInfo), outbox: await f.db.select().from(storeOrderOutbox),
      bills: await f.db.select().from(userBill) };
  }

  async function createIntegralOrder(show = 1, productType?: 1 | 2, enableBeforeCheckout = false) {
    if (productType) await setVirtualSource(productType);
    const input = await f.input([70]); input.is_show = show;
    if (productType) input.products[0].skus.find(row => row.base_unique === 'base0070')!.price = '0.00';
    const created = await f.serviceFor().create(input, integralBatchActor);
    const integralId = created.products[0].integral_id;
    const sku = (await f.db.select().from(storeProductAttrValue)).find(row => row.productId === integralId && row.type === 4 && row.suk === '蓝')!;
    expect(sku).toBeDefined();
    if (enableBeforeCheckout) {
      expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, integralId)))[0]).toMatchObject({ status: 0, isShow: 0 });
      const enabled = await f.checkout!.app.request('/api/admin/activity/status', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'integral', id: integralId, status: 1 }) }, f.env);
      expect((await enabled.json<{ status: number; msg: string }>()).status).toBe(200);
      expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, integralId)))[0]).toMatchObject({ status: 1, isShow: 1 });
    }
    const cart = await new StoreCartService(f.container, f.env).add({ uid: 11,
      productId: 70, type: 4, activityId: integralId, unique: sku.unique, cartNum: 2, isNew: 1 });
    const [persistedCart] = await f.db.select().from(storeCart).where(eq(storeCart.id, cart.id));
    expect(persistedCart).toMatchObject({ productId: 70, productAttrUnique: 'blue0070', type: 4, activityId: integralId, cartNum: 2 });
    const params = { cartIds: [cart.id], addressId: 11, shippingType: 1, type: 4, useIntegral: false };
    const quoteResponse = await f.checkout!.app.request('/api/order/confirm', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(params) }, f.env);
    const quote = await quoteResponse.json<{ status: number; msg: string; data: any }>();
    expect(quote.status, quote.msg).toBe(200);
    expect(quote.data.priceGroup).toMatchObject({ pay_integral: 20 });
    expect(quote.data.priceGroup.pay_price).toBe('8.50');
    const beforeOrder = await f.snapshot();
    const orderResult = await StoreOrderCreateService.createWithRuntime(f.container,
      { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, nextOrderId: async () => `integral_batch_order_${++sequence}` },
      { ...params, uid: 11, key: quote.data.orderKey, quoteToken: quote.data.quoteToken, userIp: '127.0.0.1' });
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderResult.orderId));
    expect(order).toMatchObject({ type: 4, activityId: integralId, paid: 0, payIntegral: 20, payPrice: '8.50', totalNum: 2 });
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(line).toMatchObject({ productId: 70, skuUnique: 'blue0070', cartNum: 2 });
    const lineJson = JSON.parse(line.cartInfo!);
    expect(lineJson).toMatchObject({ integral: 10, product: { id: 70, activityId: integralId },
      sku: { id: 81, unique: 'blue0070' }, activitySku: { id: sku.id, unique: sku.unique, integral: 10, price: '4.25' } });
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0])
      .toMatchObject({ integral: 100, nowMoney: '100.00' });
    const reserved = await f.snapshot();
    expect(reserved.products.find(row => row.id === 70)?.stock).toBe(18);
    expect(reserved.skus.find(row => row.type === 0 && row.unique === 'blue0070')?.stock).toBe(10);
    expect(reserved.skus.find(row => row.id === sku.id)).toMatchObject({ stock: 10, quota: 6 });
    expect(reserved.integrals.find(row => row.id === integralId)).toMatchObject({ stock: 18, quota: 11 });
    return { order, integralId, sku, beforeOrder, reserved };
  }

  it('uses the selected cloned SKU cash and points rather than the root minimum and restores an unpaid cancellation once', async () => {
    const { order, sku, integralId, beforeOrder } = await createIntegralOrder();
    expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, integralId)))[0])
      .toMatchObject({ integral: 5, price: '9.00' });
    await cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId });
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId })).rejects.toThrow();
    const restored = await f.snapshot();
    expect(restored.products).toEqual(beforeOrder.products);
    expect(restored.skus.find(row => row.id === sku.id)).toEqual(beforeOrder.skus.find(row => row.id === sku.id));
    expect(restored.integrals.find(row => row.id === integralId)).toEqual(beforeOrder.integrals.find(row => row.id === integralId));
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100, nowMoney: '100.00' });
    expect((await f.db.select().from(userBill))).toEqual([]);
  });

  it('debits actual payment cash and cloned SKU points, then refunds both and all source/activity stock exactly once', async () => {
    const { order, beforeOrder, sku, integralId } = await createIntegralOrder();
    const paid = await applyStoreOrderBalancePayment(f.container, { uid: 11, orderId: order.orderId });
    expect(paid.outcome).toBe('paid'); expect(paid.outbox).toBeDefined();
    const queue = { send: async () => {}, sendBatch: async () => ({ successful: 1 }) };
    const outbox = new OrderOutboxService(f.container, { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
    const message = { action: 'processOrderPaidOutbox' as const, outboxId: paid.outbox!.id, eventKey: paid.outbox!.eventKey };
    expect(await outbox.processMessage(message)).toBe('completed');
    expect(await outbox.processMessage(message)).toBe('already-completed');
    expect((await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, paid.outbox!.id)))[0].status).toBe('COMPLETED');
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0])
      .toMatchObject({ nowMoney: '91.50', integral: 80 });
    expect((await f.db.select().from(userBill)).filter(row => row.type === 'storeIntegral_use_integral'))
      .toMatchObject([{ pm: 0, number: '20.00', linkId: String(order.id) }]);
    expect((await applyStoreOrderBalancePayment(f.container, { uid: 11, orderId: order.orderId })).outcome).toBe('already-paid');
    const application = await applyOrderRefund(f.container, { uid: 11, orderId: order.orderId,
      applyType: 1, refundReason: '本机积分商品整单退款', refundExplain: '', applicationOrderId: 'integral_batch_refund' });
    expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
    const after = await f.snapshot();
    expect(after.products).toEqual(beforeOrder.products);
    expect(after.skus.find(row => row.id === sku.id)).toEqual(beforeOrder.skus.find(row => row.id === sku.id));
    expect(after.integrals.find(row => row.id === integralId)).toEqual(beforeOrder.integrals.find(row => row.id === integralId));
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ nowMoney: '100.00', integral: 100 });
    const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId));
    expect(refund).toMatchObject({ refundType: 6, refundNum: 2, refundPrice: '8.50', refundedPrice: '8.50' });
    const bills = await f.db.select().from(userBill);
    // PHP regressionIntegral distinguishes required redemption points from
    // optional checkout deductions: payIntegral uses order_integral_refund.
    const returned = bills.filter(row => row.type === 'order_integral_refund');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ uid: 11, pm: 1, category: 'integral',
      eventKey: 'order_integral_refund', number: '20.00', balance: '100.00', linkId: String(order.id), status: 1 });
    expect(bills.filter(row => row.type === 'pay_product_integral_back')).toHaveLength(0);
    expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('already-completed');
    expect(await f.db.select().from(userBill)).toEqual(bills);
    expect(await f.snapshot()).toEqual(after);
  });

  it('preserves source stock when a bulk-created hidden activity is refused by the real cart consumer', async () => {
    const input = await f.input([70]); input.is_show = 0;
    const result = await f.serviceFor().create(input, integralBatchActor), before = await f.snapshot();
    const sku = before.skus.find(row => row.type === 4 && row.productId === result.products[0].integral_id && row.suk === '蓝')!;
    await expect(new StoreCartService(f.container, f.env).add({ uid: 11, type: 4,
      productId: 70, activityId: result.products[0].integral_id, unique: sku.unique, cartNum: 1, isNew: 1 })).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.db.select().from(storeOrder)).toEqual([]);
  });

  it('activates a hidden bulk graph through the actual Admin integral status controller before real checkout and cancellation', async () => {
    const { order, beforeOrder } = await createIntegralOrder(0, undefined, true);
    await cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId });
    const after = await f.snapshot();
    expect(after.products).toEqual(beforeOrder.products);
    expect(after.skus).toEqual(beforeOrder.skus);
    expect(after.integrals).toEqual(beforeOrder.integrals);
  });

  it.each([1, 2] as const)('charges the selected higher-point virtual type-%s SKU through direct exchange and restores both inventory layers on refund once', async productType => {
    await setVirtualSource(productType);
    const input = await f.input([70]);
    for (const selected of input.products[0].skus) selected.price = '0.00';
    const created = await f.serviceFor().create(input, integralBatchActor);
    const integralId = created.products[0].integral_id;
    const high = (await f.db.select().from(storeProductAttrValue)).find(row => row.type === 4 && row.productId === integralId && row.suk === '蓝')!;
    const before = await f.snapshot(), cartsBefore = await f.db.select().from(storeCart), activity = new ActivityService(f.container, f.env);
    expect(before.integrals.find(row => row.id === integralId)).toMatchObject({ integral: 5, price: '0.00', productType });
    const key = crypto.randomUUID(), result = await activity.exchange(11, integralId, 2, high.unique, key);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, result.orderId));
    expect(order).toMatchObject({ type: 4, activityId: integralId, paid: 1, payType: 'integral',
      productType, payIntegral: 20, payPrice: '0.00', totalNum: 2 });
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 80, nowMoney: '100.00' });
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(line).toMatchObject({ productId: 70, productType, skuUnique: 'blue0070', cartNum: 2 });
    expect(Number(line.cartId)).toBeGreaterThan(0);
    expect(JSON.parse(line.cartInfo!)).toMatchObject({ integral: 10,
      product: { id: 70, activityId: integralId, integral: 10 },
      sku: { id: 81, unique: 'blue0070' }, activitySku: { id: high.id, unique: high.unique, integral: 10, price: '0.00' } });
    const reserved = await f.snapshot();
    expect(reserved.products.find(row => row.id === 70)).toMatchObject({ stock: 18, sales: 2 });
    expect(reserved.skus.find(row => row.id === 81)).toMatchObject({ stock: 10, sales: 2 });
    expect(reserved.skus.find(row => row.id === high.id)).toMatchObject({ stock: 10, quota: 6, sales: 2 });
    expect(reserved.integrals.find(row => row.id === integralId)).toMatchObject({ stock: 18, quota: 11, sales: 2 });
    const committed = await consumerState();
    // The direct line can have the same positive numeric id as an unrelated
    // real cart. Its immutable line identity must never mutate that cart.
    expect(line.cartId).toBe('1');
    expect(cartsBefore.some(cart => String(cart.id) === line.cartId)).toBe(true);
    expect(committed.carts).toEqual(cartsBefore);
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId })).rejects.toThrow();
    expect(await consumerState()).toEqual(committed);
    expect(await activity.exchange(11, integralId, 2, high.unique, key)).toEqual(result);
    expect(await consumerState()).toEqual(committed);
    const refund = await applyOrderRefund(f.container, { uid: 11, orderId: order.orderId,
      applyType: 1, refundReason: '本机虚拟积分规格退款', refundExplain: '', applicationOrderId: `virtual_batch_refund_${productType}` });
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('completed');
    const restored = await f.snapshot();
    expect(restored.products).toEqual(before.products);
    expect(restored.skus).toEqual(before.skus);
    expect(restored.integrals).toEqual(before.integrals);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100, nowMoney: '100.00' });
    const refunded = await consumerState();
    expect(refunded.carts).toEqual(cartsBefore);
    const returned = refunded.bills.filter(row => row.type === 'order_integral_refund');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ uid: 11, pm: 1, category: 'integral',
      eventKey: 'order_integral_refund', number: '20.00', balance: '100.00', linkId: String(order.id), status: 1 });
    expect(refunded.bills.filter(row => row.type === 'pay_product_integral_back')).toHaveLength(0);
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('already-completed');
    expect(await consumerState()).toEqual(refunded);
  });

  it.each([1, 2] as const)('refuses a cash-bearing selected virtual type-%s SKU on direct exchange even when the root minimum has zero cash', async productType => {
    await setVirtualSource(productType);
    const input = await f.input([70]);
    input.products[0].skus.find(row => row.base_unique === 'base0070')!.price = '0.00';
    const created = await f.serviceFor().create(input, integralBatchActor), integralId = created.products[0].integral_id;
    const high = (await f.db.select().from(storeProductAttrValue)).find(row => row.type === 4 && row.productId === integralId && row.suk === '蓝')!;
    expect((await f.snapshot()).integrals.find(row => row.id === integralId)).toMatchObject({ price: '0.00', integral: 5 });
    expect(high).toMatchObject({ price: '4.25', integral: 10 });
    const before = await consumerState();
    await expect(new ActivityService(f.container, f.env).exchange(11, integralId, 2, high.unique, crypto.randomUUID())).rejects.toThrow();
    expect(await consumerState()).toEqual(before);
  });

  it('binds a committed direct-exchange request key to the original quantity and immutable base/activity SKU pair', async () => {
    await setVirtualSource(1);
    const input = await f.input([70]);
    for (const sku of input.products[0].skus) sku.price = '0.00';
    const created = await f.serviceFor().create(input, integralBatchActor), integralId = created.products[0].integral_id;
    const values = await f.db.select().from(storeProductAttrValue);
    const high = values.find(row => row.type === 4 && row.productId === integralId && row.suk === '蓝')!;
    const low = values.find(row => row.type === 4 && row.productId === integralId && row.suk === '红')!;
    const activity = new ActivityService(f.container, f.env), key = crypto.randomUUID();
    const result = await activity.exchange(11, integralId, 2, high.unique, key);
    const committed = await consumerState(), order = committed.orders.find(row => row.orderId === result.orderId)!;
    expect(order).toMatchObject({ totalNum: 2, payIntegral: 20, paid: 1 });
    expect(committed.users.find(row => row.uid === 11)).toMatchObject({ integral: 80 });
    expect(committed.bills.filter(row => row.type === 'storeIntegral_use_integral')).toMatchObject([
      { uid: 11, pm: 0, number: '20.00', linkId: String(order.id) }]);
    for (const changed of [{ quantity: 1, unique: high.unique }, { quantity: 2, unique: low.unique },
      { quantity: 2, unique: 'base0070' }]) {
      await expect(activity.exchange(11, integralId, changed.quantity, changed.unique, key)).rejects.toThrow();
      expect(await consumerState()).toEqual(committed);
    }
    // The same persisted pair has two legitimate historical API identities.
    expect(await activity.exchange(11, integralId, 2, 'blue0070', key)).toEqual(result);
    expect(await activity.exchange(11, integralId, 2, high.unique, key)).toEqual(result);
    expect(await consumerState()).toEqual(committed);
  });

  it.each([1, 2] as const)('uses the selected virtual type-%s cash and points in real unified checkout and restores both stock layers on cancellation', async productType => {
    const { order, beforeOrder } = await createIntegralOrder(1, productType);
    expect(order).toMatchObject({ productType, payIntegral: 20, payPrice: '8.50', paid: 0 });
    await cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId });
    const restored = await f.snapshot();
    expect(restored.products).toEqual(beforeOrder.products);
    expect(restored.skus).toEqual(beforeOrder.skus);
    expect(restored.integrals).toEqual(beforeOrder.integrals);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100, nowMoney: '100.00' });
    await expect(cancelStoreOrder(f.container, { uid: 11, orderId: order.orderId })).rejects.toThrow();
    expect(await f.snapshot()).toEqual(restored);
  });

  it.each(['all-retired', 'all-deleted'] as const)('fails closed for %s modern type-4 SKUs instead of downgrading a bulk graph to an ordinary base SKU', async state => {
    await setVirtualSource(1);
    const submitted = await f.input([70]);
    for (const sku of submitted.products[0].skus) sku.price = '0.00';
    const created = await f.serviceFor().create(submitted, integralBatchActor), integralId = created.products[0].integral_id;
    const high = (await f.db.select().from(storeProductAttrValue)).find(row => row.type === 4 && row.productId === integralId && row.suk === '蓝')!;
    const predicate = and(eq(storeProductAttrValue.productId, integralId), eq(storeProductAttrValue.type, 4));
    if (state === 'all-retired') await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(predicate);
    else await f.db.delete(storeProductAttrValue).where(predicate);
    const before = await consumerState();
    expect(before.graph.products.find(row => row.id === 70)).toMatchObject({ isShow: 1, stock: 20 });
    expect(before.graph.results.some(row => row.productId === integralId && row.type === 4)).toBe(true);
    for (const requestedUnique of [high.unique, 'blue0070'])
      await expect(new ActivityService(f.container, f.env).exchange(11, integralId, 2, requestedUnique, crypto.randomUUID())).rejects.toThrow();
    expect(await consumerState()).toEqual(before);
  });
});
