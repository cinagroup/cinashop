import request, { getData } from "@/utils/request";

/** Legacy type-4 rows are still resolved from numeric role rules at request time. */
export interface SupplierMenuRule {
  id: number;
  pid: number;
  type: 4;
  auth_type: 0 | 1 | 2;
  menu_name: string;
  menu_path: string;
  unique_auth: string;
  api_url: string;
  methods: string;
  icon: string;
  sort: number;
  is_show: 0 | 1;
  is_show_path: 0 | 1;
  access: 0 | 1;
  is_del: 0;
  revision: string;
  role_reference_count: number;
  role_reference_ids: number[];
  effective_permissions: string[];
  children: SupplierMenuRule[];
}

export interface SupplierMenuRulePage {
  list: SupplierMenuRule[];
  count: number;
}

export interface SupplierMenuRuleCatalog {
  permissions: Array<{ key: string; label: string; manage: boolean }>;
  navigation: Array<{ path: string; name: string; permission: string }>;
  write_ready: boolean;
}

export interface SupplierMenuRuleFilter {
  keyword?: string;
  is_show?: 0 | 1;
}

const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
const text = (value: unknown) => typeof value === "string";
const flag = (value: unknown) => value === 0 || value === 1;

function readRule(value: unknown, depth = 0): SupplierMenuRule {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 64) {
    throw new Error("供应商规则响应无效");
  }
  const row = value as Record<string, unknown>;
  if (!positiveId(row.id as number) || !Number.isSafeInteger(row.pid) || (row.pid as number) < 0 ||
    row.type !== 4 || ![0, 1, 2].includes(row.auth_type as number) ||
    !["menu_name", "menu_path", "unique_auth", "api_url", "methods", "icon", "revision"].every(key => text(row[key])) ||
    !Number.isSafeInteger(row.sort) || !flag(row.is_show) || !flag(row.is_show_path) ||
    !flag(row.access) || row.is_del !== 0 || !Number.isSafeInteger(row.role_reference_count) ||
    (row.role_reference_count as number) < 0 || !Array.isArray(row.role_reference_ids) ||
    !row.role_reference_ids.every(positiveId) || row.role_reference_ids.length !== row.role_reference_count ||
    !Array.isArray(row.effective_permissions) ||
    !row.effective_permissions.every(text) || !Array.isArray(row.children)) {
    throw new Error("供应商规则响应无效");
  }
  return { ...row, children: row.children.map(child => readRule(child, depth + 1)) } as SupplierMenuRule;
}

export function parseSupplierMenuRulePage(value: unknown): SupplierMenuRulePage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("供应商规则列表响应无效");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.list) || !Number.isSafeInteger(page.count) || (page.count as number) < 0) {
    throw new Error("供应商规则列表响应无效");
  }
  return { list: page.list.map(row => readRule(row)), count: page.count as number };
}

export function parseSupplierMenuRuleCatalog(value: unknown): SupplierMenuRuleCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("供应商权限目录响应无效");
  const catalog = value as Record<string, unknown>;
  if (!Array.isArray(catalog.permissions) || !Array.isArray(catalog.navigation) ||
    typeof catalog.write_ready !== "boolean" ||
    !catalog.permissions.every(row => row && typeof row === "object" &&
      text(row.key) && text(row.label) && typeof row.manage === "boolean") ||
    !catalog.navigation.every(row => row && typeof row === "object" &&
      text(row.path) && text(row.name) && text(row.permission))) {
    throw new Error("供应商权限目录响应无效");
  }
  return catalog as unknown as SupplierMenuRuleCatalog;
}

export async function apiSupplierMenuRules(filter: SupplierMenuRuleFilter = {}, signal?: AbortSignal): Promise<SupplierMenuRulePage> {
  const keyword = filter.keyword?.trim() ?? "";
  if ([...keyword].length > 80 || (filter.is_show !== undefined && !flag(filter.is_show))) {
    throw new Error("供应商规则筛选条件无效");
  }
  const params: SupplierMenuRuleFilter = {};
  if (keyword) params.keyword = keyword;
  if (filter.is_show !== undefined) params.is_show = filter.is_show;
  return parseSupplierMenuRulePage(await getData<unknown>(request.get("/supplier/menu-rules", { params, signal })));
}

export async function apiSupplierMenuRuleDetail(id: number, signal?: AbortSignal): Promise<SupplierMenuRule> {
  if (!positiveId(id)) throw new Error("供应商规则 ID 无效");
  return readRule(await getData<unknown>(request.get(`/supplier/menu-rules/${id}`, { signal })));
}

export async function apiSupplierMenuRuleCatalog(signal?: AbortSignal): Promise<SupplierMenuRuleCatalog> {
  return parseSupplierMenuRuleCatalog(await getData<unknown>(request.get("/supplier/menu-rules/catalog", { signal })));
}
