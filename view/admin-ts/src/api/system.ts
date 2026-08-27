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
  permissionKeys: string[];
}

export interface PermissionTreeNode {
  key: string;
  label: string;
  path: string;
  children: Array<{ key: string; label: string }>;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewPermissions: PermissionTreeNode[] = [
  { key: "dashboard", label: "控制台", path: "/dashboard", children: [{ key: "dashboard.view", label: "查看" }] },
  { key: "order", label: "订单管理", path: "/order", children: [{ key: "order.view", label: "查看" }, { key: "order.manage", label: "管理" }] },
  { key: "store", label: "门店与店员", path: "/operations/store", children: [{ key: "store.view", label: "查看" }, { key: "store.manage", label: "管理" }] },
  { key: "division", label: "事业部管理", path: "/division", children: [{ key: "division.view", label: "查看" }, { key: "division.manage", label: "管理" }] },
  { key: "wechat_content", label: "公众号内容", path: "/content/wechat", children: [{ key: "wechat_content.view", label: "查看" }, { key: "wechat_content.manage", label: "管理" }] },
  { key: "wechat_qrcode", label: "渠道二维码", path: "/content/wechat-qrcode", children: [{ key: "wechat_qrcode.view", label: "查看" }, { key: "wechat_qrcode.manage", label: "管理" }] },
  { key: "system", label: "管理员与角色", path: "/system", children: [{ key: "system.view", label: "查看" }, { key: "system.manage", label: "管理" }] },
];

/** 管理员列表 (GET /adminapi/system_admin/list) */
export function apiAdminSystemAdminList(): Promise<AdminAccount[]> {
  if (previewMode) return Promise.resolve([{ id: 1, account: "admin", realName: "超级管理员", phone: "13800000000", roles: "", level: 0, status: 1, lastTime: 1_800_000_000 }]);
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
  if (previewMode) return Promise.resolve([{ id: 2, roleName: "事业部运营", rules: "dashboard.view,division.view,division.manage", level: 1, status: 1, permissionKeys: ["dashboard.view", "division.view", "division.manage"] }]);
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
  if (previewMode) return Promise.resolve({ id: params.id ?? 2 });
  return getData(request.post<{ id: number }>("/system_role/save", params));
}

/** 删除角色 (DELETE /adminapi/system_role/del/:id) */
export function apiAdminSystemRoleDel(id: number): Promise<null> {
  if (previewMode) return Promise.resolve(null);
  return getData(request.delete<null>(`/system_role/del/${id}`));
}

export function apiAdminPermissionTree(): Promise<PermissionTreeNode[]> {
  if (previewMode) return Promise.resolve(previewPermissions);
  return getData(request.get<PermissionTreeNode[]>("/system_menus/tree"));
}
