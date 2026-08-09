/**
 * Admin 系统管理 API
 */
import request, { getData } from "@/utils/request";

export interface AdminAccount {
  id: number;
  account: string;
  realName: string;
  phone: string;
  roles: string;
  level: number;
  status: number;
  lastTime: number;
}

export interface RoleItem {
  id: number;
  roleName: string;
  rules: string;
  level: number;
  status: number;
}

/** 管理员列表 (GET /adminapi/system_admin/list) */
export function apiAdminSystemAdminList(): Promise<AdminAccount[]> {
  return getData(request.get<AdminAccount[]>("/system_admin/list"));
}

/** 保存管理员 (POST /adminapi/system_admin/save) */
export function apiAdminSystemAdminSave(params: {
  id?: number;
  account?: string;
  real_name?: string;
  phone?: string;
  pwd?: string;
  roles?: string;
  level?: number;
  status?: number;
}): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/system_admin/save", params));
}

/** 角色列表 (GET /adminapi/system_role/list) */
export function apiAdminSystemRoleList(): Promise<RoleItem[]> {
  return getData(request.get<RoleItem[]>("/system_role/list"));
}

/** 保存角色 (POST /adminapi/system_role/save) */
export function apiAdminSystemRoleSave(params: {
  id?: number;
  role_name?: string;
  rules?: string;
  level?: number;
  status?: number;
}): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/system_role/save", params));
}

/** 删除角色 (DELETE /adminapi/system_role/del/:id) */
export function apiAdminSystemRoleDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/system_role/del/${id}`));
}
