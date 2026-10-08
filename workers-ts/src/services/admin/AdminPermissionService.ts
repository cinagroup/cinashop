import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
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
  { key: "writeoff_order", label: "核销订单", path: "/operations/writeoff-orders",
    matches: ["merchant/verify_order", "merchant/verify/spread_info", "merchant/verify_badge"], manage: false },
  { key: "invoice", label: "发票管理", path: "/order/invoice", matches: ["order/invoices"], manage: true },
  { key: "recharge_order", label: "充值订单", path: "/finance/recharges", matches: ["finance/recharge-orders"], manage: false },
  { key: "commission", label: "佣金记录", path: "/finance/commissions", matches: ["finance/commissions"], manage: false },
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
  { key: "coupon", label: "优惠券管理", path: "/coupon", matches: ["coupon/", "marketing/coupon-issues"], manage: true },
  { key: "coupon_template", label: "优惠券模板", path: "/marketing/coupon-templates", matches: ["marketing/coupon-templates"], manage: true },
  { key: "coupon_template_issue", label: "优惠券模板发布", path: "/marketing/coupon-templates", matches: ["marketing/coupon-template-issues"], manage: true },
  { key: "coupon_record", label: "用户领取记录", path: "/marketing/coupon-records", matches: ["marketing/coupon-records/"], manage: false },
  { key: "seckill_statistics", label: "秒杀统计", path: "/activity/seckill-statistics", matches: ["activity/seckill-statistics/"], manage: false },
  { key: "seckill_time", label: "秒杀时段", path: "/activity/seckill-times", matches: ["activity/seckill-times"], manage: true },
  { key: "seckill_activity", label: "秒杀父活动", path: "/activity/seckill-activities", matches: ["activity/seckill-activities"], manage: true },
  { key: "combination_export", label: "拼团商品导出", path: "/activity/combinations", matches: ["activity/combinations/export"], manage: false },
  { key: "combination_group", label: "全局拼团记录", path: "/activity/combination-groups", matches: ["activity/combination-groups"], manage: false },
  { key: "combination_statistics", label: "拼团统计", path: "/activity/combination-statistics", matches: ["activity/combination-statistics"], manage: false },
  { key: "combination", label: "拼团商品", path: "/activity/combinations", matches: ["activity/combinations"], manage: true },
  { key: "integral_category", label: "积分分类", path: "/marketing/integral-categories", matches: ["marketing/integral-categories"], manage: true },
  { key: "integral_batch", label: "批量添加积分商品", path: "/activity/integral-batch", matches: ["activity/integral-batch"], manage: true },
  { key: "recharge_quota", label: "充值档位", path: "/marketing/recharge-options", matches: ["marketing/recharge-quotas"], manage: true },
  { key: "sign_day_config", label: "签到天数组", path: "/marketing/sign-day-config", matches: ["marketing/sign-day-config"], manage: true },
  { key: "activity_frame", label: "活动边框", path: "/marketing/activity-frame",
    matches: ["marketing/activity-frame", "marketing/activity_frame/"], manage: true },
  { key: "activity_background", label: "活动背景", path: "/marketing/activity-background",
    matches: ["marketing/activity-background", "marketing/activity_background/"], manage: true },
  { key: "time_discount", label: "限时折扣", path: "/marketing/time-discounts",
    matches: ["marketing/time-discounts"], manage: true },
  { key: "full_discount", label: "满减满折", path: "/marketing/full-discounts",
    matches: ["marketing/full-discounts"], manage: true },
  { key: "nth_discount", label: "第N件N折", path: "/marketing/nth-discounts",
    matches: ["marketing/nth-discounts"], manage: true },
  { key: "full_gift", label: "满送活动", path: "/marketing/full-gifts",
    matches: ["marketing/full-gifts"], manage: true },
  {
    key: "activity",
    label: "营销活动",
    path: "/activity",
    matches: ["activity/", "discounts/"],
    manage: true,
  },
  { key: "feedback", label: "客服反馈", path: "/kefu/feedback", matches: ["feedback"], manage: true },
  { key: "speechcraft", label: "客服话术", path: "/kefu/speechcraft", matches: ["wechat/speechcraft"], manage: true },
  { key: "service", label: "客服会话", path: "/kefu", matches: ["service/", "api/ws/kefu"], manage: true },
  { key: "reply", label: "商品评价", path: "/reply", matches: ["reply/"], manage: true },
  { key: "community", label: "社区运营", path: "/community", matches: ["community/"], manage: true },
  {
    key: "attachment",
    label: "素材中心",
    path: "/assets",
    matches: ["file/file", "file/upload", "file/upload_type", "file/category", "config/storage", "assets", "asset-categories"],
    manage: true,
  },
  { key: "shipping_settings", label: "发货设置", path: "/setting/shipping", matches: ["config/shipping"], manage: true },
  { key: 'city_delivery_settings', label: '同城配送设置', path: '/setting/city-delivery-settings', matches: ['config/city-delivery'], manage: true },
  { key: "city_delivery_record", label: "同城配送记录", path: "/setting/city-delivery-records",
    matches: ["city_delivery/records", "city_delivery/stores"], manage: false },
  { key: "pc_home_banner", label: "PC首页轮播", path: "/setting/pc-banner",
    matches: ["setting/pc-banners"], manage: true },
  { key: "fab_settings", label: "悬浮按钮", path: "/setting/fab",
    matches: ["setting/fab"], manage: true },
  { key: "theme_settings", label: "主题风格", path: "/setting/theme-style",
    matches: ["setting/theme-style"], manage: true },
  { key: 'product_category_style', label: '商品分类页面', path: '/setting/product-category-style', matches: ['config/product-category-style'], manage: true },
  { key: 'product_detail_design', label: '商品详情页面', path: '/setting/product-detail-design', matches: ['config/product-detail-design'], manage: true },
  { key: 'user_center_design', label: '个人中心页面', path: '/setting/user-center-design', matches: ['config/user-center-design'], manage: true },
  { key: "config", label: "系统配置", path: "/config", matches: ["config/", "config_class", "config_class/", "form/", "setting/", "sms/", "erp/config"], manage: true },
  { key: "print", label: "小票打印", path: "/setting/print", matches: ["print/"], manage: true },
  { key: "waybill", label: "电子面单", path: "/setting/waybill", matches: ["waybill/"], manage: true },
  { key: "supplier_application", label: "供应商入驻", path: "/supplier/applications", matches: ["supplier/apply/", "supplier/applications"], manage: true },
  { key: "supplier_menu_rules", label: "供应商菜单规则", path: "/supplier/menu-rules", matches: ["supplier/menu-rules"], manage: true },
  { key: "supplier_directory", label: "供应商目录", path: "/supplier/directory", matches: ["supplier/supplier"], manage: true },
  { key: "supplier_order_statistics", label: "供应商订单统计", path: "/supplier/order-statistics",
    matches: ["supplier/order-statistics-screen/"], manage: false },
  { key: "supplier_capital", label: "供应商资金流水", path: "/supplier/capital-flow",
    matches: ["supplier/capital-screen/"], manage: true },
  { key: "supplier_bill", label: "供应商账单", path: "/supplier/bills",
    matches: ["supplier/bill-screen/"], manage: false },
  { key: "system", label: "管理员与角色", path: "/system", matches: ["system_admin/", "system_role/", "system_menus/"], manage: true },
  { key: "extract", label: "提现审核", path: "/finance/extract", matches: ["extract/"], manage: true },
  { key: "supplier_extract", label: "供应商提现", path: "/finance/supplier-extract", matches: ["supplier/extract/"], manage: true },
  { key: "bill", label: "资金记录", path: "/finance/bill", matches: ["bill/", "finance/user-money-ledger"], manage: false },
  { key: "integral_log", label: "积分日志", path: "/marketing/user-point", matches: ["marketing/user-point/"], manage: false },
  { key: "point_statistic", label: "积分统计", path: "/marketing/point-statistic", matches: ["marketing/point/"], manage: false },
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
  { key: "lottery_record", label: "抽奖记录", path: "/marketing/lottery-records", matches: ["lottery/record/"], manage: true },
  { key: "lottery", label: "抽奖活动", path: "/marketing/lottery", matches: ["lottery/"], manage: true },
  { key: "log", label: "操作日志", path: "/system/log", matches: ["log/"], manage: false },
  {
    key: "agent_level", label: "分销等级", path: "/setting/distributor-levels",
    matches: ["agent/levels", "agent/level"], manage: true,
  },
  {
    key: "agent_level_task", label: "分销等级任务", path: "/setting/distributor-levels/tasks",
    matches: ["agent/level-tasks", "agent/level_task"], manage: true,
  },
  {
    key: "distribution",
    label: "分销管理",
    path: "/agent",
    matches: ["spread/", "brokerage/", "promoter/"],
    manage: true,
  },
  { key: "agent_agreement", label: "推广员协议", path: "/agent/agreement",
    matches: ["agent/get_agent_agreement", "agent/set_agent_agreement/"], manage: true },
  {
    key: "division_statistics",
    label: "事业部统计",
    path: "/division/statistics",
    matches: ["agent/division/statistics-screen/"],
    manage: false,
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
permissionKeys.add("integral_log.export");
permissionKeys.add("bill.export");
permissionKeys.add("system.legacy_admin_view");
permissionKeys.add("system.legacy_role_view");
permissionKeys.add("system.legacy_role_form_view");
permissionKeys.add("system.legacy_role_manage");

/** Canonical grants cover narrower legacy contracts; legacy grants stay within their own workflow. */
export function hasAdminPermission(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) return true;
  if (required === "system.legacy_role_manage") return granted.has("system.manage");
  if (["system.legacy_role_view", "system.legacy_role_form_view"].includes(required)
    && granted.has("system.legacy_role_manage")) return true;
  return ["system.legacy_admin_view", "system.legacy_role_view", "system.legacy_role_form_view"].includes(required)
    && granted.has("system.view");
}

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
  if (/^order\/form_image\/[^/]+\/[^/]+$/.test(route)) return true;
  if (/^order\/form_preview\/[^/]+\/[^/]+$/.test(route)) return true;
  if (/^order\/form\/[^/]+\/[^/]+$/.test(route)) return true;
  return route === "order/place/list" || /^order\/place\/detail\/[^/]+$/.test(route) || route === "order/pay/status" ||
    /^order\/(?:cart\/[^/]+|cart\/(?:add|del|num)\/[^/]+|confirm\/[^/]+|computed\/[^/]+\/[^/]+|coupons\/[^/]+|create\/[^/]+\/[^/]+|pay\/[^/]+)$/.test(route);
}

export function isAdminAuthorityRecoveryRoute(method:string,routePath:string):boolean {
  const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^system\/authority\/receipt\/[^/]+$/.test(route))
    || (verb==='POST' && route==='system/authority/resolve');
}

export function requiredAdminPermission(method: string, routePath: string): string | null {
  const route = normalizeAdminRoute(routePath);
  // Only authenticated owners may recover their own immutable operation key.
  // Recovery service admits live identity independently of current role grants.
  if (method.toUpperCase()==='POST' && ['system/authority/preview','system/authority/commit'].includes(route)) return 'system.manage';
  if (isAdminAuthorityRecoveryRoute(method,routePath)) return null;
  // Legacy staff authority lives under setting/, but is independent of runtime
  // configuration. Its lists and numeric role form/save have separate grants.
  // Other legacy writes do not grant config access or authority over modern writes.
  if (/^setting\/(?:admin(?:\/|$)|role(?:\/|$)|set_status(?:\/|$))/.test(route)) {
    if (["GET", "HEAD"].includes(method.toUpperCase())) {
      if (route === "setting/admin") return "system.legacy_admin_view";
      if (route === "setting/role") return "system.legacy_role_view";
      if (route === "setting/role/create" || /^setting\/role\/(?::id|[1-9]\d*)\/edit$/.test(route)) return "system.legacy_role_form_view";
    }
    if (method.toUpperCase() === "POST" && /^setting\/role\/(?::id|0|[1-9]\d*)$/.test(route)) return "system.legacy_role_manage";
    return null;
  }
  // Legacy quick-login is a separate impersonation capability, never a
  // directory read. No such handoff route is enabled yet.
  if (/^supplier\/supplier\/login\/[^/]+$/.test(route)) return null;
  // Claimant identities retain the existing independent history capability.
  if (["GET", "HEAD"].includes(method.toUpperCase()) && /^marketing\/coupon-issues\/[^/]+\/claims$/.test(route)) return "coupon_record.view";
  // Record detail exposes the existing shipping carrier and tracking number
  // needed by the fulfillment editor; the records list remains view-only.
  if (["GET", "HEAD"].includes(method.toUpperCase()) && /^lottery\/record\/detail\/[^/]+$/.test(route)) return "lottery_record.manage";
  // The old export-userPoint action was a separate menu grant. Keep that
  // capability independent from the point-log page's read permission.
  if (["GET", "HEAD"].includes(method.toUpperCase()) && ["marketing/user-point/export", "export/userpoint"].includes(route)) return "integral_log.export";
  // The old finance menu separated list/type reads from export/userFinance.
  // Keep its numeric grants usable without granting exports to bill viewers.
  if (["GET", "HEAD"].includes(method.toUpperCase()) && ["finance/user-money-ledger/export", "export/userfinance"].includes(route)) return "bill.export";
  if (["GET", "HEAD"].includes(method.toUpperCase()) && ["finance/finance/list", "finance/finance/bill_type"].includes(route)) return "bill.view";
  // The PHP compatibility URL mutates promotion state despite using GET.
  if (/^marketing\/activity_frame\/set_status\/[^/]+\/[^/]+$/.test(route)) return "activity_frame.manage";
  if (/^marketing\/activity_background\/set_status\/[^/]+\/[^/]+$/.test(route)) return "activity_background.manage";
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
  if (group.key === "config" && /^form\/set_show\/[^/]+\/[^/]+$/.test(route)) {
    // Keep the legacy GET status mutation behind the same capability as PUT.
    return "config.manage";
  }
  if (group.key === "activity" && route.startsWith("discounts/set_status/")) {
    // CRMEB exposed this mutation as GET. A view-only role must never be able
    // to change package availability through that compatibility route.
    return "activity.manage";
  }
  if (
    group.key === "distribution"
    && /^promoter\/apply\/examine\/[^/]+\/[^/]+\/[^/]+$/.test(route)
  ) {
    // The legacy review URL mutates application state despite using GET.
    return "distribution.manage";
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
    if (token === "system.legacy_role_manage") {
      expanded.add("system.legacy_role_view");
      expanded.add("system.legacy_role_form_view");
    }
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
  const excess = [...new Set(requested)].filter((key) => !hasAdminPermission(granted, key));
  if (excess.length) {
    throw new ValidateException(`不能授予超出当前管理员范围的权限: ${excess.join(",")}`);
  }
}

function menuPathPermission(menuPath: string): string | null {
  const route = menuPath.trim().toLowerCase();
  if (route === "/admin/setting/system_admin/index") return "system.legacy_admin_view";
  if (route === "/admin/setting/system_role/index") return "system.legacy_role_view";
  if(route==='/admin/setting/membership_level/index')return 'agent_level.view';
  if (route === "/admin/statistic/capital") return "capital_flow.view";
  if (route === "/admin/agent/statistics") return "division_statistics.view";
  if (route === "/admin/supplier/orderstatistics/index") return "supplier_order_statistics.view";
  if (route === "/admin/supplier/capital/index") return "supplier_capital.view";
  if (route === "/admin/supplier/cash/index") return "supplier_extract.view";
  if (route === "/admin/supplier/apply") return "supplier_application.view";
  if (route === "/admin/supplier/supplier/index") return "supplier_menu_rules.view";
  if (route === "/admin/supplier/menu/list") return "supplier_directory.view";
  if (route === "/admin/agent/agreement") return "agent_agreement.view";
  if (route === "/admin/marketing/lottery/recording_list") return "lottery_record.view";
  if (route === "/admin/marketing/integral/signin") return "sign_day_config.view";
  if (route === "/admin/setting/distribution/deliver") return "shipping_settings.view";
  if (route === "/admin/setting/city/delivery/record") return "city_delivery_record.view";
  if (route === '/admin/setting/city/delivery/setting') return 'city_delivery_settings.view';
  if (route === "/admin/setting/pages/fab") return "fab_settings.view";
  if (route === "/admin/setting/theme_style") return "theme_settings.view";
  if (route === '/admin/setting/pages/product_category') return 'product_category_style.view';
  if (route === '/admin/setting/pages/product_detail') return 'product_detail_design.view';
  if (route === '/admin/setting/pages/home') return 'user_center_design.view';
  if (/^\/admin\/setting\/system_group_data\/pc\/[^/]+$/.test(route)) return "pc_home_banner.view";
  if (route === "/admin/marketing/activity_frame") return "activity_frame.view";
  if (/^\/admin\/marketing\/activity_frame\/create(?:\/[^/]+)?$/.test(route)) return "activity_frame.manage";
  if (route === "/admin/marketing/activity_background") return "activity_background.view";
  if (route === "/admin/marketing/discount/list") return "time_discount.view";
  if (/^\/admin\/marketing\/discount\/add(?:\/[^/]+)?$/.test(route)) return "time_discount.manage";
  if (route === "/admin/marketing/discount/full_discount") return "full_discount.view";
  if (/^\/admin\/marketing\/discount\/add_discount(?:\/[^/]+)?$/.test(route)) return "full_discount.manage";
  if (route === "/admin/marketing/discount/pieces_discount") return "nth_discount.view";
  if (/^\/admin\/marketing\/discount\/add_pieces(?:\/[^/]+)?$/.test(route)) return "nth_discount.manage";
  if (route === "/admin/marketing/discount/give") return "full_gift.view";
  if (/^\/admin\/marketing\/discount\/add_give(?:\/[^/]+)?$/.test(route)) return "full_gift.manage";
  if (/^\/admin\/marketing\/activity_background\/create(?:\/[^/]+)?$/.test(route)) return "activity_background.manage";
  if (route === "/admin/setting/store_service/feedback") return "feedback.view";
  if (route === "/admin/setting/store_service/speechcraft") return "speechcraft.view";
  if (route === "/admin/finance/finance/bill") return "bill.view";
  if (/^\/admin\/supplier\/bill\/index(?:\/[^/]+)?$/.test(route)) return "supplier_bill.view";
  if (["/marketing/coupon-templates", "/admin/marketing/store_coupon/index"].includes(route)) return "coupon_template.view";
  if (/^\/admin\/marketing\/store_coupon_issue\/(?:index|create(?:\/[^/]+)?)$/.test(route)) return "coupon.view";
  const group = ADMIN_PERMISSION_GROUPS.find((candidate) =>
    // Export is an explicit capability on the catalog page. A legacy page
    // fallback must retain catalog access rather than silently grant export.
    !["combination_export", "coupon_template_issue"].includes(candidate.key) && (candidate.path === route || route.includes(candidate.path)),
  );
  return group ? `${group.key}.view` : null;
}

/** These identities have an audited binding. A rejected binding cannot become
 * an opaque grant merely because it resolves to no current permission keys. */
const auditedLegacyMenuIds = new Set([1035, 1075, 1490, 1592, 1593, 1594]);
const auditedLegacyPageAuth = new Set([
  'setting-system-list', 'setting-system-role', 'admin-statistic-capital',
  'agent-division-statistics', 'admin-supplier-supplier_list', 'admin-supplier-capital-index',
  'admin-supplier-cash-index', 'admin-supplier-apply', 'admin-supplier-menu-list', 'agent-agreement',
  'admin-supplier-supplier-index', 'admin-supplier-bill-index',
  'admin-marketing-lottery-recording_list', 'marketing-integral-sign',
  'setting-distribution-deliver', 'setting-city-delivery-record', 'setting-city-delivery-setting',
  'admin-setting-pages-home', 'admin-setting-pages-product_category', 'admin-setting-pages-product_detail',
  'setting-system-fab', 'admin-setting-theme_style', '/admin/setting/membership_level/index',
  'setting-system-group_data-pc', 'admin-marketing-activity_frame', 'marketing-activity_frame-create',
  'admin-marketing-activity_background', 'marketing-activity_background-create',
  'marketing-discount-list', 'marketing-discount-add', 'marketing-discount-full_discount',
  'marketing-discount-add_discount', 'marketing-discount-pieces_discount',
  'marketing-discount-add_pieces', 'marketing-discount-give', 'marketing-discount-add_give',
  'marketing-store_integral-create', 'admin-setting-store_service-feedback',
  'admin-setting-store_service-speechcraft', 'finance-finance-bill',
]);

export function canRetainOpaqueLegacyMenu(menu: Pick<typeof systemMenus.$inferSelect,
  'id' | 'authType' | 'apiUrl' | 'methods' | 'menuPath' | 'uniqueAuth'>): boolean {
  if (auditedLegacyMenuIds.has(menu.id) || permissionKeys.has(menu.uniqueAuth)
    || auditedLegacyPageAuth.has(menu.uniqueAuth) || menuPathPermission(menu.menuPath)) return false;
  // The membership-level page has a paired page-only policy outside the usual
  // path mapping. Integral batch is an exact legacy API tuple too.
  if (menu.menuPath === '/admin/setting/membership_level/index'
    || normalizeAdminRoute(menu.apiUrl) === 'marketing/integral/batch') return false;
  if (menu.authType === 1) return !!menu.menuPath.trim() && !menu.apiUrl.trim();
  if (menu.authType !== 2 || !menu.apiUrl.trim()) return false;
  const methods = menu.methods.split(/[\s,|]+/).filter(Boolean).map(method => method.toUpperCase());
  return methods.length > 0
    && methods.every(method => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method))
    && methods.every(method => !requiredAdminPermission(method, menu.apiUrl));
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
        ...(group.key === "integral_log" ? [{ key: "integral_log.export", label: "导出" }] : []),
        ...(group.key === "bill" ? [{ key: "bill.export", label: "导出" }] : []),
        ...(group.key === "system" ? [
          { key: "system.legacy_admin_view", label: "旧管理员列表（下一层级）" },
          { key: "system.legacy_role_view", label: "旧角色列表（下一层级）" },
          { key: "system.legacy_role_form_view", label: "旧角色表单（下一层级）" },
          { key: "system.legacy_role_manage", label: "旧角色保存（下一层级）" },
        ] : []),
      ],
    }));
  }

  async resolveAdminPermissionKeys(
    admin: Pick<NonNullable<AppVariables["adminInfo"]>, "level" | "roles">,
  ): Promise<Set<string>> {
    if (admin.level === 0) return new Set(permissionKeys);
    return (await this.resolveRoleAssignment(admin.roles)).keys;
  }

  /** Same rule semantics as single-account reads, with one role/menu query for bounded fan-out. */
  async resolveManyAdminPermissionKeys(admins: ReadonlyArray<Pick<NonNullable<AppVariables["adminInfo"]>, "level" | "roles">>): Promise<Set<string>[]> {
    const assignments = admins.map((admin) => admin.level === 0 ? [] : splitRuleTokens(admin.roles).filter(isNumericToken).map(Number));
    const ids = [...new Set(assignments.flat())];
    if (ids.length > 10000) throw new ValidateException("通知角色数量超出单批上限");
    const roles = ids.length ? await this.container.db.select({ id: systemRole.id, rules: systemRole.rules }).from(systemRole)
      .where(and(inArray(systemRole.id, ids), eq(systemRole.status, 1),
        inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0))) : [];
    const keys = await this.resolveManyRulePermissionKeys(roles.map((role) => role.rules));
    const byRole = new Map(roles.map((role, index) => [role.id, keys[index]]));
    return admins.map((admin, index) => admin.level === 0 ? new Set(permissionKeys)
      : new Set(assignments[index].flatMap((id) => byRole.get(id) ?? [])));
  }

  async resolveRoleAssignment(
    value: string | readonly string[] | undefined,
    lockForDecision = false,
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
    const roleQuery = this.container.db
      .select({ id: systemRole.id, rules: systemRole.rules })
      .from(systemRole)
      .where(and(inArray(systemRole.id, roleIds), eq(systemRole.status, 1),
        inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0)));
    const roles = lockForDecision ? await roleQuery.orderBy(asc(systemRole.id)).for("share", { noWait: true }) : await roleQuery;
    const found = new Set(roles.map((role) => role.id));
    const ruleTokens = roles.flatMap((role) => splitRuleTokens(role.rules));
    return {
      keys: await this.resolveRuleTokens(ruleTokens, lockForDecision),
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
            authType: systemMenus.authType,
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
              or(eq(systemMenus.authType, 2), and(eq(systemMenus.authType, 1), or(
                and(eq(systemMenus.uniqueAuth, "setting-system-list"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system-role"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/index")),
                and(eq(systemMenus.uniqueAuth, "admin-statistic-capital"),
                  eq(systemMenus.menuPath, "/admin/statistic/capital")),
                and(eq(systemMenus.uniqueAuth, "agent-division-statistics"),
                  eq(systemMenus.menuPath, "/admin/agent/statistics")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-bill-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/bill/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-capital-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/capital/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-cash-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/cash/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-supplier_list"),
                  eq(systemMenus.menuPath, "/admin/supplier/orderStatistics/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-apply"),
                  eq(systemMenus.menuPath, "/admin/supplier/apply")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-supplier-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/supplier/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-menu-list"),
                  eq(systemMenus.menuPath, "/admin/supplier/menu/list")),
                and(eq(systemMenus.uniqueAuth, "agent-agreement"),
                  eq(systemMenus.menuPath, "/admin/agent/agreement")),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-lottery-recording_list"),
                  eq(systemMenus.menuPath, "/admin/marketing/lottery/recording_list")),
                and(eq(systemMenus.uniqueAuth, "marketing-integral-sign"),
                  eq(systemMenus.menuPath, "/admin/marketing/integral/signIn")),
                and(eq(systemMenus.uniqueAuth, "setting-distribution-deliver"),
                  eq(systemMenus.menuPath, "/admin/setting/distribution/deliver")),
                and(eq(systemMenus.uniqueAuth, "setting-city-delivery-record"),
                  eq(systemMenus.menuPath, "/admin/setting/city/delivery/record")),
                and(eq(systemMenus.id, 1490), eq(systemMenus.uniqueAuth, 'setting-city-delivery-setting'), eq(systemMenus.menuPath, '/admin/setting/city/delivery/setting')),
                and(eq(systemMenus.id, 1593), eq(systemMenus.uniqueAuth, 'admin-setting-pages-product_category'), eq(systemMenus.menuPath, '/admin/setting/pages/product_category')),
                and(eq(systemMenus.id, 1594), eq(systemMenus.uniqueAuth, 'admin-setting-pages-product_detail'), eq(systemMenus.menuPath, '/admin/setting/pages/product_detail')),
                and(eq(systemMenus.id, 1592), eq(systemMenus.uniqueAuth, 'admin-setting-pages-home'), eq(systemMenus.menuPath, '/admin/setting/pages/home')),
                and(eq(systemMenus.uniqueAuth, "setting-system-fab"),
                  eq(systemMenus.menuPath, "/admin/setting/pages/fab")),
                and(inArray(systemMenus.id, [1035, 1075]), eq(systemMenus.uniqueAuth, "admin-setting-theme_style"),
                  eq(systemMenus.menuPath, "/admin/setting/theme_style")),
                and(eq(systemMenus.uniqueAuth, "/admin/setting/membership_level/index"),
                  eq(systemMenus.menuPath, "/admin/setting/membership_level/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system-group_data-pc"),
                  sql`${systemMenus.menuPath} ~ '^/admin/setting/system_group_data/pc/([1-9][0-9]*|:id)$'`),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-activity_frame"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_frame")),
                and(eq(systemMenus.uniqueAuth, "marketing-activity_frame-create"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_frame/create")),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-activity_background"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_background")),
                and(eq(systemMenus.uniqueAuth, "marketing-activity_background-create"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_background/create")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-list"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/list")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-full_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/full_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-pieces_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/pieces_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_pieces"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_pieces")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-give"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/give")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_give"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_give")),
                and(eq(systemMenus.uniqueAuth, "marketing-store_integral-create"),
                  inArray(systemMenus.menuPath, ["/pages/marketing/store_integral/add_store_integral", "/admin/marketing/store_integral/add_store_integral"])),
                and(eq(systemMenus.uniqueAuth, "admin-setting-store_service-feedback"),
                  eq(systemMenus.menuPath, "/admin/setting/store_service/feedback")),
                and(eq(systemMenus.uniqueAuth, "admin-setting-store_service-speechcraft"),
                  eq(systemMenus.menuPath, "/admin/setting/store_service/speechcraft")),
                and(eq(systemMenus.uniqueAuth, "finance-finance-bill"),
                  eq(systemMenus.menuPath, "/admin/finance/finance/bill")),
              ))),
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
    // Auth middleware has authenticated the account. The recovery service
    // repeats live realm/status/password checks and binds the receipt owner;
    // these two exact endpoints never perform a staff/role mutation.
    if (isAdminAuthorityRecoveryRoute(method,routePath)) return;
    if (admin.level === 0) return;
    // Common header: authenticated financial/product-only roles need not hold
    // dashboard access. The controller independently filters EVERY count by role.
    if (["GET", "HEAD"].includes(method.toUpperCase()) && normalizeAdminRoute(routePath) === "new_push") return;
    const required = requiredAdminPermission(method, routePath);
    if (!required) {
      throw new AuthException("该管理接口尚未登记权限规则", ApiErrorCode.ERR_AUTH);
    }
    const granted = await this.resolveAdminPermissionKeys(admin);
    if (!hasAdminPermission(granted, required)) {
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
      children: group.key === "distribution" ? [{
        id: 10_000 + index,
        pid: index + 1,
        path: "/agent/promoter-applications",
        name: "分销员申请",
        icon: "",
        sort: 0,
        type: 1,
        children: [],
      }] : [],
    }));
  }

  private async resolveRuleTokens(tokens: readonly string[], lockForDecision = false): Promise<Set<string>> {
    const legacyIds = tokens.filter(isNumericToken).map(Number);
    const menuQuery = this.container.db
          .select({
            id: systemMenus.id,
            authType: systemMenus.authType,
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
              or(eq(systemMenus.authType, 2), and(eq(systemMenus.authType, 1), or(
                and(eq(systemMenus.uniqueAuth, "setting-system-list"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system-role"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/index")),
                and(eq(systemMenus.uniqueAuth, "admin-statistic-capital"),
                  eq(systemMenus.menuPath, "/admin/statistic/capital")),
                and(eq(systemMenus.uniqueAuth, "agent-division-statistics"),
                  eq(systemMenus.menuPath, "/admin/agent/statistics")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-bill-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/bill/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-capital-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/capital/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-cash-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/cash/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-supplier_list"),
                  eq(systemMenus.menuPath, "/admin/supplier/orderStatistics/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-apply"),
                  eq(systemMenus.menuPath, "/admin/supplier/apply")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-supplier-index"),
                  eq(systemMenus.menuPath, "/admin/supplier/supplier/index")),
                and(eq(systemMenus.uniqueAuth, "admin-supplier-menu-list"),
                  eq(systemMenus.menuPath, "/admin/supplier/menu/list")),
                and(eq(systemMenus.uniqueAuth, "agent-agreement"),
                  eq(systemMenus.menuPath, "/admin/agent/agreement")),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-lottery-recording_list"),
                  eq(systemMenus.menuPath, "/admin/marketing/lottery/recording_list")),
                and(eq(systemMenus.uniqueAuth, "marketing-integral-sign"),
                  eq(systemMenus.menuPath, "/admin/marketing/integral/signIn")),
                and(eq(systemMenus.uniqueAuth, "setting-distribution-deliver"),
                  eq(systemMenus.menuPath, "/admin/setting/distribution/deliver")),
                and(eq(systemMenus.uniqueAuth, "setting-city-delivery-record"),
                  eq(systemMenus.menuPath, "/admin/setting/city/delivery/record")),
                and(eq(systemMenus.id, 1490), eq(systemMenus.uniqueAuth, 'setting-city-delivery-setting'), eq(systemMenus.menuPath, '/admin/setting/city/delivery/setting')),
                and(eq(systemMenus.id, 1593), eq(systemMenus.uniqueAuth, 'admin-setting-pages-product_category'), eq(systemMenus.menuPath, '/admin/setting/pages/product_category')),
                and(eq(systemMenus.id, 1594), eq(systemMenus.uniqueAuth, 'admin-setting-pages-product_detail'), eq(systemMenus.menuPath, '/admin/setting/pages/product_detail')),
                and(eq(systemMenus.id, 1592), eq(systemMenus.uniqueAuth, 'admin-setting-pages-home'), eq(systemMenus.menuPath, '/admin/setting/pages/home')),
                and(eq(systemMenus.uniqueAuth, "setting-system-fab"),
                  eq(systemMenus.menuPath, "/admin/setting/pages/fab")),
                and(inArray(systemMenus.id, [1035, 1075]), eq(systemMenus.uniqueAuth, "admin-setting-theme_style"),
                  eq(systemMenus.menuPath, "/admin/setting/theme_style")),
                and(eq(systemMenus.uniqueAuth, "/admin/setting/membership_level/index"),
                  eq(systemMenus.menuPath, "/admin/setting/membership_level/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system-group_data-pc"),
                  sql`${systemMenus.menuPath} ~ '^/admin/setting/system_group_data/pc/([1-9][0-9]*|:id)$'`),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-activity_frame"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_frame")),
                and(eq(systemMenus.uniqueAuth, "marketing-activity_frame-create"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_frame/create")),
                and(eq(systemMenus.uniqueAuth, "admin-marketing-activity_background"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_background")),
                and(eq(systemMenus.uniqueAuth, "marketing-activity_background-create"),
                  eq(systemMenus.menuPath, "/admin/marketing/activity_background/create")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-list"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/list")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-full_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/full_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-pieces_discount"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/pieces_discount")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_pieces"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_pieces")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-give"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/give")),
                and(eq(systemMenus.uniqueAuth, "marketing-discount-add_give"),
                  eq(systemMenus.menuPath, "/admin/marketing/discount/add_give")),
                and(eq(systemMenus.uniqueAuth, "marketing-store_integral-create"),
                  inArray(systemMenus.menuPath, ["/pages/marketing/store_integral/add_store_integral", "/admin/marketing/store_integral/add_store_integral"])),
                and(eq(systemMenus.uniqueAuth, "admin-setting-store_service-feedback"),
                  eq(systemMenus.menuPath, "/admin/setting/store_service/feedback")),
                and(eq(systemMenus.uniqueAuth, "admin-setting-store_service-speechcraft"),
                  eq(systemMenus.menuPath, "/admin/setting/store_service/speechcraft")),
                and(eq(systemMenus.uniqueAuth, "finance-finance-bill"),
                  eq(systemMenus.menuPath, "/admin/finance/finance/bill")),
              ))),
              eq(systemMenus.access, 1),
              eq(systemMenus.isDel, 0),
            ),
          );
    const menus = legacyIds.length
      ? lockForDecision ? await menuQuery.orderBy(asc(systemMenus.id)).for("share", { noWait: true }) : await menuQuery
      : [];
    return this.resolveTokensWithMenus(tokens, menus);
  }

  private resolveTokensWithMenus(
    tokens: readonly string[],
    menus: ReadonlyArray<{
      id: number;
      authType: number;
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
        if (menu.id === 1592 || menu.menuPath === '/admin/setting/pages/home' || menu.uniqueAuth === 'admin-setting-pages-home') {
          if (menu.id === 1592 && menu.authType === 1 && menu.menuPath === '/admin/setting/pages/home' && menu.uniqueAuth === 'admin-setting-pages-home') resolved.add('user_center_design.view');
          continue;
        }
        if (menu.uniqueAuth === 'user_center_design.view' || menu.uniqueAuth === 'user_center_design.manage'
          || (menu.apiUrl && requiredAdminPermission('POST', menu.apiUrl)?.startsWith('user_center_design.'))) continue;
        if (menu.id === 1594 || menu.menuPath === '/admin/setting/pages/product_detail' || menu.uniqueAuth === 'admin-setting-pages-product_detail') {
          if (menu.id === 1594 && menu.authType === 1 && menu.menuPath === '/admin/setting/pages/product_detail' && menu.uniqueAuth === 'admin-setting-pages-product_detail') resolved.add('product_detail_design.view');
          continue;
        }
        if (menu.uniqueAuth === 'product_detail_design.view' || menu.uniqueAuth === 'product_detail_design.manage'
          || (menu.apiUrl && requiredAdminPermission('POST', menu.apiUrl)?.startsWith('product_detail_design.'))) continue;
        if (menu.id === 1593 || menu.menuPath === '/admin/setting/pages/product_category' || menu.uniqueAuth === 'admin-setting-pages-product_category') {
          if (menu.id === 1593 && menu.authType === 1 && menu.menuPath === '/admin/setting/pages/product_category' && menu.uniqueAuth === 'admin-setting-pages-product_category') resolved.add('product_category_style.view');
          continue;
        }
        if (menu.uniqueAuth === 'product_category_style.view' || menu.uniqueAuth === 'product_category_style.manage'
          || (menu.apiUrl && requiredAdminPermission('POST', menu.apiUrl)?.startsWith('product_category_style.'))) continue;
        if (menu.id === 1490 || menu.menuPath === '/admin/setting/city/delivery/setting' || menu.uniqueAuth === 'setting-city-delivery-setting') {
          if (menu.id === 1490 && menu.authType === 1 && menu.menuPath === '/admin/setting/city/delivery/setting' && menu.uniqueAuth === 'setting-city-delivery-setting') resolved.add('city_delivery_settings.view');
          continue;
        }
        if (menu.uniqueAuth === 'city_delivery_settings.view' || menu.uniqueAuth === 'city_delivery_settings.manage'
          || (menu.apiUrl && requiredAdminPermission('POST', menu.apiUrl)?.startsWith('city_delivery_settings.'))) continue;
        // Only the two proved theme page menus confer this read authority.
        // PC menu 1036 and action-shaped/forged pairs cannot grant it.
        if ([1035, 1075].includes(menu.id) || menu.menuPath === "/admin/setting/theme_style" || menu.uniqueAuth === "admin-setting-theme_style") {
          if ([1035, 1075].includes(menu.id) && menu.authType === 1 && menu.menuPath === "/admin/setting/theme_style"
            && menu.uniqueAuth === "admin-setting-theme_style") resolved.add("theme_settings.view");
          continue;
        }
        // No legacy action/menu row has been proved to grant the new writer.
        // This includes empty-auth API 1280/1281 and PC menu 1036. Management
        // requires the explicit modern rule token, already resolved above.
        if (menu.uniqueAuth === "theme_settings.view" || menu.uniqueAuth === "theme_settings.manage"
          || (menu.apiUrl && requiredAdminPermission("POST", menu.apiUrl)?.startsWith("theme_settings."))) continue;
        // The old FAB page menu is a read grant. Its path and auth string must
        // match together; neither an unrelated page nor a forged action grants it.
        if (menu.menuPath === "/admin/setting/pages/fab" || menu.uniqueAuth === "setting-system-fab") {
          if (menu.authType === 1 && menu.menuPath === "/admin/setting/pages/fab" && menu.uniqueAuth === "setting-system-fab") {
            resolved.add("fab_settings.view");
          }
          continue;
        }
        if (menu.authType === 1) {
          // Seed 972 is the single legacy grade/task page. Task action rules
          // remain independent and cannot grant full grade catalog access.
          if(menu.menuPath==='/admin/setting/membership_level/index' || menu.uniqueAuth==='/admin/setting/membership_level/index') {
            if(menu.menuPath==='/admin/setting/membership_level/index' && menu.uniqueAuth==='/admin/setting/membership_level/index') {
              resolved.add('agent_level.view');resolved.add('agent_level_task.view');
            }
            continue;
          }
          // Seed menu 931 and batch menu 933 share this old auth string. Only
          // the exact batch page pair can authorize the independent writer.
          if (menu.uniqueAuth === "marketing-store_integral-create" && [
            "/pages/marketing/store_integral/add_store_integral", "/admin/marketing/store_integral/add_store_integral",
          ].includes(menu.menuPath)) {
            resolved.add("integral_batch.manage");
            continue;
          }
          // Audited page-only legacy rules map to their independent read grants.
          const mapped = menuPathPermission(menu.menuPath);
          if (mapped) resolved.add(mapped);
          continue;
        }
        // The legacy batch API has no unique_auth/menu_path. Match its actual
        // POST tuple before any generic auth string or page fallback; single
        // product creation and a GET with the same URL never grant bulk writes.
        if (normalizeAdminRoute(menu.apiUrl) === "marketing/integral/batch") {
          if (menu.authType === 2 && menu.methods.trim().toUpperCase() === "POST" && menu.uniqueAuth === "" && menu.menuPath === "") {
            resolved.add("integral_batch.manage");
          }
          continue;
        }
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
      if (key === "system.legacy_role_manage") {
        resolved.add("system.legacy_role_view");
        resolved.add("system.legacy_role_form_view");
      }
    }
    return resolved;
  }
}
