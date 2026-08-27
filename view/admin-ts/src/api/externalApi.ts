import request, { getData } from "@/utils/request";

export interface ExternalAccount {
  id: number;
  appid: string;
  title: string;
  status: number;
  rules: number[];
  add_time: number;
  last_time: number;
  credential_state: "hashed" | "invalid_or_missing_hash";
  legacy_plaintext_present: boolean;
  push_configured: boolean;
  push_runtime: "not_migrated";
}

export interface ExternalInterface {
  id: number;
  pid: number;
  type: number;
  name: string;
  title: string;
  method: string;
  url: string;
  runtime_status: "available_read" | "available_write" | "not_migrated" | "group";
  children?: ExternalInterface[];
}

export interface ExternalInterfaceDetail extends ExternalInterface {
  describe: string | null;
  request_params: unknown;
  return_params: unknown;
  request_example: unknown;
  return_example: unknown;
  error_code: unknown;
}

export interface ExternalAccountSaveResult {
  id: number;
  issued_secret?: string;
  secret_display: "once" | "unchanged";
}

export interface ExternalAudit {
  id: number;
  out_account_id: number;
  appid: string;
  method: string;
  route_template: string;
  operation: "read" | "write";
  resource_hash: string;
  query_fields: string;
  ip_hash: string;
  user_agent_hash: string;
  outcome: "success" | "denied" | "rate_limited" | "error";
  result_code: number;
  duration_ms: number;
  add_time: number;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewInterfaces: ExternalInterface[] = [
  {
    id: 20, pid: 0, type: 0, name: "商品相关", title: "商品相关", method: "", url: "",
    runtime_status: "group",
    children: [
      { id: 21, pid: 20, type: 1, name: "商品列表", title: "商品列表", method: "GET", url: "/product/list", runtime_status: "available_read" },
      { id: 22, pid: 20, type: 1, name: "商品详情", title: "商品详情", method: "GET", url: "/product/{id}", runtime_status: "available_read" },
      { id: 23, pid: 20, type: 1, name: "新增商品", title: "新增商品", method: "POST", url: "/product", runtime_status: "not_migrated" },
    ],
  },
  {
    id: 30, pid: 0, type: 0, name: "分类相关", title: "分类相关", method: "", url: "",
    runtime_status: "group",
    children: [
      { id: 31, pid: 30, type: 1, name: "分类列表", title: "分类列表", method: "GET", url: "/category/list", runtime_status: "available_read" },
      { id: 32, pid: 30, type: 1, name: "分类详情", title: "分类详情", method: "GET", url: "/category/{id}", runtime_status: "available_read" },
    ],
  },
  {
    id: 40, pid: 0, type: 0, name: "订单相关", title: "订单相关", method: "", url: "",
    runtime_status: "group",
    children: [
      { id: 41, pid: 40, type: 1, name: "订单列表", title: "订单列表", method: "GET", url: "/order/list", runtime_status: "available_read" },
      { id: 42, pid: 40, type: 1, name: "订单备注", title: "订单备注", method: "PUT", url: "/order/remark/{order_id}", runtime_status: "available_write" },
      { id: 43, pid: 40, type: 1, name: "订单发货", title: "订单发货", method: "PUT", url: "/order/delivery/{order_id}", runtime_status: "available_write" },
      { id: 44, pid: 40, type: 1, name: "确认收货", title: "确认收货", method: "PUT", url: "/order/receive/{order_id}", runtime_status: "available_write" },
      { id: 45, pid: 40, type: 1, name: "拆单发货", title: "拆单发货", method: "PUT", url: "/order/split_delivery/{order_id}", runtime_status: "available_write" },
      { id: 46, pid: 40, type: 1, name: "修改配送信息", title: "修改配送信息", method: "PUT", url: "/order/distribution/{order_id}", runtime_status: "available_write" },
    ],
  },
  {
    id: 50, pid: 0, type: 0, name: "退款相关", title: "退款相关", method: "", url: "",
    runtime_status: "group",
    children: [
      { id: 51, pid: 50, type: 1, name: "退款详情", title: "退款详情", method: "GET", url: "/refund/{order_id}", runtime_status: "available_read" },
      { id: 52, pid: 50, type: 1, name: "退款备注", title: "退款备注", method: "PUT", url: "/refund/remark/{order_id}", runtime_status: "available_write" },
      { id: 53, pid: 50, type: 1, name: "退款审核", title: "退款审核", method: "PUT", url: "/refund/audit/{order_id}", runtime_status: "not_migrated" },
    ],
  },
];

const previewAccounts: ExternalAccount[] = [
  { id: 7, appid: "erp-production", title: "ERP 商品目录同步", status: 1, rules: [21, 22, 31, 32], add_time: 1_786_000_000, last_time: 1_786_320_000, credential_state: "hashed", legacy_plaintext_present: false, push_configured: false, push_runtime: "not_migrated" },
  { id: 8, appid: "warehouse-reader", title: "仓储只读客户端", status: 2, rules: [21, 22], add_time: 1_785_000_000, last_time: 1_785_900_000, credential_state: "hashed", legacy_plaintext_present: true, push_configured: true, push_runtime: "not_migrated" },
];

const previewAudits: ExternalAudit[] = [
  { id: 3, out_account_id: 7, appid: "erp-production", method: "PUT", route_template: "/order/remark/{order_id}", operation: "write", resource_hash: "91ad02bc663c1be2", query_fields: "", ip_hash: "31c98f02ea3b7254", user_agent_hash: "8b6cb5d09140e01a", outcome: "success", result_code: 200, duration_ms: 38, add_time: 1_786_321_200 },
  { id: 2, out_account_id: 7, appid: "erp-production", method: "GET", route_template: "/user/info/{uid}", operation: "read", resource_hash: "1b273aaf2006cd72", query_fields: "fields", ip_hash: "31c98f02ea3b7254", user_agent_hash: "8b6cb5d09140e01a", outcome: "success", result_code: 200, duration_ms: 21, add_time: 1_786_320_800 },
  { id: 1, out_account_id: 8, appid: "warehouse-reader", method: "GET", route_template: "/order/list", operation: "read", resource_hash: "dfdb24d189f693b7", query_fields: "limit,page,status", ip_hash: "04dc91c6621032a8", user_agent_hash: "a0f572d91ea372d6", outcome: "denied", result_code: 400011, duration_ms: 7, add_time: 1_786_320_400 },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function generatedPreviewSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function apiExternalAccounts(params: Record<string, unknown>) {
  if (previewMode) {
    const keyword = String(params.name ?? "").trim().toLowerCase();
    const status = params.status === undefined || params.status === "" ? null : Number(params.status);
    const list = previewAccounts.filter((row) =>
      (!keyword || `${row.appid}${row.title}`.toLowerCase().includes(keyword)) &&
      (status === null || row.status === status));
    return Promise.resolve({ list: clone(list), count: list.length });
  }
  return getData<{ list: ExternalAccount[]; count: number }>(
    request.get("/system_out/index", { params }),
  );
}

export function apiExternalInterfaces() {
  if (previewMode) return Promise.resolve(clone(previewInterfaces));
  return getData<ExternalInterface[]>(request.get("/system_out/interface/list"));
}

export function apiExternalAudits(params: Record<string, unknown>) {
  if (previewMode) {
    const operation = String(params.operation ?? "");
    const outcome = String(params.outcome ?? "");
    const route = String(params.route ?? "").toLowerCase();
    const list = previewAudits.filter((row) =>
      (!operation || row.operation === operation) &&
      (!outcome || row.outcome === outcome) &&
      (!route || row.route_template.toLowerCase().includes(route)));
    return Promise.resolve({ list: clone(list), count: list.length });
  }
  return getData<{ list: ExternalAudit[]; count: number }>(
    request.get("/system_out/audit", { params }),
  );
}

export function apiExternalInterfaceInfo(id: number) {
  if (previewMode) {
    const row = previewInterfaces.flatMap((group) => group.children ?? []).find((item) => item.id === id)!;
    return Promise.resolve({
      ...clone(row), describe: `${row.name}接口文档`, request_params: [], return_params: [],
      request_example: { page: 1, limit: 20 }, return_example: { status: 200, data: {} }, error_code: [],
    } as ExternalInterfaceDetail);
  }
  return getData<ExternalInterfaceDetail>(request.get(`/system_out/interface/info/${id}`));
}

export function apiExternalAccountSave(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const nextId = id || Math.max(...previewAccounts.map((item) => item.id), 0) + 1;
    const existing = previewAccounts.find((item) => item.id === nextId);
    const next: ExternalAccount = {
      id: nextId,
      appid: String(data.appid),
      title: String(data.title ?? ""),
      status: Number(data.status ?? 1),
      rules: (data.rules as number[]) ?? [],
      add_time: existing?.add_time ?? Math.floor(Date.now() / 1000),
      last_time: existing?.last_time ?? 0,
      credential_state: "hashed",
      legacy_plaintext_present: false,
      push_configured: existing?.push_configured ?? false,
      push_runtime: "not_migrated",
    };
    const index = previewAccounts.findIndex((item) => item.id === nextId);
    if (index >= 0) previewAccounts[index] = next; else previewAccounts.unshift(next);
    const issued = !id || data.rotate_secret ? generatedPreviewSecret() : undefined;
    return Promise.resolve({ id: nextId, issued_secret: issued, secret_display: issued ? "once" : "unchanged" } as ExternalAccountSaveResult);
  }
  return getData<ExternalAccountSaveResult>(
    id
      ? request.post(`/system_out/update/${id}`, data)
      : request.post("/system_out/save", data),
  );
}

export function apiExternalAccountStatus(id: number, status: number) {
  if (previewMode) {
    const row = previewAccounts.find((item) => item.id === id);
    if (row) row.status = status;
    return Promise.resolve({ id, status });
  }
  return getData<{ id: number; status: number }>(
    request.put(`/system_out/set_status/${id}/${status}`),
  );
}

export function apiExternalAccountDelete(id: number) {
  if (previewMode) {
    const index = previewAccounts.findIndex((item) => item.id === id);
    if (index >= 0) previewAccounts.splice(index, 1);
    return Promise.resolve(null);
  }
  return getData<null>(request.delete(`/system_out/delete/${id}`));
}
