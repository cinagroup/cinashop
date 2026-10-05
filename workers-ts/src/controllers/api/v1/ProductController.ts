/**
 * 商品控制器
 *
 * 对应 PHP app/controller/api/v1/product/StoreProduct.php
 * + app/controller/api/v1/product/StoreProductCategory.php
 */
import type { Context } from "hono";
import { jsonOk } from "@/utils/json";
import { StoreProductService, type GoodsListParams } from "@/services/product/StoreProductService";
import { StoreCategoryService } from "@/services/product/StoreCategoryService";
import { ProductExperienceService } from "@/services/product/ProductExperienceService";
import { PublicCatalogService, normalizeCatalogPage } from "@/services/product/PublicCatalogService";
import { RecommendationNavigationService } from "@/services/product/RecommendationNavigationService";
import { PresaleSkuCatalogService } from "@/services/activity/PresaleSkuCatalogService";
import { jsonFail } from "@/utils/json";
import { NotFoundException, ValidateException } from "@/utils/errors";
import type { AppVariables, Env } from "@/env";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { categoryPublicId, publicCategoryQuery } from '@/services/product/PublicCategoryPolicy';
import { withTx } from '@/lib/di';
import { sql } from 'drizzle-orm';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { readProductCommunity } from '@/services/product/ProductDetailDesignData';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** Public posts attached to this exact visible product; count/list share RR. */
export async function productCommunity(c:C){
  const id=categoryPublicId(c.req.param('id')),query=new URL(c.req.url).searchParams;
  for(const key of query.keys())if(!['page','limit'].includes(key)||query.getAll(key).length!==1)throw new ValidateException('商品晒单查询参数无效');
  const page=Number(query.get('page')??1),limit=Number(query.get('limit')??10);
  const result=await withTx(c.get('container'),async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);return readProductCommunity(tx,id,page,limit);});
  const images=await renderProductPictures(c.env.APP_KEY,result.list.map(row=>row.image));
  return jsonOk(c,{...result,list:result.list.map((row,i)=>({...row,image:images[i]}))});
}

/**
 * GET /api/products
 * 对应 PHP StoreProduct::lst
 */
export async function lst(c: C) {
  const q = c.req.query();
  const params: GoodsListParams = {
    ...publicCategoryQuery(new URL(c.req.url).searchParams),
    store_name: q.store_name || q.keyword,
    cate_id: q.cate_id,
    brand_id: q.brand_id,
    priceOrder: (q.priceOrder as "" | "asc" | "desc") || "",
    salesOrder: (q.salesOrder as "" | "asc" | "desc") || "",
    news: q.news ? Number(q.news) : undefined,
    ids: q.ids,
    promotions_type: q.promotions_type ? Number(q.promotions_type) : undefined,
    defaultOrder: q.defaultOrder !== undefined ? Number(q.defaultOrder) : undefined,
    page: q.page ? Number(q.page) : 1,
    limit: q.limit ? Number(q.limit) : undefined,
  };

  const uid = c.get("uid");
  const svc = new StoreProductService(c.get("container"), c.env);
  const { list, count } = await svc.getGoodsList(params, uid);
  return jsonOk(c, { list, count });
}

/**
 * GET /api/product/detail/:id
 * 对应 PHP StoreProduct::detail
 */
export async function detail(c: C) {
  if (c.req.query("view") !== undefined) {
    c.header("Cache-Control", "private, no-store");
    if (c.req.query("view") !== "presale" || c.req.queries("view")?.length !== 1 ||
      (c.req.param("type") !== undefined && c.req.param("type") !== "0")) return jsonFail(c, "商品详情视图无效");
    return jsonOk(c, await new PresaleSkuCatalogService(c.get("container"),c.env).read(c.get("uid") ?? 0, c.req.param("id")));
  }
  const id = categoryPublicId(c.req.param("id"));
  const type = Number(c.req.param("type") ?? 0);
  if (!Number.isSafeInteger(type) || type < 0 || type > 7) return jsonFail(c, "商品类型不存在");

  const uid = c.get("uid");
  const svc = new StoreProductService(c.get("container"), c.env);
  const info = await svc.getProductDetail(id, uid, type);
  c.executionCtx.waitUntil(
    new ProductExperienceService(c.get("container"))
      // PHP's normal-product ProductLogJob passes the product id into the
      // legacy store_visit.cate_id slot. Preserve that odd contract so copied
      // and newly written aggregates remain comparable.
      .recordVisit(uid, id, id)
      .catch((error: unknown) => {
        emitOperationalEvent("error", {
          event: "product_visit_record_failed",
          component: "http",
          operation: "analytics_write",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        });
      }),
  );
  const flat = {
    ...info,
    store_name: info.storeName ?? info.store_name ?? "",
    store_info: info.storeInfo ?? info.store_info ?? "",
    slider_image: info.sliderImage ?? info.slider_image ?? [],
    ot_price: String(info.otPrice ?? info.ot_price ?? "0"),
    vip_price: String(info.vipPrice ?? info.vip_price ?? "0"),
    video_link: info.videoLink ?? info.video_link ?? "",
    delivery_type: info.deliveryType ?? info.delivery_type ?? [],
    spec_type: info.specType ?? info.spec_type ?? 0,
    is_vip: info.isVip ?? info.is_vip ?? 0,
    is_vip_product: info.isVipProduct ?? info.is_vip_product ?? 0,
    is_presale_product: info.isPresaleProduct ?? info.is_presale_product ?? 0,
    is_show: info.isShow ?? info.is_show ?? 0,
    is_del: info.isDel ?? info.is_del ?? 0,
    unit_name: info.unitName ?? info.unit_name ?? "",
    cate_id: info.cateId ?? info.cate_id ?? "",
    cart_button: info.cart_button === 0 || Number(info.productType ?? info.product_type ?? 0) > 0
      || Number(info.isPresaleProduct ?? info.is_presale_product ?? 0) > 0
      || Number(info.systemFormId ?? info.system_form_id ?? 0) > 0 ? 0 : 1,
  };
  const rawSkus = (flat as Record<string, unknown>).attr_value;
  const skus = Array.isArray(rawSkus) ? rawSkus as Array<Record<string, unknown>> : [];
  const legacyStore = { ...flat };
  delete (legacyStore as Record<string, unknown>).storeInfo;
  return jsonOk(c, {
    ...flat,
    storeInfo: legacyStore,
    productAttr: info.productAttr ?? [],
    productValue: Object.fromEntries(skus.filter(sku => typeof sku.unique === 'string' && sku.unique).map((sku) => [String(sku.unique), sku])),
    reply: info.reply ?? [],
    replyChance: info.replyChance ?? 0,
    replyCount: info.replyCount ?? 0,
    elegant_list: info.elegant_list ?? [],
    elegant_count: info.elegant_count ?? 0,
  });
}

/** GET /api/v2/get_attr/:id/:type (`type` is the include-cart-count flag). */
export async function getProductAttrV2(c: C) {
  const id = Number(c.req.param("id"));
  const includeCartQuantity = Number(c.req.param("type"));
  if (
    !Number.isSafeInteger(id) || id <= 0 ||
    !Number.isSafeInteger(includeCartQuantity) || includeCartQuantity < 0
  ) {
    return jsonFail(c, "参数错误");
  }
  try {
    const data = await new StoreProductService(c.get("container"), c.env)
      .getLegacyProductAttr(id, c.get("uid") ?? 0, includeCartQuantity !== 0);
    return jsonOk(c, data);
  } catch (error) {
    if (error instanceof NotFoundException) return jsonFail(c, error.message);
    throw error;
  }
}

function catalogParams(c: C): GoodsListParams & { productId?: string } {
  const q = c.req.query();
  return {
    ...publicCategoryQuery(new URL(c.req.url).searchParams),
    store_name: q.store_name || q.keyword,
    cate_id: q.cate_id,
    brand_id: q.brand_id,
    store_label_id: q.store_label_id,
    news: q.news ? Number(q.news) : undefined,
    type: q.type,
    ids: q.ids,
    productId: q.productId,
  };
}

/** GET /api/brand — brands represented in the current product result set. */
export async function brand(c: C) {
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env).brand(catalogParams(c)));
}

/** GET /api/search/filter — promotions, brands and store labels for current filters. */
export async function searchFilter(c: C) {
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env).searchFilter(catalogParams(c)));
}

/** GET /api/search/recommend/:type */
export async function searchRecommend(c: C) {
  const type = Number(c.req.param("type"));
  const rank = type === 2 ? "star" : type === 3 ? "collect" : "sales";
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env)
    .recommend(c.get("uid") ?? 0, { rank, limit: 8 }));
}

/** GET /api/product/rank/category */
export async function rankCategory(c: C) {
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env).rankCategory());
}

/** GET /api/product/rank/:type */
export async function rankList(c: C) {
  const type = Number(c.req.param("type"));
  const rank = type === 2 ? "star" : type === 3 ? "collect" : "sales";
  const paging = normalizeCatalogPage(c.req.query("page"), c.req.query("limit"));
  if (!Number.isSafeInteger(paging.page) || (paging.page - 1) * paging.limit > 2_147_483_647) return jsonFail(c, "页码超出范围");
  c.header("Cache-Control", "private, no-store");
  const list = await new PublicCatalogService(c.get("container"), c.env).recommend(
    c.get("uid") ?? 0,
    { rank, selectId: Number(c.req.query("selectId") ?? 0), ...paging },
  );
  return jsonOk(c, await new RecommendationNavigationService(c.get("container")).decorate(list));
}

/** GET /api/product/detail/recommend/:id */
export async function detailRecommend(c: C) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env)
    .detailRecommend(c.get("uid") ?? 0, id));
}

/** GET /api/product/detail/activity/:id */
export async function detailActivity(c: C) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  const promotionTypeValue = c.req.query("promotions_type");
  const promotionType = promotionTypeValue === undefined || promotionTypeValue === ""
    ? 0 : Number(promotionTypeValue);
  if (!Number.isSafeInteger(promotionType) || promotionType < 0 || promotionType > 32_767) {
    return jsonFail(c, "促销类型参数错误");
  }
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env).productActivity(id, promotionType));
}

/** GET /api/product/detail_content/:id */
export async function detailContent(c: C) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  try {
    return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env).detailContent(id));
  } catch (error) {
    if (error instanceof NotFoundException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/groom/list/:type */
export async function groomList(c: C) {
  const type = Number(c.req.param("type"));
  const mapping = {
    1: ["best", "routine_home_bast_banner"],
    2: ["hot", "routine_home_hot_banner"],
    3: ["new", "routine_home_new_banner"],
    4: ["benefit", "routine_home_benefit_banner"],
    5: ["vip", ""],
  } as const;
  if (!Object.hasOwn(mapping, type)) return jsonOk(c, { banner: [], list: [] });
  const [flag, group] = mapping[type as keyof typeof mapping];
  const svc = new PublicCatalogService(c.get("container"), c.env);
  const [groups, list] = await Promise.all([
    group
      ? svc.groupDataMany([group])
      : Promise.resolve({} as Record<string, Record<string, unknown>[]>),
    svc.recommend(c.get("uid") ?? 0, { flag, limit: 100 }),
  ]);
  return jsonOk(c, { banner: group ? groups[group] ?? [] : [], list });
}

/** GET /api/product/hot */
export async function productHot(c: C) {
  const paging = normalizeCatalogPage(c.req.query("page"), c.req.query("limit"));
  paging.limit = Math.max(1, paging.limit);
  // Keep legacy offset pagination, but reject offsets that cannot be represented safely.
  if (!Number.isSafeInteger(paging.page) || (paging.page - 1) * paging.limit > 2_147_483_647) return jsonFail(c, "页码超出范围");
  const list = await new PublicCatalogService(c.get("container"), c.env)
    .recommend(c.get("uid") ?? 0, { flag: "hot", ...paging });
  return jsonOk(c, await new RecommendationNavigationService(c.get("container")).decorate(list));
}

/** GET /api/presale/list */
export async function presaleList(c: C) {
  c.header('Cache-Control', 'private, no-store');
  const q = c.req.query();
  return jsonOk(c, await new PublicCatalogService(c.get("container"), c.env)
    .presale(c.get("uid") ?? 0, Number(q.time_type ?? 0), q.page, q.limit));
}

/**
 * GET /api/category
 * 对应 PHP StoreProductCategory::category
 */
export async function category(c: C) {
  const svc = new StoreCategoryService(c.get("container"), c.env);
  const tree = await svc.getCategory();
  return jsonOk(c, tree);
}

/**
 * GET /api/category_version
 * 对应 PHP StoreProductCategory::getCategoryVersion (前端缓存键)
 */
export async function categoryVersion(c: C) {
  const svc = new StoreCategoryService(c.get("container"), c.env);
  const version = await svc.getVersion();
  return jsonOk(c, { version });
}

/**
 * GET /api/level_category
 * 对应 PHP StoreProductCategory::levelCategory (同级分类)
 */
export async function levelCategory(c: C) {
  const { categoryPublicId } = await import('@/services/product/PublicCategoryPolicy');
  const q = new URL(c.req.url).searchParams;
  if ([...q.keys()].some(key => !['id', 'cid'].includes(key)) || q.getAll('id').length > 1 || q.getAll('cid').length > 1) throw new ValidateException('同级分类参数无效');
  const id = categoryPublicId(q.get('id') ?? q.get('cid'));
  if (q.has('id') && q.has('cid') && categoryPublicId(q.get('cid')) !== id) throw new ValidateException('同级分类ID冲突');
  return jsonOk(c, await new StoreCategoryService(c.get('container'), c.env).getLevelCategory(id));
}
