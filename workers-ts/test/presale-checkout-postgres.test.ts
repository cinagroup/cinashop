import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { cartAdd, cartList, orderCreate, orderCancel } from '../src/controllers/api/v1/OrderController';
import { cancelStoreOrder, StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { preparePresalePurchase } from '../src/services/activity/PresalePurchaseSnapshot';
import { createPcCouponFixture } from './helpers/pcCouponFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';
import { storeCart, storeProduct, storeProductAttrValue, user, systemUserLevel,
  storeOrderCartInfo, storeOrderStatus, storeCouponUser, printDocument, userBill } from '../src/models/schema';

// Actual checkout requires the commissioned PostgreSQL capability. Do not fake
// it in PGlite or inherit DATABASE_URL/Hyperdrive/production identity.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('presale quote/create on owned PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof createPcCouponFixture>>, sequence: number;
  const input = { cartIds: [1], type: 6, addressId: 11, shippingType: 1, useIntegral: false };
  const stamp = () => Math.floor(Date.now() / 1000);
  beforeEach(async () => {
    f = await createPcCouponFixture([systemUserLevel]); sequence = 0;
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: stamp() - 3600,
      presaleEndTime: stamp() + 3600, presaleDay: 7, isLimit: 1, limitType: 1, limitNum: 2 });
    await f.db.update(storeCart).set({ type: 6 });
    Object.assign(f.env, { SEQUENCE: {
      idFromName: () => 'owned-local-presale', get: () => ({ fetch: async () => new Response(`presale_local_${++sequence}`) }),
    } });
    f.app.post('/api/cart/add', cartAdd); f.app.post('/api/order/create/:key', orderCreate); f.app.post('/api/order/cancel', orderCancel);
    f.app.get('/api/cart/list', cartList);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await f?.close(); }, 30_000);
  type Receipt = { orderKey: string; quoteToken: string; priceGroup: { pay_price: string } };
  async function post<T>(path: string, body: object) {
    return (await f.app.request(`/api${path}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env)).json() as Promise<{ status: number; msg: string; data: T }>;
  }
  async function confirm(selection: object = {}) {
    const response = await post<Receipt>('/order/confirm', { ...input, ...selection });
    expect(response.status, response.msg).toBe(200); return response.data;
  }
  const quote = (selection: Partial<CreateOrderParams> = {}) => new StoreOrderCreateService(f.container, f.env)
    .quoteOrder({ ...input, uid: 11, ...selection });
  const create = (db: DbClient, receipt: Receipt, selection: Partial<CreateOrderParams> = {}, beforeTx?: () => Promise<void>) =>
    StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true,
      nextOrderId: async () => { await beforeTx?.(); return `presale_core_${++sequence}`; },
    }, { ...input, uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1', ...selection });
  const state = async () => ({ ...await f.snapshot(), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus), coupons: await f.db.select().from(storeCouponUser), prints: await f.db.select().from(printDocument),
    origins: Array.from(await f.db.execute(sql`SELECT * FROM public.store_order_purchase_origin ORDER BY order_id`)) });

  it.each([true, 1, 9000])('quotes server-calculated points for presale, never the client quantity: %s', async useIntegral => {
    const before = await state();
    expect(await quote({ useIntegral })).toMatchObject({ totalCents: 1800, payPostageCents: 300,
      deductionCents: 50, usedIntegralPoints: 50, surplusIntegralPoints: 50, payCents: 2050,
      couponPriceCents: 0, firstOrderPriceCents: 0 });
    expect(await state()).toEqual(before);
  });

  it('keeps member cart display, confirmation, points ledger and cancellation consistent', async () => {
    const response = await f.app.request('/api/cart/list?scope=buy&ids=1', { headers: { 'x-fixture-user': '11' } }, f.env);
    expect(await response.json()).toMatchObject({ status: 200, data: [{ truePrice: '9.00', trueSumPrice: '18.00',
      priceType: 'member', productInfo: { price: '10' }, sumPrice: '20.00' }] });
    const before = await state(), receipt = await confirm({ useIntegral: true });
    expect(receipt.priceGroup.pay_price).toBe('20.50');
    const created = await create(f.db, receipt, { useIntegral: true }), purchased = await state();
    expect(purchased.orders).toMatchObject([{ orderId: created.orderId, type: 6, totalPrice: '18.00',
      payPrice: '20.50', payPostage: '3.00', deductionPrice: '0.50', useIntegral: '50.00' }]);
    expect(purchased.users[0].integral).toBe(50);
    expect(purchased.origins).toMatchObject([{ order_type: 6, total_num: 2, used_points: '50' }]);
    expect(purchased.bills).toMatchObject([{ eventKey: 'order_integral_deduction', pm: 0, number: '50.00', balance: '50.00' }]);
    expect(JSON.parse(purchased.details[0].cartInfo!)).toMatchObject({ use_integral: '50', integral_price: '0.50', sum_true_price: '17.50' });
    expect(await create(f.db, receipt, { useIntegral: true })).toEqual(created); expect(await state()).toEqual(purchased);
    await f.db.update(storeProduct).set({ isPresaleProduct: 0, presaleEndTime: 1 });
    await f.setConfig({ integral_ratio: '0.50', integral_ratio_status: '0' });
    expect(await post('/order/cancel', { order_id: created.orderId })).toMatchObject({ status: 200 });
    const cancelled = await state();
    expect(cancelled.origins).toEqual(purchased.origins);
    expect(cancelled.users).toEqual(before.users); expect(cancelled.skus).toEqual(before.skus);
    expect(cancelled.bills.map(bill => ({ event: bill.eventKey, number: bill.number, pm: bill.pm }))).toEqual([
      { event: 'order_integral_deduction', number: '50.00', pm: 0 }, { event: 'order_cancel_integral_back', number: '50.00', pm: 1 },
    ]);
    expect(await post('/order/cancel', { order_id: created.orderId })).toMatchObject({ status: 400 });
    expect(await state()).toEqual(cancelled);
  });

  it('caps presale points by payable percentage with a fractional exchange ratio through cancellation', async () => {
    await f.setConfig({ integral_ratio: '0.015', integral_max_type: '2', integral_max_rate: '3' });
    const before = await state();
    expect(await quote({ useIntegral: true })).toMatchObject({ totalCents: 1800,
      deductionCents: 54, usedIntegralPoints: 36, surplusIntegralPoints: 64, payCents: 2046 });
    expect(await state()).toEqual(before);
    const receipt = await confirm({ useIntegral: true });
    expect(receipt.priceGroup.pay_price).toBe('20.46');
    const created = await create(f.db, receipt, { useIntegral: true });
    const purchased = await state();
    expect(purchased.orders).toMatchObject([{ useIntegral: '36.00', deductionPrice: '0.54', payPrice: '20.46' }]);
    expect(purchased.users[0].integral).toBe(64);
    expect(purchased.origins).toMatchObject([{ used_points: '36' }]);
    expect(purchased.bills).toMatchObject([{ eventKey: 'order_integral_deduction', number: '36.00', balance: '64.00' }]);
    expect(JSON.parse(purchased.details[0].cartInfo!)).toMatchObject({ use_integral: '36', integral_price: '0.54' });
    await f.setConfig({ integral_ratio: '0', integral_ratio_status: '0' });
    await cancelStoreOrder(f.container, { uid: 11, orderId: created.orderId });
    const cancelled = await state();
    expect(cancelled.users).toEqual(before.users);
    expect(cancelled.bills.map(bill => ({ event: bill.eventKey, number: bill.number, pm: bill.pm }))).toEqual([
      { event: 'order_integral_deduction', number: '36.00', pm: 0 },
      { event: 'order_cancel_integral_back', number: '36.00', pm: 1 },
    ]);
    expect(cancelled.origins).toEqual(purchased.origins);
  });

  it('does not spend frozen points and restores only the original deducted amount', async () => {
    await f.db.insert(userBill).values({ uid: 11, pm: 1, category: 'integral', type: 'local_frozen', number: '80.00', frozenTime: 2147483647 });
    const receipt = await confirm({ useIntegral: true }); expect(receipt.priceGroup.pay_price).toBe('20.80');
    const created = await create(f.db, receipt, { useIntegral: true });
    const paid = await state(); expect(paid.users[0].integral).toBe(80); expect(paid.orders[0].useIntegral).toBe('20.00');
    await cancelStoreOrder(f.container, { uid: 11, orderId: created.orderId });
    expect((await state()).users[0].integral).toBe(100);
    expect((await state()).bills.filter(bill => bill.eventKey === 'order_cancel_integral_back')[0].number).toBe('20.00');
  });

  it.each([
    ['cancel', 'cancel'], ['cancel', 'delete'], ['delete', 'cancel'], ['delete', 'delete'],
  ] as const)('returns presale points once when %s and %s cancellation actions wait for the same order', async (firstAction, secondAction) => {
    const before = await state(), receipt = await confirm({ useIntegral: true });
    const created = await create(f.db, receipt, { useIntegral: true }), purchased = await state();
    expect(purchased.users[0].integral).toBe(50);
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN');
      await holder.db.execute(sql`SELECT id FROM store_order WHERE id=${purchased.orders[0].id} FOR UPDATE`);
      const cancelling = outcome(cancelStoreOrder(createContainerFromDb(first.db), { uid: 11, orderId: created.orderId }, firstAction));
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const competing = outcome(cancelStoreOrder(createContainerFromDb(second.db), { uid: 11, orderId: created.orderId }, secondAction));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      expect(await state()).toEqual(purchased);
      await holder.exec('COMMIT');
      expect((await cancelling).ok).toBe(true);
      const lost = await competing;
      expect(lost.ok).toBe(false); if (!lost.ok) expect(lost.error.message).toMatch(/订单状态不允许取消/);
    });
    const cancelled = await state();
    expect(cancelled.users).toEqual(before.users);
    expect(cancelled.products).toEqual(before.products); expect(cancelled.skus).toEqual(before.skus);
    expect(cancelled.details).toEqual(purchased.details); expect(cancelled.coupons).toEqual(before.coupons);
    expect(cancelled.prints).toEqual(purchased.prints);
    expect(cancelled.orders).toMatchObject([{ paid: 0, status: -2, isDel: 1, useIntegral: '50.00' }]);
    expect(cancelled.carts[0].isPay).toBe(0);
    expect(cancelled.bills.map(bill => ({ event: bill.eventKey, number: bill.number, pm: bill.pm }))).toEqual([
      { event: 'order_integral_deduction', number: '50.00', pm: 0 },
      { event: 'order_cancel_integral_back', number: '50.00', pm: 1 },
    ]);
    expect(cancelled.statuses.filter(row => row.changeType === 'cancel')).toHaveLength(1);
    expect(cancelled.statuses.filter(row => row.changeType === 'remove_order')).toHaveLength(firstAction === 'delete' ? 1 : 0);
  }, 15_000);

  it.each(['cancel', 'delete'] as const)('does not return presale points when a paid transition commits while %s waits', async action => {
    const receipt = await confirm({ useIntegral: true }), created = await create(f.db, receipt, { useIntegral: true });
    const purchased = await state();
    await withFinancePeers(f.db, async ([payer, canceller]) => {
      // Synthetic paid transition tests the cancellation boundary, not a provider callback.
      await payer.exec('BEGIN');
      await payer.db.execute(sql`UPDATE store_order SET paid=1 WHERE id=${purchased.orders[0].id}`);
      const cancelling = outcome(cancelStoreOrder(createContainerFromDb(canceller.db), { uid: 11, orderId: created.orderId }, action));
      await waitForFinanceBlock(f.db, canceller.pid, payer.pid);
      expect(await state()).toEqual(purchased);
      await payer.exec('COMMIT');
      const result = await cancelling;
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toMatch(/已支付订单不能取消/);
    });
    expect(await state()).toEqual({ ...purchased, orders: purchased.orders.map(order => ({ ...order, paid: 1 })) });
  }, 15_000);

  it.each(['not-requested', 'disabled', 'empty-balance', 'zero-ratio'] as const)('has no points debit when %s', async scenario => {
    if (scenario === 'disabled') await f.setConfig({ integral_ratio_status: '0' });
    if (scenario === 'zero-ratio') await f.setConfig({ integral_ratio: '0' });
    if (scenario === 'empty-balance') await f.db.update(user).set({ integral: 0 });
    const selection = { useIntegral: scenario !== 'not-requested' }, before = await state();
    const receipt = await confirm(selection); expect(receipt.priceGroup.pay_price).toBe('21.00');
    await create(f.db, receipt, selection); const after = await state();
    expect(after.users).toEqual(before.users); expect(after.bills).toEqual(before.bills);
    expect(after.orders[0]).toMatchObject({ useIntegral: '0.00', deductionPrice: '0.00' });
  });

  it.each(['balance', 'ratio'] as const)('rejects a changed points %s after receipt verification without retaining business writes', async target => {
    const receipt = await confirm({ useIntegral: true }); let before: Awaited<ReturnType<typeof state>>;
    await expect(create(f.db, receipt, { useIntegral: true }, async () => {
      if (target === 'balance') await f.db.update(user).set({ integral: 5 });
      else await f.setConfig({ integral_ratio: '0.02' });
      before = await state();
    })).rejects.toThrow();
    expect(await state()).toEqual(before!);
  });

  it.each(['create', 'cancel'] as const)('rolls back points, stock and audit rows on a late %s SQL failure', async operation => {
    const receipt = await confirm({ useIntegral: true });
    const order = operation === 'cancel' ? await create(f.db, receipt, { useIntegral: true }) : null;
    const before = await state(), transaction = f.db.transaction.bind(f.db);
    const intercept: typeof f.db.transaction = (fn, config) => transaction(async tx => {
      await fn(tx); await tx.execute(sql`SELECT 1 / 0`); throw Error('unreachable');
    }, config);
    const db = new Proxy(f.db, { get(target, key, receiver) { return key === 'transaction' ? intercept : Reflect.get(target, key, receiver); } });
    await expect(order ? cancelStoreOrder(createContainerFromDb(db), { uid: 11, orderId: order.orderId })
      : create(db, receipt, { useIntegral: true })).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('serializes two different cart receipts against the same points balance and requires the loser to reconfirm', async () => {
    await f.db.update(user).set({ integral: 50 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', type: 6, cartNum: 2, isNew: 1, status: 1 });
    const firstReceipt = await confirm({ useIntegral: true }), secondReceipt = await confirm({ cartIds: [2], useIntegral: true });
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const buying = outcome(create(first.db, firstReceipt, { useIntegral: true }));
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const competing = outcome(create(second.db, secondReceipt, { cartIds: [2], useIntegral: true }));
      await waitForFinanceBlock(f.db, second.pid, first.pid); await holder.exec('COMMIT');
      expect((await buying).ok).toBe(true); const lost = await competing;
      expect(lost.ok).toBe(false); if (!lost.ok) expect(lost.error.message).toMatch(/重新确认/);
    });
    const after = await state(); expect(after.users[0].integral).toBe(0); expect(after.orders).toHaveLength(1);
    expect(after.bills).toHaveLength(1); expect(after.products[0].stock).toBe(6);
    const refreshed = await confirm({ cartIds: [2], useIntegral: true }); expect(refreshed.priceGroup.pay_price).toBe('21.00');
    await create(f.db, refreshed, { cartIds: [2], useIntegral: true });
    expect((await state()).bills).toHaveLength(1); expect((await state()).users[0].integral).toBe(0);
  }, 15000);

  it('does not reverse user/SKU locks when cancelling while another points checkout owns the user', async () => {
    const oldReceipt = await confirm({ useIntegral: true }), oldOrder = await create(f.db, oldReceipt, { useIntegral: true });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', type: 6, cartNum: 2, isNew: 1, status: 1 });
    const receipt = await confirm({ cartIds: [2], useIntegral: true });
    await withFinancePeers(f.db, async ([holder, buyer, canceller]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt, { cartIds: [2], useIntegral: true }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const before = await state();
      const cancellation = await outcome(cancelStoreOrder(createContainerFromDb(canceller.db), { uid: 11, orderId: oldOrder.orderId }));
      expect(cancellation.ok).toBe(false); if (!cancellation.ok) expect(cancellation.error.message).toMatch(/积分余额正在更新/);
      expect(await state()).toEqual(before);
      await holder.exec('COMMIT'); expect((await buying).ok).toBe(true);
    });
    await cancelStoreOrder(f.container, { uid: 11, orderId: oldOrder.orderId });
    const after = await state(); expect(after.users[0].integral).toBe(50); expect(after.products[0].stock).toBe(6);
    expect(after.bills.filter(bill => bill.eventKey === 'order_cancel_integral_back')).toHaveLength(1);
  }, 15000);

  it('runs legacy immediate-buy -> confirm -> create -> cancel with member price, no coupon/first-order promotion', async () => {
    await f.db.delete(storeCart);
    const added = await post<{ cartId: number }>('/cart/add', { productId: 70, uniqueId: 'qared001', cartNum: 2, new: 1 });
    expect(added).toMatchObject({ status: 200, data: { cartId: 1 } });
    f.config.first_order_status = '1';
    const before = await state(), receipt = await confirm({ type: undefined, couponId: 41 });
    expect(receipt.priceGroup.pay_price).toBe('21.00');
    expect(await quote({ couponId: 41 })).toMatchObject({ rawTotalCents: 2000, totalCents: 1800, payCents: 2100,
      memberDiscountCents: 200, couponPriceCents: 0, firstOrderPriceCents: 0, usedIntegralPoints: 0, deductionCents: 0 });
    const created = await post<{ orderId: string }>(`/order/create/${receipt.orderKey}`, {
      addressId: 11, shippingType: 1, couponId: 41, quoteToken: receipt.quoteToken,
    });
    expect(created.status, created.msg).toBe(200);
    const purchased = await state();
    expect(purchased.orders).toMatchObject([{ type: 6, activityId: 0, paid: 0, payPrice: '21.00', useIntegral: '0.00' }]);
    expect(purchased.products[0].stock).toBe(6); expect(purchased.skus[0].stock).toBe(6);
    const snapshot = JSON.parse(purchased.details[0].cartInfo!);
    expect(snapshot.presale).toEqual({ version: 'presale-full-payment-v1', productId: 70,
      startsAt: before.products[0].presaleStartTime, endsAt: before.products[0].presaleEndTime,
      shippingDaysAfterEnd: 7, paidMemberOnly: false, perOrderLimit: 2 });
    expect(snapshot).toMatchObject({ price_type: 'member', vip_truePrice: '1.00' });
    expect(purchased.coupons).toEqual(before.coupons); expect(purchased.users).toEqual(before.users); expect(purchased.bills).toEqual([]);
    // Current catalogue edits cannot rewrite an order's promise or prevent replay/cancellation.
    await f.db.update(storeProduct).set({ presaleEndTime: stamp() - 1, presaleDay: 99, isPresaleProduct: 0 });
    expect(await post(`/order/create/${receipt.orderKey}`, {})).toMatchObject({ status: 200, data: created.data });
    expect(sequence).toBe(1);
    expect(await post('/order/cancel', { order_id: created.data.orderId })).toMatchObject({ status: 200 });
    const cancelled = await state();
    expect(cancelled.products[0].stock).toBe(8); expect(cancelled.skus).toEqual(before.skus);
    expect(cancelled.carts[0].isPay).toBe(0); expect(cancelled.users).toEqual(before.users);
    expect(JSON.parse(cancelled.details[0].cartInfo!).presale).toEqual(snapshot.presale);
  });

  it('applies an active level discount to type6 while retaining paid-member freight benefits', async () => {
    await f.setConfig({ member_func_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 1, discount: '80.00', isShow: 1, isDel: 0 });
    await f.db.update(user).set({ levelStatus: 1, level: 1 });
    expect(await quote()).toMatchObject({ totalCents: 1600, payCents: 1900, levelDiscountCents: 400, paidMemberDiscountCents: 0 });
  });

  it.each([
    { isPresaleProduct: 0 }, { isShow: 0 }, { isVerify: 0 }, { productType: 3 },
    { presaleStartTime: 2147483647, presaleEndTime: 2147483647 }, { presaleEndTime: 1 }, { presaleDay: -1 },
    { stock: 1 }, { isLimit: 1, limitType: 1, limitNum: 1 }, { isLimit: 1, limitType: 0 },
    { isLimit: 1, limitType: 2, limitNum: 10 },
  ])('rejects inadmissible product terms in core quote without trusting cart reads: %j', async patch => {
    await f.db.update(storeProduct).set(patch); const before = await state();
    await expect(quote()).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  it.each([{ isNew: 0 }, { activityId: 2 }, { bargainUserId: 3 }, { storeId: 1 }, { cartNum: 0 }, { type: 0 }])(
    'rejects stale or out-of-scope cart %j', async patch => {
      await f.db.update(storeCart).set(patch); const before = await state();
      await expect(quote()).rejects.toThrow(); expect(await state()).toEqual(before);
    });
  it('cannot bypass presale by labelling both the cart and order ordinary', async () => {
    await f.db.update(storeCart).set({ type: 0 });
    await expect(quote({ type: 0 })).rejects.toThrow('预售商品不能');
  });
  it('checks disabled users, retired SKUs and member-only eligibility even with global member pricing off', async () => {
    await f.db.update(user).set({ status: 0 }); await expect(quote()).rejects.toThrow('用户状态');
    await f.db.update(user).set({ status: 1 });
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }); await expect(quote()).rejects.toThrow();
    await f.db.update(storeProductAttrValue).set({ isRetired: 0 });
    await f.setConfig({ member_card_status: '0' }); await f.db.update(storeProduct).set({ isVipProduct: 1 });
    await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 1, overdueTime: stamp() - 1 });
    await expect(quote()).rejects.toThrow('有效付费会员');
    await f.db.update(user).set({ overdueTime: stamp() + 3600 });
    expect(await quote()).toMatchObject({ totalCents: 2000, payCents: 2600 });
  });
  it('includes every millisecond of the final purchase second without extending midnight to a day', async () => {
    const before = await state(), cart = before.carts[0], sku = before.skus[0], account = before.users[0];
    const product = { ...before.products[0], presaleStartTime: 100, presaleEndTime: 200 };
    expect(preparePresalePurchase(cart, product, sku, account, new Date(200999)).endsAt).toBe(200);
    expect(() => preparePresalePurchase(cart, product, sku, account, new Date(201000))).toThrow('已结束');
    expect(() => preparePresalePurchase(cart, product, sku, account, new Date(99999))).toThrow('未开始');
  });

  it.each([{ presaleDay: 8 }, { presaleEndTime: 2147483646 }, { limitNum: 3 }, { isVipProduct: 1 }])(
    'binds presale contractual changes to the immutable confirmation receipt: %j', async patch => {
      const receipt = await confirm(); await f.db.update(storeProduct).set(patch); const before = await state();
      const response = await post(`/order/create/${receipt.orderKey}`, { ...input, quoteToken: receipt.quoteToken });
      expect(response).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
      expect(await state()).toEqual(before);
    });
  it.each(['cart', 'sku', 'product', 'user'] as const)('rejects a committed %s edit between quote validation and the write boundary', async target => {
    const receipt = await confirm();
    const edit = async () => {
      if (target === 'cart') await f.db.update(storeCart).set({ bargainUserId: 8 });
      if (target === 'sku') await f.db.update(storeProductAttrValue).set({ vipPrice: '8.00' });
      if (target === 'product') await f.db.update(storeProduct).set({ presaleDay: 8 });
      if (target === 'user') await f.db.update(user).set({ status: 0 });
    };
    let before: Awaited<ReturnType<typeof state>>;
    await expect(create(f.db, receipt, {}, async () => { await edit(); before = await state(); })).rejects.toThrow();
    expect(await state()).toEqual(before!);
  });
  it('guards pickup cart tuples even without a delivery/template snapshot', async () => {
    const pickup = { shippingType: 2, storeId: 1, realName: '本地自提', userPhone: '00000000000' };
    const receipt = await confirm(pickup); let before: Awaited<ReturnType<typeof state>>;
    await expect(create(f.db, receipt, pickup, async () => {
      await f.db.update(storeCart).set({ cartNum: 1 }); before = await state();
    })).rejects.toThrow(); expect(await state()).toEqual(before!);
  });
  it('rejects an ordinary product becoming presale after quote validation but before inventory writes', async () => {
    await f.db.update(storeCart).set({ type: 0 }); await f.db.update(storeProduct).set({ isPresaleProduct: 0 });
    const receipt = await confirm({ type: 0 }); let before: Awaited<ReturnType<typeof state>>;
    await expect(create(f.db, receipt, { type: 0 }, async () => {
      await f.db.update(storeProduct).set({ isPresaleProduct: 1 }); before = await state();
    })).rejects.toThrow(); expect(await state()).toEqual(before!);
  });
  it('rolls back all writes if SQL fails after the final admission checks', async () => {
    const receipt = await confirm(), before = await state();
    const transaction = f.db.transaction.bind(f.db);
    const intercept: typeof f.db.transaction = (fn, config) => transaction(async tx => {
      await fn(tx); await tx.execute(sql`SELECT 1 / 0`); throw Error('unreachable');
    }, config);
    const db = new Proxy(f.db, { get(target, key, receiver) { return key === 'transaction' ? intercept : Reflect.get(target, key, receiver); } });
    await expect(create(db, receipt)).rejects.toThrow(); expect(await state()).toEqual(before);
  });

  it.each(['presaleDay', 'isPresaleProduct'] as const)('rechecks %s after an actual product row-lock wait', async field => {
    const receipt = await confirm(); let before: Awaited<ReturnType<typeof state>>;
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec('BEGIN');
      await editor.db.update(storeProduct).set(field === 'presaleDay' ? { presaleDay: 8 } : { isPresaleProduct: 0 });
      const buying = outcome(create(buyer.db, receipt));
      await waitForFinanceBlock(f.db, buyer.pid, editor.pid); await editor.exec('COMMIT');
      before = await state(); expect((await buying).ok).toBe(false);
    });
    expect(await state()).toEqual(before!);
  }, 15_000);
  it('rejects purchase after a lock-only SKU wait crosses the end second, despite a frozen application clock', async () => {
    const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(VALUES (1)) AS probe(n)`);
    const millis = Math.floor(Number(clock.millis)), end = Math.floor(millis / 1000) + 1;
    await f.db.update(storeProduct).set({ presaleEndTime: end });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(millis);
    const receipt = await confirm(), before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await waitForFinanceClock(f.db, (end + 1) * 1000 + 10); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/重新确认/);
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it('uses NOWAIT for final principal protection instead of reversing the user/SKU lock order', async () => {
    await f.setConfig({ member_card_status: '0' });
    const receipt = await confirm(), before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const result = await outcome(create(buyer.db, receipt));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toMatch(/资格正在更新/);
      await holder.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it('does not oversell two different presale selections racing for the same final inventory', async () => {
    await f.db.update(storeProduct).set({ stock: 2 }); await f.db.update(storeProductAttrValue).set({ stock: 2 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', type: 6,
      cartNum: 2, isNew: 1, status: 1 });
    const a = await confirm(), b = await confirm({ cartIds: [2] });
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(first.db, a));
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const competing = outcome(create(second.db, b, { cartIds: [2] }));
      // Start the second buyer only after the first owns the tuple wait slot.
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await holder.exec('COMMIT');
      expect([await buying, await competing].filter(result => result.ok)).toHaveLength(1);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.details).toHaveLength(1);
    expect(after.products[0].stock).toBe(0); expect(after.skus[0].stock).toBe(0);
    expect(after.carts.filter(cart => cart.isPay === 1)).toHaveLength(1);
  }, 15_000);
  it('rechecks timed member-only eligibility after waiting even with membership pricing disabled', async () => {
    await f.setConfig({ member_card_status: '0' }); await f.db.update(storeProduct).set({ isVipProduct: 1 });
    const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(VALUES (1)) AS probe(n)`);
    const millis = Math.floor(Number(clock.millis)), expiry = Math.floor(millis / 1000) + 2;
    await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 1, overdueTime: expiry });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(millis);
    const receipt = await confirm(), before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid); await waitForFinanceClock(f.db, expiry * 1000 + 10);
      await holder.exec('COMMIT'); const result = await buying;
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toMatch(/重新确认/);
    });
    expect(await state()).toEqual(before);
  }, 15_000);
});
