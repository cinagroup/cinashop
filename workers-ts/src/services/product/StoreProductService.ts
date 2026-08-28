/**
 * 商品 Service
 *
 * 对应 PHP app/services/product/StoreProductServices.php
 * 核心方法: getGoodsList (列表) + getProductDetail (详情)
 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { cacheGet, cacheSet } from "@/utils/cache";
import { NotFoundException } from "@/utils/errors";
import { UserLevelService } from "@/services/user/UserLevelService";
import { ProductExperienceService } from "@/services/product/ProductExperienceService";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  storeCart,
  storeProductAttr,
  storeProductAttrValue,
  storeProductCategory,
  systemForm,
} from "@/models/schema";
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
    // 1. 组装 where
    const where: Record<string, unknown> = {
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      status: 1, // 上架 (searcher status=1 → is_show=1 AND is_del=0 AND is_verify=1)
      isVipProduct: 0, // 非 svip 专属 (默认隐藏 svip 商品)
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
    const { discount, levelName } = await this.getUserDiscount(_uid);

    // 4. 后处理: getMinPrice / cart_button / video_link 清理
    for (const item of list) {
      this.postProcessRow(item, discount, levelName);
    }

    // 5. 精确 count 与 PHP `{list,count}` 契约保持一致。
    const count = await this.container.storeProductDao.countSearch(where);

    return { list, count };
  }

  /** 公共首页、推荐和榜单共用的可售商品读取路径。 */
  async getRecommendProducts(
    uid: number,
    params: RecommendProductParams = {},
  ): Promise<Record<string, unknown>[]> {
    const where: Record<string, unknown> = {
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
    const { discount, levelName } = await this.getUserDiscount(uid);
    for (const item of list) this.postProcessRow(item, discount, levelName);
    return list;
  }

  /**
   * 取用户会员折扣 + 等级名 (对应 PHP getMinPrice 里查 level 的逻辑)
   * 一次列表查询共享, 避免每行重复查。
   */
  private async getUserDiscount(uid: number): Promise<{ discount: number; levelName: string }> {
    if (!uid) return { discount: 100, levelName: "" };
    const user = await this.container.userDao.findForAuth(uid);
    if (!user || !user.level) return { discount: 100, levelName: "" };
    const levelSvc = new UserLevelService(this.container, this.env);
    const level = await levelSvc.getLevel(user.level);
    if (!level) return { discount: 100, levelName: "" };
    return { discount: level.discount, levelName: level.name };
  }

  /**
   * 计算会员价 (精确移植 PHP getMinPrice)
   *
   * 逻辑:
   *   - discount ∈ [0,100) → level_price = round(discount/100 * price, 2)
   *   - is_vip=1 → vip_price = product.vip_price
   *   - 两者都有 → 取 min, 标记 price_type
   *   - 返回 { level_name, vip_price, price_type, level_price }
   *
   * 精度: 用字符串运算 (对应 PHP bcmath), 避免浮点误差。
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
      // round(discount/100 * price, 2) — 对应 bcmul(bcdiv(discount,'100',2), price, 2)
      const ratio = (discount / 100).toFixed(2);
      levelPrice = (Number(ratio) * Number(price)).toFixed(2);
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
      Number(item.is_vip ?? 0),
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
        .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0)))
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
      vip_price: String(sku.vipPrice),
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
    const { discount, levelName } = await this.getUserDiscount(uid);
    const quoted = this.getMinPrice(
      String(product.specType === 1 ? minPrice : product.price),
      product.isVip,
      String(product.vipPrice),
      discount,
      levelName,
    );
    storeInfo.min_price = minPrice;
    storeInfo.max_price = maxPrice;
    storeInfo.price_type = quoted.price_type;
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
   * 缓存: Upstash 存 600s (对应 PHP getCacheProductInfo)
   */
  async getProductDetail(id: number, uid: number, type = 0): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(type) || type < 0 || type > 7) {
      throw new NotFoundException("商品类型不存在");
    }
    // 1. 缓存
    const cacheKey = type === 0 ? `product_info_${id}` : `product_info_${id}_${type}`;
    const cached = await cacheGet<Record<string, unknown>>(cacheKey, this.env);
    if (cached) {
      const [ensure, userCollect] = await Promise.all([
        new ProductExperienceService(this.container).productEnsures(id, cached.ensureId),
        uid ? this.container.userRelationDao.be({
          uid, relationId: id, type: "collect", category: "product",
        }) : false,
      ]);
      return { ...cached, ensure, userCollect, userLike: 0, uid };
    }

    // 2. 查商品
    const product = await this.container.storeProductDao.getById(id);
    if (!product) throw new NotFoundException("商品不存在");
    if (!product.isShow || product.isDel) {
      throw new NotFoundException("商品已下架");
    }

    // 3. 构建详情 (访问器, 对应 PHP model getter)
    const detail: Record<string, unknown> = {
      ...product,
      sliderImage: this.parseSliderImage(product.sliderImage),
      storeName: product.storeName,
      storeInfo: product.storeInfo,
      // 展示销量 = 真实 + 虚拟
      fsales: product.sales + product.ficti,
      // 视频处理
      videoLink: product.videoOpen ? product.videoLink : "",
      // 配送类型
      deliveryType: String(product.deliveryType || "").split(",").filter(Boolean),
      // 默认值
      userCollect: false,
      userLike: 0,
      uid,
    };

    // 4. 价格区间: 多规格从 attr_value 取 min/max, 单规格用 product.price
    if (product.specType === 1) {
      const range = await this.container.storeProductAttrValueDao.getPriceRange(id, type);
      detail.price = range.min > 0 ? String(range.min) : String(product.price);
      detail.min_price = range.min;
      detail.max_price = range.max;
    } else {
      detail.price = String(product.price);
      detail.min_price = Number(product.price);
      detail.max_price = Number(product.price);
    }
    detail.otPrice = String(product.otPrice);

    // 5. 会员价计算 (getMinPrice)
    const { discount, levelName } = await this.getUserDiscount(uid);
    const minPrice = this.getMinPrice(
      String(detail.price),
      product.isVip,
      String(product.vipPrice),
      discount,
      levelName,
    );
    detail.price_type = minPrice.price_type;
    detail.level_name = minPrice.level_name;
    detail.vipPrice = minPrice.price_type === "member" ? minPrice.vip_price : (product.isVip ? String(product.vipPrice) : "0");

    // 6. SKU 详情 (M3 完整接入; 这里先返回价格区间供前端用)
    detail.spec_type = product.specType;

    // 6b. SKU 列表 (M18: 规格弹窗用, 单规格也返回一条)
    const skus = await this.container.storeProductAttrValueDao.getByProductId(id, type);
    detail.attr_value = skus.map((s) => ({
      id: s.id,
      unique: s.unique,
      suk: s.suk || "默认",
      price: String(s.price),
      ot_price: String(s.otPrice ?? s.price),
      vip_price: String(s.vipPrice ?? "0"),
      stock: s.stock,
      sales: s.sales,
      image: s.image,
      small_image: s.image,
    }));

    // Product assurance definitions are a separate catalog. Resolve both the
    // legacy ensure_id CSV and type=5 relation rows, filtering disabled entries.
    detail.ensure = await new ProductExperienceService(this.container)
      .productEnsures(id, product.ensureId);

    detail.userCollect = uid ? await this.container.userRelationDao.be({
      uid, relationId: id, type: "collect", category: "product",
    }) : false;

    // 7. 回填缓存 (注意: 缓存不含 userCollect 等用户态字段)
    const cacheable = { ...detail };
    delete cacheable.userCollect;
    delete cacheable.userLike;
    delete cacheable.uid;
    delete cacheable.ensure;
    await cacheSet(cacheKey, cacheable, this.env, 600);
    return detail;
  }

  /** 解析轮播图 JSON (对应 PHP getSliderImageAttr) */
  private parseSliderImage(raw: string): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 失效商品缓存 (后台改商品时调用) */
  async invalidateProductCache(id: number): Promise<void> {
    const { cacheDelete } = await import("@/utils/cache");
    await cacheDelete(`product_info_${id}`, this.env);
  }
}
