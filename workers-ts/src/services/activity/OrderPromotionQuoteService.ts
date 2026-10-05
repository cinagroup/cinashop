import { and, desc, eq, inArray, lte, gte, sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import {
  storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue,
  storeProductRelation, storePromotions, storePromotionsAuxiliary,
} from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';

type Promotion = typeof storePromotions.$inferSelect;
type Auxiliary = typeof storePromotionsAuxiliary.$inferSelect;
type PromotionType = 1 | 2 | 3;

/** All prices are integer cents. `key` must uniquely identify a cart line. */
export interface OrderPromotionInputLine {
  key: string | number;
  productId: number;
  skuUnique: string;
  quantity: number;
  rawUnitPriceCents: number;
  memberUnitPriceCents: number;
}

export interface OrderPromotionQuoteInput {
  uid: number;
  lines: readonly OrderPromotionInputLine[];
  firstOrderEligible?: boolean;
  /** UNIX seconds. Omit to use the server clock. Transactional rechecks use the DB clock. */
  now?: number;
}

export interface OrderPromotionAllocation {
  promotionId: number;
  rootId: number;
  type: PromotionType;
  savingsCents: number;
  discountQuantity: number;
  labelIds: number[];
  name: string;
}

export interface OrderPromotionSegment {
  quantity: number;
  rawGrossCents: number;
  totalPriceCents: number;
  unitPriceCents: number | null;
  membershipSavingsCents: number;
  promotionIds: number[];
  promotionAllocations: OrderPromotionAllocation[];
  couponEligibleGrossCents: number;
}

export interface OrderPromotionQuoteLine {
  key: string | number;
  productId: number;
  quantity: number;
  /** Null when a partial cap or cent allocation prevents one uniform unit price. */
  unitPriceCents: number | null;
  totalPriceCents: number;
  promotionSavingsCents: number;
  membershipSavingsCents: number;
  /** Only type-1 discounted pieces consume the lifetime per-product cap. */
  discountQuantity: number;
  promotionIds: number[];
  promotionAllocations: OrderPromotionAllocation[];
  segments: OrderPromotionSegment[];
  couponEligibleGrossCents: number;
  priceType: 'promotions' | '';
}

export interface OrderPromotionQuote {
  lines: OrderPromotionQuoteLine[];
  totalPriceCents: number;
  totalSavingsCents: number;
  membershipSavingsCents: number;
  couponEligibleGrossCents: number;
  /** SHA-256 of the eligible rules, SKU/scope material, history and exact quote. */
  materialsFingerprint: string;
}

interface SelectedLine {
  input: OrderPromotionInputLine;
  parentId: number;
  brands: Set<number>;
  labels: Set<number>;
  byType: Partial<Record<PromotionType, Promotion>>;
}

const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
const ids = (value: unknown) => [...new Set(String(value ?? '').split(',').map(Number)
  .filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
const words = (value: unknown) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const moneyCents = (value: string | number) => {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new ValidateException('优惠活动金额配置无效');
  const [yuan, fen = ''] = text.split('.');
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, '0'));
  if (!whole(cents)) throw new ValidateException('优惠活动金额配置无效');
  return cents;
};

/** PHP floors the saving on each unit, then subtracts it from original price. */
export function discountUnitPriceCents(rawUnitPriceCents: number, discount: string | number): number {
  const percent = Number(discount);
  if (!whole(rawUnitPriceCents) || !Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new ValidateException('限时折扣百分比配置无效');
  }
  return rawUnitPriceCents - Math.trunc(rawUnitPriceCents * (100 - percent) / 100);
}

/** Legacy type-2/3 rules stored decimal percentages. PHP first bcdivs the
 * configured percentage by 100 at scale 2, so 95.50 behaves as 95% before
 * per-unit saving is truncated. New type-1 admin rules remain integer-only. */
function legacyRuleDiscountUnitPriceCents(priceCents: number, discount: string | number): number {
  const text = String(discount);
  const percent = Number(discount);
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(text)
    || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new ValidateException('满减折折扣百分比配置无效');
  }
  return discountUnitPriceCents(priceCents, Math.trunc(percent));
}

function matchesScope(root: Promotion, auxiliary: readonly Auxiliary[], line: SelectedLine): boolean {
  const own = auxiliary.filter((row) => row.promotionsId === root.id && row.type === 1);
  const product = line.parentId;
  switch (root.productPartakeType) {
    case 1: return true;
    case 2: {
      const entries = own.filter((row) => row.productId === product);
      return entries.some((row) => row.isAll === 1 || !words(row.unique).length || words(row.unique).includes(line.input.skuUnique));
    }
    case 3: {
      const entries = own.filter((row) => row.productId === product);
      return !entries.some((row) => row.isAll === 1 || !words(row.unique).length || words(row.unique).includes(line.input.skuUnique));
    }
    case 4: return own.some((row) => row.brandId > 0 && line.brands.has(row.brandId));
    case 5: return own.some((row) => row.storeLabelId > 0 && line.labels.has(row.storeLabelId));
    default: return false;
  }
}

function canOverlay(a: Promotion, b: Promotion): boolean {
  return ids(a.overlay).includes(b.promotionsType) && ids(b.overlay).includes(a.promotionsType);
}

function labelIds(row: Promotion): number[] { return ids(row.labelId); }
function alloc(root: Promotion, savingsCents: number, discountQuantity: number): OrderPromotionAllocation {
  return { promotionId: root.id, rootId: root.id, type: root.promotionsType as PromotionType,
    savingsCents, discountQuantity, labelIds: labelIds(root), name: root.name };
}

function allocateCents(total: number, weights: number[]): number[] {
  const result = weights.map(() => 0), sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return result;
  let left = total;
  for (let i = 0; i < weights.length - 1; i++) {
    result[i] = Math.min(left, Math.trunc(total * weights[i] / sum));
    left -= result[i];
  }
  result[result.length - 1] = left;
  return result;
}

/** A tier percentage is saved per unit in PHP, then multiplied by quantity.
 * If an earlier stacked rule created a nonuniform segment, distribute its
 * exact cents across units before applying that same per-unit truncation. */
function percentageSavingsForSegments(segments: readonly OrderPromotionSegment[], discount: string | number): number {
  return segments.reduce((sum, segment) => {
    const low = Math.floor(segment.totalPriceCents / segment.quantity);
    const highCount = segment.totalPriceCents % segment.quantity;
    const lowSaving = low - legacyRuleDiscountUnitPriceCents(low, discount);
    const highSaving = highCount ? low + 1 - legacyRuleDiscountUnitPriceCents(low + 1, discount) : 0;
    return sum + (segment.quantity - highCount) * lowSaving + highCount * highSaving;
  }, 0);
}

function historyQuantity(snapshot: string | null, cartNum: number): number {
  if (snapshot) {
    try {
      const value = JSON.parse(snapshot) as Record<string, unknown>;
      const quantity = value.promotion_discount_quantity;
      if (typeof quantity === 'number' && whole(quantity) && quantity <= cartNum) return quantity;
    } catch { /* Historical cart JSON may be non-JSON; conservatively count its full quantity. */ }
  }
  return cartNum;
}

async function fingerprint(material: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(material));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the same authoritative materials used by checkout; never hides a DB error. */
export async function quoteOrderPromotions(container: Container, input: OrderPromotionQuoteInput): Promise<OrderPromotionQuote> {
  if (!whole(input.uid) || !Array.isArray(input.lines) || input.lines.length > 200) throw new ValidateException('促销报价参数无效');
  const lineKeys = new Set<string>();
  for (const line of input.lines) {
    if (!whole(line.productId) || line.productId === 0 || !line.skuUnique || !Number.isSafeInteger(line.quantity)
      || line.quantity <= 0 || !whole(line.rawUnitPriceCents) || !whole(line.memberUnitPriceCents)
      || line.memberUnitPriceCents > line.rawUnitPriceCents || lineKeys.has(String(line.key))) {
      throw new ValidateException('促销报价商品参数无效');
    }
    lineKeys.add(String(line.key));
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!whole(now)) throw new ValidateException('促销报价时间无效');
  const productIds = [...new Set(input.lines.map((line) => line.productId))];
  if (!productIds.length) {
    return { lines: [], totalPriceCents: 0, totalSavingsCents: 0, membershipSavingsCents: 0,
      couponEligibleGrossCents: 0, materialsFingerprint: await fingerprint([]) };
  }
  const [products, skus, relations, roots] = await Promise.all([
    container.db.select().from(storeProduct).where(inArray(storeProduct.id, productIds)),
    container.db.select().from(storeProductAttrValue).where(and(
      inArray(storeProductAttrValue.productId, productIds), eq(storeProductAttrValue.type, 0),
      eq(storeProductAttrValue.isRetired, 0))),
    container.db.select().from(storeProductRelation).where(and(
      inArray(storeProductRelation.productId, productIds), inArray(storeProductRelation.type, [2, 3]))),
    container.db.select().from(storePromotions).where(and(
      eq(storePromotions.pid, 0), eq(storePromotions.type, 1), eq(storePromotions.storeId, 0),
      inArray(storePromotions.promotionsType, [1, 2, 3]), eq(storePromotions.status, 1),
      eq(storePromotions.isDel, 0), lte(storePromotions.startTime, now), gte(storePromotions.stopTime, now),
    )).orderBy(storePromotions.promotionsType, desc(storePromotions.updateTime), desc(storePromotions.id)).limit(1001),
  ]);
  if (roots.length > 1000) throw new ValidateException('有效促销活动过多，请联系管理员');
  const rootIds = roots.map((row) => row.id);
  const [auxiliary, children] = await Promise.all([
    rootIds.length ? container.db.select().from(storePromotionsAuxiliary).where(and(
      inArray(storePromotionsAuxiliary.promotionsId, rootIds), eq(storePromotionsAuxiliary.type, 1)))
      .orderBy(storePromotionsAuxiliary.id) : [],
    rootIds.length ? container.db.select().from(storePromotions).where(and(
      // Paid purchases keep consuming a lifetime cap after a derived row is
      // retired. Current tiers below separately require an active child.
      inArray(storePromotions.pid, rootIds), eq(storePromotions.type, 1)))
      .orderBy(storePromotions.pid, storePromotions.threshold, storePromotions.id) : [],
  ]);
  const productById = new Map(products.map((row) => [row.id, row]));
  // PostgreSQL char(8) pads values on read; cart identities use the unpadded key.
  const skuByIdentity = new Map<string, typeof skus[number]>();
  const requestedIdentities = new Set(input.lines.map((line) => `${line.productId}:${line.skuUnique}`));
  for (const sku of skus) {
    const identity = `${sku.productId}:${sku.unique.trimEnd()}`;
    if (!requestedIdentities.has(identity)) continue;
    if (skuByIdentity.has(identity)) throw new ValidateException('商品规格身份重复，请联系管理员');
    skuByIdentity.set(identity, sku);
  }
  const selected: SelectedLine[] = input.lines.map((line) => {
    const product = productById.get(line.productId);
    const sku = skuByIdentity.get(`${line.productId}:${line.skuUnique}`);
    if (!product || !sku || moneyCents(sku.price) !== line.rawUnitPriceCents) {
      throw new ValidateException('商品规格或价格已变化，请重新确认订单');
    }
    const parentId = product.pid > 0 ? product.pid : product.id;
    const ownRelations = relations.filter((row) => row.productId === parentId);
    const result: SelectedLine = { input: line, parentId,
      brands: new Set(ownRelations.filter((row) => row.type === 2).map((row) => row.relationId)),
      labels: new Set(ownRelations.filter((row) => row.type === 3).map((row) => row.relationId)), byType: {} };
    if (!input.firstOrderEligible) {
      for (const root of roots) {
        const type = root.promotionsType as PromotionType;
        if (!result.byType[type] && matchesScope(root, auxiliary, result)) result.byType[type] = root;
      }
    }
    return result;
  });
  const parentIds = [...new Set(selected.map((line) => line.parentId))];
  const missingParents = parentIds.filter((id) => !productIds.includes(id));
  const [parentProducts, parentRelations] = await Promise.all([
    missingParents.length ? container.db.select().from(storeProduct).where(inArray(storeProduct.id, missingParents)) : [],
    missingParents.length ? container.db.select().from(storeProductRelation).where(and(
      inArray(storeProductRelation.productId, missingParents), inArray(storeProductRelation.type, [2, 3]))) : [],
  ]);
  const allProducts = new Map([...products, ...parentProducts].map((row) => [row.id, row]));
  for (const line of selected) {
    for (const relation of parentRelations) if (relation.productId === line.parentId) {
      (relation.type === 2 ? line.brands : line.labels).add(relation.relationId);
    }
    // A child product's scope is its root's scope. Resolve after loading root relations.
    if (!input.firstOrderEligible && line.parentId !== line.input.productId) {
      line.byType = {};
      for (const root of roots) {
        const type = root.promotionsType as PromotionType;
        if (!line.byType[type] && matchesScope(root, auxiliary, line)) line.byType[type] = root;
      }
    }
    const parent = allProducts.get(line.parentId);
    if (!parent || parent.pid !== 0 || parent.isShow !== 1 || parent.isDel !== 0 || parent.isVerify !== 1) {
      line.byType = {};
    }
  }

  const history = !input.firstOrderEligible && input.uid > 0
    && roots.some((row) => row.promotionsType === 1 && row.isLimit === 1)
    ? await container.db.select({ cart: storeOrderCartInfo, order: storeOrder }).from(storeOrderCartInfo)
      .innerJoin(storeOrder, eq(storeOrderCartInfo.oid, storeOrder.id)).where(and(
        eq(storeOrderCartInfo.uid, input.uid), inArray(storeOrderCartInfo.productId, productIds),
        // Supplier allocation changes the original paid root from pid=0 to
        // pid=-1 and clones cart snapshots into pid>0 fulfillment children.
        // Count only the original root snapshot, exactly once.
        eq(storeOrder.uid, input.uid), inArray(storeOrder.pid, [0, -1]),
      )).limit(10001) : [];
  if (history.length > 10000) throw new ValidateException('历史促销订单过多，无法核对限购');
  const historyByRootProduct = new Map<string, number>();
  for (const { cart, order } of history) {
    // Paid purchases continue to consume a lifetime campaign cap after refund or user-hidden deletion.
    // An unpaid cancellation does not. Pending unpaid orders reserve it.
    if (!order.paid && (order.status === -2 || order.isDel === 1)) continue;
    const chosen = ids(cart.promotionsId);
    for (const root of roots) {
      if (root.promotionsType !== 1 || root.isLimit !== 1) continue;
      if (!chosen.includes(root.id) && !children.some((child) => child.pid === root.id
        && child.promotionsType === 1 && chosen.includes(child.id))) continue;
      // Quota identity is the actual purchased product, shared across its SKUs.
      // A supplier copy with the same platform parent has its own quota.
      const key = `${root.id}:${cart.productId}`;
      historyByRootProduct.set(key, (historyByRootProduct.get(key) ?? 0) + historyQuantity(cart.cartInfo, cart.cartNum));
    }
  }

  const base = selected.map(({ input: line }) => ({
    key: line.key, productId: line.productId, quantity: line.quantity,
    unitPriceCents: line.memberUnitPriceCents, totalPriceCents: line.memberUnitPriceCents * line.quantity,
    promotionSavingsCents: 0, membershipSavingsCents: (line.rawUnitPriceCents - line.memberUnitPriceCents) * line.quantity,
    discountQuantity: 0, promotionIds: [], promotionAllocations: [],
    segments: [{ quantity: line.quantity, rawGrossCents: line.rawUnitPriceCents * line.quantity,
      totalPriceCents: line.memberUnitPriceCents * line.quantity,
      unitPriceCents: line.memberUnitPriceCents,
      membershipSavingsCents: (line.rawUnitPriceCents - line.memberUnitPriceCents) * line.quantity,
      promotionIds: [], promotionAllocations: [],
      couponEligibleGrossCents: line.memberUnitPriceCents * line.quantity }],
    couponEligibleGrossCents: line.memberUnitPriceCents * line.quantity, priceType: '',
  })) as OrderPromotionQuoteLine[];

  // Eight global combinations let threshold campaigns compete with a non-overlay
  // time discount; mutual overlay is checked for each product before stacking.
  let best = base;
  let bestTotal = base.reduce((sum, row) => sum + row.totalPriceCents, 0);
  if (!input.firstOrderEligible) for (let mask = 1; mask < 8; mask++) {
    const current: OrderPromotionQuoteLine[] = base.map((row) => ({ ...row,
      promotionIds: [], promotionAllocations: [], segments: row.segments.map((segment) => ({ ...segment,
        promotionIds: [], promotionAllocations: [] })) }));
    const selectedTypes = ([1, 2, 3] as const).filter((type) => mask & (1 << (type - 1)));
    const active = selected.map((line) => selectedTypes.filter((type) => !!line.byType[type]));
    for (let i = 0; i < selected.length; i++) {
      const chosen = active[i];
      // Reject an incompatible combination for this product, then let its
      // compatible smaller combination compete in another mask.
      if (chosen.some((type, j) => chosen.slice(j + 1).some((other) =>
        !canOverlay(selected[i].byType[type]!, selected[i].byType[other]!)))) active[i] = [];
    }
    const remainingByRootProduct = new Map<string, number>();
    for (let i = 0; i < selected.length; i++) {
      const root = active[i].includes(1) ? selected[i].byType[1] : undefined;
      if (!root) continue;
      const line = selected[i].input;
      const bucket = `${root.id}:${line.productId}`;
      const already = historyByRootProduct.get(bucket) ?? 0;
      const remaining = remainingByRootProduct.get(bucket) ?? Math.max(0, root.limitNum - already);
      const count = root.isLimit ? (input.uid > 0 ? Math.min(line.quantity, remaining) : 0) : line.quantity;
      const promoUnit = discountUnitPriceCents(line.rawUnitPriceCents, root.discount);
      const savings = (line.rawUnitPriceCents - promoUnit) * count;
      if (!count || !savings || promoUnit >= line.memberUnitPriceCents && active[i].length === 1) continue;
      remainingByRootProduct.set(bucket, Math.max(0, remaining - count));
      const segments: OrderPromotionSegment[] = [{ quantity: count,
        rawGrossCents: line.rawUnitPriceCents * count, totalPriceCents: promoUnit * count,
        unitPriceCents: promoUnit, membershipSavingsCents: 0, promotionIds: [root.id],
        promotionAllocations: [alloc(root, savings, count)],
        couponEligibleGrossCents: ids(root.overlay).includes(5) ? promoUnit * count : 0 }];
      if (count < line.quantity) segments.push({ quantity: line.quantity - count,
        rawGrossCents: line.rawUnitPriceCents * (line.quantity - count),
        totalPriceCents: line.memberUnitPriceCents * (line.quantity - count),
        unitPriceCents: line.memberUnitPriceCents,
        membershipSavingsCents: (line.rawUnitPriceCents - line.memberUnitPriceCents) * (line.quantity - count),
        promotionIds: [], promotionAllocations: [],
        couponEligibleGrossCents: line.memberUnitPriceCents * (line.quantity - count) });
      current[i].segments = segments;
      current[i].totalPriceCents = segments.reduce((sum, s) => sum + s.totalPriceCents, 0);
      current[i].promotionSavingsCents = savings;
      current[i].membershipSavingsCents = (line.rawUnitPriceCents - line.memberUnitPriceCents) * (line.quantity - count);
      current[i].discountQuantity = count;
      current[i].promotionIds = [root.id];
      current[i].promotionAllocations = [alloc(root, savings, count)];
    }
    for (const type of [2, 3] as const) {
      const rootsForType = [...new Set(active.flatMap((types, i) => types.includes(type)
        ? [selected[i].byType[type]!] : []))];
      for (const root of rootsForType) {
        const positions = selected.map((line, i) => active[i].includes(type) && line.byType[type]?.id === root.id ? i : -1)
          .filter((i) => i >= 0);
        const gross = positions.map((i) => current[i].totalPriceCents);
        const sum = gross.reduce((a, b) => a + b, 0);
        const quantity = positions.reduce((n, i) => n + selected[i].input.quantity, 0);
        // saveData merges the first tier into the root, then inserts only
        // subsequent tiers as children.
        // The parent's active window/status controls its tiers. SaveData puts
        // the first tier on the root; later platform tiers carry pid=root but
        // their own start/stop defaults are zero. Supplier-derived or other
        // promotion-type children sharing a pid are never discount rules.
        const rules = [root, ...children.filter((row) => row.pid === root.id
          && row.storeId === 0 && row.promotionsType === root.promotionsType && row.isDel === 0)];
        if (!sum || !quantity) continue;
        let savings = 0;
        if (type === 2) {
          const rule = rules[0];
          if (quantity >= Number(rule.threshold)) {
            const cheapest = Math.min(...positions.flatMap((i) => current[i].segments.map((s) =>
              Math.floor(s.totalPriceCents / s.quantity))));
            savings = cheapest - legacyRuleDiscountUnitPriceCents(cheapest, rule.discount);
          }
        } else {
          const tiers = rules.filter((rule) => Number(rule.threshold) > 0);
          const measure = (rule: Promotion) => rule.thresholdType === 1 ? sum : quantity;
          if (root.promotionsCate === 1) {
            const tier = tiers.filter((rule) => measure(rule) >= (rule.thresholdType === 1
              ? moneyCents(rule.threshold) : Number(rule.threshold))).at(-1);
            if (tier) savings = tier.discountType === 1 ? moneyCents(tier.discount)
              : positions.reduce((total, i) => total + percentageSavingsForSegments(current[i].segments, tier.discount), 0);
          } else {
            const tier = tiers[0];
            if (tier) {
              const threshold = tier.thresholdType === 1 ? moneyCents(tier.threshold) : Number(tier.threshold);
              const times = Math.floor(measure(tier) / threshold);
              if (times > 0) {
                if (tier.discountType === 1) savings = moneyCents(tier.discount) * times;
                else if (tier.thresholdType === 1) savings = (threshold - legacyRuleDiscountUnitPriceCents(threshold, tier.discount)) * times;
                else {
                  const cheapest = Math.min(...positions.flatMap((i) => current[i].segments.map((s) =>
                    Math.floor(s.totalPriceCents / s.quantity))));
                  savings = (cheapest - legacyRuleDiscountUnitPriceCents(cheapest, tier.discount)) * times;
                }
              }
            }
          }
        }
        savings = Math.min(sum, Math.max(0, savings));
        if (!savings) continue;
        const apportioned = allocateCents(savings, gross);
        for (let j = 0; j < positions.length; j++) {
          const i = positions[j], share = apportioned[j];
          if (!share) continue;
          const line = current[i];
          const segmentShares = allocateCents(share, line.segments.map((s) => s.totalPriceCents));
          line.segments = line.segments.map((segment, index) => {
            const remaining = segment.totalPriceCents - segmentShares[index];
            const promotionIds = [...segment.promotionIds, root.id];
            const couponEligible = (segment.promotionIds.length === 0 || segment.couponEligibleGrossCents > 0)
              && ids(root.overlay).includes(5) ? remaining : 0;
            return { ...segment, totalPriceCents: remaining,
              unitPriceCents: remaining % segment.quantity === 0 ? remaining / segment.quantity : null,
              promotionIds, promotionAllocations: [...segment.promotionAllocations,
                alloc(root, segmentShares[index], segment.quantity)], couponEligibleGrossCents: couponEligible };
          });
          line.totalPriceCents -= share;
          line.promotionSavingsCents += share;
          line.promotionIds.push(root.id);
          line.promotionAllocations.push(alloc(root, share, line.quantity));
        }
      }
    }
    const total = current.reduce((sum, row) => sum + row.totalPriceCents, 0);
    if (total < bestTotal) { best = current; bestTotal = total; }
  }
  for (const line of best) {
    line.couponEligibleGrossCents = line.segments.reduce((sum, s) => sum + s.couponEligibleGrossCents, 0);
    line.unitPriceCents = line.totalPriceCents % line.quantity === 0
      && line.segments.every((s) => s.unitPriceCents === line.totalPriceCents / line.quantity)
      ? line.totalPriceCents / line.quantity : null;
    line.priceType = line.promotionIds.length ? 'promotions' : '';
  }
  // Stock and sales change on another customer's successful checkout. They
  // are checked by stock admission, but cannot invalidate this customer's
  // price confirmation. Bind only the DB facts this quote actually uses.
  const productMaterial = (row: typeof products[number]) => ({ id: row.id,
    pid: row.pid, isShow: row.isShow, isDel: row.isDel, isVerify: row.isVerify });
  const skuMaterial = (row: typeof skus[number]) => ({ id: row.id,
    productId: row.productId, unique: row.unique.trimEnd(), type: row.type,
    isRetired: row.isRetired, price: row.price });
  const promotionMaterial = (row: Promotion) => ({ id: row.id, pid: row.pid,
    promotionsType: row.promotionsType, productPartakeType: row.productPartakeType,
    promotionsCate: row.promotionsCate, thresholdType: row.thresholdType,
    threshold: row.threshold, discountType: row.discountType,
    discount: row.discount, isLimit: row.isLimit, limitNum: row.limitNum,
    overlay: row.overlay, labelId: row.labelId, name: row.name,
    startTime: row.startTime, stopTime: row.stopTime, updateTime: row.updateTime });
  const matchedRoots = [...new Map(selected.flatMap((line) => ([1, 2, 3] as const)
    .flatMap((type) => line.byType[type] ? [[line.byType[type]!.id, line.byType[type]!] as const] : []))).values()]
    .sort((a, b) => a.id - b.id);
  const matchedRootIds = new Set(matchedRoots.map((root) => root.id));
  const matchedAuxiliary = auxiliary.filter((row) => matchedRootIds.has(row.promotionsId));
  const material = { firstOrderEligible: !!input.firstOrderEligible,
    lines: input.lines, products: [...products].sort((a, b) => a.id - b.id).map(productMaterial),
    parentProducts: [...parentProducts].sort((a, b) => a.id - b.id).map(productMaterial),
    skus: skus.filter((sku) => requestedIdentities.has(`${sku.productId}:${sku.unique.trimEnd()}`))
      .sort((a, b) => a.id - b.id).map(skuMaterial),
    scopes: selected.map((row) => {
      const rootIds = new Set(Object.values(row.byType).map((root) => root?.id));
      const own = matchedAuxiliary.filter((item) => rootIds.has(item.promotionsId));
      const brands = new Set(own.map((item) => item.brandId).filter((id) => id > 0));
      const labels = new Set(own.map((item) => item.storeLabelId).filter((id) => id > 0));
      return { parentId: row.parentId,
        brands: [...row.brands].filter((id) => brands.has(id)).sort((a, b) => a - b),
        labels: [...row.labels].filter((id) => labels.has(id)).sort((a, b) => a - b) };
    }),
    roots: matchedRoots.map(promotionMaterial),
    children: children.filter((row) => row.storeId === 0 && row.isDel === 0 && matchedRoots.some((root) => root.id === row.pid
      && root.promotionsType === 3 && row.promotionsType === root.promotionsType)).map(promotionMaterial),
    auxiliary: matchedAuxiliary.map((row) => ({ id: row.id, promotionsId: row.promotionsId,
      type: row.type, productId: row.productId, brandId: row.brandId,
      storeLabelId: row.storeLabelId, isAll: row.isAll, unique: row.unique })),
    history: [...historyByRootProduct.entries()].filter(([key]) => selected.some((row) =>
      row.byType[1] && key === `${row.byType[1].id}:${row.input.productId}`)).sort(), quote: best };
  return { lines: best, totalPriceCents: bestTotal,
    totalSavingsCents: best.reduce((sum, row) => sum + row.promotionSavingsCents, 0),
    membershipSavingsCents: best.reduce((sum, row) => sum + row.membershipSavingsCents, 0),
    couponEligibleGrossCents: best.reduce((sum, row) => sum + row.couponEligibleGrossCents, 0),
    materialsFingerprint: await fingerprint(material) };
}

/** Call only inside the order's PostgreSQL transaction, before claiming stock. */
export async function lockAndRequoteOrderPromotions(
  container: Container, input: OrderPromotionQuoteInput, expectedFingerprint: string,
  giftLocks?: { auxiliaryIds: readonly number[]; giftProductIds: readonly number[]; couponIssueIds: readonly number[] },
): Promise<OrderPromotionQuote> {
  // Admin ordinary-promotion mutations (types 1 and 3) take the exclusive
  // form of this shared catalog lock before root/auxiliary writes. It covers
  // an inserted root that no existing row lock could prevent.
  await container.db.execute(sql`SELECT pg_advisory_xact_lock_shared(
    hashtext('time_discount_catalog'), hashtext('platform_type_1'))`);
  // Keep the rules and scope rows used by the eventual quote stable until
  // commit. Type-1/3 admin writes take the catalog lock first; existing type-2
  // writers are not yet catalog-serialized, but matching rows are locked.
  const lockedRoots = await container.db.execute<{ id: number }>(sql`
    SELECT id FROM ${storePromotions}
    WHERE pid = 0 AND type = 1 AND store_id = 0
      AND promotions_type IN (1, 2, 3, 4) AND status = 1 AND is_del = 0
      AND start_time <= floor(extract(epoch from clock_timestamp()))::integer
      AND stop_time >= floor(extract(epoch from clock_timestamp()))::integer
    ORDER BY id FOR SHARE`);
  if (lockedRoots.length > 1000) throw new ValidateException('有效促销活动过多，请联系管理员');
  if (lockedRoots.length) {
    const rootIds = sql.join(lockedRoots.map((row) => sql`${Number(row.id)}`), sql`, `);
    await container.db.execute(sql`SELECT id FROM ${storePromotions}
      WHERE pid IN (${rootIds}) AND type = 1 AND is_del = 0 ORDER BY id FOR SHARE`);
    await container.db.execute(sql`SELECT id FROM ${storePromotionsAuxiliary}
      WHERE promotions_id IN (${rootIds}) AND type = 1 ORDER BY id FOR SHARE`);
  }
  if (giftLocks?.auxiliaryIds.length) {
    const targets = sql.join([...new Set(giftLocks.auxiliaryIds)].sort((a, b) => a - b).map(id => sql`${id}`), sql`, `);
    await container.db.execute(sql`SELECT id FROM ${storePromotionsAuxiliary}
      WHERE id IN (${targets}) AND type IN (2, 3) ORDER BY id FOR UPDATE`);
  }
  if (input.uid > 0) {
    const productIds = [...new Set(input.lines.map((line) => line.productId))].sort((a, b) => a - b);
    for (const productId of productIds) {
      await container.db.execute(sql`SELECT pg_advisory_xact_lock(${input.uid}::integer, ${productId}::integer)`);
    }
  }
  if (input.lines.length) {
    const requestedIds = [...new Set([...input.lines.map(line => line.productId),
      ...(giftLocks?.giftProductIds ?? [])])].sort((a, b) => a - b);
    const targets = sql.join(requestedIds.map((id) => sql`${id}`), sql`, `);
    const lockedProducts = await container.db.execute<{ id: number; pid: number }>(sql`
      SELECT id, pid FROM ${storeProduct} WHERE id IN (${targets}) ORDER BY id FOR UPDATE`);
    const parentIds = [...new Set(lockedProducts.map((row) => Number(row.pid)).filter((id) => id > 0))]
      .filter((id) => !requestedIds.includes(id)).sort((a, b) => a - b);
    if (parentIds.length) {
      await container.db.execute(sql`SELECT id FROM ${storeProduct}
        WHERE id IN (${sql.join(parentIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
    }
    // The same transaction will later claim stock. UPDATE locks avoid the
    // SHARE-to-UPDATE upgrade deadlock between simultaneous checkouts.
    await container.db.execute(sql`SELECT id FROM ${storeProductAttrValue}
      WHERE product_id IN (${targets}) AND type = 0 ORDER BY id FOR UPDATE`);
  }
  if (giftLocks?.couponIssueIds.length) {
    const targets = sql.join([...new Set(giftLocks.couponIssueIds)].sort((a, b) => a - b).map(id => sql`${id}`), sql`, `);
    await container.db.execute(sql`SELECT id FROM store_coupon_issue WHERE id IN (${targets}) ORDER BY id FOR UPDATE`);
  }
  // A checkout can wait on another purchase or an admin write after its
  // transaction began. Recheck against the wall clock after those locks.
  const clock = await container.db.execute<{ now: number }>(sql`SELECT floor(extract(epoch from clock_timestamp()))::integer AS now`);
  const quote = await quoteOrderPromotions(container, { ...input, now: Number(clock[0]?.now) });
  if (quote.materialsFingerprint !== expectedFingerprint) {
    throw new HttpApiException('优惠活动或价格已变化，请重新确认订单', 409, 409);
  }
  return quote;
}
