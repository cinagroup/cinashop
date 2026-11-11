import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCouponIssue, storeProductCoupon } from '@/models/schema';
import { normalizeCouponIds, tryLockProductCoupon } from '@/services/activity/ProductCouponService';
import { ValidateException } from '@/utils/errors';

const columns = { ...getTableColumns(storeProductCoupon), rowVersion: sql<string>`xmin::text` };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Omission preserves the original receipt hash; explicit empty means clear. */
export function outProductCouponInput(input: Record<string, unknown>): number[] | undefined {
  const value = input.coupon_ids;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) && typeof value !== 'string') throw new ValidateException('优惠券ID格式错误');
  const ids = normalizeCouponIds(value);
  if (ids.some(id => id > 2147483647)) throw new ValidateException('优惠券ID格式错误');
  return ids;
}

async function rows(tx: DbClient, productId: number) {
  const result = await tx.select(columns).from(storeProductCoupon).where(eq(storeProductCoupon.productId, productId))
    .orderBy(asc(storeProductCoupon.id)).limit(2001);
  if (result.length > 2000) throw new ValidateException('商品历史优惠券关联过多，请先核对');
  return result;
}
type Rows = Awaited<ReturnType<typeof rows>>;
type Issue = typeof storeCouponIssue.$inferSelect;
interface Proof { productId: number; rows: Rows; issues?: Issue[] }

/** The coordinator already holds the product row (including on insert). All
 * product-coupon writers lock that parent; the standalone editor also takes
 * this advisory lock. Never wait backwards while holding the parent. Capture
 * xmin to detect trigger interference without granting UPDATE on coupon rows. */
export async function captureOutProductCoupons(tx: DbClient, productId: number): Promise<Proof> {
  if (!await tryLockProductCoupon(tx, productId)) throw new ValidateException('商品优惠券正在变化，请刷新后重试');
  return { productId, rows: await rows(tx, productId) };
}

export async function replaceOutProductCoupons(tx: DbClient, fence: Proof, ids: number[], now: number): Promise<Proof> {
  const issues = ids.length ? await tx.select().from(storeCouponIssue)
    .where(and(inArray(storeCouponIssue.id, ids), eq(storeCouponIssue.isDel, 0)))
    .orderBy(asc(storeCouponIssue.id)).for('share', { noWait: true }) : [];
  if (issues.length !== ids.length) throw new ValidateException('部分优惠券不存在');
  await tx.delete(storeProductCoupon).where(eq(storeProductCoupon.productId, fence.productId));
  const expected = issues.map(issue => ({ productId: fence.productId, issueCouponId: issue.id,
    addTime: now, title: issue.couponTitle || issue.title }));
  const inserted = expected.length ? await tx.insert(storeProductCoupon).values(expected).returning() : [];
  if (inserted.length !== expected.length || inserted.some((row, index) =>
    Object.entries(expected[index]).some(([key, value]) => row[key as keyof typeof row] !== value))) {
    throw new ValidateException('商品优惠券关联写入结果已变化');
  }
  const current = await rows(tx, fence.productId);
  if (!same(current.map(({ rowVersion: _version, ...row }) => row), inserted)) {
    throw new ValidateException('商品优惠券关联写入结果已变化');
  }
  return { productId: fence.productId, rows: current, issues };
}

export async function assertOutProductCoupons(tx: DbClient, proof: Proof) {
  const current = await rows(tx, proof.productId);
  const issues = proof.issues?.length ? await tx.select().from(storeCouponIssue)
    .where(inArray(storeCouponIssue.id, proof.issues.map(issue => issue.id))).orderBy(asc(storeCouponIssue.id)) : [];
  if (!same(current, proof.rows) || (proof.issues && !same(issues, proof.issues))) {
    throw new ValidateException('商品优惠券关联或发行实例已变化');
  }
}
