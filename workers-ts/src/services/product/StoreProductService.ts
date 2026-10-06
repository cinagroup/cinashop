/**
 * 商品 Service
 *
 * 对应 PHP app/services/product/StoreProductServices.php
 * 核心方法: getGoodsList (列表) + getProductDetail (详情)
 */
import { withTx, createContainerFromDb, type Container } from "@/lib/di";
import type { Env } from "@/env";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { UserLevelService } from "@/services/user/UserLevelService";
import { readMembershipPricingPolicy } from "@/services/user/MembershipPricingPolicy";
import { calculateMemberUnitPriceCents, isPaidMembershipActive } from "@/services/order/StoreOrderCreateService";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  storeCart,
  storeProductAttr,
  storeProductAttrValue,
  storeProductCategory,
  systemForm,
} from "@/models/schema";
import { readOrdinaryProductSnapshot } from './OrdinaryProductReadData';
import { validatePublicCategoryFilters } from './PublicCategoryPolicy';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { detailDisplayPrice,readProductDetailExtras,renderProductDetailExtras,readDetailVideo } from './ProductDetailDesignData';
import { parseSystemFormDefinition } from "@/services/system/SystemMetadataService";

/** 默认分页大小 (对应 PHP database.page.defaultLimit) */
const DEFAULT_LIMIT = 10;
/** 最大分页 (对应 PHP database.page.limitMax) */
const MAX_LIMIT = 100;

/** 列表查询入参 (对应 PHP getGoodsList 的 $where) */
export interface GoodsListParams {
  keyword?: string; // → store_name
  store_name?: string;
  sid?: number; // 二级分类
  cid?: number; // 一级分类
  tid?: number; // 三级分类
  cate_id?: string; // 多分类逗号串
  selectId?: number;
  brand_id?: string;
  store_label_id?: string;
  priceOrder?: "" | "asc" | "desc";
  salesOrder?: "" | "asc" | "desc";
  news?: number; // → is_new
  type?: string; // → status
  product_types?: number[];
  ids?: string;
  promotions_type?: number;
  defaultOrder?: number;
  page?: number;
  limit?: number;
}

export interface RecommendProductParams {
  ids?: number[];
  cateIds?: number[];
  productTypes?: number[];
  isHot?: boolean;
  isBenefit?: boolean;
  isBest?: boolean;
  isNew?: boolean;
  isGood?: boolean;
  isVip?: boolean;
  rankOrder?: "sales" | "star" | "collect";
  page?: number;
  limit?: number;
}

export function parseLegacyProductAttrValues(value: string): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch {
    // Older rows store the same values as a comma-delimited string.
  }
  return normalized.split(",").map((item) => item.trim()).filter(Boolean);
}

function legacyProductInfo(
  product: NonNullable<Awaited<ReturnType<Container["storeProductDao"]["getById"]>>>,
): Record<string, unknown> {
  return {
    id: product.id,
    pid: product.pid,
    type: product.type,
    product_type: product.productType,
    relation_id: product.relationId,
    image: product.image,
    recommend_image: product.recommendImage,
    slider_image: product.sliderImage,
    store_name: product.storeName,
    store_info: product.storeInfo,
    keyword: product.keyword,
    bar_code: product.barCode,
    cate_id: product.cateId,
    price: String(product.price),
    vip_price: String(product.vipPrice),
    ot_price: String(product.otPrice),
    delivery_type: String(product.deliveryType || "").split(",").filter(Boolean),
    freight: product.freight,
    postage: String(product.postage),
    temp_id: product.tempId,
    unit_name: product.unitName,
    sort: product.sort,
    star: String(product.star),
    collect: product.collect,
    ficti: product.ficti,
    sales: product.sales,
    stock: product.stock,
    is_show: product.isShow,
    is_del: product.isDel,
    is_verify: product.isVerify,
    is_vip: product.isVip,
    is_vip_product: product.isVipProduct,
    is_presale_product: product.isPresaleProduct,
    presale_start_time: product.presaleStartTime,
    presale_end_time: product.presaleEndTime,
    spec_type: product.specType,
    system_form_id: product.systemFormId,
    custom_form: [],
  };
}

export class StoreProductService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /** 分页参数归一化 (对应 PHP BaseServices::getPageValue) */
  private getPageValue(
    page?: number,
    limit?: number,
  ): [number, number] {
    const p = Number(page) > 0 ? Number(page) : 1;
    let l = Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT;
    if (l > MAX_LIMIT) l = MAX_LIMIT;
    if (!Number.isSafeInteger(p) || !Number.isSafeInteger(l) || (p - 1) * l > 100000) throw new ValidateException("商品分页超出完整读取范围");
    return [p, l];
  }

  /**
   * 商品列表 (对应 PHP getGoodsList)
   *
   * 流程:
   *   1. 强制过滤 is_show=1, is_del=0, is_verify=1 (上架可见)
   *   2. cid/sid/tid 转换为 relation 子查询的 cateId (M2 简化: 直接传 cateId)
   *   3. 关键字 (M2 简化: 不做分词, 直接走 store_name searcher; M5 接入 vicSearch)
   *   4. 调 dao.getSearchList 取列表 (含 sales=ficti+real 计算列)
   *   5. 每行做 getMinPrice 后处理 (会员价/等级价)
   *   6. 返回 { list, count }
   */
  async getGoodsList(params: GoodsListParams, _uid: number): Promise<{
    list: Record<string, unknown>[];
    count: number | null;
  }> {
    return withTx(this.container, async tx => {
      // Keyword search retains its existing history write. The catalogue,
      // membership and count still observe one bounded transaction snapshot.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`); await themeDeadlines(tx);
      return new StoreProductService(createContainerFromDb(tx), this.env).getGoodsListInSnapshot(params, _uid);
    });
  }
  private async getGoodsListInSnapshot(params: GoodsListParams, _uid: number): Promise<{ list: Record<string, unknown>[]; count: number }> {
    await validatePublicCategoryFilters(this.container.db, { cid: params.cid, sid: params.sid, tid: params.tid, selectId: params.selectId });
    // 1. 组装 where
    const where: Record<string, unknown> = {
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      status: 1, // 上架 (searcher status=1 → is_show=1 AND is_del=0 AND is_verify=1)
      isVipProduct: 0, // 非 svip 专属 (默认隐藏 svip 商品)
      publicCatalog: true,
    };

    if (_uid) {
      const current = await this.container.userDao.findForAuth(_uid);
      if (current?.isMoneyLevel) where.isVipProduct = -1;
    }

    let sid = params.sid;
    let cid = params.cid;
    let tid = params.tid;
    if (params.selectId && (!sid || !cid)) {
      const categories = await this.container.db
        .select({ level: storeProductCategory.level })
        .from(storeProductCategory)
        .where(eq(storeProductCategory.id, params.selectId))
        .limit(1);
      const level = categories[0]?.level ?? 0;
      if (level === 0) cid = params.selectId;
      else if (level === 1) sid = params.selectId;
      else tid = params.selectId;
    }

    if (params.store_name) where.store_name = params.store_name;
    if (params.store_name) where.pid = 0;
    if (params.news) where.timeOrder = 1;
    if (params.cate_id) where.cateId = String(params.cate_id).split(",").map(Number);
    if (cid) where.cid = cid;
    if (sid) where.sid = sid;
    if (tid) where.tid = tid;
    if (params.type !== undefined && params.type !== "") where.status = Number(params.type);
    if (params.product_types?.length) where.productType = params.product_types;
    if (params.brand_id) where.brandId = String(params.brand_id).split(",").map(Number);
    if (params.store_label_id) {
      where.storeLabelIds = String(params.store_label_id)
        .split(",")
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    }
    if (params.priceOrder) where.priceOrder = params.priceOrder;
    if (params.salesOrder) where.salesOrder = params.salesOrder;
    if (params.defaultOrder !== undefined) where.defaultOrder = params.defaultOrder;

    // Explicit product scopes participate in the cached keyword query instead
    // of replacing its result afterwards.
    if (params.ids) {
      const ids = String(params.ids)
        .split(",")
        .map(Number)
        .filter((n) => n > 0);
      if (ids.length) where.ids = ids;
    }

    // PHP UserSearchServices::vicSearch caches the complete matching id set for
    // two hours, then stores/updates the user's search history before paging.
    const searchKeyword = params.store_name?.trim();
    if (searchKeyword) {
      const searchIds = await new UserBehaviorService(this.container)
        .resolveProductSearch(_uid, searchKeyword, where);
      if (searchIds.length > 0) {
        where.ids = searchIds;
        delete where.store_name;
      }
    }

    // 2. 分页
    const [page, limit] = this.getPageValue(params.page, params.limit);

    // 3. 取列表 (dao 内含排序 + sales 计算列)
    const list = await this.container.storeProductDao.getSearchList({
      where,
      page,
      limit,
    });

    // 3.5 取用户会员折扣 (列表级共享, 避免每行查询)
    const { discount, levelName, paidMemberPriceEnabled } = await this.getUserDiscount(_uid);

    // 4. 后处理: getMinPrice / cart_button / video_link 清理
    for (const item of list) {
      this.postProcessRow(item, discount, levelName, paidMemberPriceEnabled);
    }

    // 5. 精确 count 与 PHP `{list,count}` 契约保持一致。
    const count = await this.container.storeProductDao.countSearch(where);

    const { decoratePublicProductCards } = await import('./PublicProductCardData');
    return { list: await this.decorateLegacyPromotions(await decoratePublicProductCards(this.container.db, list, _uid, this.env)), count };
  }

  /** 公共首页、推荐和榜单共用的可售商品读取路径。 */
  async getRecommendProducts(
    uid: number,
    params: RecommendProductParams = {},
  ): Promise<Record<string, unknown>[]> {
    const where: Record<string, unknown> = {
      publicCatalog: true,
      status: 1,
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      pid: 0,
      isVipProduct: 0,
    };
    if (uid) {
      const user = await this.container.userDao.findForAuth(uid);
      if (user?.isMoneyLevel) where.isVipProduct = -1;
    }
    if (params.ids?.length) where.ids = params.ids;
    if (params.cateIds?.length) where.cateId = params.cateIds;
    if (params.productTypes?.length) where.productType = params.productTypes;
    if (params.isHot) where.isHot = 1;
    if (params.isBenefit) where.isBenefit = 1;
    if (params.isBest) where.isBest = 1;
    if (params.isNew) where.isNew = 1;
    if (params.isGood) where.isGood = 1;
    if (params.isVip) where.isVip = 1;
    if (params.rankOrder) where.rankOrder = params.rankOrder;

    const [page, limit] = this.getPageValue(params.page, params.limit);
    const list = await this.container.storeProductDao.getSearchList({ where, page, limit });
    const { discount, levelName, paidMemberPriceEnabled } = await this.getUserDiscount(uid);
    for (const item of list) this.postProcessRow(item, discount, levelName, paidMemberPriceEnabled);
    return this.decorateLegacyPromotions(list);
  }

  /**
   * PHP attaches the promotion, activity-frame and activity-background slots to
   * every ordinary catalogue row. Load the compatibility service only after
   * this module is initialized because its promotion-specific product endpoint
   * also uses StoreProductService for the base catalogue query.
   */
  private async decorateLegacyPromotions(list: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    if (!list.length) return list;
    const { V2PromotionCompatibilityService } = await import("@/services/activity/V2PromotionCompatibilityService");
    const decorated = await new V2PromotionCompatibilityService(this.container, this.env)
      .decorateCatalogProducts(list);
    return decorated.map((item) => ({
      ...item,
      promotions: item.promotions && typeof item.promotions === "object"
        && !Array.isArray(item.promotions) && Object.keys(item.promotions).length === 0
        ? [] : item.promotions,
    }));
  }

  /**
   * 取用户会员折扣 + 等级名 (对应 PHP getMinPrice 里查 level 的逻辑)
   * 一次列表查询共享, 避免每行重复查。
   */
  private async getUserDiscount(uid: number): Promise<{ discount: number; levelName: string; paidMemberPriceEnabled: boolean; paidMemberActive: boolean }> {
    // One policy snapshot per list/detail, never per row and never from KV.
    // Paid prices remain advertised offers, not proof of the visitor's eligibility.
    const policy = await readMembershipPricingPolicy(this.container.db);
    const fallback = { discount: 100, levelName: "", paidMemberPriceEnabled: policy.paidMemberPriceEnabled, paidMemberActive: false };
    if (!uid) return fallback;
    const user = await this.container.userDao.findForAuth(uid);
    fallback.paidMemberActive = Boolean(user && isPaidMembershipActive(user, Math.floor(Date.now() / 1000)));
    // An assigned level alone does not activate its pricing entitlement.
    if (!policy.memberFunctionEnabled || !user || user.levelStatus !== 1 || !user.level) return fallback;
    const levelSvc = new UserLevelService(this.container, this.env);
    const level = await levelSvc.getLevel(user.level);
    if (!level) return fallback;
    return { ...fallback, discount: level.discount, levelName: level.name };
  }

  /** Additive ordinary-SKU quote for the current visitor, not the advertised
   * SVIP offer in vip_price. Reuse checkout arithmetic/eligibility; raw SKU price
   * stays unchanged. Context is read once per response, never once per SKU.
   */
  private skuMemberPrice(price: string, vipPrice: string, isVip: number,
    context: { discount: number; levelName: string; paidMemberPriceEnabled: boolean; paidMemberActive: boolean }) {
    const quoted = calculateMemberUnitPriceCents({
      basePriceCents: decimalToCents(price), levelDiscountPercent: context.discount,
      paidMemberPriceCents: decimalToCents(vipPrice), paidMemberActive: context.paidMemberActive,
      paidMemberPriceEnabled: context.paidMemberPriceEnabled, productPaidMemberPriceEnabled: isVip === 1,
    });
    return { member_price: centsToDecimal(quoted.unitPriceCents), price_type: quoted.priceType,
      level_name: quoted.priceType === 'level' ? context.levelName : '' };
  }

  /**
   * 计算会员价 (精确移植 PHP getMinPrice)
   *
   * 逻辑:
   *   - discount ∈ [0,100) → PHP bcdiv(discount, 100, 2), then bcmul(price, ratio, 2)
   *   - is_vip=1 → vip_price = product.vip_price
   *   - 两者都有 → 取 min, 标记 price_type
   *   - 返回 { level_name, vip_price, price_type, level_price }
   *
   * 精度: both PHP operations truncate, never round. Integer cents avoid
   * binary floating-point errors; zero display prices do not set checkout policy.
   */
  getMinPrice(
    price: string,
    isVip: number,
    vipPrice: string,
    discount: number,
    levelName: string,
  ): { level_name: string; vip_price: string; price_type: string; level_price: string } {
    let levelPrice = price;
    let vipPriceOut = "0";
    let priceType = "";

    // 等级价
    if (discount >= 0 && discount < 100) {
      const normalized = price.trim();
      if (normalized.length > 32 || !/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
        throw new ValidateException("商品价格格式无效");
      }
      const [whole, fraction = ""] = normalized.split(".");
      const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
      if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidateException("商品价格超出安全范围");
      // bcdiv at scale 2 discards the fractional percent before multiplication.
      const quotedCents = cents * BigInt(Math.trunc(discount)) / 100n;
      levelPrice = `${quotedCents / 100n}.${String(quotedCents % 100n).padStart(2, "0")}`;
    }

    // svip 价
    if (isVip) {
      vipPriceOut = vipPrice;
    }

    // 对比 (对应 PHP 的多层 if/else if)
    if ((discount !== 100 || isVip)) {
      if (discount !== 100 && isVip) {
        // 两者都有 → 取低
        if (Number(levelPrice) < Number(vipPrice)) {
          priceType = "level";
          vipPriceOut = levelPrice;
        } else {
          priceType = "member";
          vipPriceOut = vipPrice;
        }
      } else if (discount !== 100 && !isVip) {
        // 只有等级价
        priceType = "level";
        vipPriceOut = levelPrice;
      } else if (discount === 100 && isVip) {
        // 只有 svip 价
        priceType = "member";
        vipPriceOut = vipPrice;
      }
    }

    return { level_name: levelName, vip_price: vipPriceOut, price_type: priceType, level_price: levelPrice };
  }

  /**
   * 单行后处理 (对应 PHP getGoodsList 的 per-row 循环 + getMinPrice)
   */
  private postProcessRow(
    item: Record<string, unknown>,
    discount: number,
    levelName: string,
    paidMemberPriceEnabled: boolean,
  ): void {
    // video_open = 0 → video_link 清空
    if (!Number(item.video_open)) {
      item.video_link = "";
    }
    // cart_button: product_type>0 / 预售 / 系统表单 → 0
    const productType = Number(item.product_type ?? 0);
    const isPresale = Number(item.is_presale_product ?? 0);
    const systemFormId = Number(item.system_form_id ?? 0);
    item.cart_button = productType > 0 || isPresale > 0 || systemFormId > 0 ? 0 : 1;

    // 会员价计算 (getMinPrice)
    const minPrice = this.getMinPrice(
      String(item.price ?? "0"),
      paidMemberPriceEnabled ? Number(item.is_vip ?? 0) : 0,
      String(item.vip_price ?? "0"),
      discount,
      levelName,
    );
    item.price_type = minPrice.price_type;
    item.level_name = minPrice.level_name;
    item.vip_price = minPrice.vip_price;
    // svip 未开通或商品非 svip → vip_price 清零 (与 PHP 一致)
    if (minPrice.price_type === "member" && !Number(item.is_vip)) {
      item.vip_price = "0";
    }
  }

  /**
   * PHP v2 `/get_attr/:id/:type` compatibility payload.
   *
   * The second path argument is the legacy "include cart quantity" flag, not
   * an activity/SKU type. `productValue` must therefore be keyed by `suk`;
   * the old UniApp builds a comma-delimited attribute selection and indexes
   * this object directly with that value.
   */
  async getLegacyProductAttr(
    id: number,
    uid: number,
    includeCartQuantity: boolean,
  ): Promise<{
    storeInfo: Record<string, unknown>;
    productAttr: Record<string, unknown>[];
    productValue: Record<string, Record<string, unknown>>;
  }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NotFoundException("商品不存在");
    const product = await this.container.storeProductDao.getById(id);
    if (!product) throw new NotFoundException("商品不存在");

    const [attrs, skus, formRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeProductAttr)
        .where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, 0)))
        .orderBy(asc(storeProductAttr.id)),
      this.container.db
        .select()
        .from(storeProductAttrValue)
        .where(and(
          eq(storeProductAttrValue.productId, id),
          eq(storeProductAttrValue.type, 0),
          eq(storeProductAttrValue.isRetired, 0),
        ))
        .orderBy(asc(storeProductAttrValue.id)),
      product.systemFormId > 0
        ? this.container.db
          .select({ value: systemForm.value })
          .from(systemForm)
          .where(and(
            eq(systemForm.id, product.systemFormId),
            eq(systemForm.status, 1),
            eq(systemForm.isDel, 0),
          ))
          .limit(1)
        : Promise.resolve([]),
    ]);

    const cartQuantity = new Map<string, number>();
    const uniqueValues = [...new Set(skus.map((sku) => sku.unique).filter(Boolean))];
    if (includeCartQuantity && uid > 0 && uniqueValues.length > 0) {
      const cartRows = await this.container.db
        .select({
          unique: storeCart.productAttrUnique,
          quantity: sql<number>`COALESCE(SUM(${storeCart.cartNum}), 0)::int`,
        })
        .from(storeCart)
        .where(and(
          eq(storeCart.uid, uid),
          eq(storeCart.productId, id),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isNew, 0),
          eq(storeCart.status, 1),
          inArray(storeCart.productAttrUnique, uniqueValues),
        ))
        .groupBy(storeCart.productAttrUnique);
      for (const row of cartRows) cartQuantity.set(row.unique, Number(row.quantity));
    }

    const productAttr = attrs.map((attr) => {
      const values = parseLegacyProductAttrValues(attr.attrValues);
      return {
        id: attr.id,
        product_id: attr.productId,
        attr_name: attr.attrName,
        attr_values: values,
        type: attr.type,
        attr_value: values.map((value) => ({ attr: value, check: false })),
      };
    });
    const pricing = await this.getUserDiscount(uid);
    const { discount, levelName, paidMemberPriceEnabled } = pricing;
    const productValue = Object.fromEntries(skus.map((sku) => [sku.suk, {
      id: sku.id,
      product_id: sku.productId,
      product_type: sku.productType,
      suk: sku.suk,
      stock: sku.stock,
      sum_stock: sku.sumStock,
      sales: sku.sales,
      price: String(sku.price),
      settle_price: String(sku.settlePrice),
      integral: sku.integral,
      image: sku.image,
      small_image: sku.image,
      unique: sku.unique,
      cost: String(sku.cost),
      bar_code: sku.barCode,
      ot_price: String(sku.otPrice),
      vip_price: paidMemberPriceEnabled && product.isVip ? String(sku.vipPrice) : "0",
      ...this.skuMemberPrice(String(sku.price), String(sku.vipPrice), product.isVip, pricing),
      weight: String(sku.weight),
      volume: String(sku.volume),
      brokerage: String(sku.brokerage),
      brokerage_two: String(sku.brokerageTwo),
      type: sku.type,
      quota: sku.quota,
      quota_show: sku.quotaShow,
      code: sku.code,
      disk_info: sku.diskInfo,
      product_stock: sku.stock,
      ...(includeCartQuantity ? { cart_num: cartQuantity.get(sku.unique) ?? 0 } : {}),
    }]));

    const storeInfo = legacyProductInfo(product);
    const customForm = formRows[0]?.value ? parseSystemFormDefinition(formRows[0].value) : [];
    storeInfo.custom_form = customForm;
    storeInfo.cart_button = customForm.length > 0 || product.isPresaleProduct > 0 || product.productType > 0 ? 0 : 1;
    const skuPrices = skus.map((sku) => Number(sku.price)).filter(Number.isFinite);
    const minPrice = skuPrices.length > 0 ? Math.min(...skuPrices) : Number(product.price);
    const maxPrice = skuPrices.length > 0 ? Math.max(...skuPrices) : Number(product.price);
    const quoted = this.getMinPrice(
      String(product.specType === 1 ? minPrice : product.price),
      paidMemberPriceEnabled ? product.isVip : 0,
      String(product.vipPrice),
      discount,
      levelName,
    );
    storeInfo.min_price = minPrice;
    storeInfo.max_price = maxPrice;
    storeInfo.price_type = quoted.price_type;
    storeInfo.vip_price = quoted.vip_price;
    storeInfo.level_price = quoted.level_price;
    storeInfo.level_name = quoted.level_name;
    return { storeInfo, productAttr, productValue };
  }

  /**
   * 商品详情 (对应 PHP productDetail)
   *
   * M2 实现核心字段:
   *   - 商品基础信息 (含 sales=ficti+real)
   *   - SKU 价格区间 (min/max from attr_value)
   *   - 轮播图 JSON 解码
   *   - 收藏/浏览计数
   *
   * Do not cache the assembled detail across requests: it contains current
   * visibility, SKU stock/prices and user-level enrichment. Product writers do
   * not share a complete invalidation protocol. Redis TTL is not a substitute
   * for those checks; read the authoritative DAOs for each request instead.
   */
  async getProductDetail(id: number, uid: number, type = 0): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NotFoundException("商品不存在");
    if (!Number.isSafeInteger(type) || type < 0 || type > 7) throw new NotFoundException("商品类型不存在");
    const snapshot = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
      const source = await readOrdinaryProductSnapshot(tx, id, uid, type), product = source.product;
      const scoped = new StoreProductService(createContainerFromDb(tx), this.env), pricing = await scoped.getUserDiscount(uid);
      const cents = source.skus.map(row => decimalToCents(row.price));
      const minimum = product.specType === 1 && cents.length ? Math.min(...cents) : decimalToCents(product.price);
      const maximum = product.specType === 1 && cents.length ? Math.max(...cents) : decimalToCents(product.price);
      const quoted = this.getMinPrice(centsToDecimal(minimum), pricing.paidMemberPriceEnabled ? product.isVip : 0, product.vipPrice, pricing.discount, pricing.levelName);
      const extras = await readProductDetailExtras(tx,product,uid,pricing.paidMemberActive);
      const attr_value = source.skus.map(row => ({ ...row, vip_price: pricing.paidMemberPriceEnabled && product.isVip ? row.vip_price : '0.00',
        display_price:detailDisplayPrice(extras.product_detail_design.value.showPrice,row.price,row.vip_price,pricing.discount,pricing.levelName,pricing.paidMemberPriceEnabled&&product.isVip===1),
        ...(type === 0 ? this.skuMemberPrice(row.price, row.vip_price, product.isVip, pricing) : {}),
        purchasable: source.cartButton === 1 && row.stock > 0, issues: [] }));
      const display_price=detailDisplayPrice(extras.product_detail_design.value.showPrice,centsToDecimal(minimum),product.vipPrice,pricing.discount,pricing.levelName,pricing.paidMemberPriceEnabled&&product.isVip===1);
      const userCollect = uid ? await createContainerFromDb(tx).userRelationDao.be({ uid, relationId: id, type: 'collect', category: 'product' }) : false;
      return { source, extras, detail: { ...product, display_price, fsales: product.sales + product.ficti, price: centsToDecimal(minimum), otPrice: product.otPrice,
        min_price: minimum / 100, max_price: maximum / 100, price_type: quoted.price_type, level_name: quoted.level_name,
        vipPrice: quoted.vip_price, level_price: quoted.level_price, deliveryType: String(product.deliveryType || '').split(',').filter(Boolean),
        videoLink: await readDetailVideo(tx,product), userCollect, userLike: 0, uid,
        brand_name: source.brandName, cart_button: source.cartButton, cart_num: attr_value.reduce((sum,row) => sum + row.cart_num, 0),
        spec_type: product.specType, productAttr: source.productAttr, attr_value, issues: [] } };
    });
    const images = await renderProductPictures(this.env?.APP_KEY, snapshot.source.references), galleryLength = snapshot.source.galleryLength;
    snapshot.detail.image = images[0];
    snapshot.detail.videoLink=(await renderProductPictures(this.env?.APP_KEY,[snapshot.detail.videoLink]))[0];
    const detail: Record<string, unknown> = { ...snapshot.detail, ...await renderProductDetailExtras(this.env,snapshot.extras), sliderImage: images.slice(1, 1 + galleryLength),
      attr_value: snapshot.detail.attr_value.map((row, index) => ({ ...row, image: images[1 + galleryLength + index], small_image: images[1 + galleryLength + index] })) };
    delete detail.ensureId; delete detail.customFormPresent; delete detail.recommendList;
    return detail;
  }

  /** Explicit legacy cleanup only; current detail reads do not depend on it. */
  async invalidateProductCache(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NotFoundException("商品不存在");
    const { cacheDelete } = await import("@/utils/cache");
    await Promise.all(Array.from({ length: 8 }, (_, type) =>
      cacheDelete(type === 0 ? `product_info_${id}` : `product_info_${id}_${type}`, this.env),
    ));
  }
}

