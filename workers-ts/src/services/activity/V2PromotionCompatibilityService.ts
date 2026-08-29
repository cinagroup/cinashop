import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import {
  storeCouponIssue,
  storeProduct,
  storeProductAttrValue,
  storeProductRelation,
  storePromotions,
  storePromotionsAuxiliary,
} from "@/models/schema";
import { legacyCouponProjection } from "@/services/activity/V2CouponCompatibilityService";
import { StoreProductService } from "@/services/product/StoreProductService";
import { ValidateException } from "@/utils/errors";

const MAX_PAGE = 1_000;
const MAX_PAGE_SIZE = 100;
const MAX_ACTIVE_PROMOTIONS = 200;
const MAX_PROMOTION_PRODUCTS = 5_000;

type Promotion = typeof storePromotions.$inferSelect;
type PromotionAuxiliary = typeof storePromotionsAuxiliary.$inferSelect;
type ProductAttrValue = typeof storeProductAttrValue.$inferSelect;

export interface LegacyPromotionPage {
  page: number;
  limit: number;
}

function phpInteger(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).trim().match(/^[+-]?\d+/);
  if (!match) return 0;
  const result = Number(match[0]);
  return Number.isSafeInteger(result) ? result : 0;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const result = phpInteger(value, fallback);
  return result > 0 ? Math.min(result, maximum) : fallback;
}

export function parseLegacyPromotionPage(query: Record<string, unknown>): LegacyPromotionPage {
  return {
    page: positiveInteger(query.page, 1, MAX_PAGE),
    limit: positiveInteger(query.limit, 10, MAX_PAGE_SIZE),
  };
}

function csvIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values.map((item) => Number(String(item).trim())).filter((id) => (
    Number.isSafeInteger(id) && id > 0
  )))];
}

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

/** PHP used bcdiv(discount, 100, 2) then bcmul(price, ratio, 2). */
export function legacyPromotionPrice(price: unknown, discount: unknown): number {
  const priceCents = Math.max(0, Math.round(numberValue(price) * 100));
  const integerPercent = Math.max(0, Math.min(100, Math.trunc(numberValue(discount))));
  return Math.trunc(priceCents * integerPercent / 100) / 100;
}

function promotionCatalogProjection(row: Promotion): Record<string, unknown> {
  return {
    id: row.id,
    promotions_type: row.promotionsType,
    name: row.name,
    desc: row.description ?? "",
    image: row.image,
    title: row.title,
    product_partake_type: row.productPartakeType,
    discount: numberValue(row.discount),
    discount_type: row.discountType,
    start_time: row.startTime,
    stop_time: row.stopTime,
  };
}

function promotionRuleProjection(row: Promotion): Record<string, unknown> {
  return {
    id: row.id,
    pid: row.pid,
    type: row.type,
    store_id: row.storeId,
    promotions_type: row.promotionsType,
    promotions_cate: row.promotionsCate,
    name: row.name,
    title: row.title,
    image: row.image,
    desc: row.description ?? "",
    threshold_type: row.thresholdType,
    threshold: numberValue(row.threshold),
    discount_type: row.discountType,
    n_piece_n_discount: row.nPieceNDiscount,
    discount: numberValue(row.discount),
    give_integral: row.giveIntegral,
    give_coupon_id: csvIds(row.giveCouponId),
    give_product_id: csvIds(row.giveProductId),
    give_product_unique: String(row.giveProductUnique ?? "").split(",").filter(Boolean),
    overlay: csvIds(row.overlay),
    label_id: csvIds(row.labelId),
    product_partake_type: row.productPartakeType,
    product_id: csvIds(row.productId),
    is_limit: row.isLimit,
    limit_num: row.limitNum,
    start_time: row.startTime,
    stop_time: row.stopTime,
    sort: row.sort,
    status: row.status,
    is_del: row.isDel,
    update_time: row.updateTime,
    add_time: row.addTime,
  };
}

function skuProjection(row: ProductAttrValue): Record<string, unknown> {
  return {
    id: row.id,
    product_id: row.productId,
    product_type: row.productType,
    suk: row.suk,
    stock: row.stock,
    sum_stock: row.sumStock,
    sales: row.sales,
    price: row.price,
    settle_price: row.settlePrice,
    integral: row.integral,
    image: row.image,
    unique: row.unique,
    cost: row.cost,
    bar_code: row.barCode,
    ot_price: row.otPrice,
    vip_price: row.vipPrice,
    weight: row.weight,
    volume: row.volume,
    brokerage: row.brokerage,
    brokerage_two: row.brokerageTwo,
    type: row.type,
    quota: row.quota,
    quota_show: row.quotaShow,
    code: row.code,
  };
}

function thresholdTitle(rule: Promotion): string {
  const prefix = rule.promotionsCate === 2 ? "每满" : "满";
  const unit = rule.thresholdType === 1 ? "元可领取" : "件可领取";
  return `${prefix}${numberValue(rule.threshold)}${unit}`;
}

export class V2PromotionCompatibilityService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private activeWhere(now: number): SQL {
    return and(
      eq(storePromotions.pid, 0),
      eq(storePromotions.type, 1),
      eq(storePromotions.storeId, 0),
      eq(storePromotions.status, 1),
      eq(storePromotions.isDel, 0),
      lte(storePromotions.startTime, now),
      gte(storePromotions.stopTime, now),
    )!;
  }

  private async activePromotions(type?: number): Promise<Promotion[]> {
    if (type !== undefined && (!Number.isSafeInteger(type) || type < 1 || type > 6)) return [];
    const now = Math.floor(Date.now() / 1_000);
    const rows = await this.container.db.select().from(storePromotions).where(and(
      this.activeWhere(now),
      type === undefined ? undefined : eq(storePromotions.promotionsType, type),
    )).orderBy(
      storePromotions.promotionsType,
      desc(storePromotions.updateTime),
      desc(storePromotions.id),
    ).limit(MAX_ACTIVE_PROMOTIONS + 1);
    if (rows.length > MAX_ACTIVE_PROMOTIONS) {
      throw new ValidateException("有效优惠活动过多，请联系管理员整理");
    }
    return rows;
  }

  private async activePromotion(id: number): Promise<Promotion | null> {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const now = Math.floor(Date.now() / 1_000);
    const rows = await this.container.db.select().from(storePromotions).where(and(
      eq(storePromotions.id, id),
      this.activeWhere(now),
    )).limit(1);
    return rows[0] ?? null;
  }

  private async scopeAuxiliaries(promotions: Promotion[]): Promise<PromotionAuxiliary[]> {
    const ids = promotions.map((row) => row.id);
    if (!ids.length) return [];
    return this.container.db.select().from(storePromotionsAuxiliary).where(and(
      inArray(storePromotionsAuxiliary.promotionsId, ids),
      eq(storePromotionsAuxiliary.type, 1),
    )).orderBy(storePromotionsAuxiliary.id);
  }

  private scopeCondition(
    promotion: Promotion,
    auxiliaries: readonly PromotionAuxiliary[],
  ): SQL | undefined {
    const own = auxiliaries.filter((row) => row.promotionsId === promotion.id);
    switch (promotion.productPartakeType) {
      case 1:
        return sql`true`;
      case 2: {
        const ids = [...new Set(own.map((row) => row.productId).filter((id) => id > 0))];
        return ids.length ? inArray(storeProduct.id, ids) : undefined;
      }
      case 3: {
        const excluded = [...new Set(own.filter((row) => row.isAll === 1)
          .map((row) => row.productId).filter((id) => id > 0))];
        return excluded.length ? notInArray(storeProduct.id, excluded) : sql`true`;
      }
      case 4: {
        const ids = [...new Set(own.map((row) => row.brandId).filter((id) => id > 0))];
        if (!ids.length) return undefined;
        const related = this.container.db.select({ productId: storeProductRelation.productId })
          .from(storeProductRelation).where(and(
            eq(storeProductRelation.type, 2),
            inArray(storeProductRelation.relationId, ids),
          ));
        return inArray(storeProduct.id, related);
      }
      case 5: {
        const ids = [...new Set(own.map((row) => row.storeLabelId).filter((id) => id > 0))];
        if (!ids.length) return undefined;
        const related = this.container.db.select({ productId: storeProductRelation.productId })
          .from(storeProductRelation).where(and(
            eq(storeProductRelation.type, 3),
            inArray(storeProductRelation.relationId, ids),
          ));
        return inArray(storeProduct.id, related);
      }
      default:
        return undefined;
    }
  }

  private async matchingProductIds(
    promotions: Promotion[],
    auxiliaries: PromotionAuxiliary[],
  ): Promise<number[]> {
    if (!promotions.length) return [];
    const scopes = promotions.map((row) => this.scopeCondition(row, auxiliaries)).filter(Boolean) as SQL[];
    if (!scopes.length) return [];
    const rows = await this.container.db.select({ id: storeProduct.id }).from(storeProduct).where(and(
      eq(storeProduct.pid, 0),
      eq(storeProduct.isShow, 1),
      eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1),
      sql`(${sql.join(scopes.map((scope) => sql`(${scope})`), sql` OR `)})`,
    )).orderBy(desc(storeProduct.sort), desc(storeProduct.id)).limit(MAX_PROMOTION_PRODUCTS + 1);
    if (rows.length > MAX_PROMOTION_PRODUCTS) {
      throw new ValidateException("活动商品过多，请缩小活动范围");
    }
    return rows.map((row) => row.id);
  }

  private async productRelations(productIds: number[]) {
    if (!productIds.length) return new Map<number, { brands: Set<number>; labels: Set<number> }>();
    const rows = await this.container.db.select({
      productId: storeProductRelation.productId,
      type: storeProductRelation.type,
      relationId: storeProductRelation.relationId,
    }).from(storeProductRelation).where(and(
      inArray(storeProductRelation.productId, productIds),
      inArray(storeProductRelation.type, [2, 3]),
    ));
    const result = new Map<number, { brands: Set<number>; labels: Set<number> }>();
    for (const row of rows) {
      const value = result.get(row.productId) ?? { brands: new Set<number>(), labels: new Set<number>() };
      if (row.type === 2) value.brands.add(row.relationId);
      if (row.type === 3) value.labels.add(row.relationId);
      result.set(row.productId, value);
    }
    return result;
  }

  private matches(
    productId: number,
    relation: { brands: Set<number>; labels: Set<number> } | undefined,
    promotion: Promotion,
    auxiliaries: readonly PromotionAuxiliary[],
  ): boolean {
    const own = auxiliaries.filter((row) => row.promotionsId === promotion.id);
    if (promotion.productPartakeType === 1) return true;
    if (promotion.productPartakeType === 2) return own.some((row) => row.productId === productId);
    if (promotion.productPartakeType === 3) {
      return !own.some((row) => row.productId === productId && row.isAll === 1);
    }
    if (promotion.productPartakeType === 4) {
      return own.some((row) => row.brandId > 0 && relation?.brands.has(row.brandId));
    }
    if (promotion.productPartakeType === 5) {
      return own.some((row) => row.storeLabelId > 0 && relation?.labels.has(row.storeLabelId));
    }
    return false;
  }

  private async productsFor(
    promotions: Promotion[],
    uid: number,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const auxiliaries = await this.scopeAuxiliaries(promotions);
    const candidateIds = await this.matchingProductIds(promotions, auxiliaries);
    if (!candidateIds.length) return [];
    const page = parseLegacyPromotionPage(query);
    const list = await new StoreProductService(this.container, this.env).getRecommendProducts(uid, {
      ids: candidateIds,
      page: page.page,
      limit: page.limit,
    });
    const productIds = list.map((item) => Number(item.id)).filter((id) => id > 0);
    const relations = await this.productRelations(productIds);
    return list.map((item) => {
      const productId = Number(item.id);
      const matches = promotions.filter((promotion) => this.matches(
        productId,
        relations.get(productId),
        promotion,
        auxiliaries,
      ));
      const promotion = matches[0];
      const output: Record<string, unknown> = {
        ...item,
        product_id: productId,
        promotions: [],
        activity_frame: [],
        activity_background: [],
      };
      if (!promotion) return output;
      if (promotion.promotionsType >= 1 && promotion.promotionsType <= 4) {
        output.promotions = promotionCatalogProjection(promotion);
        if (promotion.promotionsType === 1) {
          output.price = legacyPromotionPrice(item.price, promotion.discount);
        }
      } else if (promotion.promotionsType === 5) {
        output.activity_frame = { id: promotion.id, name: promotion.name, image: promotion.image };
      } else if (promotion.promotionsType === 6) {
        output.activity_background = { id: promotion.id, name: promotion.name, image: promotion.image };
      }
      return output;
    });
  }

  /**
   * Attach the three legacy catalogue promotion slots to an existing product
   * list. Collection/history endpoints need these stable keys but must retain
   * unavailable products that the public recommendation query filters out.
   */
  async decorateCatalogProducts(
    list: readonly Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (!list.length) return [];
    const productIds = [...new Set(list
      .map((item) => Number(item.product_id ?? item.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    const promotions = await this.activePromotions();
    const auxiliaries = await this.scopeAuxiliaries(promotions);
    const relations = await this.productRelations(productIds);
    return list.map((item) => {
      const productId = Number(item.product_id ?? item.id);
      const matches = promotions.filter((promotion) => this.matches(
        productId,
        relations.get(productId),
        promotion,
        auxiliaries,
      ));
      const promotion = matches.find((row) => row.promotionsType >= 1 && row.promotionsType <= 4);
      const frame = matches.find((row) => row.promotionsType === 5);
      const background = matches.find((row) => row.promotionsType === 6);
      return {
        ...item,
        promotions: promotion ? promotionCatalogProjection(promotion) : {},
        activity_frame: frame
          ? { id: frame.id, name: frame.name, image: frame.image }
          : [],
        activity_background: background
          ? { id: background.id, name: background.name, image: background.image }
          : [],
      };
    });
  }

  async productList(typeValue: unknown, query: Record<string, unknown>) {
    const type = phpInteger(typeValue);
    if (type < 1 || type > 6) return { list: [] };
    const promotions = await this.activePromotions(type);
    return { list: await this.productsFor(promotions, 0, query) };
  }

  async collectOrderProduct(uid: number, idValue: unknown, query: Record<string, unknown>) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
    const id = phpInteger(idValue);
    const promotion = await this.activePromotion(id);
    if (!promotion) throw new ValidateException("活动已失效，请刷新页面");
    const children = await this.container.db.select().from(storePromotions)
      .where(eq(storePromotions.pid, promotion.id)).orderBy(storePromotions.id)
      .limit(MAX_ACTIVE_PROMOTIONS + 1);
    if (children.length > MAX_ACTIVE_PROMOTIONS) throw new ValidateException("活动阶梯配置过多");
    return {
      promotions: {
        ...promotionRuleProjection(promotion),
        promotions: children.map(promotionRuleProjection),
      },
      list: await this.productsFor([promotion], uid, query),
    };
  }

  async giveInfo(idValue: unknown) {
    const id = phpInteger(idValue);
    const promotion = await this.activePromotion(id);
    if (!promotion || promotion.promotionsType !== 4) return {};
    const children = await this.container.db.select().from(storePromotions)
      .where(eq(storePromotions.pid, promotion.id)).orderBy(storePromotions.id)
      .limit(MAX_ACTIVE_PROMOTIONS + 1);
    if (children.length > MAX_ACTIVE_PROMOTIONS) throw new ValidateException("活动阶梯配置过多");
    const rules = [promotion, ...children];
    const ruleIds = rules.map((row) => row.id);
    const auxiliary = await this.container.db.select().from(storePromotionsAuxiliary).where(and(
      inArray(storePromotionsAuxiliary.promotionsId, ruleIds),
      inArray(storePromotionsAuxiliary.type, [2, 3]),
    )).orderBy(storePromotionsAuxiliary.id);
    const couponIds = [...new Set(auxiliary.filter((row) => row.type === 2)
      .map((row) => row.couponId).filter((value) => value > 0))];
    const productIds = [...new Set(auxiliary.filter((row) => row.type === 3)
      .map((row) => row.productId).filter((value) => value > 0))];
    const uniques = [...new Set(auxiliary.filter((row) => row.type === 3)
      .map((row) => String(row.unique ?? "")).filter(Boolean))];
    const [coupons, products, attrs] = await Promise.all([
      couponIds.length ? this.container.db.select().from(storeCouponIssue)
        .where(inArray(storeCouponIssue.id, couponIds)) : Promise.resolve([]),
      productIds.length ? this.container.db.select({
        id: storeProduct.id,
        storeName: storeProduct.storeName,
      }).from(storeProduct).where(inArray(storeProduct.id, productIds)) : Promise.resolve([]),
      uniques.length ? this.container.db.select().from(storeProductAttrValue).where(and(
        inArray(storeProductAttrValue.unique, uniques),
        eq(storeProductAttrValue.type, 0),
      )) : Promise.resolve([]),
    ]);
    const couponById = new Map(coupons.map((row) => [row.id, row]));
    const productById = new Map(products.map((row) => [row.id, row]));
    const attrByUnique = new Map(attrs.map((row) => [row.unique, row]));
    const giveIntegral: Record<string, unknown>[] = [];
    const giveCoupon: Record<string, unknown>[] = [];
    const giveProducts: Record<string, unknown>[] = [];
    for (const rule of rules) {
      const title = thresholdTitle(rule);
      if (rule.giveIntegral) {
        giveIntegral.push({ threshold_title: title, give_integral: rule.giveIntegral });
      }
      for (const row of auxiliary.filter((item) => item.promotionsId === rule.id && item.type === 2)) {
        const coupon = couponById.get(row.couponId);
        if (!coupon) continue;
        giveCoupon.push({
          type: row.type,
          promotions_id: row.promotionsId,
          coupon_id: row.couponId,
          limit_num: row.limitNum,
          surplus_num: row.surplusNum,
          ...legacyCouponProjection(coupon, { variant: "list" }),
          threshold_title: title,
        });
      }
      for (const row of auxiliary.filter((item) => item.promotionsId === rule.id && item.type === 3)) {
        const product = productById.get(row.productId);
        if (!product) continue;
        const attr = attrByUnique.get(String(row.unique ?? ""));
        giveProducts.push({
          type: row.type,
          promotions_id: row.promotionsId,
          product_id: row.productId,
          limit_num: row.limitNum,
          surplus_num: row.surplusNum,
          unique: row.unique ?? "",
          id: product.id,
          store_name: product.storeName,
          ...(attr ? skuProjection(attr) : {}),
          threshold_title: title,
        });
      }
    }
    return { giveIntegral, giveCoupon, giveProducts };
  }
}
