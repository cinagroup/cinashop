import { sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { actorInDatabase, type BuyerReviewActor } from '@/services/order/BuyerReviewSession';
import { assertOrdinaryVipCandidate } from '@/services/order/OrdinaryVipCartAdmission';
import { calculateMemberUnitPriceCents, isPaidMembershipActive } from '@/services/order/StoreOrderCreateService';
import { centsToDecimal, decimalToCents } from '@/services/order/OrderBrokerageService';
import { readMembershipPricingPolicy } from '@/services/user/MembershipPricingPolicy';
import { quoteFirstOrderDiscountFromDb } from '@/services/activity/StoreNewcomerService';
import { quoteOrderPromotions } from '@/services/activity/OrderPromotionQuoteService';
import { readBestEstimatedCoupon } from '@/services/activity/PublicCouponEstimateService';
import { readOrdinaryProductSnapshot } from './OrdinaryProductReadData';
import { ValidateException } from '@/utils/errors';
import { decodePublicProductEstimate, validPublicEstimateSku, type PublicProductEstimate } from '../../../../view/common/publicProductEstimate';

const invalid = () => new ValidateException('商品单件预估资料无效，请重新读取');
function title(value: string) {
  const text = value.replace(/<[^>]*>/gu, '').replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 255);
  if (!text) throw invalid();
  return text;
}

/** Quantity-one advice, never a cart, receipt, reservation or grant. All facts
 * belong to one repeatable-read SQL snapshot; checkout remains authoritative. */
export class PublicProductEstimateService {
  constructor(private readonly container: Container, private readonly actor?: BuyerReviewActor,
    private readonly authorize: () => Promise<void> = async () => {}) {}

  async estimate(productId: number, unique?: string): Promise<PublicProductEstimate> {
    if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647
      || unique !== undefined && !validPublicEstimateSku(unique)) throw invalid();
    await this.authorize();
    const uid = this.actor?.uid ?? 0;
    const result = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SET LOCAL statement_timeout='5s'`);
      await db.execute(sql`SET LOCAL lock_timeout='250ms'`);
      await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if (this.actor) await actorInDatabase(db, this.actor);
      const nowMs = Date.now(), now = Math.floor(nowMs / 1_000), scoped = createContainerFromDb(db);
      // uid=0 deliberately avoids the catalogue reader's cart-count projection.
      const { product, skus } = await readOrdinaryProductSnapshot(db, productId, 0, 0);
      if (product.isPresaleProduct !== 0) throw new ValidateException('预售商品不支持普通单件预估');
      const sku = unique === undefined
        ? [...skus].sort((a, b) => decimalToCents(a.price) - decimalToCents(b.price) || a.id - b.id)[0]
        : skus.find(row => row.unique === unique);
      if (!sku) throw new ValidateException('请选择当前有效的商品规格');
      if (sku.stock < 1) throw new ValidateException('当前规格库存不足，无法预估');
      await assertOrdinaryVipCandidate(db, uid, product);
      const rawCents = decimalToCents(sku.price);
      let memberCents = rawCents;
      if (uid > 0) {
        const account = await scoped.userDao.findForAuth(uid);
        if (!account) throw invalid();
        const policy = await readMembershipPricingPolicy(db);
        const level = policy.memberFunctionEnabled && account.levelStatus === 1 && account.level > 0
          ? await scoped.systemUserLevelDao.getById(account.level) : null;
        const discount = level && level.isShow === 1 && level.isDel === 0 ? Number(level.discount) || 100 : 100;
        memberCents = calculateMemberUnitPriceCents({ basePriceCents: rawCents, levelDiscountPercent: discount,
          paidMemberPriceCents: decimalToCents(sku.vip_price), paidMemberActive: policy.paidMemberEnabled && isPaidMembershipActive(account, now),
          paidMemberPriceEnabled: policy.paidMemberPriceEnabled, productPaidMemberPriceEnabled: product.isVip === 1 }).unitPriceCents;
      }
      const first = uid > 0 ? await quoteFirstOrderDiscountFromDb(scoped, uid, memberCents, now) : null;
      const promotion = await quoteOrderPromotions(scoped, { uid, now, firstOrderEligible: first?.eligible ?? false,
        lines: [{ key: sku.unique, productId, skuUnique: sku.unique, quantity: 1, rawUnitPriceCents: rawCents, memberUnitPriceCents: memberCents }] });
      const line = promotion.lines[0];
      if (promotion.lines.length !== 1 || !line || line.key !== sku.unique || line.productId !== productId || line.quantity !== 1) throw invalid();
      const firstCents = first ? decimalToCents(first.firstOrderPrice) : 0;
      const best = first?.couponExclusive ? null : await readBestEstimatedCoupon(scoped, uid,
        [{ cart: { cartNum: 1 }, product, unitPriceCents: memberCents, promotion: line, couponEligibleGrossCents: line.couponEligibleGrossCents }], nowMs);
      const couponCents = best?.priceCents ?? 0;
      const promotions: PublicProductEstimate['computed']['promotions'] = [];
      for (const allocation of line.promotionAllocations) {
        if (allocation.savingsCents === 0) continue;
        const previous = promotions.find(row => row.id === allocation.rootId);
        if (previous) {
          if (previous.type !== allocation.type) throw invalid();
          previous.savings = centsToDecimal(decimalToCents(previous.savings) + allocation.savingsCents);
        } else promotions.push({ id: allocation.rootId, type: allocation.type, name: title(allocation.name),
          savings: centsToDecimal(allocation.savingsCents), quantity: 1 });
      }
      let coupon: PublicProductEstimate['computed']['coupon'] = null;
      if (best) {
        const { candidate } = best, { issue, terms } = candidate;
        if (issue.type !== 1 && issue.type !== 2) throw invalid();
        coupon = { source: candidate.source, issueId: issue.id, ownedId: candidate.ownedCoupon?.id ?? null,
          requiresClaim: candidate.source === 'issue', isMember: issue.category === 2,
          title: title(candidate.ownedCoupon?.couponTitle || issue.couponTitle || issue.title), benefitType: issue.type,
          benefitValue: centsToDecimal(decimalToCents(terms.couponPrice)), minimum: centsToDecimal(decimalToCents(terms.useMinPrice)), savings: centsToDecimal(couponCents) };
      }
      const value: PublicProductEstimate = { version: 1, view: 'uni_product_estimate_v1', ownerUid: uid,
        productId, skuUnique: sku.unique, quantity: 1, evaluatedAt: now, firstOrderEligible: first?.eligible ?? false,
        computed: { promotions, coupon, deduction: { sum_price: centsToDecimal(rawCents),
          vip_price: centsToDecimal(line.membershipSavingsCents), promotions_price: centsToDecimal(line.promotionSavingsCents),
          first_order_price: centsToDecimal(firstCents), coupon_price: centsToDecimal(couponCents),
          pay_price: centsToDecimal(line.totalPriceCents - firstCents - couponCents) } },
        excludes: ['shipping', 'integral', 'payment'], requiresCheckoutRequote: true };
      // The shared strict decoder also checks conservation and all exposed facts.
      return decodePublicProductEstimate(value, { ownerUid: uid, productId, skuUnique: sku.unique });
    });
    await this.authorize();
    if (this.actor) await actorInDatabase(this.container.db, this.actor);
    return result;
  }
}
