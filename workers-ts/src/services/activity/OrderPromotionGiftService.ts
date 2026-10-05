import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { storeCouponIssue, storeCouponIssueUser, storeCouponUser, storeOrder,
  storeOrderCartInfo, storeOrderPromotionGiftCouponReward, storeProduct,
  storeProductAttrValue, storeProductRelation, storePromotions,
  storePromotionsAuxiliary, user, userBill } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { ORDER_PROMOTION_GIFT_VERSION, readOrderPromotionGiftIntent,
  type OrderPromotionGiftIntent, type PromotionGiftCampaign,
  type PromotionGiftCoupon, type PromotionGiftLabel, type PromotionGiftProduct } from './OrderPromotionGiftSnapshot';

type Promotion = typeof storePromotions.$inferSelect;
type Auxiliary = typeof storePromotionsAuxiliary.$inferSelect;
type Product = typeof storeProduct.$inferSelect;
type Sku = typeof storeProductAttrValue.$inferSelect;

export interface OrderPromotionGiftInputLine {
  key: string | number;
  productId: number;
  skuUnique: string;
  quantity: number;
  postPromotionGrossCents: number;
  couponDiscountCents: number;
}
export interface OrderPromotionGiftQuoteInput {
  uid: number;
  lines: readonly OrderPromotionGiftInputLine[];
  firstOrderEligible?: boolean;
  shippingType?: number;
  pricePromotions?: readonly PromotionGiftLabel[];
  now?: number;
}
export interface OrderPromotionGiftQuote {
  intent: OrderPromotionGiftIntent | null;
  materialsFingerprint: string;
  /** Active gift pool rows that checkout must lock FOR UPDATE before product stock. */
  auxiliaryIds: number[];
  /** Purchased and gift product IDs are locked as one sorted set. */
  giftProductIds: number[];
  couponIssueIds: number[];
  totalGiftQuantity: number;
  totalIntegral: number;
}

const validInt = (n: number, zero = false) => Number.isSafeInteger(n) && n >= (zero ? 0 : 1);
const idList = (value: unknown) => [...new Set(String(value ?? '').split(',').map(Number)
  .filter((id) => validInt(id)))].sort((a, b) => a - b);
const skuList = (value: unknown) => String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
const invalid = (message: string) => new ValidateException(message);
const moneyCents = (value: string | number) => {
  const source = String(value);
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(source)) throw invalid('满送金额配置无效');
  const [yuan, fen = ''] = source.split('.');
  const result = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
  if (!validInt(result, true)) throw invalid('满送金额配置无效');
  return result;
};
const ordered = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function selectedScope(root: Promotion, auxiliary: readonly Auxiliary[], product: Product,
  skuUnique: string, brands: Set<number>, labels: Set<number>): boolean {
  const own = auxiliary.filter(row => row.promotionsId === root.id && row.type === 1);
  const parentId = product.pid || product.id;
  const key = skuUnique.trimEnd();
  switch (root.productPartakeType) {
    case 1: return true;
    case 2: return own.some(row => row.productId === parentId &&
      (row.isAll === 1 || !skuList(row.unique).length || skuList(row.unique).includes(key)));
    case 3: return !own.some(row => row.productId === parentId &&
      (row.isAll === 1 || !skuList(row.unique).length || skuList(row.unique).includes(key)));
    case 4: return own.some(row => row.brandId > 0 && brands.has(row.brandId));
    case 5: return own.some(row => row.storeLabelId > 0 && labels.has(row.storeLabelId));
    default: return false;
  }
}

function couponSnapshot(row: Auxiliary, issue: typeof storeCouponIssue.$inferSelect, now: number): PromotionGiftCoupon {
  const title = issue.couponTitle || issue.title;
  const start = issue.useStartTime ? Math.floor(issue.useStartTime.getTime() / 1000) : null;
  const end = issue.useEndTime ? Math.floor(issue.useEndTime.getTime() / 1000) : null;
  if (row.type !== 2 || row.couponId !== issue.id || row.isAll !== 1 || !validInt(row.limitNum)
    || row.surplusNum < 1
    || issue.receiveType !== 3 || issue.status !== 1 || issue.isDel !== 0
    || (issue.startTime && issue.startTime.getTime() > now * 1000)
    || (issue.endTime && issue.endTime.getTime() < now * 1000)
    || (issue.day === 0 && (start === null || end === null || end < now))
    || (issue.isPermanent !== 1 && issue.remainCount < 1)
    || !title || title.length > 64 || ![1, 2].includes(issue.type)) {
    throw invalid('满送优惠券不存在、已失效或发行量不足');
  }
  return { aux_id: row.id, issue_id: issue.id, title, price: String(issue.couponPrice),
    min_price: String(issue.useMinPrice), type: issue.type as 1 | 2, day: issue.day,
    use_start_time: issue.day > 0 ? null : start, use_end_time: issue.day > 0 ? null : end };
}

function giftProductSnapshot(row: Auxiliary, product: Product | undefined, sku: Sku | undefined,
  quantity: number, shippingType: number | undefined, eligibleOwners: Set<string>): PromotionGiftProduct {
  const unique = String(row.unique ?? '').trimEnd();
  if (row.type !== 3 || row.isAll !== 1 || !product || !sku || !validInt(row.limitNum)
    || row.surplusNum < quantity || product.stock < quantity || sku.stock < quantity
    || product.id !== row.productId || product.productType !== 0 || product.isPresaleProduct !== 0
    || product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1
    || !eligibleOwners.has(`${product.type}:${product.relationId}`)
    || sku.productId !== product.id || sku.type !== 0 || sku.isRetired !== 0
    || sku.unique.trimEnd() !== unique || (shippingType !== undefined
      && !String(product.deliveryType).split(',').includes(String(shippingType)))) {
    throw invalid('满送赠品库存不足，或商品、规格、履约归属、配送方式不可用');
  }
  return { aux_id: row.id, product_id: product.id, sku_id: sku.id, unique,
    quantity, cart_id: '' };
}

/** Type-4 uses the exact post-price-promotion, post-coupon line amount. A gift
 * changes no charged cents and is never a type-1/2/3 savings allocation. */
export async function quoteOrderPromotionGifts(container: Container,
  input: OrderPromotionGiftQuoteInput): Promise<OrderPromotionGiftQuote> {
  if (!validInt(input.uid, true) || input.lines.length > 200 || ![1, 2, 3].includes(input.shippingType ?? 1))
    throw invalid('满送报价参数无效');
  const keys = new Set<string>();
  for (const line of input.lines) {
    if (!validInt(line.productId) || !line.skuUnique || !validInt(line.quantity)
      || !validInt(line.postPromotionGrossCents, true) || !validInt(line.couponDiscountCents, true)
      || line.couponDiscountCents > line.postPromotionGrossCents || keys.has(String(line.key)))
      throw invalid('满送报价商品参数无效');
    keys.add(String(line.key));
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!validInt(now, true)) throw invalid('满送报价时间无效');
  const none = async (): Promise<OrderPromotionGiftQuote> => ({ intent: null,
    materialsFingerprint: await hash({ firstOrderEligible: !!input.firstOrderEligible, lines: input.lines, campaigns: [] }),
    auxiliaryIds: [], giftProductIds: [], couponIssueIds: [], totalGiftQuantity: 0, totalIntegral: 0 });
  if (!input.lines.length || input.firstOrderEligible || input.uid === 0) return none();
  const ids = ordered(input.lines.map(line => line.productId));
  const [products, roots] = await Promise.all([
    container.db.select().from(storeProduct).where(inArray(storeProduct.id, ids)),
    container.db.select().from(storePromotions).where(and(eq(storePromotions.pid, 0), eq(storePromotions.type, 1),
      eq(storePromotions.storeId, 0), eq(storePromotions.promotionsType, 4), eq(storePromotions.status, 1),
      eq(storePromotions.isDel, 0), sql`${storePromotions.startTime} <= ${now}`,
      sql`${storePromotions.stopTime} >= ${now}`))
      .orderBy(desc(storePromotions.updateTime), desc(storePromotions.id)).limit(1001),
  ]);
  if (roots.length > 1000) throw invalid('有效满送活动过多，请联系管理员');
  if (!roots.length) return none();
  const productById = new Map(products.map(product => [product.id, product]));
  const rootIds = roots.map(root => root.id);
  const [auxiliary, children] = await Promise.all([
    container.db.select().from(storePromotionsAuxiliary).where(inArray(storePromotionsAuxiliary.promotionsId, rootIds))
      .orderBy(storePromotionsAuxiliary.id),
    container.db.select().from(storePromotions).where(and(inArray(storePromotions.pid, rootIds),
      eq(storePromotions.type, 1), eq(storePromotions.storeId, 0), eq(storePromotions.promotionsType, 4),
      eq(storePromotions.isDel, 0))).orderBy(storePromotions.pid, storePromotions.threshold, storePromotions.id),
  ]);
  const parentIds = ordered(products.map(product => product.pid).filter(id => id > 0));
  const [parents, relations] = await Promise.all([
    parentIds.length ? container.db.select().from(storeProduct).where(inArray(storeProduct.id, parentIds)) : [],
    container.db.select().from(storeProductRelation).where(and(
      inArray(storeProductRelation.productId, ordered([...ids, ...parentIds])),
      inArray(storeProductRelation.type, [2, 3]))) ]);
  const parentById = new Map(parents.map(parent => [parent.id, parent]));
  const chosenByLine = new Map<string, Promotion>();
  for (const line of input.lines) {
    const product = productById.get(line.productId);
    const parent = product?.pid ? parentById.get(product.pid) : product;
    if (!product || !parent || parent.pid !== 0 || parent.isDel || parent.isShow !== 1 || parent.isVerify !== 1
      || product.isDel || product.isShow !== 1 || product.isVerify !== 1 || product.productType !== 0) continue;
    const brands = new Set(relations.filter(row => row.productId === parent.id && row.type === 2).map(row => row.relationId));
    const labels = new Set(relations.filter(row => row.productId === parent.id && row.type === 3).map(row => row.relationId));
    const root = roots.find(candidate => selectedScope(candidate, auxiliary, product, line.skuUnique, brands, labels));
    if (root) chosenByLine.set(String(line.key), root);
  }
  const chosenRoots = roots.filter(root => [...chosenByLine.values()].some(chosen => chosen.id === root.id));
  if (!chosenRoots.length) return none();
  const allTiers = chosenRoots.flatMap(root => [root, ...children.filter(child => child.pid === root.id)]);
  const allTierIds = new Set(allTiers.map(tier => tier.id));
  const giveAux = await container.db.select().from(storePromotionsAuxiliary).where(and(
    inArray(storePromotionsAuxiliary.promotionsId, [...allTierIds]),
    inArray(storePromotionsAuxiliary.type, [2, 3]))).orderBy(storePromotionsAuxiliary.id);
  const couponIds = ordered(giveAux.filter(row => row.type === 2 && row.isAll === 1).map(row => row.couponId));
  const giftIds = ordered(giveAux.filter(row => row.type === 3 && row.isAll === 1).map(row => row.productId));
  const [coupons, giftProducts, giftSkus] = await Promise.all([
    couponIds.length ? container.db.select().from(storeCouponIssue).where(inArray(storeCouponIssue.id, couponIds)) : [],
    giftIds.length ? container.db.select().from(storeProduct).where(inArray(storeProduct.id, giftIds)) : [],
    giftIds.length ? container.db.select().from(storeProductAttrValue).where(and(
      inArray(storeProductAttrValue.productId, giftIds), eq(storeProductAttrValue.type, 0),
      eq(storeProductAttrValue.isRetired, 0))) : [],
  ]);
  const couponById = new Map(coupons.map(coupon => [coupon.id, coupon]));
  const giftById = new Map(giftProducts.map(product => [product.id, product]));
  const campaigns: PromotionGiftCampaign[] = [];
  const usedCoupons = new Set<number>();
  for (const root of chosenRoots) {
    const eligible = input.lines.filter(line => chosenByLine.get(String(line.key))?.id === root.id);
    const amount = eligible.reduce((sum, line) => sum + line.postPromotionGrossCents - line.couponDiscountCents, 0);
    const quantity = eligible.reduce((sum, line) => sum + line.quantity, 0);
    const tiers = [root, ...children.filter(child => child.pid === root.id)];
    const metric = (tier: Promotion) => tier.thresholdType === 1 ? amount : quantity;
    const threshold = (tier: Promotion) => tier.thresholdType === 1 ? moneyCents(tier.threshold) : Number(tier.threshold);
    if (tiers.some(tier => !validInt(threshold(tier)) || ![1, 2].includes(tier.thresholdType)))
      throw invalid('满送门槛配置无效');
    const chosen = root.promotionsCate === 1 ? tiers.filter(tier => metric(tier) >= threshold(tier)).at(-1)
      : tiers[0];
    if (!chosen) continue;
    const repetitions = root.promotionsCate === 1 ? 1 : Math.floor(metric(chosen) / threshold(chosen));
    if (!repetitions) continue;
    if (!validInt(repetitions) || repetitions > 1000 || !validInt(chosen.giveIntegral, true)
      || !validInt(chosen.giveIntegral * repetitions, true)) throw invalid('满送次数或积分超出范围');
    const chosenAux = giveAux.filter(row => row.promotionsId === chosen.id && row.isAll === 1);
    const ownerSet = new Set(eligible.map(line => {
      const product = productById.get(line.productId)!;
      return `${product.type}:${product.relationId}`;
    }));
    const couponsForTier: PromotionGiftCoupon[] = [];
    for (const row of chosenAux.filter(row => row.type === 2)) {
      if (usedCoupons.has(row.couponId)) continue; // PHP's WHERE IN grant is one issue per order.
      const issue = couponById.get(row.couponId);
      if (!issue) throw invalid('满送优惠券不存在');
      couponsForTier.push(couponSnapshot(row, issue, now));
      usedCoupons.add(row.couponId);
    }
    const productsForTier: PromotionGiftProduct[] = chosenAux.filter(row => row.type === 3).map(row => {
      const product = giftById.get(row.productId);
      const sku = giftSkus.find(value => value.productId === row.productId && value.unique.trimEnd() === String(row.unique ?? '').trimEnd());
      return giftProductSnapshot(row, product, sku, repetitions, input.shippingType, ownerSet);
    });
    if (!chosen.giveIntegral && !couponsForTier.length && !productsForTier.length) {
      // PHP grants an issue ID once per order even if two matching campaigns
      // list it. The second coupon-only campaign has no additional entitlement.
      if (chosenAux.some(row => row.type === 2 && usedCoupons.has(row.couponId))) continue;
      throw invalid('满送层级没有有效权益');
    }
    campaigns.push({ id: root.id, tier_id: chosen.id, name: root.name || '满送活动', label_id: idList(root.labelId),
      eligible_cart_ids: eligible.map(line => String(line.key)), threshold_type: chosen.thresholdType as 1 | 2,
      threshold: String(chosen.threshold), repetitions, give_integral: chosen.giveIntegral * repetitions,
      coupons: couponsForTier, products: productsForTier });
  }
  // Refund selectors and legacy cart readers require numeric identities. Assign
  // high IDs inside this order, checking the actual purchased IDs for collision;
  // these are never StoreCart records and never enter purchase-origin quota.
  const cartIds = new Set(input.lines.map(line => String(line.key)));
  let giftCartId = 2_147_483_647;
  for (const product of campaigns.flatMap(campaign => campaign.products)) {
    while (cartIds.has(String(giftCartId))) giftCartId--;
    if (giftCartId < 1) throw invalid('满送赠品订单行标识不足');
    product.cart_id = String(giftCartId--);
    cartIds.add(product.cart_id);
  }
  const intent: OrderPromotionGiftIntent | null = campaigns.length ? { version: ORDER_PROMOTION_GIFT_VERSION,
    price_promotions: [...(input.pricePromotions ?? [])], promotions: campaigns } : null;
  if (intent) readOrderPromotionGiftIntent(JSON.stringify(intent));
  const giftRows = campaigns.reduce((sum, campaign) => sum + campaign.products.length, 0);
  const giftQuantity = campaigns.flatMap(campaign => campaign.products).reduce((sum, product) => sum + product.quantity, 0);
  if (input.lines.length + giftRows > 200 || !validInt(giftQuantity, true)
    || giftQuantity + input.lines.reduce((sum, line) => sum + line.quantity, 0) > 2_147_483_647 || giftRows > 100
    || campaigns.some(campaign => campaign.products.some(product => product.quantity > 32767)))
    throw invalid('满送赠品数量超过订单上限');
  const bound = campaigns.flatMap(campaign => [campaign.id, campaign.tier_id]);
  const material = { input: { ...input, now: undefined }, roots: chosenRoots.map(root => ({ ...root, status: undefined })),
    tiers: allTiers.filter(tier => bound.includes(tier.id)),
    scopes: auxiliary.filter(row => chosenRoots.some(root => root.id === row.promotionsId)),
    gifts: giveAux.filter(row => bound.includes(row.promotionsId)).map(row => ({ ...row, surplusNum: undefined })),
    products: [...products, ...parents, ...giftProducts].map(row => ({ id: row.id, pid: row.pid, type: row.type,
      relationId: row.relationId, productType: row.productType, isShow: row.isShow, isDel: row.isDel,
      isVerify: row.isVerify, isPresaleProduct: row.isPresaleProduct, deliveryType: row.deliveryType })),
    coupons: coupons.map(row => ({ ...row, remainCount: undefined })), intent };
  return { intent, materialsFingerprint: await hash(material),
    auxiliaryIds: ordered(campaigns.flatMap(campaign => [...campaign.coupons, ...campaign.products].map(item => item.aux_id))),
    giftProductIds: ordered(campaigns.flatMap(campaign => campaign.products.map(item => item.product_id))),
    couponIssueIds: ordered(campaigns.flatMap(campaign => campaign.coupons.map(item => item.issue_id))),
    totalGiftQuantity: giftQuantity,
    totalIntegral: campaigns.reduce((sum, campaign) => sum + campaign.give_integral, 0) };
}

/** Caller holds the common catalog lock and the extra gift resources through
 * lockAndRequoteOrderPromotions. The clock must be read after lock waits. */
export async function requoteLockedOrderPromotionGifts(container: Container,
  input: OrderPromotionGiftQuoteInput, expectedFingerprint: string): Promise<OrderPromotionGiftQuote> {
  const clock = await container.db.execute<{ now: number }>(sql`
    SELECT floor(extract(epoch from clock_timestamp()))::integer AS now`);
  const quote = await quoteOrderPromotionGifts(container, { ...input, now: Number(clock[0]?.now) });
  if (quote.materialsFingerprint !== expectedFingerprint)
    throw new HttpApiException('满送活动或赠品已变化，请重新确认订单', 409, 409);
  return quote;
}

/** All writes are in the caller's order-creation transaction. The caller has
 * already locked the common catalog, auxiliary pools, products/SKUs and issue
 * rows in that order. No failed gift is silently omitted. */
export async function reserveOrderPromotionGifts(tx: DbClient, input: {
  quote: OrderPromotionGiftQuote;
  orderId: number;
  uid: number;
  now: number;
  paidMember: boolean;
}): Promise<void> {
  const intent = input.quote.intent;
  if (!intent) return;
  if (!validInt(input.orderId) || !validInt(input.uid) || !validInt(input.now)) throw invalid('满送预留参数无效');
  const coupons = intent.promotions.flatMap(campaign => campaign.coupons.map(coupon => ({ campaign, coupon })));
  const products = intent.promotions.flatMap(campaign => campaign.products.map(product => ({ campaign, product })));
  for (const { campaign, coupon } of coupons) {
    const updated = await tx.update(storePromotionsAuxiliary)
      .set({ surplusNum: sql`${storePromotionsAuxiliary.surplusNum} - 1` })
      .where(and(eq(storePromotionsAuxiliary.id, coupon.aux_id),
        eq(storePromotionsAuxiliary.promotionsId, campaign.tier_id),
        eq(storePromotionsAuxiliary.type, 2), eq(storePromotionsAuxiliary.couponId, coupon.issue_id),
        eq(storePromotionsAuxiliary.isAll, 1), sql`${storePromotionsAuxiliary.surplusNum} >= 1`))
      .returning({ id: storePromotionsAuxiliary.id });
    if (!updated.length) throw invalid('满送优惠券活动池不足，请重新确认订单');
    const issue = await tx.select({ isPermanent: storeCouponIssue.isPermanent }).from(storeCouponIssue)
      .where(and(eq(storeCouponIssue.id, coupon.issue_id), eq(storeCouponIssue.status, 1),
        eq(storeCouponIssue.isDel, 0))).limit(1);
    if (!issue.length) throw invalid('满送优惠券已失效，请重新确认订单');
    if (issue[0].isPermanent !== 1) {
      const held = await tx.update(storeCouponIssue)
        .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
        .where(and(eq(storeCouponIssue.id, coupon.issue_id),
          sql`${storeCouponIssue.remainCount} >= 1`))
        .returning({ id: storeCouponIssue.id });
      if (!held.length) throw invalid('满送优惠券发行量不足，请重新确认订单');
    }
  }
  for (const { campaign, product: gift } of products) {
    const updated = await tx.update(storePromotionsAuxiliary)
      .set({ surplusNum: sql`${storePromotionsAuxiliary.surplusNum} - ${gift.quantity}` })
      .where(and(eq(storePromotionsAuxiliary.id, gift.aux_id),
        eq(storePromotionsAuxiliary.promotionsId, campaign.tier_id),
        eq(storePromotionsAuxiliary.type, 3), eq(storePromotionsAuxiliary.productId, gift.product_id),
        eq(storePromotionsAuxiliary.unique, gift.unique), eq(storePromotionsAuxiliary.isAll, 1),
        sql`${storePromotionsAuxiliary.surplusNum} >= ${gift.quantity}`))
      .returning({ id: storePromotionsAuxiliary.id });
    if (!updated.length) throw invalid('满送赠品活动池不足，请重新确认订单');
    const sku = await tx.update(storeProductAttrValue)
      .set({ stock: sql`${storeProductAttrValue.stock} - ${gift.quantity}`,
        sales: sql`${storeProductAttrValue.sales} + ${gift.quantity}` })
      .where(and(eq(storeProductAttrValue.id, gift.sku_id), eq(storeProductAttrValue.productId, gift.product_id),
        eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0),
        eq(storeProductAttrValue.unique, gift.unique), sql`${storeProductAttrValue.stock} >= ${gift.quantity}`))
      .returning({ id: storeProductAttrValue.id, suk: storeProductAttrValue.suk });
    const product = await tx.update(storeProduct)
      .set({ stock: sql`${storeProduct.stock} - ${gift.quantity}`,
        sales: sql`${storeProduct.sales} + ${gift.quantity}` })
      .where(and(eq(storeProduct.id, gift.product_id), eq(storeProduct.productType, 0),
        eq(storeProduct.isPresaleProduct, 0), eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1),
        eq(storeProduct.isDel, 0), sql`${storeProduct.stock} >= ${gift.quantity}`))
      .returning({ id: storeProduct.id, type: storeProduct.type,
        relationId: storeProduct.relationId, storeName: storeProduct.storeName,
        image: storeProduct.image, isSupportRefund: storeProduct.isSupportRefund });
    if (!sku.length || !product.length) throw invalid('满送赠品库存不足或商品已失效，请重新确认订单');
    const snapshot = {
      financial_version: 'checkout-line-finance-v1', id: gift.cart_id, cart_num: gift.quantity,
      sum_price: '0.00', vip_truePrice: '0.00', price_type: '',
      member_savings_version: 'checkout-member-savings-v1', paid_member: input.paidMember ? 1 : 0,
      member_postage_price: '0.00', member_coupon_price: '0.00',
      raw_postage_price: '0.00', postage_price: '0.00', coupon_price: '0.00',
      integral_price: '0.00', first_order_price: '0.00', sum_true_price: '0.00',
      promotions_true_price: '0.00', costPrice: '0.00', integral: 0,
      use_integral: '0', gain_integral: '0', one_brokerage: '0.00', two_brokerage: '0.00',
      division_staff_brokerage: '0.00', division_agent_brokerage: '0.00', division_brokerage: '0.00',
      product: { id: gift.product_id, storeName: product[0].storeName, image: product[0].image,
        giveIntegral: '0.00' },
      sku: { id: gift.sku_id, unique: gift.unique, suk: sku[0].suk, price: '0.00', write_times: 1 },
      promotion_gift: { version: ORDER_PROMOTION_GIFT_VERSION, root_id: campaign.id,
        tier_id: campaign.tier_id, aux_id: gift.aux_id },
    };
    await tx.insert(storeOrderCartInfo).values({ uid: input.uid, oid: input.orderId, cartId: gift.cart_id,
      type: product[0].type, relationId: product[0].relationId, productId: gift.product_id, productType: 0,
      skuUnique: gift.unique, promotionsId: String(campaign.id), isGift: 1,
      isSupportRefund: product[0].isSupportRefund, cartNum: gift.quantity,
      surplusNum: gift.quantity, splitSurplusNum: gift.quantity, settlePrice: '0.00',
      writeTimes: gift.quantity, writeSurplusTimes: gift.quantity, cartInfo: JSON.stringify(snapshot),
      unique: crypto.randomUUID().replaceAll('-', ''), addTime: input.now });
  }
}

function intentCoupons(intent: OrderPromotionGiftIntent) {
  return intent.promotions.flatMap(campaign => campaign.coupons.map(coupon => ({ campaign, coupon })));
}
function intentProducts(intent: OrderPromotionGiftIntent) {
  return intent.promotions.flatMap(campaign => campaign.products.map(product => ({ campaign, product })));
}

/** Payment root is locked by OrderOutboxService. Issue stock was held at order
 * creation, so a paid retry never consumes it twice. The receipt, owned coupon
 * and points ledger commit with the outbox completion. */
export async function grantPaidOrderPromotionGifts(tx: DbClient,
  order: Pick<typeof storeOrder.$inferSelect,
    'id' | 'uid' | 'orderId' | 'type' | 'pid' | 'paid' | 'refundStatus' | 'promotionsGive' | 'giveIntegral' | 'giveCoupon'>,
  now: number): Promise<void> {
  const intent = readOrderPromotionGiftIntent(order.promotionsGive);
  if (!intent) return;
  if (!validInt(order.id) || !validInt(order.uid) || order.type !== 0 || order.pid > 0
    || order.paid !== 1 || order.refundStatus !== 0 || !validInt(now))
    throw invalid('满送付款归属或售后状态无效');
  const coupons = intentCoupons(intent);
  const expectedIssueIds = ordered(coupons.map(item => item.coupon.issue_id));
  const storedIssueIds = idList(order.giveCoupon);
  const points = intent.promotions.reduce((sum, campaign) => sum + campaign.give_integral, 0);
  if (points !== order.giveIntegral || JSON.stringify(expectedIssueIds) !== JSON.stringify(storedIssueIds))
    throw invalid('满送订单权益与付款快照不一致');
  const existing = await tx.select().from(storeOrderPromotionGiftCouponReward)
    .where(eq(storeOrderPromotionGiftCouponReward.orderId, order.id));
  if (existing.length && existing.length !== coupons.length) throw invalid('满送赠券付款凭据不完整');
  const existingByAux = new Map(existing.map(row => [row.auxiliaryId, row]));
  for (const { campaign, coupon } of coupons) {
    const owned = existingByAux.get(coupon.aux_id);
    if (!owned) continue;
    if (owned.uid !== order.uid || owned.rootId !== campaign.id || owned.tierId !== campaign.tier_id
      || owned.issueCouponId !== coupon.issue_id) throw invalid('满送赠券付款凭据不一致');
    const [issued] = await tx.select({ id: storeCouponUser.id, uid: storeCouponUser.uid,
      issueCouponId: storeCouponUser.issueCouponId }).from(storeCouponUser)
      .where(eq(storeCouponUser.id, owned.couponUserId)).limit(1);
    if (!issued || issued.uid !== order.uid || issued.issueCouponId !== coupon.issue_id)
      throw invalid('满送赠券实例归属不一致');
  }
  const [account] = await tx.select({ uid: user.uid, integral: user.integral }).from(user)
    .where(eq(user.uid, order.uid)).limit(1).for('update');
  if (!account) throw invalid('满送付款用户不存在');
  for (const { campaign, coupon } of coupons) {
    if (existingByAux.has(coupon.aux_id)) continue;
    if (coupon.day === 0 && coupon.use_end_time! < now)
      throw invalid('满送赠券固定使用期已过期，请人工核对付款权益');
    const startTime = coupon.day > 0 ? new Date(now * 1000) : new Date(coupon.use_start_time! * 1000);
    const endTime = coupon.day > 0 ? new Date((now + coupon.day * 86400) * 1000)
      : new Date(coupon.use_end_time! * 1000);
    const [issued] = await tx.insert(storeCouponUser).values({ uid: order.uid,
      issueCouponId: coupon.issue_id, couponTitle: coupon.title,
      couponPrice: coupon.price, useMinPrice: coupon.min_price, status: 0,
      startTime, endTime, useTime: null, type: coupon.type, receiveTime: now,
      receiveSource: 'order', isFail: 0 }).returning({ id: storeCouponUser.id });
    if (!issued) throw new Error('满送赠券写入失败');
    await tx.insert(storeOrderPromotionGiftCouponReward).values({ orderId: order.id, uid: order.uid,
      rootId: campaign.id, tierId: campaign.tier_id, auxiliaryId: coupon.aux_id,
      issueCouponId: coupon.issue_id, couponUserId: issued.id, addTime: now });
    await tx.insert(storeCouponIssueUser).values({ uid: order.uid, issueCouponId: coupon.issue_id, addTime: now });
  }
  const bills = await tx.select({ number: userBill.number }).from(userBill)
    .where(and(eq(userBill.uid, order.uid), eq(userBill.linkId, String(order.id)),
      eq(userBill.eventKey, 'order_promotions_give_integral'))).limit(2);
  if (bills.length > 1) throw invalid('满送积分付款凭据重复');
  const existingBill = bills[0];
  if (existingBill && Number(existingBill.number) !== points) throw invalid('满送积分付款凭据不一致');
  if (points > 0 && !existingBill) {
    const next = account.integral + points;
    if (!validInt(next, true)) throw invalid('满送积分余额超出范围');
    await tx.insert(userBill).values({ uid: order.uid, linkId: String(order.id), pm: 1,
      title: '优惠活动赠送积分', category: 'integral', type: 'gain',
      eventKey: 'order_promotions_give_integral', number: String(points), balance: String(next),
      mark: `订单 ${order.orderId} 满送活动赠送 ${points} 积分`, status: 1, addTime: now });
    await tx.update(user).set({ integral: next }).where(eq(user.uid, order.uid));
  }
}

/** Cancellation's existing cart loop restores physical SKU/product stock.
 * This adapter returns only the independently reserved activity and coupon
 * pools; all checks and writes share that cancellation transaction. */
export async function releaseUnpaidOrderPromotionGifts(tx: DbClient,
  order: Pick<typeof storeOrder.$inferSelect,
    'id' | 'uid' | 'type' | 'pid' | 'paid' | 'promotionsGive'>): Promise<void> {
  const intent = readOrderPromotionGiftIntent(order.promotionsGive);
  if (!intent) return;
  if (order.type !== 0 || order.pid > 0 || order.paid !== 0) throw invalid('满送取消订单归属无效');
  const carts = await tx.select({ cartId: storeOrderCartInfo.cartId, isGift: storeOrderCartInfo.isGift,
    productId: storeOrderCartInfo.productId, skuUnique: storeOrderCartInfo.skuUnique,
    quantity: storeOrderCartInfo.cartNum }).from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id));
  const byCart = new Map(carts.map(cart => [cart.cartId, cart]));
  const gifts = intentProducts(intent);
  if (carts.filter(cart => cart.isGift === 1).length !== gifts.length) throw invalid('满送赠品订单行缺失');
  for (const { campaign, product } of gifts) {
    const cart = byCart.get(product.cart_id);
    if (!cart || cart.isGift !== 1 || cart.productId !== product.product_id
      || cart.skuUnique !== product.unique || cart.quantity !== product.quantity)
      throw invalid('满送赠品订单行与预留不一致');
    const [restored] = await tx.update(storePromotionsAuxiliary)
      .set({ surplusNum: sql`${storePromotionsAuxiliary.surplusNum} + ${product.quantity}` })
      .where(and(eq(storePromotionsAuxiliary.id, product.aux_id),
        eq(storePromotionsAuxiliary.promotionsId, campaign.tier_id),
        eq(storePromotionsAuxiliary.type, 3), eq(storePromotionsAuxiliary.productId, product.product_id),
        eq(storePromotionsAuxiliary.unique, product.unique),
        sql`${storePromotionsAuxiliary.surplusNum} + ${product.quantity} <= ${storePromotionsAuxiliary.limitNum}`))
      .returning({ id: storePromotionsAuxiliary.id });
    if (!restored) throw invalid('满送赠品活动池无法完整归还');
  }
  for (const { campaign, coupon } of intentCoupons(intent)) {
    const [restored] = await tx.update(storePromotionsAuxiliary)
      .set({ surplusNum: sql`${storePromotionsAuxiliary.surplusNum} + 1` })
      .where(and(eq(storePromotionsAuxiliary.id, coupon.aux_id),
        eq(storePromotionsAuxiliary.promotionsId, campaign.tier_id),
        eq(storePromotionsAuxiliary.type, 2), eq(storePromotionsAuxiliary.couponId, coupon.issue_id),
        sql`${storePromotionsAuxiliary.surplusNum} + 1 <= ${storePromotionsAuxiliary.limitNum}`))
      .returning({ id: storePromotionsAuxiliary.id });
    if (!restored) throw invalid('满送赠券活动池无法完整归还');
    const [issue] = await tx.select({ isPermanent: storeCouponIssue.isPermanent }).from(storeCouponIssue)
      .where(eq(storeCouponIssue.id, coupon.issue_id)).limit(1);
    if (!issue) throw invalid('满送赠券发行记录缺失');
    if (issue.isPermanent !== 1) {
      const [recovered] = await tx.update(storeCouponIssue)
        .set({ remainCount: sql`${storeCouponIssue.remainCount} + 1` })
        .where(and(eq(storeCouponIssue.id, coupon.issue_id),
          sql`${storeCouponIssue.remainCount} < ${storeCouponIssue.totalCount}`))
        .returning({ id: storeCouponIssue.id });
      if (!recovered) throw invalid('满送赠券发行量无法完整归还');
    }
  }
}
