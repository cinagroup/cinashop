/**
 * 会员等级管理 API
 */
import request, { getData } from "@/utils/request";

export interface LevelItem {
  id: number;
  name: string;
  grade: number;
  discount: string;
  expNum: number;
  isShow: number;
  image: string;
  color: string;
  explain: string;
  isDel: number;
}

/** 等级列表 (GET /adminapi/level/list) */
export function apiAdminLevelList(): Promise<LevelItem[]> {
  return getData(request.get<LevelItem[]>("/level/list"));
}

/** 新增/编辑 (POST /adminapi/level/save) */
export function apiAdminLevelSave(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/level/save", data));
}

/** 删除 (DELETE /adminapi/level/del/:id) */
export function apiAdminLevelDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/level/del/${id}`));
}
