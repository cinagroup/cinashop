import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTx } from '../src/lib/di';
import { storeCouponIssue, storeCouponUser, storeOrder, storeOrderCartInfo, storeProductCoupon } from '../src/models/schema';
import { ActivityService } from '../src/services/activity/ActivityService';
import { grantPaidOrderProductCoupons } from '../src/services/activity/ProductCouponService';
import { applyRegistrationGifts } from '../src/services/activity/StoreNewcomerService';
import { couponTemplateFixture } from './helpers/couponTemplateFixture';

describe('public manual claim is an explicit authority boundary', () => {
  let f: Awaited<ReturnType<typeof couponTemplateFixture>>;
  beforeEach(async () => { f = await couponTemplateFixture(); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  it.each([{ receiveType: 0 }, { receiveType: 2 }, { receiveType: 3 }, { receiveType: 4 }, { category: 2 }, { appType: 1 }])
    ('refuses direct claim of hidden/trusted/member issue %j with zero counters/user/evidence changes', async fields => {
      await f.db.update(storeCouponIssue).set(fields).where(eq(storeCouponIssue.id, 46001));
      const before = await f.snapshot();
      await expect(new ActivityService(f.container).receiveCoupon(4110, 46001)).rejects.toThrow('不允许手动领取');
      expect(await f.snapshot()).toEqual(before);
    });
  it('allows ordinary manual self-claim once, preserves identity/source and atomically enforces the limit', async () => {
    await f.db.update(storeCouponIssue).set({ receiveLimit: 1 }).where(eq(storeCouponIssue.id, 46001));
    const service = new ActivityService(f.container), result = await service.receiveCoupon(4110, 46001);
    expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, result.couponUserId)))[0])
      .toMatchObject({ uid: 4110, issueCouponId: 46001, receiveSource: 'get', couponPrice: '3.00', type: 1 });
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].remainCount).toBe(2);
    const before = await f.snapshot(); await expect(service.receiveCoupon(4110, 46001)).rejects.toThrow('限领');
    expect(await f.snapshot()).toEqual(before);
  });
  it('preserves trusted product-gift and newcomer registration paths and their exact nonmanual acquisition sources', async () => {
    await f.db.update(storeCouponIssue).set({ receiveType: 3 }).where(eq(storeCouponIssue.id, 46001));
    await f.db.insert(storeOrder).values({ id: 61001, uid: 4110, orderId: 'coupon-template-trusted-gift', unique: 'coupon-template-trusted-gift', paid: 1 });
    await f.db.insert(storeOrderCartInfo).values({ id: 61001, oid: 61001, uid: 4110, productId: 4100, unique: 'coupon-template-gift-cart' });
    await f.db.insert(storeProductCoupon).values({ productId: 4100, issueCouponId: 46001 });
    const now = Math.floor(Date.now() / 1000);
    expect(await withTx(f.container, tx => grantPaidOrderProductCoupons(tx, 61001, 4110, now))).toBe(1);
    expect(await withTx(f.container, tx => grantPaidOrderProductCoupons(tx, 61001, 4110, now))).toBe(0);
    await f.db.update(storeCouponIssue).set({ receiveType: 2 }).where(eq(storeCouponIssue.id, 46001));
    expect(await withTx(f.container, tx => applyRegistrationGifts(tx, 4110, { enabled: true, integral: 0, moneyUnits: 0, couponIds: [46001] }, now)))
      .toEqual({ integral: 0, money: '0.00', coupons: 1 });
    expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.issueCouponId, 46001))).map(row => row.receiveSource)).toEqual(['order', 'newcomer']);
  });
});
