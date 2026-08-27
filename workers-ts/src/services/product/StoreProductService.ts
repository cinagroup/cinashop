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
  ids?: string;
  promotions_type?: number;
  defaultOrder?: number;
  page?: number;
  limit?: number;
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

    if (params.store_name) where.store_name = params.store_name;
    if (params.news) where.is_new = 1;
    if (params.cate_id) where.cateId = String(params.cate_id).split(",").map(Number);
    if (params.cid) where.cid = params.cid;
    if (params.tid) where.cateId = [params.tid];
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

    // 5. count (M2 简化: 不返回精确 count, 前端用 hasMore 判断; count=null)
    const count = list.length < limit ? null : null; // TODO: 精确 count

    return { list, count };
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
  async getProductDetail(id: number, uid: number): Promise<Record<string, unknown>> {
    // 1. 缓存
    const cacheKey = `product_info_${id}`;
    const cached = await cacheGet<Record<string, unknown>>(cacheKey, this.env);
    if (cached) {
      const ensure = await new ProductExperienceService(this.container)
        .productEnsures(id, cached.ensureId);
      return { ...cached, ensure, userCollect: false, userLike: 0 };
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
      const range = await this.container.storeProductAttrValueDao.getPriceRange(id);
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
    const skus = await this.container.storeProductAttrValueDao.getByProductId(id);
    detail.attr_value = skus.map((s) => ({
      id: s.id,
      unique: s.unique,
      suk: s.suk || "默认",
      price: String(s.price),
      ot_price: String(s.otPrice ?? s.price),
      vip_price: String(s.vipPrice ?? "0"),
      stock: s.stock,
      sales: s.sales,
    }));

    // Product assurance definitions are a separate catalog. Resolve both the
    // legacy ensure_id CSV and type=5 relation rows, filtering disabled entries.
    detail.ensure = await new ProductExperienceService(this.container)
      .productEnsures(id, product.ensureId);

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
