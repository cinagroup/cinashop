import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { applyOrderRefund, finalizeStoreOrderRefund, quoteOrderRefundApplication, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { materializeCompletedRefundOrder, type RefundMaterializationIdentity } from '../src/services/order/RefundOrderMaterialization';
import { storeOrderRefundSplit } from '../src/models/schema/order_refund_split';
import { REFUND_ORDER_SPLIT_SQL } from '../src/migrations/refundOrderSplit';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBill, userBrokerage, supplierFlowingWater, supplierTransactions, user } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let applicationNumber = 0;
const now = 1_789_473_000;
const create = async (receipt = false) => {
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'materialization_checkout' },
    { uid: 11, key: 'materialization', cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true });
  const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).where(eq(storeOrder.orderId, created.orderId)).returning();
  if (receipt) {
    const service = new SupplierFulfillmentService(f.container, f.env);
    await service.deliver(0, order.id, { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
      deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 });
    await service.confirmTake(0, order.id);
  }
  return order;
};
const apply = async (orderId: string, selections = [{ cartId: 1, cartNum: 1 }], complete = true) => {
  const application = await applyOrderRefund(f.container, { uid: 11, orderId, applyType: 1,
    applicationOrderId: `materialization_refund_${++applicationNumber}`, refundReason: 'Local materialization', refundExplain: '', cartSelections: selections });
  if (complete) await finalizeStoreOrderRefund(f.container, application.refundId);
  return (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId)))[0];
};
const materialize = (refund: RefundMaterializationIdentity, db: DbClient = f.db) =>
  withTx(createContainerFromDb(db), tx => materializeCompletedRefundOrder(tx, refund, now));
const state = async () => ({
  orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
  carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  records: await f.db.select().from(storeOrderRefundSplit).orderBy(storeOrderRefundSplit.refundId),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  finance: { ...await f.snapshot(), brokerages: await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),
    payments: await f.db.select().from(storeOrderRefundPayment).orderBy(storeOrderRefundPayment.id) },
});
const twice = async () => {
  const order = await create(), firstRefund = await apply(order.orderId), first = await materialize(firstRefund);
  const before = await state(), remainder = before.orders.find(row => row.id === first.remainingOrderId)!;
  const chosen = before.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const secondRefund = await apply(remainder.orderId, [{ cartId: Number(chosen.cartId), cartNum: 1 }]);
  const second = await materialize(secondRefund);
  const done = await state(), cart = done.carts.find(row => row.oid === remainder.id)!;
  return { order, firstRefund, secondRefund, first, second, remainder, cart };
};
const quote = (orderId: string) => quoteOrderRefundApplication(f.container, { uid: 11, orderId, applyType: 1 }, 0);
beforeEach(async () => {
  applicationNumber = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions]);
  // Explicit candidate installation only in this disposable fixture. Not a
  // migration/runtime activation and not proof of minimum production ACLs.
  await f.exec(REFUND_ORDER_SPLIT_SQL);
  await f.exec('CREATE UNIQUE INDEX materialization_event ON store_order_outbox(event_key)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '100' });
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1', brokerage_compute_type: '1', store_brokerage_ratio: '10' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'Local referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(storeProduct).set({ freight: 2, postage: '3.00', giveIntegral: '100.00', isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Local remainder', price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'matr0071', suk: 'Standard', price: '30.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'matr0071', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it('creates actual refund/remainder orders and retains original request, source snapshot and money effects', async () => {
  const order = await create(), refund = await apply(order.orderId), before = await state();
  const split = await materialize(refund), done = await state();
  expect(split).toMatchObject({ disposition: 'split', sourceOrderId: order.id, paymentOrderId: order.id, replayed: false });
  expect(done.orders).toHaveLength(3); expect(done.orders[0]).toMatchObject({ pid: -1, payPrice: '55.00', totalNum: 3 });
  expect(done.orders.find(row => row.id === split.selectedOrderId)).toMatchObject({ pid: order.id, totalNum: 1,
    payPrice: '12.80', refundPrice: '12.80', useIntegral: '20.00', backIntegral: '20.00', gainIntegral: '100.00', oneBrokerage: '0.30', refundStatus: 2 });
  expect(done.orders.find(row => row.id === split.remainingOrderId)).toMatchObject({ pid: order.id, totalNum: 2,
    payPrice: '42.20', useIntegral: '80.00', backIntegral: '0.00', gainIntegral: '100.00', oneBrokerage: '3.30', refundStatus: 0, refundPrice: '0.00' });
  const active = done.carts.filter(row => row.oid !== order.id);
  expect(active.reduce((sum, row) => sum + row.cartNum, 0)).toBe(3);
  expect(active.filter(row => row.oid === split.selectedOrderId).map(row => row.refundNum)).toEqual([1]);
  expect(active.filter(row => row.oid === split.remainingOrderId).map(row => row.refundNum)).toEqual([0, 0]);
  for (const row of active) expect(JSON.parse(row.cartInfo!)).toMatchObject({ id: row.cartId, cart_num: row.cartNum });
  expect(done.refunds).toEqual(before.refunds);
  expect(JSON.parse(done.records[0].sourceSnapshot)).toMatchObject({ source: before.orders[0], refund, carts: before.carts });
  expect(done.finance.users).toEqual(before.finance.users); expect(done.finance.bills).toEqual(before.finance.bills);
  expect(done.finance.brokerages).toEqual(before.finance.brokerages); expect(done.finance.payments).toEqual(before.finance.payments);
  expect(done.finance.products).toEqual(before.finance.products); expect(done.finance.skus).toEqual(before.finance.skus);
});

it('performs the next actual refund split while retaining the remaining order and surviving cart identity', async () => {
  const order = await create(), firstRefund = await apply(order.orderId), first = await materialize(firstRefund);
  const before = await state(), remainder = before.orders.find(row => row.id === first.remainingOrderId)!;
  const chosen = before.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const kept = before.carts.find(row => row.oid === remainder.id && row.productId === 71)!;
  const secondRefund = await apply(remainder.orderId, [{ cartId: Number(chosen.cartId), cartNum: 1 }]);
  const second = await materialize(secondRefund), done = await state();
  expect(second.remainingOrderId).toBe(remainder.id); expect(second.paymentOrderId).toBe(order.id);
  expect(done.orders).toHaveLength(4);
  expect(done.orders.find(row => row.id === remainder.id)).toMatchObject({ orderId: remainder.orderId, payPrice: '29.40', totalNum: 1 });
  expect(done.carts.filter(row => row.oid === remainder.id)).toEqual([expect.objectContaining({ id: kept.id, cartId: kept.cartId,
    unique: kept.unique, productId: 71, cartNum: 1, refundNum: 0 })]);
  expect(done.refunds.find(row => row.id === secondRefund.id)).toEqual(secondRefund);
  expect(JSON.parse(done.records[1].sourceSnapshot).carts.some((row: { id: number }) => row.id === chosen.id)).toBe(true);
  expect(done.carts.some(row => row.id === chosen.id)).toBe(false);
  const recorded = await state(); expect((await materialize(firstRefund)).replayed).toBe(true);
  expect((await materialize(secondRefund)).replayed).toBe(true); expect(await state()).toEqual(recorded);
});

it('whole refund keeps order/cart identities, clears the completed quantity hold and allocates no new rows', async () => {
  const order = await create(), refund = await apply(order.orderId, [{ cartId: 1, cartNum: 2 }, { cartId: 2, cartNum: 1 }]);
  const before = await state(); const split = await materialize(refund), done = await state();
  expect(split).toMatchObject({ disposition: 'whole', selectedOrderId: order.id, remainingOrderId: null });
  expect(done.orders).toHaveLength(1); expect(done.carts.map(row => [row.id, row.cartId])).toEqual(before.carts.map(row => [row.id, row.cartId]));
  expect(done.carts.map(row => row.refundNum)).toEqual([0, 0]); expect(done.refunds).toEqual(before.refunds);
  expect((await materialize(refund)).replayed).toBe(true); expect(await state()).toEqual(done);
});

it('finishes three actual refunds across retained remaining generations without reusing prior cash, quantities or returned points', async () => {
  const order = await create();
  const firstRefund = await apply(order.orderId), first = await materialize(firstRefund);
  const firstState = await state(), remainder = firstState.orders.find(row => row.id === first.remainingOrderId)!;
  const secondCart = firstState.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const secondRefund = await apply(remainder.orderId, [{ cartId: Number(secondCart.cartId), cartNum: 1 }]);
  await materialize(secondRefund);
  const secondState = await state(), lastCart = secondState.carts.find(row => row.oid === remainder.id)!;
  expect(secondState.finance.users.find(row => row.uid === 11)?.integral).toBe(40);
  const thirdRefund = await apply(remainder.orderId, [{ cartId: Number(lastCart.cartId), cartNum: 1 }]);
  expect(thirdRefund.refundPrice).toBe('29.40');
  const third = await materialize(thirdRefund), done = await state();
  expect(third).toMatchObject({ disposition: 'whole', selectedOrderId: remainder.id, remainingOrderId: null });
  expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(100);
  expect(done.refunds.map(row => row.refundedPrice)).toEqual(['12.80', '12.80', '29.40']);
  expect(done.refunds.slice(0, 2)).toEqual([firstRefund, secondRefund]);
  expect(done.carts.filter(row => row.oid === remainder.id).map(row => row.refundNum)).toEqual([0]);
  expect(await finalizeStoreOrderRefund(f.container, thirdRefund.id)).toBe('already-completed');
  expect((await materialize(thirdRefund)).replayed).toBe(true); expect(await state()).toEqual(done);
});

it('quotes a retained generation read-only, preserving all original application evidence for Admin review', async () => {
  const { remainder, secondRefund, cart } = await twice(), before = await state();
  const result = await quote(remainder.orderId);
  expect(result).toMatchObject({ quotedPrice: '29.40', refundNum: 1, items: [{ cartId: Number(cart.cartId), cartNum: 1 }] });
  expect(result.previousRefunds).toEqual([secondRefund]); expect(await state()).toEqual(before);
});

it.each(['missing-marker', 'stale-marker', 'missing-version', 'wrong-owner', 'broken-parent', 'wrong-partition',
  'bad-bill-id', 'duplicate-bill-id', 'changed-original-refund'] as const)('refuses corrupt generation evidence %s without new application or money writes', async kind => {
  const { firstRefund, secondRefund, remainder, cart } = await twice();
  const info = JSON.parse(cart.cartInfo!);
  if (kind === 'missing-marker') delete info.refund_order_generation;
  if (kind === 'stale-marker') info.refund_order_generation.refundId = firstRefund.id;
  if (kind === 'missing-version') delete info.financial_version;
  if (['missing-marker', 'stale-marker', 'missing-version'].includes(kind)) {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
  } else if (kind === 'changed-original-refund') {
    await f.db.update(storeOrderRefund).set({ refundPrice: '12.79', refundedPrice: '12.79' }).where(eq(storeOrderRefund.id, secondRefund.id));
  } else {
    // Deliberate fixture-owner corruption, not a claim that a production runtime
    // role can disable evidence protection or that owner ACLs were tested.
    await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER sors_no_rewrite');
    try {
      if (kind === 'wrong-owner') await f.db.update(storeOrderRefundSplit).set({ supplierId: 1 }).where(eq(storeOrderRefundSplit.refundId, secondRefund.id));
      if (kind === 'broken-parent') await f.db.update(storeOrderRefundSplit).set({ previousRefundId: 0 }).where(eq(storeOrderRefundSplit.refundId, secondRefund.id));
      if (kind === 'wrong-partition') await f.db.update(storeOrderRefundSplit).set({ partitions: '[{"remainingNum":1,"remainingRowId":999,"sourceCartId":"999"}]' }).where(eq(storeOrderRefundSplit.refundId, secondRefund.id));
      if (kind === 'bad-bill-id') await f.db.update(storeOrderRefundSplit).set({ returnedPointBillIds: '[false]' }).where(eq(storeOrderRefundSplit.refundId, secondRefund.id));
      if (kind === 'duplicate-bill-id') await f.db.update(storeOrderRefundSplit).set({ returnedPointBillIds: '[1,1]' }).where(eq(storeOrderRefundSplit.refundId, secondRefund.id));
    } finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER sors_no_rewrite'); }
  }
  const before = await state(); await expect(quote(remainder.orderId)).rejects.toThrow('证据'); expect(await state()).toEqual(before);
});

it('does not silently ignore an absent marked-generation table or install it at runtime', async () => {
  const { remainder } = await twice(), before = await f.snapshot();
  await f.exec('DROP TABLE store_order_refund_split');
  await expect(quote(remainder.orderId)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  const [catalog] = await f.db.select({ table: sql<string | null>`to_regclass('store_order_refund_split')::text` }).from(sql`(values(1)) probe(n)`);
  expect(catalog.table).toBeNull();
});

it('keeps ordinary unmarked refunds operational without the candidate table', async () => {
  await f.exec('DROP TABLE store_order_refund_split');
  const order = await create(), refund = await apply(order.orderId);
  expect(refund).toMatchObject({ refundType: 6, refundedPrice: '12.80' });
  expect((await f.snapshot()).users.find(row => row.uid === 11)?.integral).toBe(20);
});

it.each(['self-parent', 'non-array', 'too-many-bills', 'oversized-bills'] as const)('candidate DDL rejects invalid generation metadata %s', async kind => {
  await twice(); const before = await state(), original = before.records[1];
  const data = { ...original, refundId: 9999,
    previousRefundId: kind === 'self-parent' ? 9999 : original.refundId,
    returnedPointBillIds: kind === 'non-array' ? '{}' : kind === 'too-many-bills' ? JSON.stringify(Array(1025).fill(1))
      : kind === 'oversized-bills' ? JSON.stringify(['x'.repeat(17000)]) : original.returnedPointBillIds };
  await expect(f.db.insert(storeOrderRefundSplit).values(data)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('rolls back the current-generation cash, points and stock together on a late finalizer failure', async () => {
  const { remainder, cart } = await twice();
  const pending = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }], false), before = await state();
  await f.exec(`CREATE FUNCTION fail_generation_finalization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.change_type='refund_price' THEN RAISE EXCEPTION 'local generation finalizer failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_generation_finalization BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION fail_generation_finalization()`);
  await expect(finalizeStoreOrderRefund(f.container, pending.id)).rejects.toThrow(); expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER fail_generation_finalization ON store_order_status');
  expect(await finalizeStoreOrderRefund(f.container, pending.id)).toBe('completed');
  expect((await state()).finance.users.find(row => row.uid === 11)?.integral).toBe(100);
});

it('rejects changed generation evidence before a new provider intent or network admission', async () => {
  const order = await create(); await f.db.update(storeOrder).set({ payType: 'weixin' }).where(eq(storeOrder.id, order.id));
  const service = new StoreOrderRefundService(f.container, f.env);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockResolvedValue({ status: 'SUCCESS' });
  const initial = await apply(order.orderId, undefined, false); await service.agreeRefund(initial.id);
  const first = await materialize((await state()).refunds[0]), firstState = await state();
  const remainder = firstState.orders.find(row => row.id === first.remainingOrderId)!;
  const cart = firstState.carts.find(row => row.oid === remainder.id)!;
  const pending = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }], false);
  const info = JSON.parse(cart.cartInfo!); info.refund_order_generation.refundId = 9999;
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
  const before = await state(); await expect(service.agreeRefund(pending.id)).rejects.toThrow('证据');
  expect(await state()).toEqual(before); expect(request).toHaveBeenCalledTimes(1); expect(before.finance.payments).toHaveLength(1);
});

it('retains point-return boundaries when the earlier materialized business refund was removed', async () => {
  const { remainder, secondRefund, cart } = await twice();
  await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.id, secondRefund.id));
  const refund = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }]);
  expect(refund.refundPrice).toBe('29.40'); expect((await state()).finance.users.find(row => row.uid === 11)?.integral).toBe(100);
  expect((await materialize(refund)).disposition).toBe('whole');
});

it('counts new returns inside the current generation while excluding only exact prior-generation bill IDs', async () => {
  await f.db.update(storeCart).set({ cartNum: 4 }).where(eq(storeCart.id, 1));
  const originalInventory = await f.snapshot();
  const order = await create(), first = await materialize(await apply(order.orderId));
  const firstState = await state(), remainder = firstState.orders.find(row => row.id === first.remainingOrderId)!;
  let cart = firstState.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  await materialize(await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }]));
  cart = (await state()).carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const thirdRefund = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }]);
  const afterThird = await state();
  await f.db.insert(userBill).values({ uid: 11, linkId: 'another-order', pm: 1, category: 'integral',
    type: 'pay_product_integral_back', number: '700', balance: '700', status: 1 });
  const lastSelections = afterThird.carts.filter(row => row.oid === remainder.id).map(row => ({ cartId: Number(row.cartId), cartNum: row.cartNum - row.refundNum })).filter(row => row.cartNum > 0);
  const fourthRefund = await apply(remainder.orderId, lastSelections), done = await state();
  expect(done.refunds.find(row => row.id === thirdRefund.id)).toEqual(thirdRefund);
  expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(100);
  expect(done.refunds.reduce((sum, row) => sum + Number(row.refundedPrice.replace('.', '')), 0)).toBe(Number(order.payPrice.replace('.', '')));
  expect(done.finance.products.map(row => row.stock)).toEqual(originalInventory.products.map(row => row.stock));
  expect(done.finance.skus.map(row => row.stock)).toEqual(originalInventory.skus.map(row => row.stock));
  expect(await finalizeStoreOrderRefund(f.container, fourthRefund.id)).toBe('already-completed'); expect(await state()).toEqual(done);
});

it('preserves all three original-channel intents and the root total across retained generations', async () => {
  const order = await create(); await f.db.update(storeOrder).set({ payType: 'weixin', tradeNo: 'local-generation-trade' }).where(eq(storeOrder.id, order.id));
  const service = new StoreOrderRefundService(f.container, f.env);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockResolvedValue({ status: 'SUCCESS' });
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS' });
  let activeOrder = order.orderId;
  for (let index = 0; index < 3; index++) {
    const snapshot = await state(), current = snapshot.orders.find(row => row.orderId === activeOrder)!;
    const cart = snapshot.carts.find(row => row.oid === current.id)!;
    const pending = await apply(activeOrder, [{ cartId: Number(cart.cartId), cartNum: 1 }], false);
    if (index === 1) { request.mockRejectedValueOnce(Error('Local generation timeout')); await expect(service.agreeRefund(pending.id)).rejects.toThrow('结果未知'); }
    await service.agreeRefund(pending.id);
    const completed = (await state()).refunds.find(row => row.id === pending.id)!;
    const split = await materialize(completed);
    if (split.remainingOrderId !== null) activeOrder = (await state()).orders.find(row => row.id === split.remainingOrderId)!.orderId;
  }
  const done = await state(); expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(100);
  expect(request).toHaveBeenCalledTimes(3); expect(query).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.map(([value]) => [value.outTradeNo, value.totalAmount, value.refundAmount]))
    .toEqual([[order.orderId, 5500, 1280], [order.orderId, 5500, 1280], [order.orderId, 5500, 2940]]);
  for (const refund of done.refunds) await service.agreeRefund(refund.id);
  expect(await state()).toEqual(done); expect(request).toHaveBeenCalledTimes(3);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('checks the current generation after a real cart-lock wait and before settlement user locks', async () => {
  const { remainder, cart, firstRefund } = await twice();
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const pending = outcome(applyOrderRefund(createContainerFromDb(worker.db), { uid: 11, orderId: remainder.orderId,
      applyType: 1, refundReason: 'Local generation race', refundExplain: '', applicationOrderId: 'generation-race',
      cartSelections: [{ cartId: Number(cart.cartId), cartNum: 1 }] }));
    await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    await holder.exec('SELECT uid FROM "user" WHERE uid IN (11,22) ORDER BY uid FOR UPDATE NOWAIT');
    const info = JSON.parse(cart.cartInfo!); info.refund_order_generation.refundId = firstRefund.id;
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('证据');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects a generation change while finalization waits without paying or taking user locks early', async () => {
  const { remainder, cart, firstRefund } = await twice();
  const refund = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }], false);
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${cart.id} FOR UPDATE`);
    const pending = outcome(finalizeStoreOrderRefund(createContainerFromDb(worker.db), refund.id));
    await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    await holder.exec('SELECT uid FROM "user" WHERE uid IN (11,22) ORDER BY uid FOR UPDATE NOWAIT');
    const info = JSON.parse(cart.cartInfo!); info.refund_order_generation.refundId = firstRefund.id;
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('证据');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it('keeps a received remainder received without replaying already credited gifts or commissions', async () => {
  const order = await create(true), refund = await apply(order.orderId), before = await state();
  const split = await materialize(refund), done = await state();
  expect(done.orders.find(row => row.id === split.remainingOrderId)).toMatchObject({ status: 2, deliveryId: 'NO-SHIPMENT' });
  expect(done.finance.users).toEqual(before.finance.users); expect(done.finance.bills).toEqual(before.finance.bills);
  expect(done.finance.brokerages).toEqual(before.finance.brokerages);
  expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(120);
});

it.each([{ received: true, paymentGifts: false }, { received: false, paymentGifts: false },
  { received: true, paymentGifts: true }, { received: false, paymentGifts: true }])
  ('reverses original earned income through three refunds: %j', async ({ received, paymentGifts }) => {
  if (paymentGifts) Object.assign(f.config, { order_give_integral: '3' });
  const order = await create(received), firstRefund = await apply(order.orderId), first = await materialize(firstRefund);
  const initial = await state(), remainder = initial.orders.find(row => row.id === first.remainingOrderId)!;
  if (!received) {
    const fulfillment = new SupplierFulfillmentService(f.container, f.env);
    await fulfillment.deliver(0, remainder.id, { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
      deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 });
    await fulfillment.confirmTake(0, remainder.id);
  }
  const credited = await state(), incomeId = String(received ? order.id : remainder.id);
  Object.assign(f.config, { order_give_integral: '999', brokerage_func_status: '0', store_brokerage_ratio: '99' });
  const secondCart = credited.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const secondRefund = await apply(remainder.orderId, [{ cartId: Number(secondCart.cartId), cartNum: 1 }]);
  const second = await state();
  expect(second.finance.users.find(row => row.uid === 11)?.integral).toBe(paymentGifts ? received ? 129 : 128 : 40);
  expect(second.finance.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.00');
  await materialize(secondRefund);
  const lastCart = (await state()).carts.find(row => row.oid === remainder.id)!;
  const thirdRefund = await apply(remainder.orderId, [{ cartId: Number(lastCart.cartId), cartNum: 1 }]);
  await materialize(thirdRefund);
  const done = await state();
  expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(100);
  expect(done.finance.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(done.finance.bills.filter(row => row.type === 'gain')).toEqual(credited.finance.bills.filter(row => row.type === 'gain'));
  expect(done.finance.brokerages.filter(row => row.pm === 1).map(row => ({ ...row, frozenTime: 0 })))
    .toEqual(credited.finance.brokerages.filter(row => row.pm === 1).map(row => ({ ...row, frozenTime: 0 })));
  expect(done.finance.brokerages.filter(row => row.pm === 0).every(row => row.linkId === incomeId)).toBe(true);
  expect(done.finance.bills.filter(row => row.eventKey === 'integral_refund').every(row => row.linkId === incomeId)).toBe(true);
  const incomeScope = JSON.parse(done.records[1].earnedIncomeScope);
  expect(incomeScope).toMatchObject({ orderId: Number(incomeId), uid: 11,
    refundId: received ? firstRefund.id : secondRefund.id, productIntegral: received ? 200 : 100,
    payment: received ? 5500 : 4220, brokerage: { one_brokerage: received ? 360 : 330 } });
  expect(JSON.parse(done.records[2].earnedIncomeScope)).toEqual(incomeScope);
  if (!received) expect(JSON.parse(done.records[0].earnedIncomeScope)).toBeNull();
  for (const refund of done.refunds) expect(await finalizeStoreOrderRefund(f.container, refund.id)).toBe('already-completed');
  expect(await state()).toEqual(done);
});

it.each(['uid', 'orderId', 'refundId', 'payment', 'version', 'missing-field'] as const)
  ('rejects corrupt original earned-income evidence %s before a new application', async kind => {
  const order = await create(true), refund = await apply(order.orderId), first = await materialize(refund), initial = await state();
  const remainder = initial.orders.find(row => row.id === first.remainingOrderId)!;
  const scope = JSON.parse(initial.records[0].earnedIncomeScope);
  if (kind === 'uid') scope.uid = 22;
  if (kind === 'orderId') scope.orderId = remainder.id;
  if (kind === 'refundId') scope.refundId = 999;
  if (kind === 'payment') scope.payment = 0;
  if (kind === 'version') scope.version = 'unknown';
  if (kind === 'missing-field') delete scope.productIntegral;
  await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER sors_no_rewrite');
  try { await f.db.update(storeOrderRefundSplit).set({ earnedIncomeScope: JSON.stringify(scope) }).where(eq(storeOrderRefundSplit.refundId, refund.id)); }
  finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER sors_no_rewrite'); }
  const before = await state(); await expect(quote(remainder.orderId)).rejects.toThrow('证据'); expect(await state()).toEqual(before);
});

it('rolls back original income reversals together with current-generation cash and returned points', async () => {
  const order = await create(true), first = await materialize(await apply(order.orderId)), initial = await state();
  const remainder = initial.orders.find(row => row.id === first.remainingOrderId)!;
  const cart = initial.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const pending = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }], false), before = await state();
  await f.exec(`CREATE FUNCTION fail_income_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.change_type='refund_price' THEN RAISE EXCEPTION 'local earned income rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_income_reversal BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION fail_income_reversal()`);
  await expect(finalizeStoreOrderRefund(f.container, pending.id)).rejects.toThrow(); expect(await state()).toEqual(before);
  await f.exec('DROP TRIGGER fail_income_reversal ON store_order_status');
  expect(await finalizeStoreOrderRefund(f.container, pending.id)).toBe('completed');
  const done = await state(); expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(40);
  expect(done.finance.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.00');
});

it.each(['cleared', 'changed'] as const)('rejects %s income provenance on a later generation', async kind => {
  const order = await create(true), first = await materialize(await apply(order.orderId)), initial = await state();
  const remainder = initial.orders.find(row => row.id === first.remainingOrderId)!;
  const cart = initial.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const second = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }]); await materialize(second);
  const scope = JSON.parse((await state()).records[1].earnedIncomeScope); scope.payment += 1;
  await f.exec('ALTER TABLE store_order_refund_split DISABLE TRIGGER sors_no_rewrite');
  try { await f.db.update(storeOrderRefundSplit).set({ earnedIncomeScope: JSON.stringify(kind === 'cleared' ? null : scope) })
    .where(eq(storeOrderRefundSplit.refundId, second.id)); }
  finally { await f.exec('ALTER TABLE store_order_refund_split ENABLE TRIGGER sors_no_rewrite'); }
  const before = await state(); await expect(quote(remainder.orderId)).rejects.toThrow('证据'); expect(await state()).toEqual(before);
});

it('uses the received fulfillment child as income owner and leaves sibling income untouched', async () => {
  await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  const order = await create(), fulfillment = new SupplierFulfillmentService(f.container, f.env);
  const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local', deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;
  await fulfillment.splitDelivery(0, order.id, shipping, [{ cartId: '1', cartNum: 2 }]);
  const split = await state(), child = split.orders.find(row => row.pid === order.id && row.status === 1)!;
  const sibling = split.orders.find(row => row.pid === order.id && row.status === 0)!;
  await fulfillment.confirmTake(0, child.id); await fulfillment.deliver(0, sibling.id, shipping); await fulfillment.confirmTake(0, sibling.id);
  const before = await state();
  const firstCart = before.carts.find(row => row.oid === child.id)!;
  const firstRefund = await apply(child.orderId, [{ cartId: Number(firstCart.cartId), cartNum: 1 }]);
  const first = await materialize(firstRefund); expect(first.remainingOrderId).toBe(child.id);
  const lastCart = (await state()).carts.find(row => row.oid === child.id)!;
  const secondRefund = await apply(child.orderId, [{ cartId: Number(lastCart.cartId), cartNum: 1 }]); await materialize(secondRefund);
  const done = await state();
  expect(JSON.parse(done.records[1].earnedIncomeScope)).toMatchObject({ orderId: child.id, payment: Number(child.payPrice.replace('.', '')) });
  expect(done.finance.brokerages.filter(row => row.linkId === String(sibling.id)))
    .toEqual(before.finance.brokerages.filter(row => row.linkId === String(sibling.id)));
  expect(done.finance.bills.filter(row => row.linkId === String(sibling.id)))
    .toEqual(before.finance.bills.filter(row => row.linkId === String(sibling.id)));
  expect(done.finance.brokerages.filter(row => row.pm === 0).every(row => row.linkId === String(child.id))).toBe(true);
  expect(done.finance.bills.filter(row => row.eventKey === 'integral_refund').reduce((sum, row) => sum + Number(row.number), 0)).toBe(200);
});

it.each(['array', 'oversized'] as const)('candidate DDL rejects %s earned-income evidence', async kind => {
  const order = await create(true); await materialize(await apply(order.orderId)); const before = await state();
  await expect(f.db.insert(storeOrderRefundSplit).values({ ...before.records[0], refundId: 9999,
    earnedIncomeScope: kind === 'array' ? '[]' : JSON.stringify({ unproven: 'x'.repeat(2048) }) })).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('locks the original lower-UID income recipient before the buyer even after child attribution changes', async () => {
  await f.db.insert(user).values({ uid: 5, account: 'Original local recipient', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(user).set({ spreadUid: 5 }).where(eq(user.uid, 11));
  const order = await create(true), first = await materialize(await apply(order.orderId)), initial = await state();
  const remainder = initial.orders.find(row => row.id === first.remainingOrderId)!;
  const cart = initial.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  await f.db.update(storeOrder).set({ spreadUid: 22 }).where(eq(storeOrder.id, remainder.id));
  const pending = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }], false);
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec('BEGIN; SELECT uid FROM "user" WHERE uid=5 FOR UPDATE');
    const work = outcome(finalizeStoreOrderRefund(createContainerFromDb(worker.db), pending.id));
    await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    await holder.exec('SELECT uid FROM "user" WHERE uid IN (11,22) ORDER BY uid FOR UPDATE NOWAIT');
    await holder.exec('COMMIT'); const result = await work;
    expect(result).toEqual({ ok: true, value: 'completed' });
  });
  const done = await state(); expect(done.finance.users.find(row => row.uid === 5)?.brokeragePrice).toBe('3.00');
  expect(done.finance.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(done.finance.users.find(row => row.uid === 11)?.integral).toBe(40);
}, 15_000);

it('whole-refunds the remaining child without generating a second empty remainder', async () => {
  const order = await create(), first = await materialize(await apply(order.orderId)), before = await state();
  const remainder = before.orders.find(row => row.id === first.remainingOrderId)!;
  const rows = before.carts.filter(row => row.oid === remainder.id);
  const refund = await apply(remainder.orderId, rows.map(row => ({ cartId: Number(row.cartId), cartNum: row.cartNum })));
  const done = await materialize(refund), snapshot = await state();
  expect(done).toMatchObject({ disposition: 'whole', selectedOrderId: remainder.id, paymentOrderId: order.id, remainingOrderId: null });
  expect(snapshot.orders).toHaveLength(3);
  expect(snapshot.carts.filter(row => row.oid === remainder.id).map(row => row.refundNum)).toEqual([0, 0]);
});

it('persists truncated point/gift residue in the remaining physical cart rather than recalculating unit grants', async () => {
  await f.db.update(storeCart).set({ cartNum: 7 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ freight: 1, giveIntegral: '0.80' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ price: '0.15' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.update(storeProductAttrValue).set({ price: '0.00' }).where(eq(storeProductAttrValue.id, 2));
  await f.setConfig({ integral_max_num: '5' });
  const order = await create(true), refund = await apply(order.orderId), split = await materialize(refund), done = await state();
  expect(order).toMatchObject({ payPrice: '1.00', useIntegral: '5.00', gainIntegral: '5.00' });
  expect(done.orders.find(row => row.id === split.selectedOrderId)).toMatchObject({ useIntegral: '0.00', gainIntegral: '0.00', payPrice: '0.14' });
  expect(done.orders.find(row => row.id === split.remainingOrderId)).toMatchObject({ useIntegral: '5.00', gainIntegral: '5.00', payPrice: '0.86' });
  const row = done.carts.find(row => row.oid === split.remainingOrderId && row.productId === 70)!;
  expect(JSON.parse(row.cartInfo!)).toMatchObject({ cart_num: 6, use_integral: '5', gain_integral: '5' });
});

it('partitions persisted entitlement counters, leaving consumed units on the remaining cart', async () => {
  const order = await create(true), refund = await apply(order.orderId), row = (await state()).carts[0];
  // Explicit structural fixture state; this is not a real write-off endpoint test.
  await f.db.update(storeOrderCartInfo).set({ writeSurplusTimes: 1, writeoffTime: now - 1 }).where(eq(storeOrderCartInfo.id, row.id));
  const split = await materialize(refund), done = await state();
  expect(done.carts.find(row => row.oid === split.selectedOrderId)).toMatchObject({ writeTimes: 1, writeSurplusTimes: 1, writeoffTime: 0, isWriteoff: 0 });
  expect(done.carts.find(row => row.oid === split.remainingOrderId && row.productId === 70)).toMatchObject({ writeTimes: 1, writeSurplusTimes: 0, writeoffTime: now - 1, isWriteoff: 1 });
});

it('does not guess independent merchant freight allocation', async () => {
  const order = await create(), refund = await apply(order.orderId);
  await f.db.update(storeOrder).set({ freightPrice: '9.00' }).where(eq(storeOrder.id, order.id));
  const before = await state(); await expect(materialize(refund)).rejects.toThrow('商家运费'); expect(await state()).toEqual(before);
});

it('does not silently expand a completed selected-goods claim into an unshipped gift-only remainder', async () => {
  await f.db.update(storeProductAttrValue).set({ price: '0.00' }).where(eq(storeProductAttrValue.id, 2));
  const order = await create();
  // A structurally valid free gift line. Promotion-award creation is not tested.
  await f.db.update(storeOrderCartInfo).set({ isGift: 1 }).where(eq(storeOrderCartInfo.productId, 71));
  const refund = await apply(order.orderId, [{ cartId: 1, cartNum: 2 }]), before = await state();
  await expect(materialize(refund)).rejects.toThrow('仅剩赠品'); expect(await state()).toEqual(before);
});

it('retains original provider payment identity after actual UNKNOWN recovery and physical creation', async () => {
  const order = await create();
  await f.db.update(storeOrder).set({ payType: 'weixin', tradeNo: 'local-materialization-trade' }).where(eq(storeOrder.id, order.id));
  const pending = await apply(order.orderId, undefined, false), service = new StoreOrderRefundService(f.container, f.env);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Local timeout'));
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS' });
  await expect(service.agreeRefund(pending.id)).rejects.toThrow('结果未知');
  await service.agreeRefund(pending.id);
  const refund = (await state()).refunds[0], before = await state(); await materialize(refund); const done = await state();
  expect(done.finance.payments).toEqual(before.finance.payments); expect(done.refunds).toEqual(before.refunds);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ outTradeNo: order.orderId, refundAmount: 1280, totalAmount: 5500 }));
  expect(query).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  expect(await service.agreeRefund(refund.id)).toMatchObject({ completed: true }); expect(await state()).toEqual(done);
});

it('gives a newly created remaining pickup order a fresh code and removes the refunded child code', async () => {
  const order = await create(); await f.db.update(storeOrder).set({ verifyCode: '123456789012' }).where(eq(storeOrder.id, order.id));
  const refund = await apply(order.orderId), split = await materialize(refund), done = await state();
  expect(done.orders.find(row => row.id === split.selectedOrderId)?.verifyCode).toBe('');
  const code = done.orders.find(row => row.id === split.remainingOrderId)?.verifyCode;
  expect(code).toMatch(/^\d{12}$/); expect(code).not.toBe('123456789012');
});

it.each(['uid', 'supplierId', 'storeId', 'storeOrderId', 'refundPrice'] as const)('rejects a changed replay identity %s without touching children', async field => {
  const order = await create(), refund = await apply(order.orderId); await materialize(refund); const before = await state();
  const changed = { ...refund, [field]: field === 'refundPrice' ? '12.79' : Number(refund[field]) + 1 };
  await expect(materialize(changed)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.each(['uncompleted', 'missing-version', 'counter', 'back-points', 'wrong-money', 'other-open', 'parent-owner'] as const)
  ('fails closed on materialization evidence %s', async kind => {
    const order = await create(), refund = await apply(order.orderId, undefined, kind !== 'uncompleted');
    const [row] = (await state()).carts;
    if (kind === 'missing-version') { const info = JSON.parse(row.cartInfo!); delete info.financial_version;
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id)); }
    if (kind === 'counter') await f.db.update(storeOrderCartInfo).set({ refundNum: 2 }).where(eq(storeOrderCartInfo.id, row.id));
    if (kind === 'back-points') await f.db.update(storeOrder).set({ backIntegral: '19.00' }).where(eq(storeOrder.id, order.id));
    if (kind === 'wrong-money') await f.db.update(storeOrder).set({ payPrice: '55.01' }).where(eq(storeOrder.id, order.id));
    if (kind === 'other-open') await f.db.insert(storeOrderRefund).values({ storeOrderId: order.id, uid: 11, refundType: 0 });
    if (kind === 'parent-owner') await f.db.update(storeOrder).set({ uid: 22 }).where(eq(storeOrder.id, order.id));
    const before = await state(); await expect(materialize(refund)).rejects.toThrow(); expect(await state()).toEqual(before);
  });

it.each(['store_order_cart_info', 'store_order_refund_split', 'store_order_status'])('rolls back all structural writes after failure in %s', async table => {
  const order = await create(), refund = await apply(order.orderId), before = await state();
  await f.exec(`CREATE FUNCTION fail_materialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local materialization failure'; END $$;
    CREATE TRIGGER fail_materialization BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_materialization()`);
  await expect(materialize(refund)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('requires the caller transaction and never repairs missing owned cart sequences', async () => {
  const order = await create(), refund = await apply(order.orderId), before = await state();
  await expect(materializeCompletedRefundOrder(f.db, refund, now)).rejects.toThrow('transaction');
  const [sequence] = await f.db.select({ name: sql<string>`pg_get_serial_sequence('store_order_cart_info','id')` }).from(sql`(values(1)) p(n)`);
  // Trusted catalog identifier belonging to the fixture, not an input path/name.
  expect(sequence.name).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/);
  await f.exec(`ALTER SEQUENCE ${sequence.name.split('.').map(part => `"${part}"`).join('.')} OWNED BY NONE`);
  await expect(materialize(refund)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it('retains committed evidence for original-key replay even if the original business rows are gone', async () => {
  const order = await create(), refund = await apply(order.orderId), split = await materialize(refund);
  await f.db.delete(storeOrderRefund).where(eq(storeOrderRefund.id, refund.id));
  await f.db.delete(storeOrder).where(eq(storeOrder.id, order.id));
  const before = await state(); expect(await materialize(refund)).toEqual({ ...split, replayed: true }); expect(await state()).toEqual(before);
});

it.each(['UPDATE store_order_refund_split SET selected_order_id=999', 'DELETE FROM store_order_refund_split', 'TRUNCATE store_order_refund_split'])
  ('candidate DDL blocks evidence rewriting: %s', async query => {
    const order = await create(), refund = await apply(order.orderId); await materialize(refund); const before = await state();
    await expect(f.exec(query)).rejects.toThrow('append-only'); expect(await state()).toEqual(before);
  });

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes independent duplicate materializers under the refund and root locks', async () => {
  const order = await create(), refund = await apply(order.orderId);
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${order.id} FOR UPDATE`);
    const a = outcome(materialize(refund, first.db)); await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(materialize(refund, second.db)); await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT'); const one = await a, two = await b;
    expect(one.ok).toBe(true); expect(two.ok).toBe(true);
    if (one.ok && two.ok) expect(two.value).toEqual({ ...one.value, replayed: true });
  });
  expect((await state()).orders).toHaveLength(3); expect((await state()).records).toHaveLength(1);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('reads financial cart evidence after the actual lock wait', async () => {
  const order = await create(), refund = await apply(order.orderId), row = (await state()).carts[1];
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${row.id} FOR UPDATE`);
    const pending = outcome(materialize(refund, worker.db)); await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    const info = JSON.parse(row.cartInfo!); info.one_brokerage = '3.01';
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    await holder.exec('COMMIT'); edited = await state();
    const observed = await pending; expect(observed.ok).toBe(false); if (!observed.ok) expect(String(observed.error)).toContain('快照');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('waits for the payment root before the active child and rejects changed parentage', async () => {
  const order = await create(), first = await materialize(await apply(order.orderId)), before = await state();
  const remainder = before.orders.find(row => row.id === first.remainingOrderId)!;
  const cart = before.carts.find(row => row.oid === remainder.id && row.productId === 70)!;
  const refund = await apply(remainder.orderId, [{ cartId: Number(cart.cartId), cartNum: 1 }]);
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, worker]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${order.id} FOR UPDATE`);
    const pending = outcome(materialize(refund, worker.db)); await waitForFinanceBlock(f.db, worker.pid, holder.pid);
    await holder.exec(`SELECT id FROM store_order WHERE id=${remainder.id} FOR UPDATE NOWAIT`);
    await holder.db.update(storeOrder).set({ pid: 999 }).where(eq(storeOrder.id, remainder.id));
    await holder.exec('COMMIT'); edited = await state();
    const observed = await pending; expect(observed.ok).toBe(false); if (!observed.ok) expect(String(observed.error)).toContain('证据');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it('integrates durable v2 finalization with registered evidence but without default route activation', () => {
  const finalizer = readFileSync('src/services/order/StoreOrderRefundService.ts', 'utf8');
  expect(finalizer).toContain('if (materializeOrders) await materializeCompletedRefundOrder(tx, refund, now, invoiceSnapshot)');
  expect(finalizer).toContain('claim?.version === MATERIALIZED_REFUND_VERSION');
  expect(readFileSync('src/controllers/api/v1/OrderController.ts', 'utf8')).not.toContain('applyOrderRefundWithMaterialization');
  expect(readFileSync('src/models/schema/index.ts', 'utf8')).toContain('order_refund_split');
  expect(readFileSync('src/services/MigrationService.ts', 'utf8')).not.toContain('REFUND_ORDER_SPLIT_SQL');
  expect(readFileSync('src/services/MigrationService.ts', 'utf8')).toContain('runRefundOrderSplitSchema');
});
