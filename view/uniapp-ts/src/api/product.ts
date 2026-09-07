/**
 * 商品 API
 */
import { http } from "@/utils/request";
import type { GoodsItem, GoodsDetail, CategoryNode } from "@/types/product";
import type { PageResult } from "@/types/api";
import { normalizeMobileGoods } from "./productDetail";

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

export async function apiGoodsDetail(id: number): Promise<GoodsDetail> {
  const goods = normalizeMobileGoods(await http.get<unknown>(`/product/detail/${id}`));
  if (goods.id !== id) throw new Error("商品详情与请求不匹配");
  return goods;
}

export function apiCategory(): Promise<CategoryNode[]> {
  return http.get<CategoryNode[]>("/category");
}
