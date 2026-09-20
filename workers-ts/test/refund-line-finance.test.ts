import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyOrderRefund, ensureAutomaticOrderRefund, finalizeStoreOrderRefund, quoteOrderRefundApplication, StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { AdminMobileOrderOperationService } from '../src/services/admin/AdminMobileOrderOperationService';
import { SupplierFulfillmentService } from '../src/services/supplier/SupplierFulfillmentService';
import { quoteAdminRefundCreation } from '../src/services/admin/AdminRefundCreationQuoteService';
import { createAdminRefundApplication } from '../src/services/admin/AdminRefundCreationService';
import { ADMIN_REFUND_CREATION_SQL } from '../src/migrations/adminRefundCreation';
import { INVOICE_EVIDENCE_SQL } from '../src/migrations/invoiceEvidence';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { md5 } from '../src/utils/jwt';
import { createContainerFromDb } from '../src/lib/di';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeProductAttrValue, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, systemAdmin } from '../src/models/schema';

let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
let applicationNumber = 0;
const create = async (cartIds = [1, 2], price?: string, useIntegral = false) => {
  const result = await StoreOrderCreateService.createWithRuntime(f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'checkout_for_refund_finance' },
    { uid: 11, key: 'refund_line_finance', cartIds, addressId: 11, userIp: '127.0.0.1', useIntegral });
  if (price !== undefined) await new AdminMobileOrderOperationService(f.container).changePrice(100, { order_id: result.orderId, price });
  await f.db.update(storeOrder).set({ paid: 1, payType: 'yue' }).where(eq(storeOrder.orderId, result.orderId));
  return result.orderId;
};
const selected = (cartId = 1, cartNum = 1) => [{ cartId, cartNum }];
const quote = (orderId: string, cartSelections: Array<{ cartId: number; cartNum: number }> | undefined = selected(), container = f.container) =>
  quoteOrderRefundApplication(container, { uid: 11, orderId, applyType: 1, cartSelections }, 0);
const apply = (orderId: string, cartSelections = selected(), price?: number, container = f.container) => applyOrderRefund(container,
  { uid: 11, orderId, applyType: price === undefined ? 1 : 4, refundReason: 'Synthetic line refund', refundExplain: '',
    applicationOrderId: `line_refund_${++applicationNumber}`, cartSelections,
    ...(price === undefined ? {} : { privilegedActor: 'admin', requestedRefundAmountCents: price, authorizeApplication: async () => {} }) });
const state = async () => ({ ...await f.snapshot(), carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
  refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id), statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  payments: await f.db.select().from(storeOrderRefundPayment).orderBy(storeOrderRefundPayment.id) });
beforeEach(async () => {
  applicationNumber = 0;
  f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
    storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage, systemAdmin]);
  await f.exec('CREATE UNIQUE INDEX refund_line_fixture_event ON store_order_outbox(event_key)');
  await f.exec(INVOICE_EVIDENCE_SQL);
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.db.update(storeProduct).set({ freight: 2, postage: '3.00' }).where(eq(storeProduct.id, 70));
  await f.db.insert(storeProduct).values({ id: 71, storeName: 'Free freight line', price: '30.00', stock: 8, isShow: 1, freight: 1 });
  await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'free0071', suk: 'Standard', price: '30.00', cost: '20.00', stock: 8 });
  await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'free0071', cartNum: 1, status: 1, isNew: 1 });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external I/O'));
}, 30_000);
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });

it.each([{ cartId: 1, expected: '13.00' }, { cartId: 2, expected: '30.00' }])
  ('quotes actual line freight for cart $cartId, not a merchandise-weight share of total payment', async ({ cartId, expected }) => {
    const orderId = await create(), before = await f.snapshot();
    const quote = await quoteOrderRefundApplication(f.container,
      { uid: 11, orderId, applyType: 1, cartSelections: [{ cartId, cartNum: 1 }] }, 0);
    expect(quote.quotedPrice).toBe(expected);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.db.select().from(storeOrderRefund)).toEqual([]);
  });

it('uses the same line price for quote, application and actual balance settlement across every remaining item', async () => {
  const orderId = await create();
  for (const [cartId, price] of [[1, '13.00'], [1, '13.00'], [2, '30.00']] as const) {
    const q = await quote(orderId, selected(cartId)), a = await apply(orderId, selected(cartId));
    expect(q.quotedPrice).toBe(price);
    expect((await state()).refunds.find(row => row.id === a.refundId)?.refundPrice).toBe(price);
    expect(await finalizeStoreOrderRefund(f.container, a.refundId)).toBe('completed');
    const done = await state();
    expect(await finalizeStoreOrderRefund(f.container, a.refundId)).toBe('already-completed');
    expect(await state()).toEqual(done);
  }
  const done = await state(); expect(done.users[0].nowMoney).toBe('56.00');
  expect(done.orders[0]).toMatchObject({ refundPrice: '56.00', refundStatus: 2 });
  expect(done.products.map(row => row.stock)).toEqual([8, 8]);
  expect(done.bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(3);
});

it('replays per-line four-place truncation over repeated partial refunds, preserving the final residue', async () => {
  await f.db.update(storeCart).set({ cartNum: 7 }).where(eq(storeCart.id, 1));
  await f.db.update(storeProduct).set({ freight: 1 }).where(eq(storeProduct.id, 70));
  await f.db.update(storeProductAttrValue).set({ price: '0.15' }).where(eq(storeProductAttrValue.id, 1));
  await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '5' });
  const orderId = await create([1], undefined, true);
  for (const [quantity, price] of [[1, '0.14'], [3, '0.42'], [3, '0.44']] as const) {
    expect((await quote(orderId, selected(1, quantity))).quotedPrice).toBe(price);
    const a = await apply(orderId, selected(1, quantity)); await finalizeStoreOrderRefund(f.container, a.refundId);
  }
  const done = await state(); expect(done.users[0]).toMatchObject({ nowMoney: '1.00', integral: 100 });
  expect(done.orders[0]).toMatchObject({ payPrice: '1.00', refundPrice: '1.00', backIntegral: '5.00' });
});

it.each([false, true])('does not transfer an Admin concession to another goods quote; automatic completion=%s', async automatic => {
  const orderId = await create(), a = await apply(orderId, selected(), 500);
  await finalizeStoreOrderRefund(f.container, a.refundId);
  expect((await quote(orderId, selected(2))).quotedPrice).toBe('30.00');
  expect((await quote(orderId, [])).quotedPrice).toBe('43.00');
  const remainder = automatic
    ? await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId, applyType: 1, refundReason: 'Automatic full recovery', refundExplain: '' })
    : await apply(orderId, [{ cartId: 1, cartNum: 1 }, { cartId: 2, cartNum: 1 }]);
  expect((await state()).refunds.find(row => row.id === remainder.refundId)?.refundPrice).toBe(automatic ? '51.00' : '43.00');
  await finalizeStoreOrderRefund(f.container, remainder.refundId);
  expect((await state()).users[0].nowMoney).toBe(automatic ? '56.00' : '48.00');
});

it.each([{ price: '28.00', expected: '6.50' }, { price: '100.00', expected: '23.21' }])
  ('quotes actual admin repricing $price with the same four-place raw-payment ratio', async ({ price, expected }) => {
    const orderId = await create([1, 2], price);
    expect((await quote(orderId)).quotedPrice).toBe(expected);
    const a = await apply(orderId); await finalizeStoreOrderRefund(f.container, a.refundId);
    expect((await state()).users[0].nowMoney).toBe(expected);
  });

it('binds actual Admin quotation and its immutable creation receipt to the new line amount', async () => {
  await f.db.insert(systemAdmin).values({ id: 100, account: 'synthetic-admin', pwd: 'synthetic-digest', adminType: 1, level: 0 });
  await f.exec(ADMIN_REFUND_CREATION_SQL);
  await create(); const order = (await state()).orders[0];
  const actor = { id: 100, authVersion: md5('synthetic-digest'), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const q = await quoteAdminRefundCreation(f.container, actor, { version: 'admin-refund-creation-quote-v1', orderId: order.id, mode: 'items', items: selected() });
  expect(q.quotedPrice).toBe('13.00');
  const key = crypto.randomUUID(), input = { version: 'admin-refund-creation-v1', review: q.review,
    mode: q.mode, items: q.items, quotedPrice: q.quotedPrice, refundPrice: '13.00', reason: 'Synthetic line quote', quoteFingerprint: q.quoteFingerprint };
  const created = await createAdminRefundApplication(f.container, actor, key, input);
  const before = await state();
  expect(await createAdminRefundApplication(f.container, actor, key, input)).toMatchObject({ replayed: true, receipt: created.receipt });
  expect(await state()).toEqual(before);
  expect(before.refunds[0]).toMatchObject({ refundPrice: '13.00', refundNum: 1 });
});

it('quotes a delivered v1 child using its own stored line and identity', async () => {
  await create(); const order = (await state()).orders[0];
  const split = await new SupplierFulfillmentService(f.container, f.env).splitDelivery(0, order.id,
    { deliveryType: 'express', deliveryName: 'Synthetic', deliveryCode: 'local', deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 },
    [{ cartId: '1', cartNum: 1 }]);
  const done = await state(), child = done.orders.find(row => row.id === split.order_id)!;
  const cart = done.carts.find(row => row.oid === child.id)!;
  expect((await quote(child.orderId, selected(Number(cart.cartId)))).quotedPrice).toBe('13.00');
});

it('cancellation releases the claim and leaves the original line quote intact', async () => {
  const orderId = await create(), a = await apply(orderId);
  await new StoreOrderRefundService(f.container, f.env).cancelApply(11, a.refundId);
  expect((await quote(orderId)).quotedPrice).toBe('13.00');
  expect((await state()).carts[0].refundNum).toBe(0);
});

it.each(['missing-freight', 'missing-version', 'invalid-money', 'counter', 'order-refund'] as const)
  ('rejects corrupt financial evidence %s for both partial and whole quotations without writes', async kind => {
    const orderId = await create(), [row] = (await state()).carts;
    const info = JSON.parse(row.cartInfo!);
    if (kind === 'missing-freight') delete info.raw_postage_price;
    else if (kind === 'missing-version') delete info.financial_version;
    else if (kind === 'invalid-money') info.postage_price = false;
    if (kind === 'counter') await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.id, row.id));
    else if (kind === 'order-refund') await f.db.update(storeOrder).set({ refundPrice: '0.01' }).where(eq(storeOrder.orderId, orderId));
    else await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    const before = await state();
    await expect(quote(orderId)).rejects.toThrow('快照');
    await expect(quote(orderId, [])).rejects.toThrow('快照');
    await expect(apply(orderId)).rejects.toThrow('快照'); expect(await state()).toEqual(before);
  });

it.each(['missing-claim', 'before-quantity', 'paid-amount', 'wrong-uid'] as const)
  ('refuses to reprice inconsistent completed history %s', async kind => {
    const orderId = await create(), a = await apply(orderId); await finalizeStoreOrderRefund(f.container, a.refundId);
    const refund = (await state()).refunds[0], info = JSON.parse(refund.cartInfo!);
    if (kind === 'missing-claim') delete info.quantityReservation;
    if (kind === 'before-quantity') info.quantityReservation.items[0].beforeRefundNum = 1;
    if (kind === 'paid-amount') await f.db.update(storeOrderRefund).set({ refundPrice: '12.00', refundedPrice: '12.00' }).where(eq(storeOrderRefund.id, a.refundId));
    else if (kind === 'wrong-uid') await f.db.update(storeOrderRefund).set({ uid: 22 }).where(eq(storeOrderRefund.id, a.refundId));
    else await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderRefund.id, a.refundId));
    const before = await state(); await expect(quote(orderId, selected(2))).rejects.toThrow(); expect(await state()).toEqual(before);
  });

it('rolls back the new line-priced application and its quantity claim after late SQL failure', async () => {
  const orderId = await create(), before = await state();
  await f.exec("CREATE FUNCTION fail_refund_line_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refund line audit failure'; END $$; CREATE TRIGGER fail_refund_line_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION fail_refund_line_audit()");
  await expect(apply(orderId)).rejects.toThrow(); expect(await state()).toEqual(before);
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('quotes only the financial evidence read after an independent cart lock wait', async () => {
  const orderId = await create(), [row] = (await state()).carts, info = JSON.parse(row.cartInfo!);
  info.postage_price = '0.00';
  let edited: Awaited<ReturnType<typeof state>> | undefined;
  await withFinancePeers(f.db, async ([holder, buyer]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order_cart_info WHERE id=${row.id} FOR UPDATE`);
    const pending = outcome(quote(orderId, selected(), createContainerFromDb(buyer.db)));
    await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
    await holder.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, row.id));
    await holder.exec('COMMIT'); edited = await state();
    const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('快照');
  });
  expect(await state()).toEqual(edited);
}, 15_000);

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes competing applications into one correctly priced quantity claim', async () => {
  const orderId = await create(), order = (await state()).orders[0];
  await withFinancePeers(f.db, async ([holder, first, second]) => {
    await holder.exec(`BEGIN; SELECT id FROM store_order WHERE id=${order.id} FOR UPDATE`);
    const a = outcome(apply(orderId, selected(), undefined, createContainerFromDb(first.db)));
    await waitForFinanceBlock(f.db, first.pid, holder.pid);
    const b = outcome(apply(orderId, selected(), undefined, createContainerFromDb(second.db)));
    await waitForFinanceBlock(f.db, second.pid, first.pid);
    await holder.exec('COMMIT'); const one = await a, two = await b;
    expect(one.ok).toBe(true); expect(two.ok).toBe(false); if (!two.ok) expect(String(two.error)).toContain('进行中');
  });
  const done = await state(); expect(done.refunds).toHaveLength(1);
  expect(done.refunds[0].refundPrice).toBe('13.00'); expect(done.carts[0].refundNum).toBe(1);
}, 15_000);

it('preserves the original new line amount and payment identity through UNKNOWN provider recovery', async () => {
  const orderId = await create();
  await f.db.update(storeOrder).set({ payType: 'weixin', tradeNo: 'synthetic-trade' }).where(eq(storeOrder.orderId, orderId));
  const a = await apply(orderId), service = new StoreOrderRefundService(f.container, f.env);
  const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockRejectedValue(Error('synthetic timeout'));
  const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS' });
  await expect(service.agreeRefund(a.refundId)).rejects.toThrow('结果未知');
  const expected = { outTradeNo: orderId, transactionId: 'synthetic-trade', outRefundNo: `CNSR${a.refundId}`, refundAmount: 1300, totalAmount: 5600 };
  expect(request).toHaveBeenCalledWith(expect.objectContaining(expected));
  expect((await state()).payments[0]).toMatchObject({ providerStatus: 'UNKNOWN', requestAmount: 1300, totalAmount: 5600 });
  expect(await service.agreeRefund(a.refundId)).toMatchObject({ completed: true });
  expect(query).toHaveBeenCalledWith(expect.objectContaining(expected)); expect(request).toHaveBeenCalledTimes(1);
  const done = await state(); expect(done.refunds[0]).toMatchObject({ refundType: 6, refundedPrice: '13.00' });
  expect(await service.agreeRefund(a.refundId)).toMatchObject({ completed: true }); expect(await state()).toEqual(done);
});
