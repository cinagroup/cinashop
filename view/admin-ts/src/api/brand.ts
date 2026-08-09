/**
 * Admin 品牌管理 API
 */
import request, { getData } from "@/utils/request";

export interface BrandItem {
  id: number;
  brandName: string;
  pic: string;
  sort: number;
  isShow: number;
}

/** 品牌列表 (GET /adminapi/brand/list) */
export function apiAdminBrandList(): Promise<BrandItem[]> {
  return getData(request.get<BrandItem[]>("/brand/list"));
}

/** 保存品牌 (POST /adminapi/brand/save) */
export function apiAdminBrandSave(params: {
  id?: number;
  brand_name: string;
  pic?: string;
  sort?: number;
  is_show?: number;
}): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/brand/save", params));
}

/** 删除品牌 (DELETE /adminapi/brand/del/:id) */
export function apiAdminBrandDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/brand/del/${id}`));
}
