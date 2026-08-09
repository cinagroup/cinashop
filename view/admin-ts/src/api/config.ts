/**
 * Admin 系统配置 API
 */
import request, { getData } from "@/utils/request";

export interface SystemConfigItem {
  id: number;
  menuName: string;
  value: string;
  info: string;
  isStore: number;
  addTime: number;
}

/** 配置列表 (GET /adminapi/config/list) */
export function apiAdminConfigList(): Promise<SystemConfigItem[]> {
  return getData(request.get<SystemConfigItem[]>("/config/list"));
}

/** 批量保存配置 (POST /adminapi/config/save) */
export function apiAdminConfigSave(payload: Record<string, string>): Promise<null> {
  return getData(request.post<null>("/config/save", payload));
}

/** 读取单个配置 (GET /adminapi/config/:menuName) */
export function apiAdminConfigGet(menuName: string): Promise<{ menuName: string; value: string }> {
  return getData(request.get<{ menuName: string; value: string }>(`/config/${menuName}`));
}
