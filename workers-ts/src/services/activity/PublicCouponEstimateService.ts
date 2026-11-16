import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeCouponIssue, storeCouponIssueUser, storeCouponUser } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { couponClaimUseWindow, membershipCouponHasHistory, membershipCouponIssueAdmission,
  ordinaryCouponClaimLimitAdmission, ordinaryCouponIssueAdmission } from './CouponClaimAdmission';
import { readMembershipCouponEligibility } from './MembershipCouponService';
import { evaluateOrderCoupon, prepareCouponScope, type CouponBenefitTerms, type PricedCouponItem } from './OrderCouponService';

type Issue = typeof storeCouponIssue.$inferSelect;
type Owned = typeof storeCouponUser.$inferSelect;
/** Offers deliberately carry no fabricated owned ID, UID or acquisition row. */
export type CouponEstimateCandidate =
  | { source: 'owned'; issue: Issue; terms: CouponBenefitTerms; ownedCoupon: Owned }
  | { source: 'issue'; issue: Issue; terms: CouponBenefitTerms; ownedCoupon: null };
type Scope = Awaited<ReturnType<typeof prepareCouponScope>>;
export interface BestEstimatedCoupon {
  candidate: CouponEstimateCandidate;
  priceCents: number;
  lineEligibleCents: number[];
  eligibleSubtotalCents: number;
  relatedProductIds: number[];
}
/** Each complete source set is bounded independently. Overflow rejects the
 * estimate; catalogue pagination must never masquerade as a global maximum. */
export const COUPON_ESTIMATE_SOURCE_CAP = 1_000;

export function claimableOrdinaryEstimatedCoupon(issue: Issue, received: number, historical: number, nowMs: number): boolean {
  return !ordinaryCouponIssueAdmission(issue, nowMs)
    && !ordinaryCouponClaimLimitAdmission(issue.receiveLimit, received, historical)
    && !couponClaimUseWindow(issue, nowMs).reason;
}

function offerTerms(issue: Issue, nowMs: number): CouponBenefitTerms {
  const window = couponClaimUseWindow(issue, nowMs);
  if (window.reason || !window.endTime) throw new ValidateException(window.reason || '优惠券有效期配置无效');
  return { status: 0, isFail: 0, couponPrice: issue.couponPrice, useMinPrice: issue.useMinPrice,
    startTime: window.startTime, endTime: window.endTime };
}

/** Stable compatibility choice: greatest actual saving, then usable ownership,
 * then ascending real owned ID or issue ID. PHP does not define a stable tie. */
function precedes(candidate: CouponEstimateCandidate, previous: CouponEstimateCandidate): boolean {
  if (candidate.source !== previous.source) return candidate.source === 'owned';
  const candidateId = candidate.source === 'owned' ? candidate.ownedCoupon.id : candidate.issue.id;
  const previousId = previous.source === 'owned' ? previous.ownedCoupon.id : previous.issue.id;
  return candidateId < previousId;
}

export function selectBestEstimatedCoupon(candidates: readonly CouponEstimateCandidate[], scope: Scope,
  nowMs: number): BestEstimatedCoupon | null {
  let best: BestEstimatedCoupon | null = null;
  for (const candidate of candidates) {
    try {
      const evaluated = evaluateOrderCoupon(candidate.terms, candidate.issue, scope, nowMs);
      if (evaluated.priceCents <= 0) continue;
      if (!best || evaluated.priceCents > best.priceCents
        || evaluated.priceCents === best.priceCents && precedes(candidate, best.candidate)) {
        best = { candidate, ...evaluated, relatedProductIds: scope.related.get(candidate.issue.id) ?? [] };
      }
    } catch (error) {
      // A single inapplicable/invalid coupon is not a candidate. SQL, metadata
      // loading, arithmetic/runtime and source-set failures remain fatal.
      if (!(error instanceof ValidateException)) throw error;
    }
  }
  return best;
}

/** Caller supplies its existing SQL snapshot and one clock. This function opens
 * no transaction and performs no KV/provider/sequence/queue or grant operation. */
export async function readBestEstimatedCoupon(container: Container, uid: number,
  items: readonly PricedCouponItem[], nowMs: number): Promise<BestEstimatedCoupon | null> {
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647 || !Number.isSafeInteger(nowMs)
    || !Number.isFinite(new Date(nowMs).getTime()) || !items.length || items.length > 100)
    throw new ValidateException('优惠券预算读取参数无效');
  const date = new Date(nowMs).toISOString();
  const eligibility = uid > 0 ? await readMembershipCouponEligibility(container.db, uid, Math.floor(nowMs / 1_000)) : null;
  const [owned, issues] = await Promise.all([
    uid > 0 ? container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue }).from(storeCouponUser)
      .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
      .where(and(eq(storeCouponUser.uid, uid), eq(storeCouponUser.status, 0), eq(storeCouponUser.isFail, 0),
        sql`(${storeCouponUser.startTime} IS NULL OR ${storeCouponUser.startTime} <= ${date})`,
        sql`(${storeCouponUser.endTime} IS NULL OR ${storeCouponUser.endTime} >= ${date})`))
      .orderBy(asc(storeCouponUser.id)).limit(COUPON_ESTIMATE_SOURCE_CAP + 1) : [],
    container.db.select().from(storeCouponIssue).where(and(eq(storeCouponIssue.status, 1), eq(storeCouponIssue.isDel, 0),
      eq(storeCouponIssue.receiveType, 1), inArray(storeCouponIssue.category, eligibility?.eligible ? [0, 1, 2] : [0, 1]),
      eq(storeCouponIssue.appType, 0),
      sql`(${storeCouponIssue.startTime} IS NULL OR ${storeCouponIssue.startTime} <= ${date})`,
      sql`(${storeCouponIssue.endTime} IS NULL OR ${storeCouponIssue.endTime} >= ${date})`,
      sql`(${storeCouponIssue.isPermanent} <> 0 OR ${storeCouponIssue.remainCount} > 0)`))
      .orderBy(asc(storeCouponIssue.id)).limit(COUPON_ESTIMATE_SOURCE_CAP + 1),
  ]);
  if (owned.length > COUPON_ESTIMATE_SOURCE_CAP || issues.length > COUPON_ESTIMATE_SOURCE_CAP)
    throw new ValidateException('有效优惠券超过预算读取上限，请联系商家');
  const ids = issues.map(issue => issue.id);
  const [counts, evidence] = uid > 0 && ids.length ? await Promise.all([
    container.db.select({ id: storeCouponUser.issueCouponId, count: sql<number>`COUNT(*)::int` }).from(storeCouponUser)
      .where(and(eq(storeCouponUser.uid, uid), inArray(storeCouponUser.issueCouponId, ids))).groupBy(storeCouponUser.issueCouponId),
    container.db.select({ id: storeCouponIssueUser.issueCouponId, count: sql<number>`COUNT(*)::int` }).from(storeCouponIssueUser)
      .where(and(eq(storeCouponIssueUser.uid, uid), inArray(storeCouponIssueUser.issueCouponId, ids))).groupBy(storeCouponIssueUser.issueCouponId),
  ]) : [[], []];
  const received = new Map(counts.map(row => [row.id, row.count]));
  const historical = new Map(evidence.map(row => [row.id, row.count]));
  const candidates: CouponEstimateCandidate[] = owned.flatMap(row => row.issue
    ? [{ source: 'owned' as const, issue: row.issue, terms: row.coupon, ownedCoupon: row.coupon }] : []);
  for (const issue of issues) {
    const count = received.get(issue.id) ?? 0, history = historical.get(issue.id) ?? 0;
    const claimable = issue.category === 2
      ? Boolean(uid > 0 && eligibility?.eligible && !membershipCouponHasHistory(count, history)
        && !membershipCouponIssueAdmission(issue, new Date(nowMs)))
      : claimableOrdinaryEstimatedCoupon(issue, count, history, nowMs);
    if (claimable) candidates.push({ source: 'issue', issue, terms: offerTerms(issue, nowMs), ownedCoupon: null });
  }
  if (!candidates.length) return null;
  const scope = await prepareCouponScope(container, items, candidates.map(candidate => candidate.issue));
  return selectBestEstimatedCoupon(candidates, scope, nowMs);
}
