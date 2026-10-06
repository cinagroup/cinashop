/**
 * 商品 API
 */
import { http } from "@/utils/request";
import type { GoodsItem, GoodsDetail, CategoryNode } from "@/types/product";
import type { PageResult } from "@/types/api";
import { normalizeMobileGoods } from "./productDetail";
import { parseCategoryStyle, parseCategoryTree, parseCategoryProducts } from '../../../common/categoryCatalog';

export interface GoodsListParams {
  keyword?: string;
  cid?: number;
  sid?: number;
  tid?: number;
  is_big?: 0 | 1;
  /** Legacy DIY fixed-product selection. */
  ids?: string;
  /** Legacy DIY multi-category selection. */
  cate_id?: string;
  brand_id?: string;
  /** Legacy DIY product-label selection. */
  store_label_id?: string;
  priceOrder?: "asc" | "desc";
  salesOrder?: "asc" | "desc";
  news?: number;
  page?: number;
  limit?: number;
}

export function apiGoodsList(params: GoodsListParams): Promise<PageResult<GoodsItem>> {
  return http.get<PageResult<GoodsItem>>("/products", params as Record<string, unknown>);
}

export async function apiGoodsDetail(id: number): Promise<GoodsDetail> {
  const goods = normalizeMobileGoods(await http.get<unknown>(`/product/detail/${id}`));
  if (goods.id !== id) throw new Error("商品详情与请求不匹配");
  return goods;
}

export function apiCategory(): Promise<CategoryNode[]> {
  return http.get<CategoryNode[]>("/category");
}

export async function apiCategoryTree() { return parseCategoryTree(await http.get<unknown>('/category')); }
export async function apiCategoryStyle() { return parseCategoryStyle(await http.get<unknown>('/v2/diy/product_detail')); }
export async function apiCategoryProducts(params: GoodsListParams) {
  return parseCategoryProducts(await http.get<unknown>('/products', params as Record<string, unknown>));
}
