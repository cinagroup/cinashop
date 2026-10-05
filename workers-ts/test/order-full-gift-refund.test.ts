import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { financePostgres } from './helpers/financePostgres';
import { storeCouponUser, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderPromotionGiftCouponReward,
  user, userBill } from '../src/models/schema';
import { assertFullGiftRefundAdmission, reverseWholeOrderPromotionGiftPoints }
  from '../src/services/order/OrderPromotionGiftRefund';
import type { OrderPromotionGiftIntent } from '../src/services/activity/OrderPromotionGiftSnapshot';

describe('full-gift whole-refund source ownership and point recovery', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const intent: OrderPromotionGiftIntent = { version: 'order-promotion-gifts-v1', price_promotions: [],
    promotions: [{ id: 61, tier_id: 62, name: '循环满送', label_id: [31], eligible_cart_ids: ['200'],
      threshold_type: 2, threshold: '1.00', repetitions: 2, give_integral: 20,
      coupons: [{ aux_id: 71, issue_id: 21, title: '赠送券', price: '5.00', min_price: '10.00',
        type: 1, day: 7, use_start_time: null, use_end_time: null }],
      products: [{ aux_id: 72, product_id: 80, sku_id: 91, unique: 'gift0001', quantity: 2, cart_id: '201' }] }] };
  beforeEach(async () => {
    f = await financePostgres([storeOrder, storeOrderCartInfo, storeCouponUser,
      storeOrderPromotionGiftCouponReward, storeOrderOutbox, user, userBill]);
    await f.db.insert(user).values({ uid: 11, integral: 120 });
    await f.db.insert(storeOrder).values({ id: 30, orderId: 'gift_refund_30', uid: 11,
      paid: 1, type: 0, status: 0, pid: 0, totalNum: 4, payPrice: '40.00', giveIntegral: 20,
      giveCoupon: '21', promotionsGive: JSON.stringify(intent) });
    await f.db.insert(storeOrderCartInfo).values([
      { id: 200, oid: 30, uid: 11, cartId: '200', cartNum: 2, productId: 70,
        skuUnique: 'paid0001', isGift: 0, cartInfo: JSON.stringify({ sku: { id: 90 } }) },
      { id: 201, oid: 30, uid: 11, cartId: '201', cartNum: 2, productId: 80,
        skuUnique: 'gift0001', isGift: 1, cartInfo: JSON.stringify({ sku: { id: 91 } }) },
    ]);
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 21, status: 1 });
    await f.db.insert(storeOrderPromotionGiftCouponReward).values({ orderId: 30, uid: 11,
      rootId: 61, tierId: 62, auxiliaryId: 71, issueCouponId: 21, couponUserId: 41 });
    await f.db.insert(userBill).values({ uid: 11, linkId: '30', category: 'integral', type: 'gain',
      eventKey: 'order_promotions_give_integral', pm: 1, status: 1, number: '20', balance: '120' });
    await f.db.insert(storeOrderOutbox).values({ eventKey: 'order.paid:30', aggregateType: 'order',
      aggregateId: 30, eventType: 'order.paid', payload: { orderId: 30, orderNo: 'gift_refund_30' },
      status: 'COMPLETED' });
  });
  afterEach(async () => f?.close());
  const state = async () => ({ order: (await f.db.select().from(storeOrder))[0],
    rows: await f.db.select().from(storeOrderCartInfo),
    selections: new Map([['200', 2], ['201', 2]]) });

  it('admits only the whole original order and retains paid coupon entitlement while recovering source points', async () => {
    const { order, rows, selections } = await state();
    await withTx(createContainerFromDb(f.db), async tx => {
      expect(await assertFullGiftRefundAdmission(tx, order, rows, selections, '40.00', true)).toBe(true);
      await reverseWholeOrderPromotionGiftPoints(tx, order, 1000);
    });
    expect((await f.db.select().from(user))[0].integral).toBe(100);
    expect(await f.db.select().from(storeCouponUser)).toMatchObject([{ id: 41, status: 1 }]);
    expect(await f.db.select().from(storeOrderPromotionGiftCouponReward)).toHaveLength(1);
    expect((await f.db.select().from(userBill)).find(row => row.eventKey === 'order_promotions_integral_refund'))
      .toMatchObject({ linkId: '30', pm: 0, number: '20.00', balance: '100.00' });
  });

  it('rejects a partial, split, delivered or legacy-protocol request before financial writes', async () => {
    const { order, rows, selections } = await state();
    for (const [candidate, claim, amount, atomic] of [
      [order, new Map([['200', 1], ['201', 2]]), '20.00', true],
      [{ ...order, pid: 9 }, selections, '40.00', true],
      [{ ...order, status: 1 }, selections, '40.00', true],
      [order, selections, '39.00', true], [order, selections, '40.00', false],
    ] as const) {
      await expect(withTx(createContainerFromDb(f.db), tx =>
        assertFullGiftRefundAdmission(tx, candidate, rows, claim, amount, atomic))).rejects.toThrow(/满送/);
    }
    expect((await f.db.select().from(user))[0].integral).toBe(120);
    expect(await f.db.select().from(userBill)).toHaveLength(1);
  });

  it('requires the original gift SKU and exact paid coupon instance and completed point grant', async () => {
    const { order, rows, selections } = await state();
    await expect(withTx(createContainerFromDb(f.db), tx => assertFullGiftRefundAdmission(tx,
      {...order,giveCoupon:'22'},rows,selections,'40.00',true))).rejects.toThrow('满送退款权益');
    await expect(withTx(createContainerFromDb(f.db), tx => assertFullGiftRefundAdmission(tx, order,
      rows.map(row => row.isGift ? { ...row, skuUnique: 'forged01' } : row), selections, '40.00', true)))
      .rejects.toThrow('满送退款权益');
    await f.db.update(storeCouponUser).set({ uid: 12 }).where(eq(storeCouponUser.id, 41));
    await expect(withTx(createContainerFromDb(f.db), tx =>
      assertFullGiftRefundAdmission(tx, order, rows, selections, '40.00', true)))
      .rejects.toThrow('满送退款权益');
    await f.db.update(storeCouponUser).set({ uid: 11 }).where(eq(storeCouponUser.id, 41));
    await f.db.delete(userBill);
    await expect(withTx(createContainerFromDb(f.db), tx =>
      assertFullGiftRefundAdmission(tx, order, rows, selections, '40.00', true)))
      .rejects.toThrow('付款赠积分尚未完成');
    expect((await f.db.select().from(user))[0].integral).toBe(120);
  });

  it('caps recovery at available points, records the original grant and rejects an unowned duplicate reversal', async () => {
    const { order, rows, selections } = await state();
    await f.db.update(user).set({ integral: 5 }).where(eq(user.uid, 11));
    await withTx(createContainerFromDb(f.db), async tx => {
      await assertFullGiftRefundAdmission(tx, order, rows, selections, '40.00', true);
      await reverseWholeOrderPromotionGiftPoints(tx, order, 1000);
    });
    expect((await f.db.select().from(user))[0].integral).toBe(0);
    const reversal = (await f.db.select().from(userBill)).find(row => row.eventKey === 'order_promotions_integral_refund');
    expect(reversal).toMatchObject({ number: '5.00', balance: '0.00' });
    expect(reversal?.mark).toContain('原赠 20 积分，实际收回 5 积分');
    await expect(withTx(createContainerFromDb(f.db), tx => reverseWholeOrderPromotionGiftPoints(tx, order, 1001)))
      .rejects.toThrow('满送退款权益');
    expect(await f.db.select().from(userBill)).toHaveLength(2);
  });
});
