/**
 * 购物车 API
 */
import request, { getData } from "@/utils/request";
import type { CartItem } from "@/types/order";

/** 购物车列表 (GET /api/cart/list) */
export function apiCartList(): Promise<CartItem[]> {
  return getData(request.get<CartItem[]>("/cart/list"));
}

/** 加入购物车 (POST /api/cart/add) */
export function apiCartAdd(params: {
  productId: number;
  unique: string;
  cartNum: number;
  type?: number;
  activityId?: number;
}): Promise<{ id: number; cartNum: number }> {
  return getData(request.post<{ id: number; cartNum: number }>("/cart/add", params));
}

/** 一次创建完整套餐的多行立即购买购物车。 */
export function apiDiscountCartAdd(params: {
  discountId: number;
  discountInfos: Array<{ id: number; product_id: number; unique: string }>;
}): Promise<{ cartId: number[]; cartIds: number[]; cartNum: number; discountId: number }> {
  return getData(request.post("/cart/add", { ...params, type: 5, new: 1 }));
}

/** 修改数量 (POST /api/cart/num) */
export function apiCartNum(id: number, cartNum: number): Promise<null> {
  return getData(request.post<null>("/cart/num", { id, cartNum }));
}

/** 删除购物车 (POST /api/cart/del) */
export function apiCartDel(ids: number[]): Promise<null> {
  return getData(request.post<null>("/cart/del", { ids }));
}

/** 购物车数量 (GET /api/cart/count) */
export function apiCartCount(): Promise<{ count: number }> {
  return getData(request.get<{ count: number }>("/cart/count"));
}
