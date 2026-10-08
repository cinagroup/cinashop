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

export interface SystemDirectoryQuery {
  keyword: string;
  status: "" | 0 | 1;
  page: number;
  limit: number;
}

export interface SystemDirectory<T> {
  list: T[];
  total: number;
  page: number;
  limit: number;
}

function directoryParams(query: SystemDirectoryQuery) {
  const keyword = query.keyword.trim();
  if (keyword.length > 64 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new Error("关键词最多 64 个字符，不能含控制字符");
  if (!Number.isSafeInteger(query.page) || query.page < 1 || query.page > 500 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100
    || (query.page - 1) * query.limit > 10000) throw new Error("分页参数错误");
  if (query.status !== "" && query.status !== 0 && query.status !== 1) throw new Error("状态筛选参数错误");
  return { page: query.page, limit: query.limit, ...(keyword ? { keyword } : {}), ...(query.status === "" ? {} : { status: query.status }) };
}

function directory<T>(value: SystemDirectory<T>, query: SystemDirectoryQuery, valid: (row: T) => boolean): SystemDirectory<T> {
  if (!value || !Array.isArray(value.list) || value.page !== query.page || value.limit !== query.limit
    || !Number.isSafeInteger(value.total) || value.total < 0 || value.list.length > query.limit || value.total < value.list.length
    || value.list.some(row => !row || !valid(row))
    || new Set(value.list.map(row => (row as { id: number }).id)).size !== value.list.length) throw new Error("系统目录响应格式错误，请重新读取");
  return value;
}

const validIdentity = (row: { id: number; level: number; status: number }) => Number.isSafeInteger(row.id) && row.id > 0
  && Number.isInteger(row.level) && row.level >= 0 && row.level <= 9 && (row.status === 0 || row.status === 1);

export async function apiAdminSystemAdminDirectory(query: SystemDirectoryQuery, signal?: AbortSignal): Promise<SystemDirectory<AdminAccount>> {
  const params = directoryParams(query);
  const result = await getData<SystemDirectory<AdminAccount>>(request.get("/system_admin/directory", { params, signal }));
  return directory(result, query, row => validIdentity(row) && [row.account, row.realName, row.phone, row.roles].every(value => typeof value === "string")
    && Number.isSafeInteger(row.lastTime) && row.lastTime >= 0);
}

export async function apiAdminSystemRoleDirectory(query: SystemDirectoryQuery, signal?: AbortSignal): Promise<SystemDirectory<RoleItem>> {
  const params = directoryParams(query);
  const result = await getData<SystemDirectory<RoleItem>>(request.get("/system_role/directory", { params, signal }));
  return directory(result, query, row => validIdentity(row) && typeof row.roleName === "string" && typeof row.rules === "string"
    && Array.isArray(row.permissionKeys) && row.permissionKeys.every(key => typeof key === "string"));
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewPermissions: PermissionTreeNode[] = [
  { key: "dashboard", label: "控制台", path: "/dashboard", children: [{ key: "dashboard.view", label: "查看" }] },
  { key: "order", label: "订单管理", path: "/order", children: [{ key: "order.view", label: "查看" }, { key: "order.manage", label: "管理" }] },
  { key: "store", label: "门店与店员", path: "/operations/store", children: [{ key: "store.view", label: "查看" }, { key: "store.manage", label: "管理" }] },
  { key: "division", label: "事业部管理", path: "/division", children: [{ key: "division.view", label: "查看" }, { key: "division.manage", label: "管理" }] },
  { key: "division_statistics", label: "事业部统计", path: "/division/statistics", children: [{ key: "division_statistics.view", label: "查看" }] },
  { key: "supplier_bill", label: "供应商账单", path: "/supplier/bills", children: [{ key: "supplier_bill.view", label: "查看" }] },
  { key: "supplier_capital", label: "供应商资金流水", path: "/supplier/capital-flow", children: [{ key: "supplier_capital.view", label: "查看" }, { key: "supplier_capital.manage", label: "管理" }] },
  { key: "supplier_order_statistics", label: "供应商订单统计", path: "/supplier/order-statistics", children: [{ key: "supplier_order_statistics.view", label: "查看" }] },
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
}, signal?: AbortSignal): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/system_admin/save", params, { signal }));
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
}, signal?: AbortSignal): Promise<{ id: number }> {
  if (previewMode) return Promise.resolve({ id: params.id ?? 2 });
  return getData(request.post<{ id: number }>("/system_role/save", params, { signal }));
}

/** 删除角色 (DELETE /adminapi/system_role/del/:id) */
export function apiAdminSystemRoleDel(id: number, signal?: AbortSignal): Promise<null> {
  if (previewMode) return Promise.resolve(null);
  return getData(request.delete<null>(`/system_role/del/${id}`, { signal }));
}

export function apiAdminPermissionTree(signal?: AbortSignal): Promise<PermissionTreeNode[]> {
  if (previewMode) return Promise.resolve(previewPermissions);
  return getData(request.get<PermissionTreeNode[]>("/system_menus/tree", { signal }));
}
