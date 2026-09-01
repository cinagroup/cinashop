/**
 * 商品 API
 */
import { http } from "@/utils/request";
import type { GoodsItem, GoodsDetail, CategoryNode } from "@/types/product";
import type { PageResult } from "@/types/api";

export interface GoodsListParams {
  keyword?: string;
  cid?: number;
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

export function apiGoodsDetail(id: number): Promise<GoodsDetail> {
  return http.get<GoodsDetail>(`/product/detail/${id}`);
}

export function apiCategory(): Promise<CategoryNode[]> {
  return http.get<CategoryNode[]>("/category");
}
