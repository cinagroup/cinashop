/**
 * Admin 商品管理 API
 * 对应后端 /adminapi/product/* (已实现的 CRUD)
 */
import request, { getData } from "@/utils/request";
import type { AdminProduct } from "@/types/admin";

/** 商品列表 (GET /adminapi/product/list) */
export function apiAdminProductList(params: {
  page?: number;
  limit?: number;
  store_name?: string;
  status?: number;
}): Promise<{ list: AdminProduct[]; page: number; limit: number }> {
  return getData(request.get("/product/list", { params }));
}

/** 商品详情 (GET /adminapi/product/detail/:id) */
export function apiAdminProductDetail(id: number): Promise<AdminProduct> {
  return getData(request.get(`/product/detail/${id}`));
}

/** 创建商品 (POST /adminapi/product/create) */
export function apiAdminProductCreate(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post("/product/create", data));
}

/** 编辑商品 (POST /adminapi/product/update/:id) */
export function apiAdminProductUpdate(
  id: number,
  data: Record<string, unknown>,
): Promise<null> {
  return getData(request.post(`/product/update/${id}`, data));
}

/** 上下架 (POST /adminapi/product/set_show/:id) */
export function apiAdminProductSetShow(id: number, isShow: number): Promise<null> {
  return getData(request.post(`/product/set_show/${id}`, { is_show: isShow }));
}

/** 删除商品 (DELETE /adminapi/product/del/:id) */
export function apiAdminProductDel(id: number): Promise<null> {
  return getData(request.delete(`/product/del/${id}`));
}
