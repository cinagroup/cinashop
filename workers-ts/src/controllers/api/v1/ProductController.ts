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
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * GET /api/products
 * 对应 PHP StoreProduct::lst
 */
export async function lst(c: C) {
  const q = c.req.query();
  const params: GoodsListParams = {
    store_name: q.store_name || q.keyword,
    sid: q.sid ? Number(q.sid) : undefined,
    cid: q.cid ? Number(q.cid) : undefined,
    tid: q.tid ? Number(q.tid) : undefined,
    cate_id: q.cate_id,
    selectId: q.selectId ? Number(q.selectId) : undefined,
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
  const id = Number(c.req.param("id"));
  if (!id) return jsonOk(c, null, "参数错误");

  const uid = c.get("uid");
  const svc = new StoreProductService(c.get("container"), c.env);
  const info = await svc.getProductDetail(id, uid);
  return jsonOk(c, info);
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
  const q = c.req.query();
  const cid = q.cid ? Number(q.cid) : 0;
  if (!cid) return jsonOk(c, []);

  const container = c.get("container");
  // 取当前分类 → 找同级 (pid 相同)
  const current = await container.storeProductCategoryDao.get(cid);
  if (!current) return jsonOk(c, []);
  const siblings = await container.storeProductCategoryDao.selectList({
    where: { pid: current.pid, isShow: 1 },
    orderBy: undefined,
  });
  return jsonOk(c, siblings);
}
