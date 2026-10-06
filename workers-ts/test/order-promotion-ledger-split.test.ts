import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeOrderPromotions } from '../src/models/schema';
import { assertOrderPromotionLedger, writeOrderPromotionLedger } from '../src/services/order/OrderPromotionLedgerSplit';
import { financePostgres } from './helpers/financePostgres';

const alloc = (quantity: number) => ({ promotionId: 101, rootId: 101, type: 1,
  savingsCents: quantity * 199, discountQuantity: quantity, labelIds: [31], name: '限时九折' });
const cart = (quantity: number) => ({ productId: 1, cartNum: quantity, cartInfo: JSON.stringify({
  promotion_quote_version: 'order-promotion-quote-v1',
  promotion_line_price: (quantity * 18).toFixed(2),
  promotion_line_savings: (quantity * 1.99).toFixed(2),
  promotion_line_member_savings: '0.00', promotion_discount_quantity: quantity,
  promotion_allocations: [alloc(quantity)],
  promotion_segments: [{ quantity, rawGrossCents: quantity * 1999, totalPriceCents: quantity * 1800,
    unitPriceCents: 1800, membershipSavingsCents: 0, promotionIds: [101],
    promotionAllocations: [alloc(quantity)], couponEligibleGrossCents: 0 }],
  coupon_price: '0.00', integral_price: '0.00', first_order_price: '0.00',
  sum_true_price: (quantity * 18).toFixed(2),
}) });

describe('versioned promotion ledger materialization', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres([storeOrderPromotions]); }, 30_000);
  afterAll(async () => f?.close());
  beforeEach(async () => f.reset());

  it('asserts the original paid ledger and writes exact child and remaining allocations', async () => {
    await f.db.insert(storeOrderPromotions).values({ oid: 9, uid: 7, productId: 1,
      promotionsId: 101, promotionsPrice: '3.98' });
    expect(await assertOrderPromotionLedger(f.db, { id: 9, uid: 7, promotionsPrice: '3.98' }, [cart(2)]))
      .toBe(true);
    await writeOrderPromotionLedger(f.db, { id: 10, uid: 7, promotionsPrice: '1.99' }, [cart(1)], 100);
    await writeOrderPromotionLedger(f.db, { id: 11, uid: 7, promotionsPrice: '1.99' }, [cart(1)], 100);
    expect((await f.db.select().from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 10)))[0])
      .toMatchObject({ uid: 7, productId: 1, promotionsId: 101, promotionsPrice: '1.99' });
    await writeOrderPromotionLedger(f.db, { id: 11, uid: 7, promotionsPrice: '0.00' }, [], 101, true);
    expect(await f.db.select().from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 11))).toEqual([]);
    expect((await f.db.select().from(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 9)))[0]
      .promotionsPrice).toBe('3.98');
  });

  it('rejects a source amount, UID or cart allocation that disagrees with its ledger', async () => {
    await f.db.insert(storeOrderPromotions).values({ oid: 9, uid: 7, productId: 1,
      promotionsId: 101, promotionsPrice: '3.97' });
    await expect(assertOrderPromotionLedger(f.db, { id: 9, uid: 7, promotionsPrice: '3.98' }, [cart(2)]))
      .rejects.toThrow('促销订单账本');
    await expect(writeOrderPromotionLedger(f.db, { id: 10, uid: 7, promotionsPrice: '1.98' }, [cart(1)], 100))
      .rejects.toThrow('促销订单账本');
  });
});
