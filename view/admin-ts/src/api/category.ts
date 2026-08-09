/**
 * Admin 分类管理 API
 */
import request, { getData } from "@/utils/request";

export interface CategoryItem {
  id: number;
  pid: number;
  cateName: string;
  pic: string;
  sort: number;
  isShow: number;
}

/** 分类列表 (GET /adminapi/category/list) */
export function apiAdminCategoryList(): Promise<CategoryItem[]> {
  return getData(request.get<CategoryItem[]>("/category/list"));
}

/** 新增/编辑分类 (POST /adminapi/category/save) */
export function apiAdminCategorySave(params: {
  id?: number;
  pid?: number;
  cate_name: string;
  pic?: string;
  sort?: number;
  is_show?: number;
}): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/category/save", params));
}

/** 删除分类 (DELETE /adminapi/category/del/:id) */
export function apiAdminCategoryDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/category/del/${id}`));
}
