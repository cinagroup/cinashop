import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeBargain, storeCart, storeCombination,
  storeIntegral, storeOrder, storeProduct, storeProductAttrValue, storeSeckill } from '@/models/schema';
import { AuthException, ValidateException } from '@/utils/errors';
import { StoreCartService } from './StoreCartService';
import { centsToDecimal, decimalToCents } from './OrderBrokerageService';
import { isPaidMembershipActive } from './StoreOrderCreateService';
import { readMembershipPricingPolicy } from '@/services/user/MembershipPricingPolicy';
import { type PricedCouponItem } from '@/services/activity/OrderCouponService';
import { claimableOrdinaryEstimatedCoupon, readBestEstimatedCoupon } from '@/services/activity/PublicCouponEstimateService';
import { legacyCouponProjection } from '@/services/activity/V2CouponCompatibilityService';
import { quoteFirstOrderDiscount } from '@/services/activity/StoreNewcomerService';
import { allocateCheckoutLineUnits, fitCheckoutLineCapacities } from './CheckoutLineAllocation';
import { quoteOrderPromotionGifts } from '@/services/activity/OrderPromotionGiftService';
import type { OrderPromotionQuoteLine } from '@/services/activity/OrderPromotionQuoteService';
import { resolveDiscountPackageSelection } from '@/services/activity/StoreDiscountService';
import { preparePresalePurchase } from '@/services/activity/PresalePurchaseSnapshot';
import { assertProductCheckoutShippingType } from './ManualVirtualDeliveryPolicy';
import { assertBargainShippingMethod } from '@/services/activity/BargainShippingPolicy';
import type { CartComputationInput } from './CartComputationInput';
import { assertIntegralOnceLimit, assertIntegralTotalLimit, readIntegralPurchasedQuantity } from '@/services/activity/IntegralPurchaseAdmission';

type Cart = typeof storeCart.$inferSelect;
type Product = typeof storeProduct.$inferSelect;
interface ComputedRow { id: number; cartNum: number; productId: number; type: number; activityId: number;
  unique: string; isValid: boolean; truePrice: string; trueSumPrice: string; sumPrice: string;
  productInfo: { productType: number; stock: number; integral: number } | null; promotion?: OrderPromotionQuoteLine }
export interface CartComputationActor { uid: number; passwordVersion: string; expiresAt: number }
// Force fresh SQL configuration without a KV write, even when a caller has Worker bindings.
const READ_CONFIG = { CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };
const cents = (value: string | number) => {
  const result = decimalToCents(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new ValidateException('购物车预算金额无效');
  return result;
};
const sum = (values: number[]) => {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new ValidateException('购物车预算金额超出安全范围');
  return result;
};
const money = (value: number) => Number(centsToDecimal(value));

/** Compatibility export; shared admission is also used by the actual writer. */
export const claimableCartCoupon = claimableOrdinaryEstimatedCoupon;

/** Budget quotes do not reserve stock, claim coupons, create tokens, or contact providers. */
export class CartComputationService {
  constructor(private readonly container: Container) {}
  private async assertActor(actor: CartComputationActor, container = this.container) {
    if (!Number.isSafeInteger(actor.uid) || actor.uid <= 0 || !Number.isSafeInteger(actor.expiresAt)
      || actor.expiresAt <= Math.floor(Date.now()/1000)) throw new AuthException('登录已过期，请重新登录');
    const account = await container.userDao.findForAuth(actor.uid);
    if (!account || account.status !== 1 || account.isDel !== 0 || account.deleteTime !== null
      || account.pwd !== actor.passwordVersion) throw new AuthException('登录状态已变化，请重新登录');
    return account;
  }
  async compute(actor: CartComputationActor, input: CartComputationInput) {
    // Service callers have the same bounded contract as HTTP callers.
    if (!input.cartIds.length || input.cartIds.length > 100 || new Set(input.cartIds).size !== input.cartIds.length
      || input.cartIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      || input.shippingType !== undefined && ![1,2,3].includes(input.shippingType)) throw new ValidateException('购物车预算参数无效');
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const scoped = createContainerFromDb(tx), account = await this.assertActor(actor, scoped);
      const now = Date.now(), carts = await scoped.storeCartDao.getByIds(input.cartIds);
      if (carts.length !== input.cartIds.length || carts.some(cart => cart.uid !== actor.uid || cart.staffId !== 0
        || cart.touristUid !== '' || cart.storeId !== 0 || cart.isPay !== 0 || cart.isDel !== 0 || cart.isNew !== 0
        || cart.status !== 1 || cart.cartNum <= 0 || cart.cartNum > 32767)) throw new ValidateException('选中商品已失效或不属于当前购物车');
      const type = carts[0]!.type, productType = carts[0]!.productType, activityId = carts[0]!.activityId;
      if (![0,1,2,3,4,5,6,7].includes(type) || carts.some(cart => cart.type !== type || cart.productType !== productType)
        || type > 0 && type !== 5 && carts.length !== 1 || type === 5 && carts.some(cart => cart.activityId !== activityId)
        || [0,6].includes(type) && carts.some(cart => cart.activityId !== 0)
        || [1,2,3,4,5,7].includes(type) && activityId <= 0) throw new ValidateException('不同活动或履约类型请分开预算');
      const products = await tx.select().from(storeProduct).where(inArray(storeProduct.id, [...new Set(carts.map(cart => cart.productId))]));
      const byProduct = new Map(products.map(product => [product.id, product]));
      if (![0,1,2,3,4].includes(productType) || carts.some(cart => !byProduct.has(cart.productId)
        || byProduct.get(cart.productId)!.productType !== cart.productType)) throw new ValidateException('商品履约类型已变化，请重新选购');
      if (input.shippingType !== undefined) {
        assertProductCheckoutShippingType(productType, input.shippingType);
        if (type !== 2 && productType === 0 && products.some(product => !product.deliveryType.split(',').includes(String(input.shippingType))))
          throw new ValidateException('商品不支持所选配送方式');
      }
      await this.activityAdmission(scoped, actor.uid, carts, byProduct, account, input);
      const policy = await readMembershipPricingPolicy(tx), svip = isPaidMembershipActive(account, Math.floor(now/1000));
      const actual = await this.budget(scoped, actor.uid, input, byProduct, false, now);
      const assumed = policy.paidMemberEnabled && !svip
        ? await this.budget(scoped, actor.uid, input, byProduct, true, now) : null;
      return { promotions: [] as unknown[], coupon: actual.coupon, deduction: {
        product_type: productType, type, activity_id: activityId, promotions_price: money(actual.promotions),
        coupon_price: money(actual.discount), first_order_price: money(actual.firstOrder),
        sum_price: money(actual.raw), vip_price: money(actual.member), pay_price: money(actual.pay),
      }, svip_status: svip, svip_price: money(Math.max(0, actual.pay - (assumed?.pay ?? actual.pay))),
        budget: { requiresCouponClaim: actual.requiresClaim, couponIssueId: actual.issueId, couponUserId: actual.userId,
          selection: input.cartIds.map(id => { const row = carts.find(cart => cart.id === id)!;
            return { id, productId: row.productId, cartNum: row.cartNum, unique: row.productAttrUnique, type: row.type, activityId: row.activityId }; }),
          gifts: actual.gifts, requiredIntegral: actual.requiredIntegral, hypotheticalPaidMemberPayPrice: assumed ? centsToDecimal(assumed.pay) : null,
          excludes: ['shipping','integral','payment'], needsCheckoutRequote: true } };
    });
    // Read outside the snapshot: a password change, ban, deletion or expiry during
    // the calculation must not release a stale private result.
    await this.assertActor(actor);
    return result;
  }
  private async activityAdmission(container: Container, uid: number, carts: Cart[], products: Map<number, Product>,
    account: NonNullable<Awaited<ReturnType<Container['userDao']['findForAuth']>>>, input: CartComputationInput) {
    const cart = carts[0]!, type = cart.type;
    if (type === 5) await resolveDiscountPackageSelection(container, { discountId: cart.activityId, uniqueKind: 'base',
      selections: carts.map(row => ({ productId: row.productId, unique: row.productAttrUnique })) });
    if (type === 6) {
      const [sku] = await container.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, cart.productId),
        eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.unique, cart.productAttrUnique), eq(storeProductAttrValue.isRetired, 0))).limit(1);
      if (!sku) throw new ValidateException('预售规格已失效');
      preparePresalePurchase(cart, products.get(cart.productId)!, sku, account);
    }
    if (![1,2,3,4].includes(type)) return;
    const table = type === 1 ? storeSeckill : type === 2 ? storeBargain : type === 3 ? storeCombination : storeIntegral;
    const [activity] = await container.db.select().from(table).where(eq(table.id, cart.activityId)).limit(1);
    if (!activity || activity.productId !== cart.productId) throw new ValidateException('活动关联已失效');
    if (type === 2 && input.shippingType !== undefined) assertBargainShippingMethod(activity, cart.productType, input.shippingType);
    if (type === 4) {
      assertIntegralOnceLimit('onceNum' in activity ? activity.onceNum : undefined, cart.cartNum);
      assertIntegralTotalLimit('num' in activity ? activity.num : undefined, cart.cartNum,
        await readIntegralPurchasedQuantity(container.db, uid, cart.activityId));
    }
    if ('onceNum' in activity && activity.onceNum > 0 && cart.cartNum > activity.onceNum) throw new ValidateException('商品数量超过活动单次限购');
    if ([1,3].includes(type)) {
      if (!('num' in activity) || activity.num <= 0 || !('onceNum' in activity) || activity.onceNum <= 0) throw new ValidateException('活动限购配置无效');
      const [history] = await container.db.select({ total: sql<string>`COALESCE(SUM(${storeOrder.totalNum}),0)::text` })
        .from(storeOrder).where(and(eq(storeOrder.uid, uid), eq(storeOrder.type, type), eq(storeOrder.activityId, cart.activityId),
          inArray(storeOrder.pid, [0,-1]), or(eq(storeOrder.paid,1), and(eq(storeOrder.paid,0),eq(storeOrder.isDel,0)))));
      const purchased = Number(history?.total ?? 0);
      if (!Number.isSafeInteger(purchased) || purchased < 0 || purchased + cart.cartNum > activity.num) throw new ValidateException('已超过活动累计限购');
    }
  }
  private async budget(container: Container, uid: number, input: CartComputationInput, products: Map<number,Product>, assumed: boolean, now: number) {
    const rows = await new StoreCartService(container).list(uid,{ mode:'compute',ids:input.cartIds,hypotheticalPaidMember:assumed }) as ComputedRow[];
    if (rows.length !== input.cartIds.length || rows.some(row => !row.isValid || !row.productInfo || row.cartNum > row.productInfo.stock))
      throw new ValidateException('选中商品或活动库存已失效，请重新选择');
    const type = rows[0]!.type, normal = type === 0;
    const requiredIntegral = type === 4 ? sum(rows.map(row => row.productInfo!.integral * row.cartNum)) : 0;
    if (type === 4) {
      const account = await container.userDao.findForAuth(uid);
      if (!account || account.integral < requiredIntegral) throw new ValidateException(`积分不足，需要 ${requiredIntegral} 积分`);
    }
    const raw = sum(rows.map(row => cents(row.sumPrice))), total = sum(rows.map(row => cents(row.trueSumPrice)));
    const promotions = sum(rows.map(row => row.promotion?.promotionSavingsCents ?? 0));
    const member = sum(rows.map(row => row.promotion?.membershipSavingsCents ?? Math.max(0,cents(row.sumPrice)-cents(row.trueSumPrice))));
    if (raw - member - promotions !== total) throw new ValidateException('购物车预算价格不一致，请重新读取');
    const first = normal ? await quoteFirstOrderDiscount(container,READ_CONFIG,uid,total,Math.floor(now/1000)) : null;
    const firstOrder = first ? cents(first.firstOrderPrice) : 0;
    const items: PricedCouponItem[] = rows.map(row => ({ cart:{cartNum:row.cartNum},product:products.get(row.productId)!,
      unitPriceCents:cents(row.truePrice),promotion:row.promotion,couponEligibleGrossCents:row.promotion?.couponEligibleGrossCents }));
    const best = normal && !first?.couponExclusive ? await readBestEstimatedCoupon(container,uid,items,now) : null;
    const discount = best?.priceCents ?? 0, pay = Math.max(0,total-discount-firstOrder);
    const gross = rows.map(row => cents(row.trueSumPrice)), capacities = best?.lineEligibleCents ?? gross;
    const apportioned = discount ? fitCheckoutLineCapacities(allocateCheckoutLineUnits(discount,capacities,4),capacities) : gross.map(()=>0);
    const pricePromotions = [...new Map(rows.flatMap(row => (row.promotion?.promotionAllocations ?? []).map(allocation =>
      [allocation.rootId,{id:allocation.rootId,label_id:allocation.labelIds,name:allocation.name}] as const))).values()];
    const gift = normal ? await quoteOrderPromotionGifts(container,{ uid,firstOrderEligible:first?.eligible,shippingType:input.shippingType,pricePromotions,
      lines:rows.map((row,index)=>({key:row.id,productId:row.productId,skuUnique:row.unique,quantity:row.cartNum,
        postPromotionGrossCents:gross[index]!,couponDiscountCents:apportioned[index]!})) }) : null;
    let coupon: Record<string,unknown> | [] = [];
    if (best) {
      const {candidate}=best;
      coupon={...legacyCouponProjection(candidate.issue,{variant:'list',relatedProductIds:best.relatedProductIds}),
        id:candidate.source==='owned'?candidate.ownedCoupon.id:candidate.issue.id,cid:candidate.issue.id,
        coupon_title:(candidate.ownedCoupon?.couponTitle || candidate.issue.couponTitle || candidate.issue.title),is_use:candidate.source==='owned',
        coupon_price:money(cents(candidate.terms.couponPrice)),use_min_price:money(cents(candidate.terms.useMinPrice)),
        true_coupon_price:money(discount),...(candidate.source==='owned'?{used:{id:candidate.ownedCoupon.id,cid:candidate.issue.id}}:{})};
    }
    return {raw,pay,member,promotions,discount,firstOrder,coupon,requiredIntegral,requiresClaim:best?.candidate.source==='issue',
      issueId:best?.candidate.issue.id??0,userId:best?.candidate.source==='owned'?best.candidate.ownedCoupon.id:0,
      gifts:gift?.intent?.promotions.map(campaign=>({id:campaign.id,name:campaign.name,giveIntegral:campaign.give_integral,
        coupons:campaign.coupons.map(c=>({issueId:c.issue_id,title:c.title})),
        products:campaign.products.map(p=>({productId:p.product_id,quantity:p.quantity}))}))??[]};
  }
}
