import { and, eq, inArray } from "drizzle-orm";
import type { AppVariables } from "@/env";
import type { Container } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { ApiErrorCode, AuthException, ValidateException } from "@/utils/errors";

export interface AdminPermissionGroup {
  key: string;
  label: string;
  path: string;
  matches: readonly string[];
  manage: boolean;
}

export interface AdminPermissionTreeNode {
  key: string;
  label: string;
  path: string;
  children: Array<{ key: string; label: string }>;
}

/**
 * 当前 Workers 管理端的服务端权限目录。
 * matches 使用已经去掉 /adminapi 或 /api/admin 前缀的路由模式。
 */
export const ADMIN_PERMISSION_GROUPS: readonly AdminPermissionGroup[] = [
  { key: "dashboard", label: "控制台", path: "/dashboard", matches: ["home/", "new_push"], manage: false },
  { key: "outbox", label: "支付后置任务", path: "/operations/outbox", matches: ["order/outbox"], manage: true },
  {
    key: "legacy_runtime",
    label: "迁移运行历史",
    path: "/operations/legacy-runtime",
    matches: ["system/timer/", "queue/"],
    manage: false,
  },
  {
    key: "enterprise_wechat",
    label: "企业微信",
    path: "/operations/work",
    matches: ["work/"],
    manage: true,
  },
  {
    key: "live_broadcast",
    label: "小程序直播",
    path: "/marketing/live",
    matches: ["live/"],
    manage: true,
  },
  {
    key: "external_api",
    label: "对外接口",
    path: "/system/out",
    matches: ["system_out/"],
    manage: true,
  },
  {
    key: "product",
    label: "商品管理",
    path: "/product",
    matches: ["product/", "unit", "unit/", "get_all_unit", "specs", "specs/", "all_specs"],
    manage: true,
  },
  { key: "category", label: "商品分类", path: "/category", matches: ["category/"], manage: true },
  { key: "brand", label: "品牌管理", path: "/brand", matches: ["brand/"], manage: true },
  {
    key: "store",
    label: "门店与店员",
    path: "/operations/store",
    matches: ["merchant/store", "merchant/store_staff", "merchant/store_list"],
    manage: true,
  },
  { key: "order", label: "订单管理", path: "/order", matches: ["order/", "integral/order"], manage: true },
  { key: "refund", label: "退款审核", path: "/refund", matches: ["refund/", "refund_order/"], manage: true },
  {
    key: "user",
    label: "用户管理",
    path: "/user",
    matches: ["user/", "user_group/", "set_group", "save_set_group"],
    manage: true,
  },
  {
    key: "paid_membership",
    label: "付费会员",
    path: "/member",
    matches: [
      "member/",
      "member_batch/",
      "member_card/",
      "member_ship/",
      "member_right/",
      "member_agreement/",
      "member_scan",
    ],
    manage: true,
  },
  { key: "level", label: "会员等级", path: "/level", matches: ["level/"], manage: true },
  { key: "coupon", label: "优惠券管理", path: "/coupon", matches: ["coupon/"], manage: true },
  {
    key: "activity",
    label: "营销活动",
    path: "/activity",
    matches: ["activity/", "discounts/"],
    manage: true,
  },
  { key: "service", label: "客服会话", path: "/kefu", matches: ["service/", "feedback", "feedback/", "wechat/speechcraft", "wechat/speechcraft/", "api/ws/kefu"], manage: true },
  { key: "reply", label: "商品评价", path: "/reply", matches: ["reply/"], manage: true },
  { key: "community", label: "社区运营", path: "/community", matches: ["community/"], manage: true },
  {
    key: "attachment",
    label: "素材中心",
    path: "/assets",
    matches: ["file/file", "file/upload", "file/upload_type", "file/category", "config/storage", "assets", "asset-categories"],
    manage: true,
  },
  { key: "config", label: "系统配置", path: "/config", matches: ["config/", "config_class", "config_class/", "form/", "setting/", "sms/", "erp/config"], manage: true },
  { key: "print", label: "小票打印", path: "/setting/print", matches: ["print/"], manage: true },
  { key: "waybill", label: "电子面单", path: "/setting/waybill", matches: ["waybill/"], manage: true },
  { key: "supplier_application", label: "供应商入驻", path: "/supplier/applications", matches: ["supplier/apply/", "supplier/applications"], manage: true },
  { key: "system", label: "管理员与角色", path: "/system", matches: ["system_admin/", "system_role/", "system_menus/"], manage: true },
  { key: "extract", label: "提现审核", path: "/finance/extract", matches: ["extract/"], manage: true },
  { key: "supplier_extract", label: "供应商提现", path: "/finance/supplier-extract", matches: ["supplier/extract/"], manage: true },
  { key: "bill", label: "财务流水", path: "/finance/bill", matches: ["bill/"], manage: false },
  { key: "capital_flow", label: "平台资金流水", path: "/finance/capital-flow", matches: ["flow/"], manage: true },
  { key: "shipping", label: "运费模板", path: "/shipping", matches: ["shipping_template/"], manage: true },
  { key: "express", label: "快递公司", path: "/express", matches: ["express/"], manage: true },
  { key: "statistic", label: "统计报表", path: "/statistic", matches: ["statistic/"], manage: false },
  {
    key: "label",
    label: "标签管理",
    path: "/label",
    matches: [
      "product_label/",
      "user_label/",
      "user_label_cate/",
      "label/",
      "set_label",
      "save_set_label",
    ],
    manage: true,
  },
  { key: "article", label: "CMS 文章", path: "/content/article", matches: ["article/"], manage: true },
  {
    key: "wechat_member_card",
    label: "公众号会员卡",
    path: "/content/wechat-card",
    matches: ["wechat/card"],
    manage: true,
  },
  {
    key: "wechat_content",
    label: "公众号内容",
    path: "/content/wechat",
    matches: [
      "wechat/reply",
      "wechat/code_reply/",
      "wechat/keyword",
      "wechat/keyword/",
      "wechat/media",
      "wechat/news",
      "wechat/news/",
      "wechat/message",
      "wechat/message/",
      "wechat/push",
    ],
    manage: true,
  },
  {
    key: "wechat_qrcode",
    label: "公众号渠道码",
    path: "/content/wechat-qrcode",
    matches: ["wechat_qrcode/"],
    manage: true,
  },
  { key: "dise", label: "DIY 装修", path: "/content/dise", matches: ["dise/", "diy/"], manage: true },
  { key: "lottery", label: "抽奖活动", path: "/marketing/lottery", matches: ["lottery/"], manage: true },
  { key: "log", label: "操作日志", path: "/system/log", matches: ["log/"], manage: false },
  {
    key: "distribution",
    label: "分销管理",
    path: "/agent",
    matches: ["spread/", "brokerage/", "promoter/", "agent/level", "agent/level/", "agent/level_task", "agent/level_task/"],
    manage: true,
  },
  {
    key: "division",
    label: "事业部管理",
    path: "/division",
    matches: ["agent/division/", "agent/division_agent/", "agent/division_staff/"],
    manage: true,
  },
  { key: "notification", label: "通知配置", path: "/setting/notification", matches: ["notification/"], manage: true },
] as const;

const permissionKeys = new Set(
  ADMIN_PERMISSION_GROUPS.flatMap((group) => [
    `${group.key}.view`,
    ...(group.manage ? [`${group.key}.manage`] : []),
  ]),
);
permissionKeys.add("order.assisted");

function isNumericToken(token: string): boolean {
  return /^[1-9]\d*$/.test(token);
}

function splitRuleTokens(value: string | readonly string[] | undefined): string[] {
  const source = typeof value === "string" ? value : value?.join(",") ?? "";
  return [...new Set(source.split(",").map((token) => token.trim()).filter(Boolean))].slice(0, 2048);
}

export function normalizeAdminRoute(routePath: string): string {
  return routePath
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\/(?:api\/admin|adminapi)\/?/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function matchesRoute(route: string, matcher: string): boolean {
  const normalized = matcher.toLowerCase();
  return normalized.endsWith("/")
    ? route.startsWith(normalized)
    : route === normalized || route.startsWith(`${normalized}/`);
}

function isAssistedOrderRoute(route: string): boolean {
  return route === "order/place/list" || route === "order/pay/status" ||
    /^order\/(?:cart\/[^/]+|cart\/(?:add|del|num)\/[^/]+|confirm\/[^/]+|computed\/[^/]+\/[^/]+|coupons\/[^/]+|create\/[^/]+\/[^/]+|pay\/[^/]+)$/.test(route);
}

export function requiredAdminPermission(method: string, routePath: string): string | null {
  const route = normalizeAdminRoute(routePath);
  if (isAssistedOrderRoute(route)) return "order.assisted";
  const group = ADMIN_PERMISSION_GROUPS.find((candidate) =>
    candidate.matches.some((matcher) => matchesRoute(route, matcher)),
  );
  if (!group) return null;
  if (
    group.key === "live_broadcast"
    && (
      new Set([
        "live/room/syncroom",
        "live/goods/syncgoods",
        "live/anchor/syncanchor",
      ]).has(route)
      || /^live\/(?:room|goods|anchor)\/set_show\/[^/]+\/[^/]+$/.test(route)
    )
  ) {
    return "live_broadcast.manage";
  }
  if (
    group.key === "enterprise_wechat"
    && new Set(["work/client/synch", "work/group_chat/synch", "work/synchmember"]).has(route)
  ) {
    return "enterprise_wechat.manage";
  }
  if (
    group.key === "paid_membership"
    && (
      route === "member_card/set_status"
      || route === "member_ship/set_ship_status"
      || route.startsWith("member_batch/set_value/")
    )
  ) {
    // PHP kept these mutations on GET routes. Preserve the URL contract but
    // never let a view-only role mutate membership inventory or catalog state.
    return "paid_membership.manage";
  }
  if (group.key === "activity" && route.startsWith("discounts/set_status/")) {
    // CRMEB exposed this mutation as GET. A view-only role must never be able
    // to change package availability through that compatibility route.
    return "activity.manage";
  }
  if (
    group.key === "order"
    && (route.startsWith("order/wirteoff/records/") || route === "order/order_verific")
  ) {
    // These inherited endpoints are POST, but they only read writeoff state.
    return "order.view";
  }
  if (
    group.key === "order" &&
    (
      route === "order/refund" ||
      route.startsWith("order/refund_agree/") ||
      route.startsWith("order/open/refund/")
    )
  ) {
    // These legacy URLs live under /order, but they decide after-sale state
    // or move funds and therefore require the dedicated refund capability.
    return "refund.manage";
  }
  if (
    group.key === "community"
    && (
      route.startsWith("community/topic/set_status/")
      || route.startsWith("community/topic/set_hot/")
    )
  ) {
    // CRMEB exposed topic mutations as GET routes. Preserve compatibility while
    // still enforcing a write permission server-side.
    return "community.manage";
  }
  const readOnly = method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
  return `${group.key}.${readOnly || !group.manage ? "view" : "manage"}`;
}

export function normalizeRoleRules(value: string | readonly string[] | undefined): string {
  const tokens = splitRuleTokens(value);
  for (const token of tokens) {
    if (!permissionKeys.has(token) && !isNumericToken(token)) {
      throw new ValidateException(`未知权限规则: ${token}`);
    }
  }
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (token.endsWith(".manage")) expanded.add(`${token.slice(0, -7)}.view`);
  }
  const orderedKeys = [...permissionKeys].filter((key) => expanded.has(key));
  const legacyIds = [...expanded]
    .filter(isNumericToken)
    .map(Number)
    .sort((a, b) => a - b)
    .map(String);
  return [...orderedKeys, ...legacyIds].join(",");
}

export function assertDelegablePermissions(
  granted: ReadonlySet<string>,
  requested: Iterable<string>,
): void {
  const excess = [...new Set(requested)].filter((key) => !granted.has(key));
  if (excess.length) {
    throw new ValidateException(`不能授予超出当前管理员范围的权限: ${excess.join(",")}`);
  }
}

function menuPathPermission(menuPath: string): string | null {
  const route = menuPath.trim().toLowerCase();
  const group = ADMIN_PERMISSION_GROUPS.find((candidate) =>
    candidate.path === route || route.includes(candidate.path),
  );
  return group ? `${group.key}.view` : null;
}

export class AdminPermissionService {
  constructor(private readonly container: Container) {}

  permissionTree(): AdminPermissionTreeNode[] {
    return ADMIN_PERMISSION_GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      path: group.path,
      children: [
        { key: `${group.key}.view`, label: "查看" },
        ...(group.manage ? [{ key: `${group.key}.manage`, label: "管理" }] : []),
        ...(group.key === "order" ? [{ key: "order.assisted", label: "代客下单" }] : []),
      ],
    }));
  }

  async resolveAdminPermissionKeys(
    admin: Pick<NonNullable<AppVariables["adminInfo"]>, "level" | "roles">,
  ): Promise<Set<string>> {
    if (admin.level === 0) return new Set(permissionKeys);
    return (await this.resolveRoleAssignment(admin.roles)).keys;
  }

  async resolveRoleAssignment(
    value: string | readonly string[] | undefined,
  ): Promise<{
    keys: Set<string>;
    roleIds: number[];
    missingRoleIds: number[];
    legacyRuleIds: number[];
  }> {
    const roleIds = splitRuleTokens(value).filter(isNumericToken).map(Number);
    if (!roleIds.length) {
      return { keys: new Set(), roleIds: [], missingRoleIds: [], legacyRuleIds: [] };
    }
    const roles = await this.container.db
      .select({ id: systemRole.id, rules: systemRole.rules })
      .from(systemRole)
      .where(and(inArray(systemRole.id, roleIds), eq(systemRole.status, 1)));
    const found = new Set(roles.map((role) => role.id));
    const ruleTokens = roles.flatMap((role) => splitRuleTokens(role.rules));
    return {
      keys: await this.resolveRuleTokens(ruleTokens),
      roleIds,
      missingRoleIds: roleIds.filter((id) => !found.has(id)),
      legacyRuleIds: [...new Set(ruleTokens.filter(isNumericToken).map(Number))],
    };
  }

  async resolveRulePermissionKeys(rules: string | readonly string[]): Promise<string[]> {
    return [...(await this.resolveRuleTokens(splitRuleTokens(rules)))];
  }

  async resolveManyRulePermissionKeys(rulesList: readonly string[]): Promise<string[][]> {
    const tokenSets = rulesList.map((rules) => splitRuleTokens(rules));
    const legacyIds = [...new Set(tokenSets.flat().filter(isNumericToken).map(Number))];
    const menus = legacyIds.length
      ? await this.container.db
          .select({
            id: systemMenus.id,
            apiUrl: systemMenus.apiUrl,
            methods: systemMenus.methods,
            menuPath: systemMenus.menuPath,
            uniqueAuth: systemMenus.uniqueAuth,
          })
          .from(systemMenus)
          .where(
            and(
              inArray(systemMenus.id, legacyIds),
              eq(systemMenus.type, 1),
              eq(systemMenus.authType, 2),
              eq(systemMenus.access, 1),
              eq(systemMenus.isDel, 0),
            ),
          )
      : [];
    return tokenSets.map((tokens) => [...this.resolveTokensWithMenus(tokens, menus)]);
  }

  async assertAuthorized(
    admin: NonNullable<AppVariables["adminInfo"]>,
    method: string,
    routePath: string,
  ): Promise<void> {
    if (admin.level === 0) return;
    // Common header: authenticated financial/product-only roles need not hold
    // dashboard access. The controller independently filters EVERY count by role.
    if (["GET", "HEAD"].includes(method.toUpperCase()) && normalizeAdminRoute(routePath) === "new_push") return;
    const required = requiredAdminPermission(method, routePath);
    if (!required) {
      throw new AuthException("该管理接口尚未登记权限规则", ApiErrorCode.ERR_AUTH);
    }
    const granted = await this.resolveAdminPermissionKeys(admin);
    if (!granted.has(required)) {
      throw new AuthException("暂时没有权限访问", ApiErrorCode.ERR_AUTH);
    }
  }

  buildMenus(keys: ReadonlySet<string>): Array<Record<string, unknown>> {
    return ADMIN_PERMISSION_GROUPS.filter(
      (group) => keys.has(`${group.key}.view`) || keys.has(`${group.key}.manage`),
    ).map((group, index) => ({
      id: index + 1,
      pid: 0,
      path: group.path,
      name: group.label,
      icon: "",
      sort: ADMIN_PERMISSION_GROUPS.length - index,
      type: 1,
      children: [],
    }));
  }

  private async resolveRuleTokens(tokens: readonly string[]): Promise<Set<string>> {
    const legacyIds = tokens.filter(isNumericToken).map(Number);
    const menus = legacyIds.length
      ? await this.container.db
          .select({
            id: systemMenus.id,
            apiUrl: systemMenus.apiUrl,
            methods: systemMenus.methods,
            menuPath: systemMenus.menuPath,
            uniqueAuth: systemMenus.uniqueAuth,
          })
          .from(systemMenus)
          .where(
            and(
              inArray(systemMenus.id, legacyIds),
              eq(systemMenus.type, 1),
              eq(systemMenus.authType, 2),
              eq(systemMenus.access, 1),
              eq(systemMenus.isDel, 0),
            ),
          )
      : [];
    return this.resolveTokensWithMenus(tokens, menus);
  }

  private resolveTokensWithMenus(
    tokens: readonly string[],
    menus: ReadonlyArray<{
      id: number;
      apiUrl: string;
      methods: string;
      menuPath: string;
      uniqueAuth: string;
    }>,
  ): Set<string> {
    const resolved = new Set(tokens.filter((token) => permissionKeys.has(token)));
    const allowedLegacyIds = new Set(tokens.filter(isNumericToken).map(Number));
    if (allowedLegacyIds.size) {
      for (const menu of menus) {
        if (!allowedLegacyIds.has(menu.id)) continue;
        if (permissionKeys.has(menu.uniqueAuth)) {
          resolved.add(menu.uniqueAuth);
          continue;
        }
        const methods = menu.methods.split(/[\s,|]+/).filter(Boolean).map((method) => method.toUpperCase());
        const method = methods.some((candidate) => candidate !== "GET" && candidate !== "HEAD")
          ? "POST"
          : "GET";
        const fromApi = menu.apiUrl ? requiredAdminPermission(method, menu.apiUrl) : null;
        const mapped = fromApi ?? menuPathPermission(menu.menuPath);
        if (mapped) resolved.add(mapped);
      }
    }
    for (const key of [...resolved]) {
      if (key.endsWith(".manage")) resolved.add(`${key.slice(0, -7)}.view`);
    }
    return resolved;
  }
}
