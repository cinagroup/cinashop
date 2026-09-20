import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { applyOrderRefund, ensureAutomaticOrderRefund, finalizeStoreOrderRefund, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { createContainerFromDb } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { targetLineCompensation } from '../src/services/order/OrderSplitFinance';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions, user } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let applicationNumber = 0;
const ship = (orderId: number) => new SupplierFulfillmentService(f.container, f.env).deliver(0, orderId,
  { deliveryType: 'express', deliveryName: 'Local only', deliveryCode: 'local', deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 });
const receive = (orderId: number) => new SupplierFulfillmentService(f.container, f.env).confirmTake(0, orderId);
const create = async (receipt = true, cartIds = [1, 2]) => {
  const created = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'line_compensation_checkout' },
    { uid: 11, key: 'line_compensation', cartIds, addressId: 11, userIp: '127.0.0.1', useIntegral: true });
  const [order] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).where(eq(storeOrder.orderId, created.orderId)).returning();
  if (receipt) {
    await ship(order.id); await receive(order.id);
  }
  return order;
};
const apply = (orderId: string, cartId: number, cartNum = 1, price?: number) => applyOrderRefund(f.container, { uid: 11, orderId,
  applyType: price === undefined ? 1 : 4, refundReason: 'Local line compensation', refundExplain: '',
  applicationOrderId: `line_compensation_${++applicationNumber}`, cartSelections: [{ cartId, cartNum }],
  ...(price === undefined ? {} : { privilegedActor: 'admin', requestedRefundAmountCents: price, authorizeApplication: async () => {} }) });
const state = async () => ({ ...await f.snapshot(), refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
  brokerages: await f.db.select().from(userBrokerage).orderBy(userBrokerage.id),
  details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  payments: await f.db.select().from(storeOrderRefundPayment).orderBy(storeOrderRefundPayment.id),
  invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
  outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
  supplierFlows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
  supplierPayments: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id) });
beforeEach(async () => {
  applicationNumber = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions]);
  await f.exec('CREATE UNIQUE INDEX line_compensation_event ON store_order_outbox(event_key)');
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '100' });
  Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1', brokerage_compute_type: '1', store_brokerage_ratio: '10' });
  await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
  await f.db.insert(user).values({ uid: 22, account: 'Local referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
  await f.db.update(storeProduct).set({ freight: 2, postage: '3.00', giveIntegral: '100.00', isSub: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ brokerage: '0.30' }).where(eq(storeProductAttrValue.id, 1));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'No gift high commission', price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'comp0071', suk: 'Standard', price: '30.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'comp0071', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it('returns the selected line deduction points, not a cash/freight share of every line points', async () => {
  const order = await create(false), refund = await apply(order.orderId, 1);
  expect(order).toMatchObject({ payPrice: '55.00', useIntegral: '100.00' });
  expect(JSON.parse((await state()).details[0].cartInfo!)).toMatchObject({ use_integral: '40' });
  await finalizeStoreOrderRefund(f.container, refund.refundId);
  expect((await state()).users.find(row => row.uid === 11)?.integral).toBe(20);
});

it('reverses the selected product gift rather than mixing it with a non-gifting product', async () => {
  const order = await create(), before = await state();
  expect(before.users.find(row => row.uid === 11)?.integral).toBe(200);
  const refund = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, refund.refundId);
  const done = await state();
  expect(done.bills.filter(row => row.eventKey === 'integral_refund').map(row => row.number)).toEqual(['100.00']);
  expect(done.users.find(row => row.uid === 11)?.integral).toBe(120);
});

it('reverses only the selected line specified-SKU commission from the actual received income', async () => {
  const order = await create(), before = await state();
  // The configured gross-price commission mode intentionally precedes points.
  expect(order.oneBrokerage).toBe('3.60');
  expect(before.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.60');
  const refund = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, refund.refundId);
  expect((await state()).brokerages.filter(row => row.type === 'refund').map(row => row.number)).toEqual(['0.30']);
});

it.each([[1, 2, 1], [2, 1, 1], [1, 1, 2]])('conserves every point/commission and preserves identities across selection order %j', async (...ids: number[]) => {
  const order = await create(), original = await state();
  for (const cartId of ids) {
    const refund = await apply(order.orderId, cartId); await finalizeStoreOrderRefund(f.container, refund.refundId);
    const done = await state();
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('already-completed');
    expect(await state()).toEqual(done);
  }
  const done = await state();
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 100, nowMoney: '55.00' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(done.orders).toHaveLength(1);
  expect(done.orders[0]).toMatchObject({ id: order.id, orderId: order.orderId, payPrice: '55.00', backIntegral: '100.00', refundPrice: '55.00' });
  expect(done.refunds.every(row => row.storeOrderId === order.id && row.refundType === 6)).toBe(true);
  // Existing full-reversal policy clears the freeze, but never changes the
  // original income's identity, amount, source type or credited balance.
  expect(done.brokerages.filter(row => row.pm === 1)).toEqual(original.brokerages.map(row => ({ ...row, frozenTime: 0 })));
  expect(done.brokerages.filter(row => row.type === 'refund').map(row => row.number)).toEqual(ids.map(id => id === 1 ? '0.30' : '3.00'));
  expect(done.bills.filter(row => ['integral_refund', 'pay_product_integral_back'].includes(row.eventKey)).every(row => row.linkId === String(order.id))).toBe(true);
});

it('keeps integer point and fractional product-gift residue on the final selected quantity', async () => {
  await f.db.update(storeCart).set({ cartNum: 7 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ freight: 1, giveIntegral: '0.80' }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ price: '0.15' }).where(eq(storeProductAttrValue.id, 1));
  await f.setConfig({ integral_max_num: '5' });
  const order = await create(true, [1]);
  expect(order).toMatchObject({ payPrice: '1.00', useIntegral: '5.00', gainIntegral: '5.00' });
  for (const quantity of [1, 3, 3]) {
    const refund = await apply(order.orderId, 1, quantity); await finalizeStoreOrderRefund(f.container, refund.refundId);
  }
  const done = await state();
  expect(done.bills.filter(row => row.eventKey === 'integral_refund').map(row => row.number)).toEqual(['2.00', '3.00']);
  expect(done.bills.filter(row => row.eventKey === 'pay_product_integral_back').map(row => row.number)).toEqual(['2.00', '3.00']);
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 100, nowMoney: '1.00' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
});

it('consumes the selected goods compensation independently of an Admin cash concession and automatic recovery', async () => {
  const order = await create(), first = await apply(order.orderId, 1, 1, 500);
  await finalizeStoreOrderRefund(f.container, first.refundId);
  const partial = await state();
  expect(partial.users.find(row => row.uid === 11)).toMatchObject({ integral: 120, nowMoney: '5.00' });
  expect(partial.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.30');
  const rest = await ensureAutomaticOrderRefund(f.container,
    { uid: 11, orderId: order.orderId, applyType: 1, refundReason: 'Local automatic recovery', refundExplain: '' });
  expect((await state()).refunds.find(row => row.id === rest.refundId)?.refundPrice).toBe('50.00');
  await finalizeStoreOrderRefund(f.container, rest.refundId);
  const done = await state();
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 100, nowMoney: '55.00' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
});

it('separates product gifts from actual payment-earned points and ignores later reward settings', async () => {
  f.config.order_give_integral = '2.00';
  const order = await create();
  expect((await state()).users.find(row => row.uid === 11)?.integral).toBe(310);
  f.config.order_give_integral = '999.00';
  const refund = await apply(order.orderId, 1, 1, 500); await finalizeStoreOrderRefund(f.container, refund.refundId);
  const done = await state();
  // 100 selected product points + floor(110 credited * 12.80 allocated / 55).
  expect(done.bills.filter(row => row.eventKey === 'integral_refund').map(row => row.number)).toEqual(['125.00']);
  expect(done.users.find(row => row.uid === 11)?.integral).toBe(205);
  expect(done.bills.filter(row => row.eventKey === 'order_give_integral').map(row => row.number)).toEqual(['110.00']);
});

it.each([false, true])('receipt compensates only completed line claims; an additional open application=%s', async open => {
  const order = await create(false); await ship(order.id);
  const refund = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, refund.refundId);
  if (open) await apply(order.orderId, 2);
  expect((await state()).users.find(row => row.uid === 11)?.integral).toBe(20);
  await receive(order.id);
  const done = await state();
  expect(done.users.find(row => row.uid === 11)?.integral).toBe(120);
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.30');
  expect(done.bills.filter(row => row.eventKey === 'integral_refund').map(row => row.number)).toEqual(['100.00']);
  expect(done.refunds.filter(row => row.refundType === 6)).toHaveLength(1);
});

it.each(['missing-version', 'invalid-cost', 'missing-gift', 'wrong-commission'] as const)
  ('rejects malformed line evidence %s during finalization without compensation writes', async kind => {
    const order = await create(), refund = await apply(order.orderId, 1), row = (await state()).details[0];
    const info = JSON.parse(row.cartInfo!);
    if (kind === 'missing-version') delete info.financial_version;
    if (kind === 'invalid-cost') info.costPrice = false;
    if (kind === 'missing-gift') { delete info.gain_integral; delete info.product.giveIntegral; }
    if (kind === 'wrong-commission') info.one_brokerage = '0.61';
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    const before = await state();
    await expect(finalizeStoreOrderRefund(f.container, refund.refundId)).rejects.toThrow('快照');
    expect(await state()).toEqual(before);
  });

it.each(['missing-claim', 'before-quantity', 'wrong-uid', 'paid-amount'] as const)
  ('receipt refuses corrupt completed history %s without granting/reversing income', async kind => {
    const order = await create(false); await ship(order.id);
    const refund = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, refund.refundId);
    const row = (await state()).refunds[0], info = JSON.parse(row.cartInfo!);
    if (kind === 'missing-claim') delete info.quantityReservation;
    if (kind === 'before-quantity') info.quantityReservation.items[0].beforeRefundNum = 1;
    if (kind === 'wrong-uid') await f.db.update(storeOrderRefund).set({ uid: 22 }).where(eq(storeOrderRefund.id, row.id));
    else if (kind === 'paid-amount') await f.db.update(storeOrderRefund).set({ refundedPrice: '12.79' }).where(eq(storeOrderRefund.id, row.id));
    else await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderRefund.id, row.id));
    const before = await state(); await expect(receive(order.id)).rejects.toThrow(); expect(await state()).toEqual(before);
  });

it.each(['user_bill', 'user_brokerage', 'store_order_status'])('rolls back all compensation after SQL failure in %s', async table => {
  const order = await create(), refund = await apply(order.orderId, 1), before = await state();
  await f.exec(`CREATE FUNCTION fail_line_compensation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local compensation failure'; END $$;
    CREATE TRIGGER fail_line_compensation BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_line_compensation()`);
  await expect(finalizeStoreOrderRefund(f.container, refund.refundId)).rejects.toThrow();
  expect(await state()).toEqual(before);
});

it('preserves existing available-balance caps and does not debit again on terminal replay', async () => {
  const order = await create();
  await f.db.update(user).set({ integral: 5 }).where(eq(user.uid, 11));
  await f.db.update(user).set({ brokeragePrice: '0.10' }).where(eq(user.uid, 22));
  const refund = await apply(order.orderId, 1); await finalizeStoreOrderRefund(f.container, refund.refundId);
  const done = await state();
  expect(done.users.find(row => row.uid === 11)?.integral).toBe(20);
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('0.00');
  expect(done.bills.filter(row => row.eventKey === 'integral_refund').map(row => row.number)).toEqual(['5.00']);
  expect(done.brokerages.filter(row => row.type === 'refund').map(row => row.number)).toEqual(['0.10']);
  await finalizeStoreOrderRefund(f.container, refund.refundId); expect(await state()).toEqual(done);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('locks unselected cart evidence before either settlement user and reads it after the wait', async () => {
  const order = await create(), refund = await apply(order.orderId, 1), row = (await state()).details[1];
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, finalizer]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${row.id} FOR UPDATE`);
    const pending = outcome(finalizeStoreOrderRefund(createContainerFromDb(finalizer.db), refund.refundId));
    await waitForFinanceBlock(f.db, finalizer.pid, holder.pid);
    // NOWAIT proves the cart wait precedes BOTH the customer and referrer locks.
    await holder.exec('SELECT uid FROM "user" WHERE uid IN (11,22) ORDER BY uid FOR UPDATE NOWAIT');
    const info = JSON.parse(row.cartInfo!); info.one_brokerage = '3.01';
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('快照');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes independent duplicate finalizers into one compensation set', async () => {
  const order = await create(), refund = await apply(order.orderId, 1);
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${order.id} FOR UPDATE`);
    const a = outcome(finalizeStoreOrderRefund(createContainerFromDb(first.db), refund.refundId));
    await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(finalizeStoreOrderRefund(createContainerFromDb(second.db), refund.refundId));
    await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT'); expect(await a).toEqual({ ok: true, value: 'completed' });
    expect(await b).toEqual({ ok: true, value: 'already-completed' });
  });
  const done = await state();
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 120, nowMoney: '12.80' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.30');
  expect(done.bills.filter(row => row.eventKey === 'integral_refund')).toHaveLength(1);
  expect(done.brokerages.filter(row => row.type === 'refund')).toHaveLength(1);
}, 15_000);

it('keeps provider cash/payment identity unchanged through UNKNOWN recovery while using line compensation', async () => {
  const order = await create();
  await f.db.update(storeOrder).set({ payType: 'weixin', tradeNo: 'local-line-compensation-trade' }).where(eq(storeOrder.id, order.id));
  const refund = await apply(order.orderId, 1), service = new StoreOrderRefundService(f.container, f.env);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('Local timeout'));
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS' });
  await expect(service.agreeRefund(refund.refundId)).rejects.toThrow('结果未知');
  const expected = { outTradeNo: order.orderId, transactionId: 'local-line-compensation-trade',
    outRefundNo: `CNSR${refund.refundId}`, refundAmount: 1280, totalAmount: 5500 };
  expect(request).toHaveBeenCalledWith(expect.objectContaining(expected));
  expect((await state()).users.find(row => row.uid === 11)?.integral).toBe(200);
  expect(await service.agreeRefund(refund.refundId)).toMatchObject({ completed: true });
  expect(query).toHaveBeenCalledWith(expect.objectContaining(expected)); expect(request).toHaveBeenCalledTimes(1);
  const done = await state();
  expect(done.payments[0]).toMatchObject({ storeOrderId: order.id, refundId: refund.refundId, requestAmount: 1280, totalAmount: 5500, providerStatus: 'SUCCESS' });
  expect(done.users.find(row => row.uid === 11)).toMatchObject({ integral: 120, nowMoney: '0.00' });
  expect(done.users.find(row => row.uid === 22)?.brokeragePrice).toBe('3.30');
  expect(await service.agreeRefund(refund.refundId)).toMatchObject({ completed: true }); expect(await state()).toEqual(done);
});

it('uses exact integer products for large actual income and rejects unsupported positive income', () => {
  expect(targetLineCompensation(999999999999, { total: 999999999999, refunded: 333333333333 })).toBe(333333333333);
  expect(targetLineCompensation(5, { total: 7, refunded: 7 })).toBe(5);
  expect(() => targetLineCompensation(1, { total: 0, refunded: 0 })).toThrow('快照');
  expect(() => targetLineCompensation(1, { total: 1, refunded: 2 })).toThrow('快照');
  expect(() => targetLineCompensation(1, undefined)).toThrow('快照');
});
