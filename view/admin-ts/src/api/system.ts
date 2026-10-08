/**
 * Admin 系统管理 API
 */
import request, { getData } from "@/utils/request";
import type { AxiosResponse } from "axios";

export type AdminAuthorityOperationKind = "admin-save" | "role-save" | "role-delete";
export interface AdminAuthorityEnvelope {
  operation_id: string;
  operation: AdminAuthorityOperationKind;
  payload: Record<string, unknown>;
}
export interface AdminAuthorityValues { role_name?: string; rules?: string; level?: number; status?: number; roles?: string }
export interface AdminAuthorityPreview {
  operation_id: string; actor_id: number; operation: AdminAuthorityOperationKind;
  request_hash: string; revision: string; expires_at: number;
  summary: { target_id: number; target_name: string; action: "create" | "update" | "delete";
    before: AdminAuthorityValues | null; after: AdminAuthorityValues };
  affected_accounts: Array<{ id: number; account: string; real_name: string; level: number; status: number; is_del: number }>;
  requires_confirmation: true;
}
export interface AdminAuthorityPending {
  version: 1; operation_id: string; actor_id: number; operation: AdminAuthorityOperationKind;
  request_hash: string; target_id: number; action: "create" | "update" | "delete";
}
export interface AdminAuthorityReceipt {
  operation_id: string; actor_id: number; operation: AdminAuthorityOperationKind;
  state: "committed" | "not_applied" | "unknown"; request_hash: string | null;
  result: { id: number; created?: boolean; deleted?: boolean } | null;
}
export interface AdminAuthorityCommit extends AdminAuthorityEnvelope { revision: string; expires_at: number; confirmed: true }
const authorityUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const authorityHash = /^[a-f0-9]{64}$/;
const authorityKinds = new Set(["admin-save", "role-save", "role-delete"]);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown, maximum: number): value is string => typeof value === "string"
  && [...value].length <= maximum && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

export function isAdminAuthorityPending(value: unknown, owner: number): value is AdminAuthorityPending {
  if (!object(value)) return false;
  const allowed = new Set(["version", "operation_id", "actor_id", "operation", "request_hash", "target_id", "action"]);
  return Object.keys(value).every(key => allowed.has(key)) && value.version === 1 && value.actor_id === owner && positiveId(owner)
    && typeof value.operation_id === "string" && authorityUUID.test(value.operation_id)
    && typeof value.operation === "string" && authorityKinds.has(value.operation)
    && typeof value.request_hash === "string" && authorityHash.test(value.request_hash)
    && (value.target_id === 0 || positiveId(value.target_id))
    && (value.operation === "role-delete" ? value.action === "delete" && positiveId(value.target_id)
      : value.action === (value.target_id === 0 ? "create" : "update"));
}
function authorityValues(value: unknown): value is AdminAuthorityValues {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, field]) => key === "role_name" ? safeText(field, 32)
    : key === "rules" ? safeText(field, 16384) : key === "roles" ? safeText(field, 128)
      : key === "level" ? typeof field === "number" && Number.isSafeInteger(field) && field >= 0 && field <= 32767
        : key === "status" && (field === -1 || field === 0 || field === 1));
}
function completeAuthorityValues(value: unknown, kind: AdminAuthorityOperationKind, deleted = false): value is AdminAuthorityValues {
  if (!authorityValues(value)) return false;
  const required = kind === "admin-save" ? ["roles", "level", "status"] : ["role_name", "rules", "level", "status"];
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && (kind !== "admin-save" || Number(value.level) <= 9)
    && (deleted ? value.status === -1 : value.status === 0 || value.status === 1);
}
async function authorityData(promise: Promise<AxiosResponse<unknown>>): Promise<unknown> {
  const response = await promise;
  const body = response.data;
  if (response.status !== 200 || !object(body) || body.status !== 200 || typeof body.msg !== "string" || !("data" in body)) {
    throw new Error("操作响应不可靠，请查询操作回执");
  }
  return body.data;
}
export async function apiAdminAuthorityPreview(envelope: AdminAuthorityEnvelope, owner: number, signal?: AbortSignal): Promise<AdminAuthorityPreview> {
  const value = await authorityData(request.post("/system/authority/preview", envelope, { signal }));
  const target = envelope.payload.id ?? 0, action = envelope.operation === "role-delete" ? "delete" : target === 0 ? "create" : "update";
  if (!positiveId(owner) || !authorityUUID.test(envelope.operation_id) || (target !== 0 && !positiveId(target))
    || !object(value) || value.operation_id !== envelope.operation_id || value.actor_id !== owner || value.operation !== envelope.operation
    || typeof value.request_hash !== "string" || !authorityHash.test(value.request_hash)
    || typeof value.revision !== "string" || !authorityHash.test(value.revision)
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= Math.floor(Date.now() / 1000)
    || Number(value.expires_at) > Math.floor(Date.now() / 1000) + 300 || value.requires_confirmation !== true
    || !object(value.summary) || value.summary.target_id !== target || value.summary.action !== action
    || !safeText(value.summary.target_name, 128) || !value.summary.target_name.trim()
    || (action === "create" ? value.summary.before !== null : !completeAuthorityValues(value.summary.before, envelope.operation))
    || !completeAuthorityValues(value.summary.after, envelope.operation, action === "delete")
    || value.summary.after.status !== (action === "delete" ? -1 : envelope.payload.status ?? (object(value.summary.before) ? value.summary.before.status : 1))
    || !Array.isArray(value.affected_accounts) || value.affected_accounts.length > 1000
    || value.affected_accounts.some(row => !object(row) || !positiveId(row.id) || !safeText(row.account, 32) || !safeText(row.real_name, 16)
      || typeof row.level !== "number" || !Number.isInteger(row.level) || row.level < 0 || row.level > 9
      || ![0, 1].includes(Number(row.status)) || typeof row.status !== "number" || ![0, 1].includes(Number(row.is_del)) || typeof row.is_del !== "number")
    || new Set(value.affected_accounts.map(row => row.id)).size !== value.affected_accounts.length) {
    throw new Error("影响预览响应格式错误，请重新预览");
  }
  return value as unknown as AdminAuthorityPreview;
}
function authorityReceipt(value: unknown, pending: AdminAuthorityPending): AdminAuthorityReceipt {
  if (!object(value) || value.operation_id !== pending.operation_id || value.actor_id !== pending.actor_id || value.operation !== pending.operation
    || !["committed", "not_applied", "unknown"].includes(String(value.state))) throw new Error("操作回执身份或操作不匹配");
  if (value.state === "committed") {
    const result = value.result;
    if (value.request_hash !== pending.request_hash || !object(result) || !positiveId(result.id)
      || pending.target_id !== 0 && result.id !== pending.target_id
      || (pending.operation === "role-delete" ? result.deleted !== true || Object.keys(result).some(key => !["id", "deleted"].includes(key))
        : result.created !== (pending.action === "create") || Object.keys(result).some(key => !["id", "created"].includes(key)))) {
      throw new Error("操作回执请求或结果不匹配");
    }
  } else if (value.request_hash !== null || value.result !== null) throw new Error("未执行操作回执格式错误");
  return value as unknown as AdminAuthorityReceipt;
}
export async function apiAdminAuthorityCommit(envelope: AdminAuthorityCommit, pending: AdminAuthorityPending, signal?: AbortSignal): Promise<AdminAuthorityReceipt> {
  const receipt = authorityReceipt(await authorityData(request.post("/system/authority/commit", envelope, { signal })), pending);
  if (receipt.state !== "committed") throw new Error("提交未返回已执行回执，请查询操作结果");
  return receipt;
}
export async function apiAdminAuthorityReceipt(pending: AdminAuthorityPending, signal?: AbortSignal): Promise<AdminAuthorityReceipt> {
  return authorityReceipt(await authorityData(request.get(`/system/authority/receipt/${pending.operation_id}`,
    { params: { operation: pending.operation }, signal })), pending);
}
export async function apiAdminAuthorityResolve(pending: AdminAuthorityPending, signal?: AbortSignal): Promise<AdminAuthorityReceipt> {
  const receipt = authorityReceipt(await authorityData(request.post("/system/authority/resolve",
    { operation_id: pending.operation_id, operation: pending.operation }, { signal })), pending);
  if (receipt.state === "unknown") throw new Error("操作尚未封存，仍须查询或确认取消");
  return receipt;
}

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

const validIdentity = (row: { id: number; level: number; status: number }, maximumLevel = 9) => Number.isSafeInteger(row.id) && row.id > 0
  && Number.isSafeInteger(row.level) && row.level >= 0 && row.level <= maximumLevel && (row.status === 0 || row.status === 1);

export async function apiAdminSystemAdminDirectory(query: SystemDirectoryQuery, signal?: AbortSignal): Promise<SystemDirectory<AdminAccount>> {
  const params = directoryParams(query);
  const result = await getData<SystemDirectory<AdminAccount>>(request.get("/system_admin/directory", { params, signal }));
  return directory(result, query, row => validIdentity(row) && [row.account, row.realName, row.phone, row.roles].every(value => typeof value === "string")
    && Number.isSafeInteger(row.lastTime) && row.lastTime >= 0);
}

export async function apiAdminSystemRoleDirectory(query: SystemDirectoryQuery, signal?: AbortSignal): Promise<SystemDirectory<RoleItem>> {
  const params = directoryParams(query);
  const result = await getData<SystemDirectory<RoleItem>>(request.get("/system_role/directory", { params, signal }));
  return directory(result, query, row => validIdentity(row, 32767) && typeof row.roleName === "string" && typeof row.rules === "string"
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
