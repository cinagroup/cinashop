import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  storeOrderProductCouponReward,
  storeOrderCartInfo,
  storeProduct,
  storeProductCoupon,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { lockProductWrite } from "@/services/product/ProductAssociationService";

const PRODUCT_COUPON_LOCK_NAMESPACE = 731_626;
const MAX_COUPONS_PER_PRODUCT = 100;

export interface CouponScopeItem {
  productId: number;
  parentProductId: number;
  categoryIds: readonly number[];
  categoryAncestorIds: readonly number[];
  brandId: number;
  brandAncestorIds: readonly number[];
  subtotalCents: number;
}

export function parseCouponScopeIds(...values: unknown[]): number[] {
  const ids = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "number") return [value];
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Fall through to comma-separated legacy values.
      }
    }
    return trimmed.split(",").map((item) => item.trim());
  });
  return [...new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export function reconcileCouponProductScopeIds(
  encodedValues: readonly unknown[],
  relationValues: readonly unknown[],
): number[] {
  const encoded = parseCouponScopeIds(...encodedValues).sort((left, right) => left - right);
  const related = parseCouponScopeIds(...relationValues).sort((left, right) => left - right);
  if (!related.length) return encoded;
  if (encoded.length) {
    const same = encoded.length === related.length
      && encoded.every((id, index) => id === related[index]);
    if (!same) {
      throw new ValidateException("优惠券商品范围数据不一致，请联系管理员修复");
    }
  }
  return related;
}

export function calculateCouponEligibleSubtotalCents(input: {
  scopeType: number;
  productIds: readonly number[];
  categoryIds: readonly number[];
  brandIds: readonly number[];
  items: readonly CouponScopeItem[];
}): number {
  const productIds = new Set(input.productIds);
  const categoryIds = new Set(input.categoryIds);
  const brandIds = new Set(input.brandIds);
  let total = 0;
  for (const item of input.items) {
    const eligible = input.scopeType === 0
      || (input.scopeType === 1
        && [...item.categoryIds, ...item.categoryAncestorIds].some((id) => categoryIds.has(id)))
      || (input.scopeType === 2
        && (productIds.has(item.productId) || productIds.has(item.parentProductId)))
      || (input.scopeType === 3
        && [item.brandId, ...item.brandAncestorIds].some((id) => brandIds.has(id)));
    if (!eligible) continue;
    if (!Number.isSafeInteger(item.subtotalCents) || item.subtotalCents < 0) {
      throw new Error("优惠券商品小计无效");
    }
    total += item.subtotalCents;
    if (!Number.isSafeInteger(total)) throw new Error("优惠券适用金额超出安全范围");
  }
  return total;
}

function decimalToHundredths(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new ValidateException(`${label}格式错误`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new ValidateException(`${label}超出安全范围`);
  return result;
}

/**
 * Calculate a coupon discount using integer arithmetic only.
 * PHP stores discount coupons as a percentage: 85 means 85% (8.5折).
 * Full-reduction coupons store a money value.
 */
export function calculateCouponDiscountCents(input: {
  discountType: number;
  couponPrice: string;
  eligibleSubtotalCents: number;
}): number {
  if (!Number.isSafeInteger(input.eligibleSubtotalCents) || input.eligibleSubtotalCents < 0) {
    throw new ValidateException("优惠券适用金额无效");
  }
  if (input.discountType === 2) {
    const storedHundredths = decimalToHundredths(input.couponPrice, "优惠券折扣");
    if (storedHundredths <= 0 || storedHundredths > 10_000) {
      throw new ValidateException("优惠券折扣必须大于0且不超过100");
    }
    // PHP uses bcdiv(coupon_price, 100, 2), which truncates the stored
    // percentage to a whole percent before multiplying the subtotal.
    const payPercent = Math.floor(storedHundredths / 100);
    return Number(
      BigInt(input.eligibleSubtotalCents) * BigInt(100 - payPercent) / 100n,
    );
  }
  const faceValueCents = decimalToHundredths(input.couponPrice, "优惠券面额");
  return Math.min(faceValueCents, input.eligibleSubtotalCents);
}

function normalizeCouponIds(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  if (raw.length > MAX_COUPONS_PER_PRODUCT) {
    throw new ValidateException(`每个商品最多关联${MAX_COUPONS_PER_PRODUCT}张优惠券`);
  }
  const ids = raw.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException("优惠券ID格式错误");
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function issueUsableForGrant(
  issue: typeof storeCouponIssue.$inferSelect,
  now: number,
): boolean {
  const nowMs = now * 1000;
  return issue.status === 1
    && issue.isDel === 0
    && (!issue.startTime || issue.startTime.getTime() <= nowMs)
    && (!issue.endTime || issue.endTime.getTime() >= nowMs)
    && (issue.totalCount === 0 || issue.isPermanent === 1 || issue.remainCount > 0);
}

export async function grantPaidOrderProductCoupons(
  tx: DbClient,
  orderId: number,
  uid: number,
  now: number,
): Promise<number> {
  const productRows = await tx
    .select({ productId: storeOrderCartInfo.productId })
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, orderId));
  const productIds = [...new Set(productRows.map((item) => item.productId).filter((id) => id > 0))];
  if (!productIds.length) return 0;
  const links = await tx
    .select()
    .from(storeProductCoupon)
    .where(inArray(storeProductCoupon.productId, productIds))
    .orderBy(asc(storeProductCoupon.issueCouponId), asc(storeProductCoupon.id));
  if (!links.length) return 0;
  // PHP queries coupon templates with `WHERE id IN (...)`, so one template is
  // granted once per paid order even when multiple purchased products point to
  // the same template. Preserve the first stable product relation as evidence.
  const linkByIssue = new Map<number, typeof links[number]>();
  for (const link of links) {
    if (link.issueCouponId > 0 && !linkByIssue.has(link.issueCouponId)) {
      linkByIssue.set(link.issueCouponId, link);
    }
  }
  const issueIds = [...linkByIssue.keys()];
  if (!issueIds.length) return 0;
  const issues = await tx
    .select()
    .from(storeCouponIssue)
    .where(inArray(storeCouponIssue.id, issueIds))
    .orderBy(asc(storeCouponIssue.id))
    .for("update");
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const existingRewards = await tx
    .select({ issueCouponId: storeOrderProductCouponReward.issueCouponId })
    .from(storeOrderProductCouponReward)
    .where(and(
      eq(storeOrderProductCouponReward.orderId, orderId),
      inArray(storeOrderProductCouponReward.issueCouponId, issueIds),
    ));
  const rewardedIssues = new Set(existingRewards.map((reward) => reward.issueCouponId));
  let granted = 0;
  for (const issueId of issueIds) {
    if (rewardedIssues.has(issueId)) continue;
    const link = linkByIssue.get(issueId)!;
    const issue = byId.get(issueId);
    if (!issue || !issueUsableForGrant(issue, now)) continue;
    const unlimited = issue.totalCount === 0 || issue.isPermanent === 1;
    if (!unlimited) {
      const remaining = await tx
        .update(storeCouponIssue)
        .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
        .where(and(eq(storeCouponIssue.id, issue.id), sql`${storeCouponIssue.remainCount} > 0`))
        .returning({ remainCount: storeCouponIssue.remainCount });
      if (!remaining[0]) continue;
      issue.remainCount = remaining[0].remainCount;
    }
    const rolling = issue.day > 0;
    const startTime = rolling ? new Date(now * 1000) : issue.useStartTime;
    const endTime = rolling ? new Date((now + issue.day * 86_400) * 1000) : issue.useEndTime;
    const couponUsers = await tx
      .insert(storeCouponUser)
      .values({
        uid,
        issueCouponId: issue.id,
        couponTitle: issue.couponTitle || issue.title,
        couponPrice: issue.couponPrice,
        useMinPrice: issue.useMinPrice,
        status: 0,
        startTime,
        endTime,
        useTime: null,
        type: issue.type,
        receiveTime: now,
        receiveSource: "order",
        isFail: 0,
      })
      .returning({ id: storeCouponUser.id });
    const couponUser = couponUsers[0];
    if (!couponUser) throw new Error("订单商品赠券写入失败");
    await tx.insert(storeOrderProductCouponReward).values({
      orderId,
      uid,
      productId: link.productId,
      issueCouponId: issue.id,
      couponUserId: couponUser.id,
      addTime: now,
    });
    if (issue.category !== 2) {
      await tx.insert(storeCouponIssueUser).values({
        uid,
        issueCouponId: issue.id,
        addTime: now,
      });
    }
    granted++;
  }
  return granted;
}

export class ProductCouponService {
  constructor(private readonly container: Container) {}

  async list(productId: number) {
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new ValidateException("商品ID错误");
    }
    return this.container.db
      .select({
        id: storeProductCoupon.id,
        product_id: storeProductCoupon.productId,
        issue_coupon_id: storeProductCoupon.issueCouponId,
        title: storeProductCoupon.title,
        add_time: storeProductCoupon.addTime,
      })
      .from(storeProductCoupon)
      .where(eq(storeProductCoupon.productId, productId))
      .orderBy(asc(storeProductCoupon.id));
  }

  async replace(productId: number, couponIdsValue: unknown) {
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new ValidateException("商品ID错误");
    }
    const couponIds = normalizeCouponIds(couponIdsValue);
    return withTx(this.container, async (tx) => {
      await lockProductWrite(tx, productId);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_COUPON_LOCK_NAMESPACE}, ${productId})`);
      const products = await tx
        .select({ id: storeProduct.id })
        .from(storeProduct)
        .where(and(eq(storeProduct.id, productId), eq(storeProduct.isDel, 0)))
        .limit(1)
        .for("update");
      if (!products[0]) throw new NotFoundException("商品不存在");
      const issues = couponIds.length
        ? await tx
            .select({ id: storeCouponIssue.id, title: storeCouponIssue.title, couponTitle: storeCouponIssue.couponTitle })
            .from(storeCouponIssue)
            .where(and(inArray(storeCouponIssue.id, couponIds), eq(storeCouponIssue.isDel, 0)))
            .orderBy(asc(storeCouponIssue.id))
            .for("key share")
        : [];
      if (issues.length !== couponIds.length) throw new NotFoundException("部分优惠券不存在");
      await tx.delete(storeProductCoupon).where(eq(storeProductCoupon.productId, productId));
      if (issues.length) {
        const now = Math.floor(Date.now() / 1000);
        await tx.insert(storeProductCoupon).values(
          issues.map((issue) => ({
            productId,
            issueCouponId: issue.id,
            addTime: now,
            title: issue.couponTitle || issue.title,
          })),
        );
      }
      return { product_id: productId, coupon_ids: couponIds };
    });
  }
}
