/** Native promotion/full-gift quotes, actual writes and independent lock waits.
 * Owned fixture actors/configuration are not production auth/provider proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeOrderPromotions, storeProduct,
  storeProductAttrValue, storePromotions } from '../src/models/schema';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { ordinaryShortSkuGiftFixture, ordinaryShortSkuPromotionFixture, ordinaryShortUnique,
  type ShortSkuReceipt } from './helpers/ordinaryShortSkuFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
async function receipt(result: { status: number; msg: string; data: ShortSkuReceipt | null }) {
  expect(result.status, result.msg).toBe(200);
  if (!result.data) throw Error('Actual confirmation did not return its receipt');
  return result.data;
}

describe.runIf(native)('ordinary short-SKU promotion lifecycle on native PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof ordinaryShortSkuPromotionFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Short SKU tests forbid external I/O'));
    f = await ordinaryShortSkuPromotionFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  it('applies the scoped short-SKU discount to reusable cart, budget, confirmation and the actual stored financial ledger', async () => {
    const before = await f.state();
    const [cart] = await f.cart().list(11, { mode: 'cart' });
    expect(cart).toMatchObject({ truePrice: '9.00', trueSumPrice: '18.00', priceType: 'promotions',
      promotion: { promotionSavingsCents: 200, promotionIds: [f.promotionId] } });
    expect((await f.compute()).deduction).toMatchObject({ sum_price: 20, pay_price: 18 });
    expect(await f.quote()).toMatchObject({ rawTotalCents: 2000, totalCents: 1800,
      payCents: 1800, promotionSavingsCents: 200 });
    const confirmed = await receipt(await f.confirm());
    expect(confirmed.priceGroup).toMatchObject({ sumPrice: '20.00', pay_price: '18.00', promotionsPrice: '2.00' });
    expect(await f.state()).toEqual(before);
    const created = await f.create(confirmed);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(order).toMatchObject({ totalNum: 2, totalPrice: '18.00', payPrice: '18.00', promotionsPrice: '2.00', paid: 0 });
    const [line] = await f.db.select().from(storeOrderCartInfo);
    expect(line).toMatchObject({ skuUnique: ordinaryShortUnique, cartNum: 2 });
    expect(JSON.parse(line.cartInfo!)).toMatchObject({ sku: { id: 1, unique: ordinaryShortUnique },
      promotion_line_price: '18.00', promotion_line_savings: '2.00', sum_true_price: '18.00' });
    expect(await f.db.select().from(storeOrderPromotions)).toMatchObject([{ oid: order.id,
      productId: 70, promotionsId: f.promotionId, promotionsPrice: '2.00' }]);
    expect(Array.from(await f.db.execute(sql`SELECT lines FROM public.store_order_purchase_origin`)))
      .toMatchObject([{ lines: [{ skuUnique: ordinaryShortUnique, quantity: 2 }] }]);
    expect(Array.from(await f.db.execute(sql`SELECT lines FROM public.store_order_purchase_physical_origin`)))
      .toMatchObject([{ lines: [{ skuUnique: ordinaryShortUnique, quantity: 2, kind: 'charged' }] }]);
  }, 30_000);

  it('waits for the actual promotion catalog writer and rejects changed pricing without retaining any checkout write', async () => {
    const confirmed = await receipt(await f.confirm());
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      let open = false;
      try {
        await writer.exec('BEGIN'); open = true;
        await writer.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('time_discount_catalog'), hashtext('platform_type_1'))`);
        await writer.db.update(storePromotions).set({ discount: '80.00' }).where(eq(storePromotions.id, f.promotionId));
        const afterEdit = await f.state(writer.db), buying = outcome(f.create(confirmed, buyer.db));
        await waitForFinanceBlock(f.db, buyer.pid, writer.pid);
        await writer.exec('COMMIT'); open = false;
        const result = await buying;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect(await f.state()).toEqual(afterEdit);
      } finally { if (open) await writer.exec('ROLLBACK'); }
    });
  }, 30_000);
});

describe.runIf(native)('ordinary short-SKU full gifts on native PostgreSQL16', () => {
  let f: Awaited<ReturnType<typeof ordinaryShortSkuGiftFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Short SKU tests forbid external I/O'));
    f = await ordinaryShortSkuGiftFixture();
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  it('keeps the short paid and gift SKUs through reusable-cart quotes and successful re-quote after a gift-product lock wait', async () => {
    const before = await f.state();
    expect(await f.cart().list(11, { mode: 'cart' })).toMatchObject([{ trueSumPrice: '20.00',
      giftPromotion: [{ id: f.rootId, repetitions: 2, giveCartInfo: [{ productId: 71, quantity: 2 }] }] }]);
    expect((await f.compute()).deduction).toMatchObject({ sum_price: 20, pay_price: 20 });
    expect(await f.quote()).toMatchObject({ payCents: 2000, totalNum: 4,
      giveCartInfo: [{ productId: 71, skuUnique: 'gift80', quantity: 2 }] });
    const confirmed = await receipt(await f.confirm());
    expect(confirmed.priceGroup.pay_price).toBe('20.00');
    expect(confirmed.cartInfo).toHaveLength(2);
    expect(await f.state()).toEqual(before);
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      let open = false;
      const buying = outcome(f.create([1], { db: buyer.db, receipt: confirmed, nextOrderId: async () => {
        await holder.exec('BEGIN'); open = true;
        await holder.db.execute(sql`SELECT id FROM public.store_product WHERE id=71 FOR UPDATE`);
      } }));
      try {
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await holder.exec('COMMIT'); open = false;
        const result = await buying;
        expect(result.ok).toBe(true);
        if (!result.ok) throw result.error;
      } finally { if (open) await holder.exec('ROLLBACK'); }
    });
    expect(await f.db.select().from(storeOrder)).toMatchObject([{ totalNum: 4, totalPrice: '20.00', payPrice: '20.00', paid: 0 }]);
    const lines = await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id);
    expect(lines).toMatchObject([{ skuUnique: ordinaryShortUnique, cartNum: 2, isGift: 0 },
      { skuUnique: 'gift80', cartNum: 2, isGift: 1 }]);
    expect(lines.map(line => JSON.parse(line.cartInfo!).sku.unique)).toEqual([ordinaryShortUnique, 'gift80']);
    expect(Array.from(await f.db.execute(sql`SELECT total_num,lines FROM public.store_order_purchase_origin`)))
      .toMatchObject([{ total_num: 2, lines: [{ skuUnique: ordinaryShortUnique, quantity: 2 }] }]);
    expect(Array.from(await f.db.execute(sql`SELECT total_num,lines FROM public.store_order_purchase_physical_origin`)))
      .toMatchObject([{ total_num: 4, lines: [{ skuUnique: ordinaryShortUnique, quantity: 2, kind: 'charged' },
        { skuUnique: 'gift80', quantity: 2, kind: 'gift' }] }]);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(38);
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(38);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 71)))[0].stock).toBe(18);
  }, 30_000);

  it('rejects a changed real gift intent after a promotion-row lock wait and rolls back paid and gift claims together', async () => {
    const confirmed = await receipt(await f.confirm());
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      let open = false;
      try {
        await writer.exec('BEGIN'); open = true;
        await writer.db.update(storePromotions).set({ giveIntegral: 4 }).where(eq(storePromotions.id, f.rootId));
        const afterEdit = await f.state(writer.db);
        const buying = outcome(f.create([1], { db: buyer.db, receipt: confirmed }));
        await waitForFinanceBlock(f.db, buyer.pid, writer.pid);
        await writer.exec('COMMIT'); open = false;
        const result = await buying;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect(await f.state()).toEqual(afterEdit);
      } finally { if (open) await writer.exec('ROLLBACK'); }
    });
  }, 30_000);
});
