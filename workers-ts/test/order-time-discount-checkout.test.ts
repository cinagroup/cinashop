import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { quoteOrderPromotions } from '../src/services/activity/OrderPromotionQuoteService';
import { grantPaidPromotionLabels } from '../src/services/order/OrderRewardService';
import { planOrderFinancialSplit } from '../src/services/order/OrderSplitFinance';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { printDocument, storeCart, storeCouponIssue, storeCouponUser, storeOrder, storeOrderCartInfo,
  storeOrderPromotions, storeOrderStatus, storeProduct, storeProductAttrValue, storePromotions, userLabel, userLabelRelation } from '../src/models/schema';

describe('time discount through real cart, confirmation and checkout finance', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let sequence = 0;
  const request = { cartIds: [1], addressId: 11, shippingType: 1, useIntegral: false };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([printDocument, storeOrderStatus, storeOrderPromotions, storeCouponIssue,
      storeCouponUser, userLabel, userLabelRelation]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ price: '19.99', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '19.99', vipPrice: '10.00' });
    await f.db.update(storeCart).set({ cartNum: 3 });
    const now = Math.floor(Date.now() / 1000);
    await f.db.insert(userLabel).values({ id: 31, name: '折扣成交客户', type: 0, relationId: 0 });
    await f.db.insert(storePromotions).values({ id: 1, name: '限时九折', promotionsType: 1, type: 1,
      pid: 0, storeId: 0, status: 1, isDel: 0, startTime: now - 3600, stopTime: now + 3600,
      discount: '90', productPartakeType: 1, isLimit: 1, limitNum: 2, labelId: '31', overlay: '' });
  }, 30_000);
  afterEach(async () => f?.close());
  const confirm = async (couponId?: number) => {
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify({ ...request, couponId }) }, f.env);
    const body = await response.json() as { status: number; msg: string; data: { orderKey: string; quoteToken: string;
      cartInfo: Array<Record<string, unknown>>; priceGroup: Record<string, string> } };
    expect(body.status, body.msg).toBe(200); return body.data;
  };
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }, couponId?: number) =>
    StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { CONFIG_KV: f.env.CONFIG_KV,
      requireConfirmation: true, nextOrderId: async () => `time_discount_${++sequence}` }, {
      ...request, uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, couponId, userIp: '127.0.0.1' });
  const coupon = async () => {
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '10.00' });
  };
  it('keeps a partial-cap line total exact in both carts and actual confirmation', async () => {
    const [row] = await new StoreCartService(f.container, f.env).list(11, { mode: 'buy', ids: [1] }) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ trueSumPrice: '55.99', priceType: 'promotions', promotion: {
      unitPriceCents: null, totalPriceCents: 5599, promotionSavingsCents: 398, discountQuantity: 2 } });
    const response = await confirm();
    expect(response.priceGroup).toMatchObject({ sumPrice: '59.97', totalPrice: '55.99', pay_price: '55.99', promotionsPrice: '3.98' });
    expect(response.cartInfo[0]).toMatchObject({ trueSumPrice: '55.99', totalPriceCents: 5599, promotion: { unitPriceCents: null } });
    expect((await f.snapshot()).orders).toEqual([]);
  });
  it('permits a coupon only against unpromoted units when overlay 5 is absent', async () => {
    await coupon();
    const response = await confirm(41);
    expect(response.priceGroup).toMatchObject({ totalPrice: '55.99', couponPrice: '1.00', pay_price: '54.99' });
    expect(response.cartInfo[0]).toMatchObject({ promotion: { couponEligibleGrossCents: 1999 } });
    await f.db.update(storeCouponUser).set({ useMinPrice: '30.00' }).where(eq(storeCouponUser.id, 41));
    await expect(new StoreOrderCreateService(f.container, f.env).quoteOrder({ uid: 11, ...request, couponId: 41 }))
      .rejects.toThrow('适用商品满');
    await f.db.update(storePromotions).set({ overlay: '5' }).where(eq(storePromotions.id, 1));
    expect((await confirm(41)).priceGroup.pay_price).toBe('54.99');
  });
  it('gives the first-order rule precedence without assigning purchase labels in a quote', async () => {
    await f.setConfig({ newcomer_status: '1', first_order_status: '1', first_order_discount: '80', first_order_discount_limit: '100' });
    const response = await confirm();
    expect(response.priceGroup).toMatchObject({ totalPrice: '59.97', promotionsPrice: '0.00', firstOrderPrice: '11.99', pay_price: '47.98' });
    expect(await f.db.select().from(userLabelRelation)).toEqual([]);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('creates exact ledgers, preserves partial split cents, and tags only after payment', async () => {
    await coupon();
    const receipt = await confirm(41), created = await create(f.db, receipt, 41);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(order).toMatchObject({ totalPrice: '55.99', payPrice: '54.99', promotionsPrice: '3.98', couponPrice: '1.00' });
    expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ promotion_line_price: '55.99', promotion_line_savings: '3.98',
      promotion_discount_quantity: 2, promotion_line_member_savings: '0.00', sum_true_price: '54.99' });
    expect(await f.db.select().from(storeOrderPromotions)).toMatchObject([{ oid: order.id, promotionsId: 1, productId: 70, promotionsPrice: '3.98' }]);
    expect(await f.db.select().from(userLabelRelation)).toEqual([]);
    const plan = planOrderFinancialSplit(order, lines, new Map([[lines[0].cartId, 1]]));
    if (!plan) throw new Error('Expected selected financial split');
    expect(plan.selected.totalPrice).toBe('18.00');
    expect(plan.remaining.totalPrice).toBe('37.99');
    await withTx(f.container, async tx => {
      await tx.update(storeOrder).set({ paid: 1 }).where(eq(storeOrder.id, order.id));
      await grantPaidPromotionLabels(tx, { ...order, paid: 1 });
      await grantPaidPromotionLabels(tx, { ...order, paid: 1 });
    });
    expect(await f.db.select().from(userLabelRelation)).toMatchObject([{ uid: 11, labelId: 31 }]);
    // The unpaid root reserved the cap before payment; it is not reusable after a split.
    const next = await quoteOrderPromotions(f.container, { uid: 11, lines: [{ key: 'next', productId: 70, skuUnique: 'qared001',
      quantity: 1, rawUnitPriceCents: 1999, memberUnitPriceCents: 1999 }] });
    expect(next.totalSavingsCents).toBe(0);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects a changed activity receipt before any resource claim', async () => {
    const receipt = await confirm(), before = await f.snapshot();
    await f.db.update(storePromotions).set({ discount: '80' }).where(eq(storePromotions.id, 1));
    await expect(create(f.db, receipt)).rejects.toBeInstanceOf(OrderQuoteReconfirmRequired);
    expect(await f.snapshot()).toEqual(before);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rechecks a rule after actually waiting for the catalog writer', async () => {
    const receipt = await confirm(), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      await writer.exec('BEGIN');
      await writer.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('time_discount_catalog'),hashtext('platform_type_1'))`);
      await writer.db.update(storePromotions).set({ discount: '80' }).where(eq(storePromotions.id, 1));
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
