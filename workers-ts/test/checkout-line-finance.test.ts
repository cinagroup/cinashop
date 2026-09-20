import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { partitionRefundCartSnapshot, REFUND_SPLIT_LINE_FIELDS } from '../src/services/order/RefundSplitAllocation';
import { agentLevel, printDocument, storeCart, storeIntegral, storeOrderCartInfo, storeOrderEconomize,
  storeOrderStatus, storeProduct, storeProductAttrValue, systemStore, user, userBrokerage } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected snapshot object');
  return value as Record<string, unknown>;
}
function cents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) throw new Error('Expected stored decimal money');
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected persisted snapshot text');
  return value;
}

describe('authoritative checkout line financial snapshots in real SQL', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let sequence: number;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    sequence = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live network forbidden in checkout fixture'); }));
    f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderEconomize,
      storeOrderStatus, userBrokerage, storeIntegral]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response(await nextOrderId()) }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close(); });
  const nextOrderId = async () => `line_finance_${++sequence}`;
  const create = (overrides: Partial<CreateOrderParams> = {}, db: DbClient = f.db) => StoreOrderCreateService.createWithRuntime(
    createContainerFromDb(db), { CONFIG_KV: f.env.CONFIG_KV, nextOrderId },
    { ...input, uid: 11, key: 'line_finance_key', userIp: '127.0.0.1', ...overrides });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(body) }, f.env);
    return object(await response.json());
  };
  const state = async () => ({ ...await f.snapshot(),
    details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    statuses: await f.db.select().from(storeOrderStatus), brokerage: await f.db.select().from(userBrokerage),
    economize: await f.db.select().from(storeOrderEconomize), prints: await f.db.select().from(printDocument),
  });
  const evidence = async () => {
    const saved = await state(); expect(saved.orders).toHaveLength(1);
    const order = saved.orders[0];
    const lines = saved.details.map(row => {
      const line = object(JSON.parse(text(row.cartInfo)));
      expect(line).toMatchObject({ financial_version: 'checkout-line-finance-v1', id: row.cartId, cart_num: row.cartNum });
      expect(partitionRefundCartSnapshot(text(row.cartInfo), row.cartNum, row.cartNum, false).missingFields).toEqual([]);
      for (const field of REFUND_SPLIT_LINE_FIELDS) expect(Object.hasOwn(line, field)).toBe(true);
      return line;
    });
    const sum = (field: string) => lines.reduce((total, line) => total + cents(line[field]), 0);
    for (const [lineField, total] of [
      ['coupon_price', order.couponPrice], ['first_order_price', order.firstOrderPrice],
      ['integral_price', order.deductionPrice], ['postage_price', order.payPostage],
      ['raw_postage_price', order.totalPostage], ['one_brokerage', order.oneBrokerage], ['two_brokerage', order.twoBrokerage],
      ['division_staff_brokerage', order.divisionStaffBrokerage], ['division_agent_brokerage', order.divisionAgentBrokerage],
      ['division_brokerage', order.divisionBrokerage], ['promotions_true_price', order.promotionsPrice],
    ]) expect(sum(lineField), lineField).toBe(cents(total));
    expect(sum('sum_true_price') + sum('postage_price')).toBe(cents(order.payPrice));
    expect(lines.reduce((total, line) => total + Number(line.use_integral), 0)).toBe(cents(order.useIntegral) / 100);
    expect(lines.reduce((total, line) => total + cents(line.costPrice) * Number(line.cart_num), 0)).toBe(cents(order.cost));
    expect(lines.reduce((total, line) => total + Number(line.integral) * Number(line.cart_num), 0)).toBe(order.payIntegral);
    expect(saved.brokerage).toEqual([]); // Checkout stores evidence, never pays commission.
    return { ...saved, order, lines };
  };
  const addLine = async (id: number, price: string, freight = 1, postage = '0.00') => {
    await f.db.insert(storeProduct).values({ id: 69 + id, storeName: `Line ${id}`, stock: 8, price,
      isShow: 1, isVerify: 1, freight, postage, tempId: 10 });
    await f.db.insert(storeProductAttrValue).values({ id, productId: 69 + id, unique: `qa00000${id}`,
      suk: `Line ${id}`, stock: 8, price });
    await f.db.insert(storeCart).values({ id, uid: 11, productId: 69 + id, productAttrUnique: `qa00000${id}`, cartNum: 1, isNew: 1, status: 1 });
  };

  it('keeps quote read-only and writes complete immutable evidence through actual HTTP create', async () => {
    await f.db.update(storeProductAttrValue).set({ cost: '2.50', settlePrice: '3.00', writeTimes: 4 }).where(eq(storeProductAttrValue.id, 1));
    const before = await state();
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, String(receipt.msg)).toBe(200);
    expect(await state()).toEqual(before); expect(sequence).toBe(0);
    const data = object(receipt.data);
    const result = await request(`/api/order/create/${data.orderKey}`, { ...input, quoteToken: data.quoteToken,
      // Untrusted client fields are not accepted as financial sources.
      postage_price: '99999.00', one_brokerage: '99999.00', costPrice: '99999.00' });
    expect(result.status, String(result.msg)).toBe(200);
    const saved = await evidence(); expect(sequence).toBe(1);
    expect(saved.order).toMatchObject({ payPrice: '26.00', cost: '5.00' });
    expect(saved.lines[0]).toMatchObject({ sum_price: '10.00', sum_true_price: '20.00', postage_price: '6.00',
      raw_postage_price: '6.00', costPrice: '2.50', use_integral: '0', sku: { write_times: 4 } });
    expect(saved.details[0]).toMatchObject({ settlePrice: '3.00', writeTimes: 8 });
    const split = partitionRefundCartSnapshot(text(saved.details[0].cartInfo), 2, 1, false);
    expect(split.missingFields).toEqual([]);
    expect(object(JSON.parse(text(split.selected)))).toMatchObject({ cart_num: 1, postage_price: '3.00', sum_true_price: '10.00' });
    expect(object(JSON.parse(text(split.remaining)))).toMatchObject({ cart_num: 1, postage_price: '3.00', sum_true_price: '10.00' });
  });

  it('conserves stacked first-order and points discounts when the last line costs one cent', async () => {
    await f.db.update(storeCart).set({ cartNum: 1 }).where(eq(storeCart.id, 1));
    await f.db.update(storeProduct).set({ freight: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '2.00' }).where(eq(storeProductAttrValue.id, 1));
    await addLine(2, '0.01');
    await f.db.update(user).set({ integral: 101 }).where(eq(user.uid, 11));
    await f.setConfig({ newcomer_status: '1', first_order_status: '1', first_order_discount: '50', first_order_discount_limit: '100',
      integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '101' });
    await create({ cartIds: [1, 2], useIntegral: true });
    const saved = await evidence();
    expect(saved.order).toMatchObject({ totalPrice: '2.01', firstOrderPrice: '1.00', deductionPrice: '1.01', payPrice: '0.00', useIntegral: '101.00' });
    expect(saved.lines).toMatchObject([
      { first_order_price: '0.99', integral_price: '1.01', sum_true_price: '0.00', use_integral: '100' },
      { first_order_price: '0.01', integral_price: '0.00', sum_true_price: '0.00', use_integral: '1' },
    ]);
    expect(saved.users.find(row => row.uid === 11)).toMatchObject({ integral: 0, isFirstOrder: 1 });
    expect(saved.bills).toHaveLength(1); expect(saved.bills[0]).toMatchObject({ number: '101.00', balance: '0.00' });
  });

  it('persists template, fixed and free fees against their original cart rows', async () => {
    await addLine(2, '1.00', 2, '3.00'); await addLine(3, '100.00');
    await create({ cartIds: [3, 1, 2] }); // Caller order must not corrupt database-row alignment.
    const saved = await evidence();
    expect(saved.order).toMatchObject({ totalPostage: '9.00', payPostage: '9.00', payPrice: '130.00' });
    expect(new Map(saved.lines.map(line => [line.id, line.postage_price]))).toEqual(new Map([['1', '6.00'], ['2', '3.00'], ['3', '0.00']]));
  });

  it('conserves the admitted member-postage cent instead of separately truncating it away', async () => {
    await f.db.update(storeCart).set({ cartNum: 1 }).where(eq(storeCart.id, 1));
    await f.db.update(storeProduct).set({ freight: 2, postage: '0.01' }).where(eq(storeProduct.id, 70));
    await addLine(2, '5.00', 2, '0.01');
    await f.setConfig({ member_card_status: '1' });
    await create({ cartIds: [1, 2] });
    const saved = await evidence();
    expect(saved.order).toMatchObject({ totalPostage: '0.02', payPostage: '0.01', payPrice: '15.01' });
    expect(saved.lines).toMatchObject([{ raw_postage_price: '0.01', postage_price: '0.00' }, { raw_postage_price: '0.01', postage_price: '0.01' }]);
  });

  it('keeps specified-SKU and percentage commission sources distinct, including division exclusion', async () => {
    Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '2',
      brokerage_compute_type: '1', store_brokerage_ratio: '10', store_brokerage_two: '5', division_status: '1' });
    await f.db.update(user).set({ spreadUid: 22, divisionId: 44 }).where(eq(user.uid, 11));
    await f.db.insert(user).values([
      { uid: 22, account: 'first', isPromoter: 1, spreadOpen: 1, status: 1, spreadUid: 33 },
      { uid: 33, account: 'second', isPromoter: 1, spreadOpen: 1, status: 1 },
      { uid: 44, account: 'division', divisionType: 1, divisionStatus: 1, divisionPercent: 40, divisionEndTime: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await f.db.update(storeProduct).set({ freight: 1, isSub: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ cost: '2.50', brokerage: '0.30', brokerageTwo: '0.10' }).where(eq(storeProductAttrValue.id, 1));
    await addLine(2, '5.00');
    await f.db.update(storeProductAttrValue).set({ cost: '1.20' }).where(eq(storeProductAttrValue.id, 2));
    await create({ cartIds: [1, 2] });
    const saved = await evidence();
    expect(saved.order).toMatchObject({ oneBrokerage: '1.10', twoBrokerage: '0.45', divisionBrokerage: '1.25', cost: '6.20' });
    expect(saved.lines).toMatchObject([
      { one_brokerage: '0.60', two_brokerage: '0.20', division_brokerage: '0.00' },
      { one_brokerage: '0.50', two_brokerage: '0.25', division_brokerage: '1.25' },
    ]);
  });

  it.each(['0.00', '3.00'])('stores activity cost and redemption points even at cash price %s', async price => {
    await f.db.insert(storeIntegral).values({ id: 9, productId: 70, storeName: 'Points sample', stock: 8, quota: 8, status: 1, isShow: 1, isDel: 0, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 9, type: 4, unique: 'act00009', suk: '红色,大号',
      stock: 8, quota: 8, price, cost: '1.25', settlePrice: '2.50', integral: 20 });
    await f.db.update(storeProductAttrValue).set({ cost: '9.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ type: 4, activityId: 9 }).where(eq(storeCart.id, 1));
    await create({ type: 4 });
    const saved = await evidence();
    expect(saved.order).toMatchObject({ payIntegral: 40, useIntegral: '0.00', cost: '2.50' });
    expect(saved.lines[0]).toMatchObject({ costPrice: '1.25', integral: 20, use_integral: '0', sum_price: price,
      activitySku: { id: 2, integral: 20 } });
    expect(saved.details[0].settlePrice).toBe('2.50');
    expect(saved.bills).toEqual([]); // Redemption payment is separate; do not deduct it at checkout.
  });

  it('replays the stored order without re-pricing or rewriting its line evidence', async () => {
    const first = await create(); const before = await evidence();
    await f.db.update(storeProductAttrValue).set({ cost: '99.00', price: '99.00', writeTimes: 99 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProduct).set({ postage: '99.00', freight: 2 }).where(eq(storeProduct.id, 70));
    const changed = await state();
    expect(await create()).toEqual(first); expect(sequence).toBe(1);
    expect(await state()).toEqual(changed); expect((await state()).details).toEqual(before.details);
  });

  it('rolls back line snapshots, inventory, first-order consumption and points on a later real SQL failure', async () => {
    await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50',
      newcomer_status: '1', first_order_status: '1', first_order_discount: '90', first_order_discount_limit: '100' });
    // This trigger is fixture-owned and fails after order/cart inserts and the points UPDATE.
    await f.exec(`CREATE FUNCTION reject_line_finance_bill() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'line finance rollback'; END $$;
      CREATE TRIGGER reject_line_finance_bill BEFORE INSERT ON user_bill FOR EACH ROW EXECUTE FUNCTION reject_line_finance_bill()`);
    const before = await state();
    const result = await outcome(create({ useIntegral: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error instanceof Error ? result.error : new Error(String(result.error));
      expect(String(error.cause ?? error)).toContain('line finance rollback');
    }
    expect(await state()).toEqual(before);
  });

  const prepareEntitlements = async () => {
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.update(storeProduct).set({ productType: 4, freight: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ productType: 4 }).where(eq(storeCart.id, 1));
    await f.db.update(storeProductAttrValue).set({ writeTimes: 4, writeValid: 1 }).where(eq(storeProductAttrValue.id, 1));
  };
  const entitlementInput = { shippingType: 2, storeId: 1, realName: 'Local pickup', userPhone: '00000000000' };
  it('records admitted per-unit and total entitlements for a valid second-card pickup order', async () => {
    await prepareEntitlements(); await create(entitlementInput);
    const saved = await evidence();
    expect(saved.lines[0]).toMatchObject({ sku: { write_times: 4, write_valid: 1 }, postage_price: '0.00' });
    expect(saved.details[0]).toMatchObject({ productType: 4, cartNum: 2, writeTimes: 8, writeSurplusTimes: 8 });
  });
  it('requires a fresh HTTP quote when the confirmed per-unit entitlement changes', async () => {
    await prepareEntitlements();
    const receipt = await request('/api/order/confirm', { ...input, ...entitlementInput });
    expect(receipt.status, String(receipt.msg)).toBe(200); const data = object(receipt.data);
    await f.db.update(storeProductAttrValue).set({ writeTimes: 9 }).where(eq(storeProductAttrValue.id, 1));
    const before = await state();
    const path = `/api/order/create/${data.orderKey}`;
    const refused = await request(path, { ...input, ...entitlementInput, quoteToken: data.quoteToken });
    expect(refused).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(before); expect(sequence).toBe(0);
    const fresh = await request(`/api/order/computed/${data.orderKey}`, { ...input, ...entitlementInput });
    expect(fresh.status, String(fresh.msg)).toBe(200);
    expect((await request(path, { ...input, ...entitlementInput, quoteToken: object(fresh.data).quoteToken })).status).toBe(200);
    const saved = await evidence();
    expect(saved.lines[0]).toMatchObject({ sku: { write_times: 9 } });
    expect(saved.details[0]).toMatchObject({ cartNum: 2, writeTimes: 18, writeSurplusTimes: 18 });
  });
  it('rejects a per-unit entitlement edit between source read and transaction admission', async () => {
    await prepareEntitlements();
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    const transaction = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementationOnce(async (fn, config) => {
      await f.db.update(storeProductAttrValue).set({ writeTimes: 9 }).where(eq(storeProductAttrValue.id, 1));
      edited = await state(); return transaction(fn, config);
    });
    await expect(create(entitlementInput)).rejects.toThrow('库存不足');
    expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rechecks entitlements after an independent PostgreSQL SKU lock wait', async () => {
    await prepareEntitlements(); const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(entitlementInput, buyer.db));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await holder.db.update(storeProductAttrValue).set({ writeTimes: 9 }).where(eq(storeProductAttrValue.id, 1));
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('库存不足');
    });
    const after = await state();
    expect(after).toEqual({ ...before, skus: before.skus.map(row => row.id === 1 ? { ...row, writeTimes: 9 } : row) });
  }, 15_000);
});
