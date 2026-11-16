import { describe, expect, it } from 'vitest';
import type { storeCouponIssue, storeCouponUser } from '../src/models/schema';
import { couponClaimUseWindow, membershipCouponHasHistory, membershipCouponIssueAdmission,
  ordinaryCouponClaimLimitAdmission, ordinaryCouponIssueAdmission } from '../src/services/activity/CouponClaimAdmission';
import { claimableOrdinaryEstimatedCoupon, selectBestEstimatedCoupon,
  type CouponEstimateCandidate } from '../src/services/activity/PublicCouponEstimateService';
import type { prepareCouponScope } from '../src/services/activity/OrderCouponService';

type Issue = typeof storeCouponIssue.$inferSelect;
type Owned = typeof storeCouponUser.$inferSelect;
const NOW = Date.parse('2026-11-15T12:00:00Z');
function issue(id: number, changes: Partial<Issue> = {}): Issue {
  return { id, cid: 0, category: 1, couponType: 0, couponTitle: '普通手领优惠券', type: 1,
    couponPrice: '1.00', useMinPrice: '0.00', productId: '0', category_id: '0', brandId: '0',
    legacyProductIds: null, legacyCategoryId: 0, legacyBrandId: 0, totalCount: 100, remainCount: 100,
    receiveLimit: 1, receiveType: 1, startTime: null, endTime: null, day: 7, isPermanent: 0,
    isGiveSubscribe: 0, isFullGive: 0, fullReduction: '0.00', isDel: 0, title: '发行标题', integral: 0,
    useStartTime: null, useEndTime: null, rule: '', status: 1, appType: 0, sort: 0, addTime: 0, ...changes };
}
function offer(row: Issue): CouponEstimateCandidate {
  const window = couponClaimUseWindow(row, NOW);
  return { source: 'issue', issue: row, ownedCoupon: null, terms: { status: 0, isFail: 0,
    startTime: window.startTime, endTime: window.endTime, couponPrice: row.couponPrice, useMinPrice: row.useMinPrice } };
}
function owned(row: Issue, id: number, changes: Partial<Owned> = {}): CouponEstimateCandidate {
  const coupon: Owned = { id, uid: 11, issueCouponId: row.id, couponTitle: '真实已发行优惠券',
    couponPrice: row.couponPrice, useMinPrice: row.useMinPrice, status: 0, isFail: 0, startTime: null,
    endTime: null, useTime: null, type: row.type, receiveTime: 1, receiveSource: 'get', ...changes };
  return { source: 'owned', issue: row, terms: coupon, ownedCoupon: coupon };
}
function scope(subtotalCents = 1_999): Awaited<ReturnType<typeof prepareCouponScope>> {
  return { related: new Map(), items: [{ productId: 71, parentProductId: 70, categoryIds: [102],
    categoryAncestorIds: [100, 101], brandId: 22, brandAncestorIds: [20, 21], subtotalCents }] };
}

describe('shared ordinary and membership manual-claim facts', () => {
  it.each([0, 1])('admits the real ordinary category %s without granting ownership', category => {
    const row = issue(1, { category });
    expect(ordinaryCouponIssueAdmission(row, NOW)).toBe('');
    expect(claimableOrdinaryEstimatedCoupon(row, 0, 0, NOW)).toBe(true);
    expect(offer(row)).toMatchObject({ source: 'issue', ownedCoupon: null });
    expect(offer(row).terms).not.toHaveProperty('id');
    expect(offer(row).terms).not.toHaveProperty('uid');
  });
  it.each([{ category: 2 }, { category: 3 }, { appType: 1 }, { receiveType: 2 }, { receiveType: 3 },
    { status: 0 }, { isDel: 1 }, { remainCount: 0 }, { startTime: new Date(NOW + 1) }, { endTime: new Date(NOW - 1) }])
  ('rejects unavailable or unauthorized ordinary issuers %j', changes => {
    expect(claimableOrdinaryEstimatedCoupon(issue(1, changes), 0, 0, NOW)).toBe(false);
  });
  it('preserves limit0 lifetime evidence and positive explicit limits', () => {
    const row = issue(1, { receiveLimit: 0 });
    expect(claimableOrdinaryEstimatedCoupon(row, 0, 0, NOW)).toBe(true);
    expect(claimableOrdinaryEstimatedCoupon(row, 1, 0, NOW)).toBe(false);
    expect(claimableOrdinaryEstimatedCoupon(row, 0, 2, NOW)).toBe(false);
    expect(ordinaryCouponClaimLimitAdmission(2, 1, 10)).toBe('');
    expect(ordinaryCouponClaimLimitAdmission(2, 2, 0)).toContain('限领 2');
    expect(ordinaryCouponClaimLimitAdmission(-1, 0, 0)).toContain('配置无效');
  });
  it('handles exact receive/use boundaries, permanent stock and future fixed start', () => {
    const row = issue(1, { isPermanent: 1, remainCount: 0, startTime: new Date(NOW), endTime: new Date(NOW),
      day: 0, useStartTime: new Date(NOW + 1), useEndTime: new Date(NOW + 10_000) });
    expect(claimableOrdinaryEstimatedCoupon(row, 0, 0, NOW)).toBe(true);
    expect(selectBestEstimatedCoupon([offer(row)], scope(), NOW)).toBeNull();
    expect(couponClaimUseWindow(issue(2, { day: 0, useEndTime: new Date(NOW) }), NOW).reason).toBe('');
    expect(couponClaimUseWindow(issue(2, { day: 0 }), NOW).reason).toContain('未配置');
    expect(couponClaimUseWindow(issue(2, { day: 0, useEndTime: new Date(NOW - 1) }), NOW).reason).toContain('过期');
  });
  it('rejects grants that cannot fit their actual owned title or finite date', () => {
    expect(couponClaimUseWindow(issue(1, { couponTitle: '券'.repeat(65) }), NOW).reason).toContain('名称');
    expect(couponClaimUseWindow(issue(1, { day: Number.MAX_SAFE_INTEGER }), NOW).reason).toContain('有效期');
    const window = couponClaimUseWindow(issue(1, { day: 7 }), NOW);
    expect(window.startTime.getTime()).toBe(NOW);
    expect(window.endTime?.getTime()).toBe(NOW + 7 * 86_400_000);
  });
  it('retains membership-specific issuer and no-history admission', () => {
    const member = issue(1, { category: 2 });
    expect(membershipCouponIssueAdmission(member, new Date(NOW))).toBe('');
    for (const changes of [{ category: 1 }, { couponType: 4 }, { type: 3 }, { type: 2, couponPrice: '100.01' },
      { couponPrice: '1e2' }, { receiveLimit: -1 }, { isPermanent: 2 }, { day: -1 }, { day: 0 },
      { day: 0, useStartTime: new Date(NOW + 2_000), useEndTime: new Date(NOW + 1_000) }])
      expect(membershipCouponIssueAdmission({ ...member, ...changes }, new Date(NOW))).not.toBe('');
    expect(membershipCouponHasHistory(0, 0)).toBe(false);
    expect(membershipCouponHasHistory(1, 0)).toBe(true);
    expect(membershipCouponHasHistory(0, 2)).toBe(true);
  });
});

describe('complete candidate actual-saving comparison with checkout evaluation', () => {
  it('compares percentage savings with money savings rather than catalogue face order', () => {
    const best = selectBestEstimatedCoupon([offer(issue(1, { type: 2, couponPrice: '95.00' })),
      offer(issue(2, { type: 2, couponPrice: '85.99' })), offer(issue(3, { couponPrice: '2.99' }))], scope(), NOW);
    expect(best).toMatchObject({ candidate: { source: 'issue', issue: { id: 2 }, ownedCoupon: null },
      priceCents: 300, eligibleSubtotalCents: 1_999, lineEligibleCents: [1_999] });
  });
  it('keeps an older valid owned grant and its issued money/minimum', () => {
    const current = issue(99, { couponPrice: '0.01', useMinPrice: '100.00' });
    const actual = owned(current, 7, { couponPrice: '3.00', useMinPrice: '19.99', receiveTime: 1 });
    const used = owned(current, 80, { couponPrice: '5.00', useMinPrice: '0.00', status: 1, receiveTime: 10 });
    expect(selectBestEstimatedCoupon([used, offer(current), actual], scope(), NOW))
      .toMatchObject({ candidate: { source: 'owned', ownedCoupon: { id: 7, couponPrice: '3.00' } }, priceCents: 300 });
    expect(selectBestEstimatedCoupon([actual], scope(1_998), NOW)).toBeNull();
  });
  it('uses deterministic ownership, owned ID and issue ID ties regardless of scan order', () => {
    const all = [offer(issue(3)), owned(issue(8), 72), offer(issue(1)), owned(issue(9), 51)];
    expect(selectBestEstimatedCoupon(all, scope(), NOW)?.candidate.ownedCoupon?.id).toBe(51);
    expect(selectBestEstimatedCoupon([...all].reverse(), scope(), NOW)?.candidate.ownedCoupon?.id).toBe(51);
    expect(selectBestEstimatedCoupon([offer(issue(3)), offer(issue(1))], scope(), NOW)?.candidate.issue.id).toBe(1);
  });
  it('finds the winning actual candidate beyond decorative and first-page boundaries', () => {
    const all = Array.from({ length: 100 }, (_, n) => offer(issue(n + 1, { couponPrice: '0.01' })));
    all.push(offer(issue(101, { couponPrice: '4.00' })));
    expect(selectBestEstimatedCoupon(all, scope(), NOW)).toMatchObject({ candidate: { issue: { id: 101 } }, priceCents: 400 });
  });
  it.each([{ couponType: 2, productId: '70' }, { couponType: 1, legacyCategoryId: 100 },
    { couponType: 3, legacyBrandId: 20 }])('shares parent/category/brand checkout scope %j', changes => {
    expect(selectBestEstimatedCoupon([offer(issue(1, changes))], scope(), NOW)?.priceCents).toBe(100);
  });
  it('uses relation scope and the exact supplied eligible post-promotion amount', () => {
    const prepared = scope(600); prepared.related.set(1, [70]);
    expect(selectBestEstimatedCoupon([offer(issue(1, { couponType: 2, productId: '0', couponPrice: '20.00' }))], prepared, NOW))
      .toMatchObject({ priceCents: 600, relatedProductIds: [70], lineEligibleCents: [600] });
    expect(selectBestEstimatedCoupon([offer(issue(1, { type: 2, couponPrice: '85.99' }))], scope(0), NOW)).toBeNull();
  });
  it('omits zero, invalid, expired, future, failed and unrelated candidates', () => {
    const all = [offer(issue(1, { couponPrice: '0.00' })), offer(issue(2, { type: 2, couponPrice: '100.00' })),
      offer(issue(3, { couponType: 2, productId: '999' })), offer(issue(4, { couponType: 4 })),
      owned(issue(5), 5, { endTime: new Date(NOW - 1) }), owned(issue(6), 6, { startTime: new Date(NOW + 1) }),
      owned(issue(7), 7, { isFail: 1 }), offer(issue(8, { type: 2, couponPrice: '100.01' }))];
    expect(selectBestEstimatedCoupon(all, scope(), NOW)).toBeNull();
  });
  it('propagates invalid priced scope as an error instead of returning a free quote', () => {
    expect(() => selectBestEstimatedCoupon([offer(issue(1))], scope(-1), NOW)).toThrow('商品小计无效');
  });
});
