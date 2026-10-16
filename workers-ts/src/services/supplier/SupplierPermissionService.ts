import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { ApiErrorCode, AuthException, ValidateException } from "@/utils/errors";

const SUPPLIER_ROLE_TYPE = 4;
const MAX_ROLE_TOKENS = 512;

export interface SupplierPermissionGroup {
  key: string;
  label: string;
  path?: string;
  icon?: string;
  manage: boolean;
  matches: readonly string[];
}

export interface SupplierPrincipal {
  id: number;
  roles: string;
  isPrimary: boolean;
}

/**
 * Stable Supplier capabilities. Paths are normalized after /supplierapi.
 * Every authenticated route must be either self-service or represented here.
 */
export const SUPPLIER_PERMISSION_GROUPS: readonly SupplierPermissionGroup[] = [
  { key: "dashboard", label: "经营概览", path: "/dashboard", icon: "DataAnalysis", manage: false, matches: ["home/", "jnotice"] },
  { key: "product", label: "商品管理", path: "/products", icon: "Goods", manage: true, matches: ["product/", "form/"] },
  { key: "shipping", label: "运费模板", path: "/shipping-templates", icon: "Box", manage: true, matches: ["setting/shipping_templates/"] },
  { key: "order", label: "订单管理", path: "/orders", icon: "List", manage: true, matches: ["order/"] },
  { key: "refund", label: "售后管理", path: "/refunds", icon: "RefreshLeft", manage: true, matches: ["refund/"] },
  { key: "finance", label: "财务结算", path: "/finance", icon: "Wallet", manage: true, matches: ["finance/"] },
  { key: "print", label: "小票打印", path: "/printers", icon: "Printer", manage: true, matches: ["print/", "printing"] },
  { key: "waybill", label: "电子面单", path: "/waybills", icon: "Tickets", manage: true, matches: ["waybill/"] },
  { key: "config", label: "履约配置", path: "/settings", icon: "Tools", manage: true, matches: ["config/", "system/config", "system/form/"] },
  { key: "profile", label: "供应商资料", path: "/profile", icon: "Setting", manage: true, matches: ["supplier"] },
  { key: "admin", label: "子账号管理", path: "/administrators", icon: "User", manage: true, matches: ["admin"] },
  { key: "attachment", label: "素材中心", manage: true, matches: ["file/"] },
] as const;

const permissionKeys = new Set(
  SUPPLIER_PERMISSION_GROUPS.flatMap((group) => [
    `supplier.${group.key}.view`,
    ...(group.manage ? [`supplier.${group.key}.manage`] : []),
  ]),
);

const authenticatedSelfServiceRoutes = new Set([
  "logout",
  "logo",
  "config",
  "city",
  "menuslist",
  "updatepwd",
]);

function splitTokens(value: string | readonly string[] | undefined): string[] {
  const source = typeof value === "string" ? value : value?.join(",") ?? "";
  const tokens = [...new Set(source.split(",").map((token) => token.trim()).filter(Boolean))];
  if (tokens.length > MAX_ROLE_TOKENS) throw new ValidateException("供应商角色规则数量异常");
  return tokens;
}

function numericTokens(value: string | readonly string[] | undefined): number[] {
  return splitTokens(value)
    .filter((token) => /^[1-9]\d*$/.test(token))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value));
}

function routeMatches(route: string, matcher: string): boolean {
  const normalized = matcher.toLowerCase();
  return normalized.endsWith("/")
    ? route.startsWith(normalized)
    : route === normalized || route.startsWith(`${normalized}/`);
}

function readMethod(method: string): boolean {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function addManageView(keys: Set<string>): Set<string> {
  for (const key of [...keys]) {
    if (key.endsWith(".manage")) keys.add(`${key.slice(0, -7)}.view`);
  }
  return keys;
}

export function allSupplierPermissionKeys(): Set<string> {
  return new Set(permissionKeys);
}

export function normalizeSupplierRoute(routePath: string): string {
  return routePath
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\/supplierapi\/?/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Empty means authenticated self-service; null means an unknown route. */
export function requiredSupplierPermissions(method: string, routePath: string): string[] | null {
  const route = normalizeSupplierRoute(routePath);
  if (route === 'product/type_header' || route.startsWith('product/type_header/')
    || route === 'product/product/thorough' || route.startsWith('product/product/thorough/')) {
    if (readMethod(method) && route === 'product/type_header') return ['supplier.product.view'];
    if (method.toUpperCase() === 'DELETE' && /^product\/product\/thorough\/(?:[1-9][0-9]{0,9}|:id|<id>)$/.test(route)) return ['supplier.product.manage'];
    return null;
  }
  if (route === 'file/video_uploads' || route.startsWith('file/video_uploads/')) {
    const uuid = '(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|:uploadid|<uploadid>)';
    const base = `file/video_uploads/${uuid}`, verb = method.toUpperCase();
    if (readMethod(method) && new RegExp(`^${base}$`).test(route)
      || verb === 'POST' && new RegExp(`^${base}/cancel$`).test(route)) return [];
    if (readMethod(method) && new RegExp(`^${base}/preview$`).test(route)) return ['supplier.attachment.view'];
    if (verb === 'PUT' && new RegExp(`^${base}(?:/parts/(?:[1-9][0-9]{0,2}|:part|<part>))?$`).test(route)
      || verb === 'POST' && new RegExp(`^${base}/complete$`).test(route)) return ['supplier.attachment.manage'];
    return null;
  }
  if (route === 'product/product/get_rule' || route.startsWith('product/product/get_rule/')
    || route === 'product/product/rule' || route.startsWith('product/product/rule/')) {
    const verb = method.toUpperCase(), id = '(?:[1-9][0-9]{0,9}|:id|<id>)';
    if (readMethod(method) && (['product/product/rule', 'product/product/get_rule'].includes(route)
      || new RegExp(`^product/product/rule/${id}$`).test(route))) return ['supplier.product.view'];
    if (verb === 'POST' && new RegExp(`^product/product/rule/(?:0|${id})$`).test(route)) return ['supplier.product.manage'];
    if (verb === 'DELETE' && new RegExp(`^product/product/rule/delete/${id}$`).test(route)) return ['supplier.product.manage'];
    return null;
  }
  if (route === 'product/all_label' || route === 'product/label' || route.startsWith('product/label/')) {
    const verb = method.toUpperCase();
    if (readMethod(method) && ['product/all_label', 'product/label/catalog', 'product/label/form'].includes(route)) return ['supplier.product.view'];
    const identifier = '(?:[1-9][0-9]{0,9}|:id|<id>)';
    if (verb === 'POST' && (route === 'product/label/0' || new RegExp(`^product/label/${identifier}$`).test(route))) return ['supplier.product.manage'];
    if (verb === 'DELETE' && new RegExp(`^product/label/${identifier}$`).test(route)) return ['supplier.product.manage'];
    return null;
  }
  if (route === 'product/batch_process' || route.startsWith('product/batch_process/')
    || route === 'product/product/batch-selection' || route.startsWith('product/product/batch-selection/')) {
    if (method.toUpperCase() === 'POST' && route === 'product/batch_process') return ['supplier.product.manage'];
    if (readMethod(method) && route === 'product/product/batch-selection') return ['supplier.product.view'];
    return null;
  }
  if (route === 'product/category' || route.startsWith('product/category/')) {
    const read = readMethod(method), verb = method.toUpperCase();
    const identifier = '(?:[1-9][0-9]{0,9}|:id|<id>)';
    // Form metadata is a read. Numeric GET menu grants must not become a
    // product writer merely because the returned form contains a save action.
    if (read && (route === 'product/category/create' || new RegExp(`^product/category/${identifier}$`).test(route))) return ['supplier.product.view'];
    if (read && (['product/category', 'product/category/tree', 'product/category/cascader_list'].includes(route)
      || /^product\/category\/(?:tree|cascader_list)\/(?:[012]|:type|<type>)$/.test(route)
      || new RegExp(`^product/category/${identifier}/detail$`).test(route))) return ['supplier.product.view'];
    if (verb === 'POST' && route === 'product/category') return ['supplier.product.manage'];
    if (['PUT', 'DELETE'].includes(verb) && new RegExp(`^product/category/${identifier}$`).test(route)) return ['supplier.product.manage'];
    if (verb === 'PUT' && new RegExp(`^product/category/set_show/${identifier}/(?:[01]|:is_show|<is_show>)$`).test(route)) return ['supplier.product.manage'];
    return null;
  }
  if (authenticatedSelfServiceRoutes.has(route)) return [];
  if (route.startsWith("order/print/")) return ["supplier.order.view", "supplier.print.manage"];
  if (route.startsWith("order/waybill/")) return ["supplier.order.view", "supplier.waybill.manage"];
  if (route.startsWith("queue/")) return ["supplier.order.view"];
  if (route === "export/expresslist") return ["supplier.order.view"];
  if (route === "export/storeorder" || route.startsWith("export/batchorderdelivery/")) {
    return ["supplier.order.manage"];
  }
  if (route === "export/financerecord") return ["supplier.finance.manage"];
  const group = SUPPLIER_PERMISSION_GROUPS.find((candidate) =>
    candidate.matches.some((matcher) => routeMatches(route, matcher)),
  );
  if (!group) return null;
  return [`supplier.${group.key}.${readMethod(method) || !group.manage ? "view" : "manage"}`];
}

export function normalizeSupplierRoleRules(value: string | readonly string[] | undefined): string {
  const tokens = splitTokens(value);
  for (const token of tokens) {
    if (!permissionKeys.has(token) && !/^[1-9]\d*$/.test(token)) {
      throw new ValidateException(`未知供应商权限规则: ${token}`);
    }
  }
  const expanded = addManageView(new Set(tokens));
  const stable = [...permissionKeys].filter((key) => expanded.has(key));
  const legacy = [...expanded]
    .filter((token) => /^[1-9]\d*$/.test(token))
    .map(Number)
    .sort((left, right) => left - right)
    .map(String);
  return [...stable, ...legacy].join(",");
}

export function assertSupplierDelegablePermissions(
  granted: ReadonlySet<string>,
  requested: Iterable<string>,
): void {
  const excess = [...new Set(requested)].filter((key) => !granted.has(key));
  if (excess.length) {
    throw new ValidateException(`不能授予超出当前供应商管理员范围的权限: ${excess.join(",")}`);
  }
}

async function resolveRuleTokens(db: DbClient, tokens: readonly string[]): Promise<Set<string>> {
  const menuIds = numericTokens(tokens);
  if (!menuIds.length) return resolveRuleTokensWithMenus(tokens, []);
  const menus = await db
    .select({ id: systemMenus.id, methods: systemMenus.methods, apiUrl: systemMenus.apiUrl })
    .from(systemMenus)
    .where(and(
      inArray(systemMenus.id, menuIds),
      eq(systemMenus.type, SUPPLIER_ROLE_TYPE),
      eq(systemMenus.authType, 2),
      eq(systemMenus.access, 1),
      eq(systemMenus.isDel, 0),
    ));
  return resolveRuleTokensWithMenus(tokens, menus);
}

function resolveRuleTokensWithMenus(
  tokens: readonly string[],
  menus: ReadonlyArray<{ id: number; methods: string; apiUrl: string }>,
): Set<string> {
  const direct = new Set(tokens.filter((token) => permissionKeys.has(token)));
  const allowedMenuIds = new Set(numericTokens(tokens));
  for (const menu of menus) {
    if (!allowedMenuIds.has(menu.id)) continue;
    const methods = menu.methods.split(/[,|]/).map((method) => method.trim()).filter(Boolean);
    for (const method of methods.length ? methods : ["GET"]) {
      const required = requiredSupplierPermissions(method, menu.apiUrl);
      for (const key of required ?? []) direct.add(key);
    }
  }
  return addManageView(direct);
}

export async function resolveSupplierRoleAssignment(
  db: DbClient,
  value: string | readonly string[] | undefined,
  supplierId: number,
): Promise<{
  keys: Set<string>;
  roleIds: number[];
  missingRoleIds: number[];
  roleNames: Map<number, string>;
}> {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    throw new ValidateException("供应商身份无效");
  }
  const roleIds = numericTokens(value);
  if (!roleIds.length) {
    return { keys: new Set(), roleIds: [], missingRoleIds: [], roleNames: new Map() };
  }
  const roles = await db
    .select({ id: systemRole.id, roleName: systemRole.roleName, rules: systemRole.rules })
    .from(systemRole)
    .where(and(
      inArray(systemRole.id, roleIds),
      eq(systemRole.type, SUPPLIER_ROLE_TYPE),
      eq(systemRole.relationId, supplierId),
      eq(systemRole.status, 1),
    ));
  const found = new Set(roles.map((role) => role.id));
  const keys = await resolveRuleTokens(db, roles.flatMap((role) => splitTokens(role.rules)));
  return {
    keys,
    roleIds,
    missingRoleIds: roleIds.filter((id) => !found.has(id)),
    roleNames: new Map(roles.map((role) => [role.id, role.roleName])),
  };
}

export class SupplierPermissionService {
  constructor(private readonly db: DbClient) {}

  async permissionsFor(principal: SupplierPrincipal, supplierId: number): Promise<Set<string>> {
    if (principal.isPrimary) return allSupplierPermissionKeys();
    return (await resolveSupplierRoleAssignment(this.db, principal.roles, supplierId)).keys;
  }

  async assertAuthorized(
    principal: SupplierPrincipal,
    supplierId: number,
    method: string,
    routePath: string,
  ): Promise<Set<string>> {
    const required = requiredSupplierPermissions(method, routePath);
    if (required === null) {
      throw new AuthException("该供应商接口尚未登记权限规则", ApiErrorCode.ERR_AUTH);
    }
    const granted = await this.permissionsFor(principal, supplierId);
    if (required.some((key) => !granted.has(key))) {
      throw new AuthException("暂时没有权限访问", ApiErrorCode.ERR_AUTH);
    }
    return granted;
  }

  buildNavigation(keys: ReadonlySet<string>) {
    return SUPPLIER_PERMISSION_GROUPS
      .filter((group) => group.path && keys.has(`supplier.${group.key}.view`))
      .map((group) => ({
        path: group.path!,
        name: group.label,
        icon: group.icon ?? "",
        permission: `supplier.${group.key}.view`,
      }));
  }

  buildSearchMenus(keys: ReadonlySet<string>) {
    return this.buildNavigation(keys).map((menu, index) => ({
      id: index + 1,
      pid: 0,
      menu_name: menu.name,
      menu_path: menu.path,
      unique_auth: menu.permission,
      sort: SUPPLIER_PERMISSION_GROUPS.length - index,
      type: 0,
    }));
  }

  permissionTree() {
    return SUPPLIER_PERMISSION_GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      children: [
        { key: `supplier.${group.key}.view`, label: "查看" },
        ...(group.manage ? [{ key: `supplier.${group.key}.manage`, label: "管理" }] : []),
      ],
    }));
  }

  async resolveManyRulePermissionKeys(rulesList: readonly string[]): Promise<string[][]> {
    const tokenSets = rulesList.map((rules) => splitTokens(rules));
    const menuIds = [...new Set(tokenSets.flatMap((tokens) => numericTokens(tokens)))];
    const menus = menuIds.length
      ? await this.db
          .select({ id: systemMenus.id, methods: systemMenus.methods, apiUrl: systemMenus.apiUrl })
          .from(systemMenus)
          .where(and(
            inArray(systemMenus.id, menuIds),
            eq(systemMenus.type, SUPPLIER_ROLE_TYPE),
            eq(systemMenus.authType, 2),
            eq(systemMenus.access, 1),
            eq(systemMenus.isDel, 0),
          ))
      : [];
    return tokenSets.map((tokens) => [...resolveRuleTokensWithMenus(tokens, menus)]);
  }
}
