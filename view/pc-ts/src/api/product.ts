/**
 * 商品 API
 */
import request, { getData } from "@/utils/request";
import type { GoodsItem, GoodsDetail, CategoryNode, PageResult } from "@/types/product";

/** 商品列表参数 */
export interface GoodsListParams {
  keyword?: string;
  sid?: number;
  cid?: number;
  tid?: number;
  cate_id?: string;
  brand_id?: string;
  priceOrder?: "asc" | "desc";
  salesOrder?: "asc" | "desc";
  news?: number;
  defaultOrder?: number;
  ids?: string;
  page?: number;
  limit?: number;
}

/** 商品列表 (GET /api/products) */
export function apiGoodsList(params: GoodsListParams): Promise<PageResult<GoodsItem>> {
  return getData(
    request.get<PageResult<GoodsItem>>("/products", { params }),
  );
}

/** 商品详情 (GET /api/product/detail/:id) */
export function apiGoodsDetail(id: number): Promise<GoodsDetail> {
  return getData(request.get<GoodsDetail>(`/product/detail/${id}`));
}

/** 分类列表 (GET /api/category) */
export function apiCategory(): Promise<CategoryNode[]> {
  return getData(request.get<CategoryNode[]>("/category"));
}

/** 热门搜索 (GET /api/search/hot_keyword) */
export function apiHotKeywords(): Promise<{ keyword: string }[]> {
  return getData(request.get<{ keyword: string }[]>("/search/hot_keyword"));
}

/** 推荐商品 (GET /api/groom/list/:type) */
export function apiRecommend(type: number, page = 1, limit = 10): Promise<PageResult<GoodsItem>> {
  return getData(
    request.get<PageResult<GoodsItem>>(`/groom/list/${type}`, { params: { page, limit } }),
  );
}

/** 评价统计 (GET /api/reply/config/:productId) */
export function apiReplyConfig(productId: number): Promise<{
  total: number;
  avgScore: string;
  goodRate: number;
  picsCount: number;
}> {
  return getData(request.get(`/reply/config/${productId}`));
}

/** 评价列表 (GET /api/reply/list/:productId) */
export function apiReplyList(productId: number, page = 1): Promise<unknown[]> {
  return getData(request.get<unknown[]>(`/reply/list/${productId}`, { params: { page, limit: 10 } }));
}

/** 提交评价 (POST /api/reply/submit) */
export function apiReplySubmit(params: {
  unique: string;
  comment: string;
  productScore: number;
  serviceScore: number;
  logisticsScore: number;
  pics?: string[];
}): Promise<{ id: number; oid: number; completed: boolean; to_lottery: false }> {
  return getData(request.post(`/reply/submit`, params));
}
