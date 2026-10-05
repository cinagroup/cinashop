import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeCouponIssue, storeCouponIssueUser, storeCouponUser } from '../src/models/schema';
import { ActivityService } from '../src/services/activity/ActivityService';
import { couponTemplateFixture } from './helpers/couponTemplateFixture';

describe('Legacy ordinary public-claim authority and once-only evidence', () => {
  let f: Awaited<ReturnType<typeof couponTemplateFixture>>;
  beforeEach(async () => { f = await couponTemplateFixture(); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  it.each([0, 1])('accepts genuine ordinary category=%s but treats its legacy limit0 as one lifetime claim', async category => {
    await f.db.update(storeCouponIssue).set({ category, receiveLimit: 0 }).where(eq(storeCouponIssue.id, 46001));
    const service = new ActivityService(f.container), result = await service.receiveCoupon(4110, 46001);
    expect((await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id, result.couponUserId)))[0])
      .toMatchObject({ uid: 4110, issueCouponId: 46001, receiveSource: 'get' });
    const before = await f.snapshot(); await expect(service.receiveCoupon(4110, 46001)).rejects.toThrow('限领'); expect(await f.snapshot()).toEqual(before);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].remainCount).toBe(2);
  });
  it('does not treat surviving issue evidence as a new claim when no owned coupon remains', async () => {
    await f.db.update(storeCouponIssue).set({ category: 1, receiveLimit: 0 }).where(eq(storeCouponIssue.id, 46001));
    await f.db.insert(storeCouponIssueUser).values([{ uid: 4110, issueCouponId: 46001, addTime: 1 },
      { uid: 4110, issueCouponId: 46001, addTime: 1 }]);
    const before = await f.snapshot(); await expect(new ActivityService(f.container).receiveCoupon(4110, 46001)).rejects.toThrow('限领');
    expect(await f.snapshot()).toEqual(before);
  });
  it('counts owned used/expired/reserved coupons even when their issue evidence is missing', async () => {
    for (const status of [1, 2, 3]) {
      await f.db.update(storeCouponIssue).set({ category: 1, receiveLimit: 0 }).where(eq(storeCouponIssue.id, 46001));
      await f.db.insert(storeCouponUser).values({ uid: 4110, issueCouponId: 46001, status });
      const before = await f.snapshot(); await expect(new ActivityService(f.container).receiveCoupon(4110, 46001)).rejects.toThrow('限领');
      expect(await f.snapshot()).toEqual(before);
      await f.db.delete(storeCouponUser);
    }
  });
  it.each([{ category: 2 }, { category: 3 }, { category: 1, appType: 1 }, { category: 1, receiveType: 3 }])
    ('ordinary legacy compatibility does not authorize member or hidden acquisition %j', async fields => {
      await f.db.update(storeCouponIssue).set(fields).where(eq(storeCouponIssue.id, 46001));
      const before = await f.snapshot(); await expect(new ActivityService(f.container).receiveCoupon(4110, 46001)).rejects.toThrow('不允许手动领取');
      expect(await f.snapshot()).toEqual(before);
    });
  it('refuses an expired fixed-use period even when the legacy receive window is unbounded', async () => {
    await f.db.update(storeCouponIssue).set({ category: 1, receiveLimit: 0, day: 0,
      useStartTime: new Date(Date.now() - 172800000), useEndTime: new Date(Date.now() - 86400000) })
      .where(eq(storeCouponIssue.id, 46001));
    const before = await f.snapshot(); await expect(new ActivityService(f.container).receiveCoupon(4110, 46001)).rejects.toThrow('过期');
    expect(await f.snapshot()).toEqual(before);
  });
  it('keeps an explicitly configured positive modern limit and decrements finite inventory exactly per successful claim', async () => {
    await f.db.update(storeCouponIssue).set({ receiveLimit: 2 }).where(eq(storeCouponIssue.id, 46001));
    const service = new ActivityService(f.container);
    await service.receiveCoupon(4110, 46001); await service.receiveCoupon(4110, 46001);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0].remainCount).toBe(1);
    const before = await f.snapshot(); await expect(service.receiveCoupon(4110, 46001)).rejects.toThrow('限领');
    expect(await f.snapshot()).toEqual(before);
  });
  it('claims a genuine unlimited issuer without altering its zero stock and still enforces lifetime limit0', async () => {
    await f.db.update(storeCouponIssue).set({ category: 1, receiveLimit: 0, isPermanent: 1, totalCount: 0, remainCount: 0 }).where(eq(storeCouponIssue.id, 46001));
    const service = new ActivityService(f.container); await service.receiveCoupon(4110, 46001);
    expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 46001)))[0]).toMatchObject({ totalCount: 0, remainCount: 0 });
    const before = await f.snapshot(); await expect(service.receiveCoupon(4110, 46001)).rejects.toThrow('限领'); expect(await f.snapshot()).toEqual(before);
  });
  it('lists only ordinary manual issuers with claimable inventory and an unexpired use/receive window', async () => {
    const now = Date.now();
    const variants = [{ category: 1 }, { isPermanent: 1, totalCount: 0, remainCount: 0 },
      { day: 0, useStartTime: new Date(now + 86400000), useEndTime: new Date(now + 172800000) },
      { category: 2 }, { appType: 1 }, { receiveType: 3 }, { remainCount: 0 },
      { day: 0, useEndTime: new Date(now - 86400000) }, { day: 0 },
      { startTime: new Date(now + 86400000) }, { endTime: new Date(now - 86400000) }, { status: 0 }, { isDel: 1 }];
    await f.db.insert(storeCouponIssue).values(variants.map((fields, i) => ({ id: 47001 + i, couponTitle: `可见性${i}`, title: `可见性${i}`,
      category: 0, receiveType: 1, appType: 0, day: 7, totalCount: 3, remainCount: 3, ...fields })));
    const before = await f.snapshot(), rows = await f.container.storeCouponIssueDao.getIssueList();
    expect(rows.map(row => row.id).sort()).toEqual([46001, 47001, 47002, 47003]);
    expect(await f.snapshot()).toEqual(before);
  });
});
