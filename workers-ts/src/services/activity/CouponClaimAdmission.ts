import type { storeCouponIssue } from '@/models/schema';

type Issue = typeof storeCouponIssue.$inferSelect;
const DAY_MS = 86_400_000;

/** Pure facts shared by ordinary manual grant and read-only offers. Grant callers
 * still own the issue lock, real history reads and all mutations. */
export function ordinaryCouponIssueAdmission(issue: Issue, nowMs: number): string {
  if (issue.status !== 1 || issue.isDel !== 0) return '优惠券不存在或已停发';
  if (issue.receiveType !== 1 || ![0, 1].includes(issue.category) || issue.appType !== 0)
    return '该优惠券不允许手动领取';
  if (issue.startTime && issue.startTime.getTime() > nowMs) return '优惠券未开始';
  if (issue.endTime && issue.endTime.getTime() < nowMs) return '优惠券已结束';
  if (!issue.isPermanent && issue.remainCount <= 0) return '优惠券已领完';
  return '';
}

export function ordinaryCouponClaimLimitAdmission(receiveLimit: number, received: number, historical: number): string {
  if (receiveLimit < 0) return '优惠券限领配置无效';
  const effectiveLimit = receiveLimit || 1;
  return received >= effectiveLimit || receiveLimit === 0 && historical > 0
    ? `每人限领 ${effectiveLimit} 张` : '';
}

/** The owned row is varchar(64), and PostgreSQL's date parameter must be finite.
 * Reject an offer that the actual grant cannot persist. No ownership is created. */
export function couponClaimUseWindow(issue: Issue, nowMs: number):
  { reason: string; startTime: Date; endTime: Date | null } {
  const now = new Date(nowMs);
  if ((issue.couponTitle || issue.title).length > 64)
    return { reason: '优惠券名称超过可领取范围', startTime: now, endTime: null };
  if (issue.day > 0) {
    const endTime = new Date(nowMs + issue.day * DAY_MS);
    if (!Number.isSafeInteger(issue.day) || !Number.isFinite(endTime.getTime()))
      return { reason: '优惠券有效期配置无效', startTime: now, endTime: null };
    return { reason: '', startTime: now, endTime };
  }
  if (!issue.useEndTime)
    return { reason: '优惠券固定有效期未配置', startTime: now, endTime: null };
  if (!Number.isFinite(issue.useEndTime.getTime()) || issue.useEndTime.getTime() < nowMs)
    return { reason: '优惠券固定使用期已过期', startTime: now, endTime: null };
  return { reason: '', startTime: issue.useStartTime ?? now, endTime: issue.useEndTime };
}

/** Membership grant's existing stricter issuer admission, also used by offers. */
export function membershipCouponIssueAdmission(issue: Issue, now: Date): string {
  if (issue.category !== 2 || issue.receiveType !== 1 || issue.appType !== 0) return '该优惠券不允许手动领取';
  if (issue.status !== 1 || issue.isDel !== 0) return '优惠券不存在或已停发';
  if (issue.startTime && issue.startTime > now) return '优惠券未开始';
  if (issue.endTime && issue.endTime < now) return '优惠券已结束';
  if (![1, 2].includes(issue.type) || ![0, 1, 2, 3].includes(issue.couponType) || issue.receiveLimit < 0
    || ![0, 1].includes(issue.isPermanent)) return '优惠券配置无效';
  const money = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u;
  if (!money.test(issue.couponPrice) || !money.test(issue.useMinPrice)) return '优惠券金额配置无效';
  if (issue.type === 2 && (Number(issue.couponPrice) <= 0 || Number(issue.couponPrice) > 100))
    return '折扣优惠券配置无效';
  if ((issue.couponTitle || issue.title).length > 64) return '优惠券名称超过可领取范围';
  if (!issue.isPermanent && issue.remainCount <= 0) return '优惠券已领完';
  if (!Number.isSafeInteger(issue.day) || issue.day < 0 || !Number.isFinite(now.getTime() + issue.day * DAY_MS)
    || Math.abs(now.getTime() + issue.day * DAY_MS) > 8_640_000_000_000_000) return '优惠券有效期配置无效';
  if (issue.day === 0 && (!issue.useEndTime || !Number.isFinite(issue.useEndTime.getTime()) || issue.useEndTime < now))
    return '优惠券固定使用期已过期或未配置';
  if (issue.day === 0 && issue.useStartTime && issue.useEndTime && issue.useStartTime > issue.useEndTime)
    return '优惠券固定使用期配置无效';
  return '';
}

/** Any previous owned state or surviving evidence blocks another member grant. */
export function membershipCouponHasHistory(received: number, historical: number): boolean {
  return received > 0 || historical > 0;
}
