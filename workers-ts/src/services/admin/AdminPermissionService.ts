import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { AppVariables } from "@/env";
import type { Container } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { ApiErrorCode, AuthException, ValidateException } from "@/utils/errors";
import { pcBaseMenuBinding, pcBasePermissionsFromMenus } from './AdminPcBasePermissionBinding';
import { wechatAppMenuBinding, wechatAppPermissionsFromMenus } from './AdminWechatAppPermissionBinding';
import { wechatRoutineMenuBinding, wechatRoutinePermissionsFromMenus } from './AdminWechatRoutinePermissionBinding';

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
    matches: ["product/", "unit", "unit/", "get_all_unit", "specs", "specs/", "all_specs", "ensure", "ensure/", "all_ensure"],
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
  { key: "bargain_record", label: "全局砍价记录", path: "/activity/bargain-records", matches: ["activity/bargain-records", "marketing/bargain_list", "marketing/bargain_list_info/"], manage: false },
  { key: "bargain_statistics", label: "砍价统计", path: "/activity/bargain-statistics", matches: ["activity/bargain-statistics/", "marketing/bargain/statistics/"], manage: false },
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
    matches: ["file/file", "file/upload", "file/upload_type", "file/video_upload", "file/video_uploads", "file/video_attachment", "file/category", "config/storage", "assets", "asset-categories"],
    manage: true,
  },
  { key: "shipping_settings", label: "发货设置", path: "/setting/shipping", matches: ["config/shipping"], manage: true },
  { key: 'city_delivery_settings', label: '同城配送设置', path: '/setting/city-delivery-settings', matches: ['config/city-delivery'], manage: true },
  { key: "city_delivery_record", label: "同城配送记录", path: "/setting/city-delivery-records",
    matches: ["city_delivery/records", "city_delivery/stores"], manage: false },
  { key: "pc_home_banner", label: "PC首页轮播", path: "/setting/pc-banner",
    matches: ["setting/pc-banners"], manage: true },
  { key: 'operational_group', label: '运营图片配置', path: '/setting/operational-groups',
    matches: ['setting/group_data', 'setting/operational_group_data'], manage: true },
  { key: 'erp.connection', label: 'ERP连接', path: '/operations/erp', matches: ['erp/connections'], manage: true },
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
  { key: "system_menu_rules", label: "平台权限规则", path: "/system/menu-rules", matches: ["system/menu-rules"], manage: true },
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
  { key: "wechat_open", label: "微信开放平台", path: "/content/wechat-open", matches: ["wechat/open"], manage: true },
  { key: "wechat_app", label: "原生App微信配置", path: "/content/wechat-app", matches: ["wechat/app"], manage: true },
  { key: "wechat_routine", label: "小程序基础配置", path: "/content/wechat-routine", matches: ["wechat/routine"], manage: true },
  { key: 'pc_base', label: 'PC基础配置', path: '/config/pc', matches: ['config/pc'], manage: true },
  { key: "wechat_base", label: "公众号基础设置", path: "/content/wechat-base", matches: ["wechat/base"], manage: true },
  { key: "wechat_menu", label: "公众号自定义菜单", path: "/content/wechat-menu", matches: ["wechat/menu", "app/wechat/menu"], manage: true },
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
permissionKeys.add('erp.connection.secret.read');
permissionKeys.add("system.legacy_admin_form_view");
permissionKeys.add("system.legacy_admin_manage");
permissionKeys.add("system.legacy_role_view");
permissionKeys.add("system.legacy_role_form_view");
permissionKeys.add("system.legacy_role_manage");
permissionKeys.add("system.legacy_role_status");
permissionKeys.add("system.legacy_role_delete");

// Route-level admission only. It is not a rule that can be stored, selected or
// delegated. Preview parses the requested action and checks its exact grant.
const legacyRolePreviewPermission = "system.legacy_role_operation_preview";

// Read admission for product editors. This is not a selectable role rule: a
// product reader or label reader may fetch options, but cannot manage labels.
export const PRODUCT_LABEL_SELECTION_PERMISSION = "label.product_selection_view";
export const PRODUCT_BRAND_SELECTION_PERMISSION = "brand.product_selection_view";
export const PRODUCT_CATEGORY_SELECTION_PERMISSION = 'category.product_selection_view';
// Read-only POST admission; exact legacy191 does not grant product writes.
export const PRODUCT_SKU_GENERATION_PERMISSION = 'product.sku_generation_view';
// Read admission for the DIY author chooser, not a selectable role rule. A
// dise manager may read options without gaining FAB/product/attachment access.
export const DISE_AUTHOR_SELECTION_PERMISSION = 'dise.author_selection_view';

/** Canonical grants cover narrower legacy contracts; legacy grants stay within their own workflow. */
export function hasAdminPermission(granted: ReadonlySet<string>, required: string): boolean {
  if (required === DISE_AUTHOR_SELECTION_PERMISSION) {
    return granted.has(required) || granted.has('dise.manage');
  }
  if (required === PRODUCT_SKU_GENERATION_PERMISSION) return granted.has(required) || granted.has('product.manage');
  if (required === PRODUCT_CATEGORY_SELECTION_PERMISSION) return granted.has(required)
    || granted.has('product.view') || granted.has('product.manage') || granted.has('category.view') || granted.has('category.manage');
  if (required === PRODUCT_BRAND_SELECTION_PERMISSION) return granted.has(required)
    || granted.has("product.view") || granted.has("product.manage")
    || granted.has("brand.view") || granted.has("brand.manage");
  if (required === PRODUCT_LABEL_SELECTION_PERMISSION) return granted.has(required)
    || granted.has("product.view") || granted.has("product.manage")
    || granted.has("label.view") || granted.has("label.manage");
  if (required === legacyRolePreviewPermission) return granted.has("system.manage")
    || granted.has("system.legacy_role_status") || granted.has("system.legacy_role_delete");
  if (granted.has(required)) return true;
  if (["system.legacy_admin_manage", "system.legacy_role_manage", "system.legacy_role_status", "system.legacy_role_delete"].includes(required)) return granted.has("system.manage");
  if (["system.legacy_admin_view", "system.legacy_admin_form_view"].includes(required)
    && granted.has("system.legacy_admin_manage")) return true;
  if (["system.legacy_role_view", "system.legacy_role_form_view"].includes(required)
    && granted.has("system.legacy_role_manage")) return true;
  if (required === "system.legacy_role_view"
    && (granted.has("system.legacy_role_status") || granted.has("system.legacy_role_delete"))) return true;
  return ["system.legacy_admin_view", "system.legacy_admin_form_view", "system.legacy_role_view", "system.legacy_role_form_view"].includes(required)
    && (granted.has("system.view") || granted.has("system.manage"));
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

/** Self-only services repeat live identity checks and never accept a target ID. */
export function isAdminProfileRoute(method:string,routePath:string):boolean {
  const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && (route==='setting/info' || route==='system/profile/challenge/status'
    || /^system\/profile\/(?:receipt|avatar)\/[^/]+$/.test(route)))
    || verb==='PUT' && (route==='setting/update_admin' || /^system\/profile\/avatar\/[^/]+$/.test(route))
    || verb==='POST' && ['system/profile/commit','system/profile/resolve','system/profile/challenge','system/profile/sms'].includes(route);
}

export function isAdminAuthorityRecoveryRoute(method:string,routePath:string):boolean {
  const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^(?:system\/authority|setting\/(?:admin|role)-authority)\/receipt\/[^/]+$/.test(route))
    || (verb==='POST' && ['system/authority/resolve','setting/admin-authority/resolve','setting/role-authority/resolve'].includes(route));
}

export function isAdminPlatformMenuRecoveryRoute(method:string,routePath:string):boolean {
  return ['GET','HEAD'].includes(method.toUpperCase()) && /^system\/menu-rules\/receipt\/[^/]+$/.test(normalizeAdminRoute(routePath));
}

export function isAdminStoreRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^merchant\/store\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='merchant/store/author/resolve';}
export function isAdminGroupRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^user\/group\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='user/group/author/resolve';}
export function isAdminUnitRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/unit\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/unit/author/resolve';}
export function isAdminEnsureRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/ensure\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/ensure/author/resolve';}
export function isAdminRuleRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/rule\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/rule/author/resolve';}
export function isAdminParameterRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/specs\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/specs/author/resolve';}
export function isAdminProductLabelRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/label\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/label/author/resolve';}
export function isAdminPcBaseRecoveryRoute(method: string, routePath: string): boolean {
  const route = normalizeAdminRoute(routePath), verb = method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^config\/pc\/operations\/[^/]+$/u.test(route))
    || (verb === 'POST' && /^config\/pc\/operations\/[^/]+\/resolve$/u.test(route));
}
export function isAdminWechatAppRecoveryRoute(method: string, routePath: string): boolean {
  const route = normalizeAdminRoute(routePath), verb = method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^wechat\/app\/operations\/[^/]+$/u.test(route))
    || (verb === 'POST' && /^wechat\/app\/operations\/[^/]+\/resolve$/u.test(route));
}
export function isAdminWechatRoutineRecoveryRoute(method: string, routePath: string): boolean {
  const route = normalizeAdminRoute(routePath), verb = method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^wechat\/routine\/operations\/[^/]+$/u.test(route))
    || (verb === 'POST' && /^wechat\/routine\/operations\/[^/]+\/resolve$/u.test(route));
}
export function isAdminWechatOpenRecoveryRoute(method: string, routePath: string): boolean {
  const route = normalizeAdminRoute(routePath), verb = method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^wechat\/open\/operations\/[^/]+$/u.test(route))
    || (verb === 'POST' && /^wechat\/open\/operations\/[^/]+\/resolve$/u.test(route));
}
export function isAdminWechatBaseRecoveryRoute(method: string, routePath: string): boolean {
  const route = normalizeAdminRoute(routePath), verb = method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^wechat\/base\/operations\/[^/]+$/u.test(route))
    || (verb === 'POST' && /^wechat\/base\/operations\/[^/]+\/resolve$/u.test(route));
}
export function isAdminHotwordRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^product\/words\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='product/words/author/resolve';}
export function isAdminDeliveryRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^order\/delivery\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='order/delivery/author/resolve';}
export function isAdminStaffRecoveryRoute(method:string,routePath:string):boolean {const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^merchant\/store_staff\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='merchant/store_staff/author/resolve';}
export function isAdminUserLabelRecoveryRoute(method:string,routePath:string):boolean {
 const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();return ['GET','HEAD'].includes(verb)&&/^user_label\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='user_label/author/resolve';
}
export function isAdminLevelRecoveryRoute(method:string,routePath:string):boolean {
 const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
 return ['GET','HEAD'].includes(verb)&&/^level\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='level/author/resolve';
}

export function isAdminExpressRecoveryRoute(method:string,routePath:string):boolean {
 const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
 return ['GET','HEAD'].includes(verb)&&/^express\/author\/receipt\/[^/]+$/.test(route)||verb==='POST'&&route==='express/author/resolve';
}

export function isAdminProductEditorRecoveryRoute(method:string,routePath:string):boolean {
  const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^product\/editor\/operations\/[^/]+$/.test(route))
    || (verb==='POST' && /^product\/editor\/operations\/[^/]+\/resolve$/.test(route));
}

export function isAdminProductVideoRecoveryRoute(method:string,routePath:string):boolean {
  const route=normalizeAdminRoute(routePath),verb=method.toUpperCase();
  return (['GET','HEAD'].includes(verb) && /^file\/video_uploads\/[^/]+$/.test(route))
    || (verb==='POST' && /^file\/video_uploads\/[^/]+\/cancel$/.test(route));
}

/** Both actual IDs and the two historical/router placeholder spellings have
 * the same narrow policy. Malformed IDs never fall through to config access. */
function legacyAdminId(value: string): boolean {
  return value === ':id' || value === '<id>'
    || /^[1-9]\d*$/.test(value) && value.length <= 10 && Number(value) <= 2147483647;
}
function legacyAdminPermission(method: string, route: string): string | null {
  const parts = route.split('/');
  if (['GET','HEAD'].includes(method)) {
    if (route === 'setting/admin') return 'system.legacy_admin_view';
    if (route === 'setting/admin/create' || parts.length === 4 && parts[0] === 'setting'
      && parts[1] === 'admin' && legacyAdminId(parts[2]) && parts[3] === 'edit') return 'system.legacy_admin_form_view';
  }
  if (method === 'POST' && route === 'setting/admin') return 'system.legacy_admin_manage';
  if (['PUT','DELETE'].includes(method) && parts.length === 3 && parts[0] === 'setting'
    && parts[1] === 'admin' && legacyAdminId(parts[2])) return 'system.legacy_admin_manage';
  if (method === 'PUT' && parts.length === 4 && parts[0] === 'setting' && parts[1] === 'set_status'
    && legacyAdminId(parts[2]) && ['0','1',':status','<status>'].includes(parts[3])) return 'system.legacy_admin_manage';
  return null;
}

function legacyRolePermission(method: string, route: string): string | null {
  const parts = route.split('/');
  if (['GET','HEAD'].includes(method)) {
    if (route === 'setting/role') return 'system.legacy_role_view';
    if (route === 'setting/role/create' || parts.length === 4 && parts[0] === 'setting'
      && parts[1] === 'role' && legacyAdminId(parts[2]) && parts[3] === 'edit') return 'system.legacy_role_form_view';
  }
  if (parts.length === 3 && parts[0] === 'setting' && parts[1] === 'role') {
    if (method === 'POST' && (parts[2] === '0' || legacyAdminId(parts[2]))) return 'system.legacy_role_manage';
    if (method === 'DELETE' && legacyAdminId(parts[2])) return 'system.legacy_role_delete';
  }
  if (method === 'PUT' && parts.length === 5 && parts[0] === 'setting' && parts[1] === 'role'
    && parts[2] === 'set_status' && legacyAdminId(parts[3]) && ['0','1',':status','<status>'].includes(parts[4])) return 'system.legacy_role_status';
  return null;
}

function isProductLabelRoute(route: string): boolean {
  return /^(?:product\/(?:label|label_cate|product_label|all_label)|product_label)(?:\/|$)/.test(route);
}

function isProductBrandRoute(route: string): boolean {
  return /^(?:product\/brand|brand)(?:\/|$)/.test(route);
}

function isProductCategoryRoute(route: string): boolean { return /^(?:product\/category|category)(?:\/|$)/.test(route); }
function productCategoryPermission(method: string, route: string): string | null {
  const read = method === 'GET' || method === 'HEAD';
  if (read && ['product/category', 'category/list', 'product/category/create'].includes(route)) return 'category.view';
  if (read && (/^product\/category\/tree\/(?:\d{1,10}|:type|<type>)$/.test(route)
    || /^product\/category\/cascader_list(?:\/(?:\d{1,10}|:type|<type>|<type\?>))?$/.test(route))) return PRODUCT_CATEGORY_SELECTION_PERMISSION;
  if (method === 'POST' && ['product/category', 'category/save'].includes(route)) return 'category.manage';
  const parts = route.split('/');
  if (parts.length === 3 && parts[0] === 'product' && parts[1] === 'category' && legacyAdminId(parts[2])) {
    if (read) return 'category.view';
    if (['PUT', 'DELETE'].includes(method)) return 'category.manage';
  }
  if (method === 'DELETE' && parts.length === 3 && parts[0] === 'category' && parts[1] === 'del' && legacyAdminId(parts[2])) return 'category.manage';
  if (method === 'PUT' && parts.length === 5 && parts[0] === 'product' && parts[1] === 'category' && parts[2] === 'set_show'
    && legacyAdminId(parts[3]) && ['0', '1', ':is_show', '<is_show>'].includes(parts[4])) return 'category.manage';
  return null;
}

function productBrandPermission(method: string, route: string): string | null {
  const read = method === "GET" || method === "HEAD";
  if (read && ["product/brand", "brand/list"].includes(route)) return "brand.view";
  if (read && (route === "product/brand/cascader_list"
    || /^product\/brand\/cascader_list\/(?:[12]|:type|<type>|<type\?>)$/.test(route))) return PRODUCT_BRAND_SELECTION_PERMISSION;
  if (method === "POST" && ["product/brand", "brand/save"].includes(route)) return "brand.manage";
  const parts = route.split("/");
  if (parts.length === 3 && parts[0] === "product" && parts[1] === "brand"
    && legacyAdminId(parts[2]) && ["PUT", "DELETE"].includes(method)) return "brand.manage";
  if (method === "PUT" && parts.length === 5 && parts[0] === "product" && parts[1] === "brand"
    && parts[2] === "set_show" && legacyAdminId(parts[3])
    && ["0", "1", ":is_show", "<is_show>"].includes(parts[4])) return "brand.manage";
  if (method === "DELETE" && parts.length === 3 && parts[0] === "brand" && parts[1] === "del"
    && legacyAdminId(parts[2])) return "brand.manage";
  return null;
}

function productLabelPermission(method: string, route: string): string | null {
  const read = method === "GET" || method === "HEAD";
  if (read && ["product/product_label", "product/all_label"].includes(route)) return PRODUCT_LABEL_SELECTION_PERMISSION;
  if (read && ["product/label", "product/label/form", "product/label_cate", "product/label_cate/create", "product_label/list"].includes(route)) return "label.view";
  const parts = route.split("/");
  if (parts[0] === "product" && parts[1] === "label_cate") {
    if (read && parts.length === 4 && legacyAdminId(parts[2]) && parts[3] === "edit") return "label.view";
    if (method === "POST" && parts.length === 2) return "label.manage";
    if (["PUT", "DELETE"].includes(method) && parts.length === 3 && legacyAdminId(parts[2])) return "label.manage";
  }
  if (parts[0] === "product" && parts[1] === "label") {
    if (method === "PUT" && route === "product/label/dels") return "label.manage";
    if (parts.length === 3 && ((method === "POST" && parts[2] === "0") || ["POST", "DELETE"].includes(method) && legacyAdminId(parts[2]))) return "label.manage";
    if (method === "PUT" && parts.length === 5 && ["set_status", "set_show"].includes(parts[2]) && legacyAdminId(parts[3])
      && ["0", "1", parts[2] === "set_status" ? ":status" : ":show", parts[2] === "set_status" ? "<status>" : "<show>"].includes(parts[4])) return "label.manage";
  }
  if (method === "POST" && route === "product_label/save") return "label.manage";
  if (method === "DELETE" && parts.length === 3 && parts[0] === "product_label" && parts[1] === "del" && legacyAdminId(parts[2])) return "label.manage";
  return null;
}

export function requiredAdminPermission(method: string, routePath: string): string | null {
  if (routePath.startsWith('/erpapi/')) {
    if (!['GET', 'HEAD'].includes(method.toUpperCase())) return null;
    if (routePath === '/erpapi/auth/access_token') return 'erp.connection.secret.read';
    return ['/erpapi/auth', '/erpapi/product/syncProduct'].includes(routePath) ? 'erp.connection.manage' : null;
  }
  // The earlier mobile editor has a distinct /api/admin selection contract.
  if (['GET', 'HEAD'].includes(method.toUpperCase()) && routePath === '/api/admin/product/category') return PRODUCT_CATEGORY_SELECTION_PERMISSION;
  const route = normalizeAdminRoute(routePath);
  // This additive reader is a closed namespace: only the exact directory
  // and one canonical record's opt-in media GET/HEAD require extract.view.
  if (route === 'extract/directory' || route.startsWith('extract/directory/')) {
    if (!['GET', 'HEAD'].includes(method.toUpperCase())) return null;
    if (route === 'extract/directory') return 'extract.view';
    const parts = route.split('/');
    return parts.length === 4 && legacyAdminId(parts[2]) && parts[3] === 'media' ? 'extract.view' : null;
  }
  if (['user/filter_options', 'user/filter_regions'].includes(route)) {
    return ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'user.view' : null;
  }
  if (route === 'setting/menus' || route.startsWith('setting/menus/') || route === 'setting/rulelist' || route === 'system/menu-rules' || route.startsWith('system/menu-rules/')) {
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if (isAdminPlatformMenuRecoveryRoute(method,routePath)) return null;
    if (read && (['setting/menus','setting/menus/create','setting/rulelist','system/menu-rules/catalog'].includes(route)
      || new RegExp(`^setting/menus/${id}(?:/edit)?$`).test(route))) return 'system_menu_rules.view';
    if (verb==='POST' && route==='setting/menus' || ['PUT','DELETE'].includes(verb) && new RegExp(`^setting/menus/${id}$`).test(route)
      || verb==='PUT' && new RegExp(`^setting/menus/show/${id}$`).test(route)) return 'system_menu_rules.manage';
    return null;
  }
  if (route === 'config/pc' || route.startsWith('config/pc/') || route === 'setting/config/edit_new_build/pc') {
    const verb = method.toUpperCase();
    if (isAdminPcBaseRecoveryRoute(method, routePath)) return null;
    if (['GET','HEAD'].includes(verb) && ['config/pc','setting/config/edit_new_build/pc'].includes(route)) return 'pc_base.view';
    if (['GET','HEAD'].includes(verb) && ['config/pc/attachment-categories','config/pc/attachment-options'].includes(route)) return 'pc_base.manage';
    return verb === 'POST' && route === 'config/pc' ? 'pc_base.manage' : null;
  }
  if (route === 'wechat/app' || route.startsWith('wechat/app/') || route === 'setting/config/edit_new_build/app') {
    const verb = method.toUpperCase();
    if (isAdminWechatAppRecoveryRoute(method, routePath)) return null;
    if (['GET','HEAD'].includes(verb) && ['wechat/app','setting/config/edit_new_build/app'].includes(route)) return 'wechat_app.view';
    return verb === 'POST' && route === 'wechat/app' ? 'wechat_app.manage' : null;
  }
  if (route === 'wechat/routine' || route.startsWith('wechat/routine/') || route === 'setting/config/edit_new_build/routine') {
    const verb = method.toUpperCase();
    if (isAdminWechatRoutineRecoveryRoute(method, routePath)) return null;
    if (['GET','HEAD'].includes(verb) && ['wechat/routine','setting/config/edit_new_build/routine'].includes(route)) return 'wechat_routine.view';
    return verb === 'POST' && route === 'wechat/routine' ? 'wechat_routine.manage' : null;
  }
  if (route === 'wechat/open' || route.startsWith('wechat/open/') || route === 'setting/config/edit_new_build/wxopen') {
    const verb = method.toUpperCase();
    if (isAdminWechatOpenRecoveryRoute(method, routePath)) return null;
    if (['GET','HEAD'].includes(verb) && ['wechat/open','setting/config/edit_new_build/wxopen'].includes(route)) return 'wechat_open.view';
    return verb === 'POST' && route === 'wechat/open' ? 'wechat_open.manage' : null;
  }
  if (route === 'wechat/base' || route.startsWith('wechat/base/') || route === 'setting/config/edit_new_build/wechat' || route === 'setting/config/save_basics') {
    const verb = method.toUpperCase();
    if (isAdminWechatBaseRecoveryRoute(method, routePath)) return null;
    if (['GET','HEAD'].includes(verb) && ['wechat/base','setting/config/edit_new_build/wechat'].includes(route)) return 'wechat_base.view';
    if (verb === 'POST' && ['wechat/base','setting/config/save_basics'].includes(route)) return 'wechat_base.manage';
    if (['GET','HEAD'].includes(verb) && ['wechat/base/attachment-categories','wechat/base/attachment-options'].includes(route)) return 'wechat_base.manage';
    return null;
  }
  if (route === 'wechat/menu' || route.startsWith('wechat/menu/') || route === 'app/wechat/menu' || route.startsWith('app/wechat/menu/')) {
    const verb = method.toUpperCase(), root = route === 'wechat/menu' || route === 'app/wechat/menu';
    if (root && ['GET','HEAD'].includes(verb)) return 'wechat_menu.view';
    if (root && verb === 'POST') return 'wechat_menu.manage';
    if (/^wechat\/menu\/operations\/[^/]+$/u.test(route) && ['GET','HEAD'].includes(verb)) return 'wechat_menu.manage';
    if (/^wechat\/menu\/operations\/[^/]+\/(?:observe|confirm-observation|resolve-missing)$/u.test(route) && verb === 'POST') return 'wechat_menu.manage';
    return null;
  }
  if(route==='product/unit/author'||route.startsWith('product/unit/author/')){
    const verb=method.toUpperCase();
    if(isAdminUnitRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/unit/author/catalog')return 'product.view';
    if(verb==='POST'&&route==='product/unit/author/commit')return 'product.manage';
    return null;
  }
  if(route==='product/ensure/author'||route.startsWith('product/ensure/author/')){
    const verb=method.toUpperCase();
    if(isAdminEnsureRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/ensure/author/catalog')return 'product.view';
    if(['GET','HEAD'].includes(verb)&&['product/ensure/author/attachments/categories','product/ensure/author/attachments/options'].includes(route))return 'product.manage';
    if(verb==='POST'&&route==='product/ensure/author/commit')return 'product.manage';
    return null;
  }
  if(route==='product/rule/author'||route.startsWith('product/rule/author/')){
    const verb=method.toUpperCase();
    if(isAdminRuleRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/rule/author/catalog')return 'product.view';
    if(verb==='POST'&&route==='product/rule/author/commit')return 'product.manage';
    return null;
  }
  if(route==='product/label/author'||route.startsWith('product/label/author/')){
    const verb=method.toUpperCase();
    if(isAdminProductLabelRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/label/author/catalog')return 'label.view';
    if(['GET','HEAD'].includes(verb)&&['product/label/author/attachments/categories','product/label/author/attachments/options'].includes(route))return 'label.manage';
    if(verb==='POST'&&route==='product/label/author/commit')return 'label.manage';
    return null;
  }
  if(route==='product/words/author'||route.startsWith('product/words/author/')){
    const verb=method.toUpperCase();
    if(isAdminHotwordRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/words/author/catalog')return 'product.view';
    if(['GET','HEAD'].includes(verb)&&['product/words/author/attachments/categories','product/words/author/attachments/options'].includes(route))return 'product.manage';
    if(verb==='POST'&&route==='product/words/author/commit')return 'product.manage';
    return null;
  }
  if(route==='product/specs/author'||route.startsWith('product/specs/author/')){
    const verb=method.toUpperCase();
    if(isAdminParameterRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='product/specs/author/catalog')return 'product.view';
    if(verb==='POST'&&route==='product/specs/author/commit')return 'product.manage';
    return null;
  }
  if(route==='user/group/author'||route.startsWith('user/group/author/')){
    const verb=method.toUpperCase();
    if(isAdminGroupRecoveryRoute(method,routePath))return null;
    if(['GET','HEAD'].includes(verb)&&route==='user/group/author/catalog')return 'user.view';
    if(verb==='POST'&&route==='user/group/author/commit')return 'user.manage';
    return null;
  }
  if(route==='order/delivery/author'||route.startsWith('order/delivery/author/')){
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb);
    if(isAdminDeliveryRecoveryRoute(method,routePath))return null;
    if(read&&['order/delivery/author/users','order/delivery/author/attachment-options','order/delivery/author/attachment-categories'].includes(route))return 'order.manage';
    if(read&&route==='order/delivery/author/catalog')return 'order.view';
    if(verb==='POST'&&route==='order/delivery/author/commit')return 'order.manage';
    return null;
  }
  // Original PHP uses GET for this mutation. HEAD must never change state.
  if(/^order\/delivery\/set_status\/(?:[1-9]\d{0,9}|:id|<id>)\/(?:[01]|:status|<status>)$/.test(route))return ['GET','PUT'].includes(method.toUpperCase())?'order.manage':null;
  if(route==='order/delivery/create')return ['GET','HEAD'].includes(method.toUpperCase())?'order.manage':null;
  if(route==='merchant/store_staff'||route.startsWith('merchant/store_staff/')){
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if(isAdminStaffRecoveryRoute(method,routePath))return null;
    if(read&&['merchant/store_staff/author/users','merchant/store_staff/author/attachment-options','merchant/store_staff/author/attachment-categories'].includes(route))return 'store.manage';
    if(read&&(['merchant/store_staff','merchant/store_staff/create','merchant/store_staff/author/catalog'].includes(route)||new RegExp(`^merchant/store_staff/${id}/edit$`).test(route)))return 'store.view';
    if(verb==='POST'&&(route==='merchant/store_staff/author/commit'||/^merchant\/store_staff\/save\/(?:0|[1-9]\d{0,9}|:id|<id>)$/.test(route))||verb==='PUT'&&new RegExp(`^merchant/store_staff/set_show/${id}/(?:[01]|:status|<status>)$`).test(route)||verb==='DELETE'&&new RegExp(`^merchant/store_staff/del/${id}$`).test(route))return 'store.manage';
    return null;
  }
  if(route==='merchant/store'||route.startsWith('merchant/store/')){
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if(isAdminStoreRecoveryRoute(method,routePath))return null;
    if(read&&['merchant/store/address','merchant/store/author/attachment-options','merchant/store/author/attachment-categories','merchant/store/author/regions','merchant/store/author/map-config'].includes(route))return 'store.manage';
    if(read&&(['merchant/store','merchant/store/get_header','merchant/store/author/catalog'].includes(route)||new RegExp(`^merchant/store/get_info/${id}$`).test(route)))return 'store.view';
    if(verb==='POST'&&(route==='merchant/store/author/commit'||/^merchant\/store\/(?:0|[1-9]\d{0,9}|:id|<id>)$/.test(route))||verb==='PUT'&&new RegExp(`^merchant/store/set_show/${id}/(?:[01]|:isshow|<isshow>)$`).test(route)||verb==='DELETE'&&new RegExp(`^merchant/store/del/${id}$`).test(route))return 'store.manage';
    return null;
  }
  if(route==='user_label'||route.startsWith('user_label/')||route==='user/user_label'||route.startsWith('user/user_label/')||route==='user/user_label_cate'||route.startsWith('user/user_label_cate/')||route==='user/synchro/work/label'){
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if(isAdminUserLabelRecoveryRoute(method,routePath))return null;
    if(read&&(['user_label/list','user_label/catalog','user/user_label','user/user_label_cate','user/user_label_cate/all','user/user_label_cate/create'].includes(route)||/^user\/user_label\/add\/(?:0|[1-9]\d{0,9}|:id|<id>)$/.test(route)||new RegExp(`^user/user_label_cate/${id}/edit$`).test(route)))return 'label.view';
    if(verb==='GET'&&route==='user/synchro/work/label'||verb==='POST'&&['user_label/save','user_label/author/commit','user_label/sync/advance','user/user_label/save','user/user_label_cate'].includes(route)||verb==='DELETE'&&new RegExp(`^(?:user_label/del|user/user_label/del|user/user_label_cate)/${id}$`).test(route)||verb==='PUT'&&new RegExp(`^user/user_label_cate/${id}$`).test(route))return 'label.manage';
    return null;
  }
  if(route==='level'||route.startsWith('level/')||route==='user/user_level'||route.startsWith('user/user_level/')) {
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if(isAdminLevelRecoveryRoute(method,routePath))return null;
    if(read&&['level/attachment-options','level/attachment-categories'].includes(route))return 'level.manage';
    if(read&&(['level/list','level/catalog','user/user_level/create','user/user_level/vip_list'].includes(route)||new RegExp(`^level/${id}/edit$`).test(route)))return 'level.view';
    if(verb==='POST'&&['level/save','level/author/commit','user/user_level'].includes(route)||verb==='DELETE'&&new RegExp(`^level/del/${id}$`).test(route)||verb==='PUT'&&(new RegExp(`^user/user_level/delete/${id}$`).test(route)||new RegExp(`^user/user_level/set_show/${id}/(?:[01]|:is_show|<is_show>)$`).test(route)))return 'level.manage';
    return null;
  }
  if(route==='express'||route.startsWith('express/')||route==='freight/express'||route.startsWith('freight/express/')) {
    const verb=method.toUpperCase(),read=['GET','HEAD'].includes(verb),id='(?:[1-9]\\d{0,9}|:id|<id>)';
    if(isAdminExpressRecoveryRoute(method,routePath)) return null;
    if(read&&(['express/list','express/catalog','freight/express'].includes(route)||new RegExp(`^(?:express|freight/express)/${id}/edit$`).test(route))) return 'express.view';
    if(verb==='POST'&&['express/save','express/author/prepare','express/author/commit','freight/express'].includes(route)
      ||verb==='DELETE'&&new RegExp(`^(?:express/del|freight/express)/${id}$`).test(route)
      ||verb==='PUT'&&new RegExp(`^freight/express/${id}$`).test(route)
      ||verb==='PUT'&&new RegExp(`^freight/express/set_status/${id}/(?:[01]|:status|<status>)$`).test(route)
      ||read&&route==='freight/express/sync_express') return 'express.manage';
    return null;
  }
  // No generic dise.view fallback for this author-only namespace. Unknown
  // children and every write verb stay unregistered, even if added by mistake.
  if (route === 'dise/author-options' || route.startsWith('dise/author-options/')) {
    return ['GET', 'HEAD'].includes(method.toUpperCase()) && [
      'dise/author-options/hot-words',
      'dise/author-options/link-categories',
      'dise/author-options/link-targets',
      'dise/author-options/tab-categories',
      'dise/author-options/tab-targets',
      'dise/author-options/list-products',
      'dise/author-options/list-brands',
      'dise/author-options/list-labels',
      'dise/author-options/list-article-categories',
    ].includes(route) ? DISE_AUTHOR_SELECTION_PERMISSION : null;
  }
  if (route === 'supplier/list' || route.startsWith('supplier/list/')) {
    return route === 'supplier/list' && ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'product.view' : null;
  }
  if (route === 'erp/connections' || route.startsWith('erp/connections/')) {
    if (['GET', 'HEAD'].includes(method.toUpperCase()) && route === 'erp/connections') return 'erp.connection.view';
    if (method.toUpperCase() === 'POST' && route === 'erp/connections') return 'erp.connection.manage';
    const id = '(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|:id|<id>)';
    if (method.toUpperCase() === 'PUT' && new RegExp(`^erp/connections/${id}/bindings$`).test(route)) return 'erp.connection.manage';
    if (method.toUpperCase() === 'POST' && new RegExp(`^erp/connections/${id}/(?:auth|rotate|disable|revoke)$`).test(route)) return 'erp.connection.manage';
    return null;
  }
  if (route === 'product/generate_attr' || route.startsWith('product/generate_attr/')) {
    return method.toUpperCase() === 'POST'
      && /^product\/generate_attr\/(?:0|[1-9]\d{0,9}|:id|<id>)\/(?:[012]|:type|<type>)$/.test(route)
      ? PRODUCT_SKU_GENERATION_PERMISSION : null;
  }
  // Central review moderation has independent capabilities even on old product URLs.
  if (isProductReplyRoute(route)) return productReplyPermission(method.toUpperCase(), route);
  if (isProductModerationRoute(route)) return productModerationPermission(method.toUpperCase(), route);
  if (isProductCatalogReadRoute(route)) return ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'product.view' : null;
  // Resource delete is the reversible PHP contract; invalid DELETE IDs cannot
  // fall through to the broad product namespace. Existing source editor POST,
  // detail GET and named unit/rule/ensure contracts retain their own policies.
  if (method.toUpperCase() === 'DELETE' && /^product\/product\/[^/]+$/.test(route)) {
    if (!legacyAdminId(route.split('/')[2])) return null;
    return 'product.manage';
  }
  if (isOperationalGroupRoute(route)) return operationalGroupPermission(method.toUpperCase(), route);
  if (isProductCategoryRoute(route)) return productCategoryPermission(method.toUpperCase(), route);
  if (isProductBrandRoute(route)) return productBrandPermission(method.toUpperCase(), route);
  // These legacy product URLs belong to the independent label workflow.
  // Resource read/:id remains unproved; unknown verbs and children fail closed.
  if (isProductLabelRoute(route)) return productLabelPermission(method.toUpperCase(), route);
  // Legacy log queries share the existing read grant. No legacy log writer
  // or constructor-triggered cleanup is exposed by these compatibility URLs.
  if (route === "system/log" || route.startsWith("system/log/")) {
    return ["GET", "HEAD"].includes(method.toUpperCase())
      && ["system/log", "system/log/search_admin"].includes(route) ? "log.view" : null;
  }
  // Only authenticated owners may recover their own immutable operation key.
  // Recovery service admits live identity independently of current role grants.
  if (method.toUpperCase()==='POST' && ['system/authority/preview','system/authority/commit'].includes(route)) return 'system.manage';
  if (isAdminWechatRoutineRecoveryRoute(method,routePath) || isAdminWechatAppRecoveryRoute(method,routePath) || isAdminPcBaseRecoveryRoute(method,routePath) || isAdminWechatOpenRecoveryRoute(method,routePath) || isAdminWechatBaseRecoveryRoute(method,routePath) || isAdminAuthorityRecoveryRoute(method,routePath) || isAdminProductEditorRecoveryRoute(method,routePath) || isAdminProductVideoRecoveryRoute(method,routePath)) return null;
  if (route === 'file/video_upload' || route === 'file/video_attachment') return method.toUpperCase() === 'POST' ? 'attachment.manage' : null;
  if (route === 'file/video_uploads' || route.startsWith('file/video_uploads/')) {
    const verb=method.toUpperCase();
    if (verb==='POST' && /^file\/video_uploads\/[^/]+(?:\/complete)?$/.test(route)) return 'attachment.manage';
    if (verb==='PUT' && /^file\/video_uploads\/[^/]+\/parts\/[^/]+$/.test(route)) return 'attachment.manage';
    if (['GET','HEAD'].includes(verb) && /^file\/video_uploads\/[^/]+\/preview$/.test(route)) return 'attachment.view';
    return null;
  }
  if (route === 'product/editor' || route.startsWith('product/editor/')) {
    if (['GET','HEAD'].includes(method.toUpperCase()) && route==='product/editor/options') return 'product.view';
    if (['GET','HEAD'].includes(method.toUpperCase()) && /^product\/editor\/detail\/(?:[1-9]\d{0,9}|:id|<id>)$/.test(route)) return 'product.view';
    if (method.toUpperCase()==='POST' && /^product\/editor\/save\/(?:0|[1-9]\d{0,9}|:id|<id>)$/.test(route)) return 'product.manage';
    if (['GET','HEAD','POST'].includes(method.toUpperCase()) && /^product\/editor\/copy\/(?:[1-9]\d{0,9}|:id|<id>)$/.test(route)) return 'product.manage';
    return null;
  }
  if (route === 'setting/admin-authority' || route.startsWith('setting/admin-authority/')) {
    return method.toUpperCase() === 'POST' && route === 'setting/admin-authority/preview' ? 'system.legacy_admin_manage' : null;
  }
  if (route === 'setting/role-authority' || route.startsWith('setting/role-authority/')) {
    return method.toUpperCase() === 'POST' && route === 'setting/role-authority/preview' ? legacyRolePreviewPermission : null;
  }
  if (route === 'system/legacy-staff') return ['GET','HEAD'].includes(method.toUpperCase()) ? 'system.legacy_admin_view' : null;
  if (route === 'system/legacy-roles') return ['GET','HEAD'].includes(method.toUpperCase()) ? 'system.legacy_role_view' : null;
  // Legacy staff authority lives under setting/, but is independent of runtime
  // configuration. Its lists and numeric role form/save have separate grants.
  // Other legacy writes do not grant config access or authority over modern writes.
  if (/^setting\/(?:admin(?:\/|$)|role(?:\/|$)|set_status(?:\/|$))/.test(route)) {
    if (route === 'setting/admin' || route.startsWith('setting/admin/') || route === 'setting/set_status' || route.startsWith('setting/set_status/')) {
      return legacyAdminPermission(method.toUpperCase(), route);
    }
    return legacyRolePermission(method.toUpperCase(), route);
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
    if (token.startsWith('wechat_app.')) throw new ValidateException('原生App权限须通过完整的旧菜单组合授予');
    if (token.startsWith('wechat_routine.')) throw new ValidateException('小程序权限须通过完整的旧菜单组合授予');
    if (!permissionKeys.has(token) && !isNumericToken(token)) {
      throw new ValidateException(`未知权限规则: ${token}`);
    }
  }
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (token.endsWith(".manage")) expanded.add(`${token.slice(0, -7)}.view`);
    if (token === "system.legacy_admin_manage") {
      expanded.add("system.legacy_admin_view");
      expanded.add("system.legacy_admin_form_view");
    }
    if (token === "system.legacy_role_manage") {
      expanded.add("system.legacy_role_view");
      expanded.add("system.legacy_role_form_view");
    }
    if (token === "system.legacy_role_status" || token === "system.legacy_role_delete") expanded.add("system.legacy_role_view");
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
  const excess = [...new Set(requested)].filter((key) => key === legacyRolePreviewPermission
    || key === DISE_AUTHOR_SELECTION_PERMISSION || !hasAdminPermission(granted, key));
  if (excess.length) {
    throw new ValidateException(`不能授予超出当前管理员范围的权限: ${excess.join(",")}`);
  }
}

function menuPathPermission(menuPath: string): string | null {
  const route = menuPath.trim().toLowerCase();
  if (route === "/admin/product/product_brand") return "brand.view";
  if (["/label/products", "/admin/product/label"].includes(route)) return "label.view";
  if (route === "/system/legacy-staff") return "system.legacy_admin_view";
  if (route === "/system/legacy-roles") return "system.legacy_role_view";
  if (route === '/admin/product/product_classify') return 'category.view';
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
  if (route === "/admin/system/maintain/system_log/index") return "log.view";
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

/** Author choices must name a fixed page exactly; the historical resolver's
 * substring fallback remains unchanged for existing numeric role rules. */
export function adminPlatformMenuPagePermission(path:string):string|null {
  const group=ADMIN_PERMISSION_GROUPS.find(g=>g.path===path);
  return group ? `${group.key}.view` : path==='/admin/setting/system_menus/index' ? 'system_menu_rules.view' : null;
}

/** These identities have an audited binding. A rejected binding cannot become
 * an opaque grant merely because it resolves to no current permission keys. */
const auditedLegacyMenuIds = new Set([1035, 1075, 1338, 1380, 1490, 1592, 1593, 1594]);
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
  'system-maintain-system-log',
  'admin-storeProduct-label',
  'admin-store-storeBrand-index',
]);

type LegacyAdminMenuMetadata = Pick<typeof systemMenus.$inferSelect,
  'id' | 'authType' | 'apiUrl' | 'methods' | 'menuPath' | 'uniqueAuth'> & Partial<Pick<typeof systemMenus.$inferSelect, 'pid' | 'type' | 'module' | 'controller' | 'action'>>;

/** Installer has NO numeric API seeds for these one-id stock contracts or
 * the new scoped notification stream. Never manufacture a writer from a
 * copied tuple; canonical role capabilities remain the admission authority.
 * The old two-argument attrs/<id>/<type> selector is a separate contract. */
function unprovedProductStockMenuClaim(menu: LegacyAdminMenuMetadata): boolean {
  const claims = [normalizeAdminRoute(menu.apiUrl), normalizeAdminRoute(menu.menuPath.replace(/^\/admin\//i, ''))];
  return claims.some(route => /^product\/product\/(?:attrs|savestocks)\/[^/]+$/i.test(route)
    || route.toLowerCase() === 'product/stock/notifications/socket');
}

function isProductModerationRoute(route: string): boolean {
  return /^product\/product\/(?:verify|remove|get_verify|set_verify)(?:\/|$)/i.test(route);
}
function productModerationPermission(method: string, route: string): string | null {
  const parts = route.split('/');
  if (parts.length !== 4 || !legacyAdminId(parts[3])) return null;
  if (['GET', 'HEAD'].includes(method) && ['verify', 'remove', 'get_verify'].includes(parts[2])) return 'product.view';
  return method === 'POST' && parts[2] === 'set_verify' ? 'product.manage' : null;
}
/** No installer numeric API seed proves any of the four review contracts.
 * Reject claims before generic API/path/auth and opaque-menu fallbacks. */
function unprovedProductModerationMenuClaim(menu: LegacyAdminMenuMetadata): boolean {
  return [normalizeAdminRoute(menu.apiUrl), normalizeAdminRoute(menu.menuPath.replace(/^\/admin(?=\/|product\/)/i, ''))].some(isProductModerationRoute)
    || /^product-product-(?:verify|remove|get_verify|set_verify)$/i.test(menu.uniqueAuth);
}

/** Installer 169 is the only DELETE resource seed. Protect the entire shared
 * resource claim before generic method collapsing/unique_auth/page fallbacks:
 * a copied GET tuple with product.manage must never become a delete writer.
 * The existing editor105/detail620 tuples remain exact independent bindings.
 * Both resolver queries already require type=1/access=1/is_del=0. */
function productGenerationMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const routes = [normalizeAdminRoute(menu.apiUrl), normalizeAdminRoute(menu.menuPath.replace(/^\/admin(?=\/|product\/)/i, ''))];
  const claimed = menu.id === 191 || routes.some(route => route === 'product/generate_attr' || route.startsWith('product/generate_attr/'));
  if (!claimed) return { protected: false, permission: null };
  return { protected: true, permission: menu.id === 191 && menu.authType === 2
    && menu.apiUrl === 'product/generate_attr/<id>/<type>' && menu.methods === 'POST'
    && menu.menuPath === '/adminproduct/generate_attr/<id>' && menu.uniqueAuth === '' ? PRODUCT_SKU_GENERATION_PERMISSION : null };
}

function productRecycleMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const claimed = [normalizeAdminRoute(menu.apiUrl), normalizeAdminRoute(menu.menuPath.replace(/^\/admin(?=\/|product\/)/i, ''))]
    .some(route => /^product\/product\/[^/]+$/.test(route) && legacyAdminId(route.split('/')[2]));
  if (![105, 169, 620].includes(menu.id) && !claimed) return { protected: false, permission: null };
  if (menu.authType !== 2 || menu.apiUrl !== 'product/product/<id>') return { protected: true, permission: null };
  const permission = menu.id === 169 && menu.methods === 'DELETE' && menu.menuPath === '' && menu.uniqueAuth === '' ? 'product.manage'
    : menu.id === 105 && menu.methods === 'POST' && menu.menuPath === '/admin/product/save' && menu.uniqueAuth === 'product-save' ? 'product.manage'
    : menu.id === 620 && menu.methods === 'GET' && menu.menuPath === '' && menu.uniqueAuth === '' ? 'product.view' : null;
  return { protected: true, permission };
}

function isProductCatalogReadRoute(route: string): boolean {
  return ['product/product', 'product/product/type_header', 'product/product/list'].includes(route);
}
const productCatalogReadMenuTuples: Record<number, readonly [string, string, string, string]> = {
  108: ['GET', 'product/product', '/admin/product/product', 'product-product-index'],
  192: ['GET', 'product/product/type_header', '/adminproduct/product/type_header', ''],
  193: ['GET', 'product/product/list', '/adminproduct/product/list', ''],
  377: ['GET', 'product/product/list', '', ''],
  388: ['GET', 'product/product/list', '', ''],
  399: ['GET', 'product/product/list', '', ''],
  410: ['GET', 'product/product/list', '', ''],
  941: ['GET', 'product/product/list', '', ''],
};
function productCatalogReadMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const route = normalizeAdminRoute(menu.apiUrl), path = menu.menuPath.toLowerCase(), auth = menu.uniqueAuth.toLowerCase();
  const page = menu.id === 2 || path === '/admin/product/product_list' || auth === 'admin-store-storeprouduct-index';
  const seed = productCatalogReadMenuTuples[menu.id];
  const claimedPath = ['/admin/product/product', '/adminproduct/product/type_header', '/adminproduct/product/list'].includes(path);
  // There is no supplier/list tuple in the PHP installer. Merely copying this
  // selector URL, its path, or a canonical unique_auth cannot mint a grant.
  const selectorClaim = [route, normalizeAdminRoute(path.replace(/^\/admin(?=\/)/, ''))]
    .some(value => value === 'supplier/list' || value.startsWith('supplier/list/'));
  if (!page && !seed && !claimedPath && !selectorClaim && !isProductCatalogReadRoute(route) && auth !== 'product-product-index') return { protected: false, permission: null };
  if (page) return { protected: true, permission: menu.id === 2 && menu.authType === 1
    && menu.menuPath === '/admin/product/product_list' && menu.uniqueAuth === 'admin-store-storeProuduct-index'
    && menu.apiUrl === '' && menu.methods === '' ? 'product.view' : null };
  const valid = menu.authType === 2 && !!seed && menu.methods === seed[0] && menu.apiUrl === seed[1]
    && menu.menuPath === seed[2] && menu.uniqueAuth === seed[3];
  return { protected: true, permission: valid ? 'product.view' : null };
}

function isProductReplyRoute(route: string): boolean {
  return route === 'product/reply' || route.startsWith('product/reply/') || route === 'reply' || route.startsWith('reply/');
}
function productReplyPermission(method: string, route: string): string | null {
  const id = '(?:[1-9]\\d*|:id|:replyid|<id>|<replyid>)';
  const productId = '(?:0|[1-9]\\d*|:product_id|<product_id>)';
  if (['GET', 'HEAD'].includes(method) && (['product/reply', 'reply/list'].includes(route)
    || new RegExp(`^product/reply/(?:comment|get_reply)/${id}$`).test(route)
    || new RegExp(`^product/reply/fictitious_reply/${productId}$`).test(route))) return 'reply.view';
  if (method === 'PUT' && new RegExp(`^product/reply/set_reply/${id}$`).test(route)) return 'reply.manage';
  if (method === 'POST' && (route === 'product/reply/save_fictitious_reply' || new RegExp(`^product/reply/save_comment/${id}/${id}$`).test(route)
    || new RegExp(`^reply/status/${id}$`).test(route))) return 'reply.manage';
  if (method === 'DELETE' && (new RegExp(`^product/reply/(?:delete_comment/)?${id}$`).test(route)
    || new RegExp(`^reply/del/${id}$`).test(route))) return 'reply.manage';
  return null;
}
const productReplyMenuTuples: Record<number, readonly [string, string, string, string]> = {
  184: ['GET', 'product/reply/fictitious_reply/<product_id>', '/adminproduct/reply/fictitious_reply', ''],
  185: ['POST', 'product/reply/save_fictitious_reply', '/adminproduct/reply/save_fictitious_reply', 'product-reply-save_fictitious_reply'],
  188: ['DELETE', 'product/reply/<id>', '/adminproduct/reply/<id>', ''],
  189: ['PUT', 'product/reply/set_reply/<id>', '/adminreply/set_reply/<id>', ''],
  190: ['GET', 'product/reply', '/adminproduct/reply', ''],
};
function productReplyMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const route = normalizeAdminRoute(menu.apiUrl), path = menu.menuPath.toLowerCase(), auth = menu.uniqueAuth.toLowerCase();
  const pageClaim = menu.id === 6 || path === '/admin/product/product_reply' || auth === 'product-product-reply';
  const seed = productReplyMenuTuples[menu.id];
  if (!pageClaim && !seed && !isProductReplyRoute(route) && auth !== 'product-reply-save_fictitious_reply') return { protected: false, permission: null };
  if (pageClaim) return { protected: true, permission: menu.id === 6 && menu.authType === 1
    && menu.menuPath === '/admin/product/product_reply' && menu.uniqueAuth === 'product-product-reply'
    && menu.apiUrl === '' && menu.methods === '' ? 'reply.view' : null };
  const valid = menu.authType === 2 && (seed
    ? menu.methods === seed[0] && menu.apiUrl === seed[1] && menu.menuPath === seed[2] && menu.uniqueAuth === seed[3]
    : menu.uniqueAuth === '' && menu.menuPath === '' && menu.apiUrl === menu.apiUrl.trim() && !/\s/.test(menu.apiUrl)
      && ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(menu.methods));
  return { protected: true, permission: valid ? productReplyPermission(menu.methods, route) : null };
}

function isOperationalGroupRoute(route: string) {
  return /^(?:setting\/group_data|setting\/operational_group_data)(?:\/|$)/.test(route);
}
function operationalGroupPermission(method: string, route: string): string | null {
  const id = '(?:[1-9][0-9]{0,9}|:id|<id>)';
  if (['GET', 'HEAD'].includes(method) && (['setting/group_data', 'setting/group_data/header', 'setting/group_data/create', 'setting/operational_group_data/options'].includes(route)
    || new RegExp(`^setting/group_data/${id}/edit$`).test(route)
    || new RegExp(`^setting/operational_group_data/detail/${id}$`).test(route)
    || /^setting\/operational_group_data\/receipt\/[^/]+\/[^/]+$/.test(route))) return 'operational_group.view';
  if (method === 'POST' && ['setting/group_data', 'setting/group_data/save_all'].includes(route)) return 'operational_group.manage';
  if (['PUT', 'DELETE'].includes(method) && new RegExp(`^setting/group_data/${id}$`).test(route)) return 'operational_group.manage';
  if (method === 'PUT' && new RegExp(`^setting/group_data/set_status/${id}/(?:[01]|:status|<status>)$`).test(route)) return 'operational_group.manage';
  return null;
}
const operationalGroupMenuTuples: Record<number, readonly [string, string]> = {
  481: ['GET', 'setting/group_data/header'], 482: ['GET', 'setting/group_data'],
  484: ['GET', 'setting/group_data/create'], 485: ['POST', 'setting/group_data'],
  486: ['GET', 'setting/group_data/<id>/edit'], 487: ['PUT', 'setting/group_data/<id>'],
  488: ['DELETE', 'setting/group_data/<id>'], 489: ['PUT', 'setting/group_data/set_status/<id>/<status>'],
};
function operationalGroupMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const route = normalizeAdminRoute(menu.apiUrl), tuple = operationalGroupMenuTuples[menu.id];
  if (!tuple && menu.id !== 483 && !isOperationalGroupRoute(route)
    && menu.uniqueAuth !== 'operational_group.view' && menu.uniqueAuth !== 'operational_group.manage'
    && menu.menuPath !== '/setting/operational-groups') return { protected: false, permission: null };
  const valid = !!tuple && menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === ''
    && menu.apiUrl === tuple[1] && menu.methods === tuple[0];
  return { protected: true, permission: valid ? operationalGroupPermission(tuple[0], tuple[1]) : null };
}
/** No old numeric menu tuple grants the independently enrolled ERP domain. */
function unprovedErpMenuClaim(menu: LegacyAdminMenuMetadata): boolean {
  return /^(?:\/erpapi(?:\/|$)|erpapi\/)/i.test(menu.apiUrl.trim())
    || /^(?:erp\/connections)(?:\/|$)/.test(normalizeAdminRoute(menu.apiUrl))
    || menu.uniqueAuth.trim().toLowerCase().startsWith('erp.connection.')
    || menu.menuPath.trim().toLowerCase() === '/operations/erp';
}
const productCategoryMenuTuples: Record<number, { method: string; route: string; path: string; auth?: string }> = {
  170: { method: 'GET', route: 'product/category', path: '/adminproduct/category' },
  171: { method: 'DELETE', route: 'product/category/<id>', path: '/adminproduct/category/<id>' },
  172: { method: 'PUT', route: 'product/category/<id>', path: '/adminproduct/category/<id>' },
  173: { method: 'POST', route: 'product/category', path: '/adminproduct/category', auth: 'product-save-cate' },
  174: { method: 'PUT', route: 'product/category/set_show/<id>/<is_show>', path: '/adminproduct/category/set_show/<id>/<is_show>' },
  176: { method: 'GET', route: 'product/category/create', path: '/admincategory/create' },
  177: { method: 'GET', route: 'product/category/<id>', path: '/admincategory/<id>/edit' },
  178: { method: 'GET', route: 'product/category/tree/<type>', path: '/admincategory/tree/:type' },
  376: { method: 'GET', route: 'product/category/tree/<type>', path: '' },
  387: { method: 'GET', route: 'product/category/tree/<type>', path: '' },
  398: { method: 'GET', route: 'product/category/tree/<type>', path: '' },
  411: { method: 'GET', route: 'product/category/tree/<type>', path: '' },
  912: { method: 'GET', route: 'product/category/cascader_list/<type?>', path: '' },
  940: { method: 'GET', route: 'product/category/tree/<type>', path: '' },
};
function productCategoryMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const route = normalizeAdminRoute(menu.apiUrl), path = menu.menuPath.trim().toLowerCase(), auth = menu.uniqueAuth.trim().toLowerCase();
  const page = menu.id === 3 || path === '/admin/product/product_classify' || auth === 'admin-store-storecategory-index';
  if (!page && menu.id !== 175 && !productCategoryMenuTuples[menu.id] && !isProductCategoryRoute(route)) return { protected: false, permission: null };
  if (page) return { protected: true, permission: menu.id === 3 && menu.authType === 1 && menu.menuPath === '/admin/product/product_classify'
    && menu.uniqueAuth === 'admin-store-storeCategory-index' && menu.apiUrl === '' && menu.methods === '' ? 'category.view' : null };
  if (menu.id === 175) return { protected: true, permission: null };
  const tuple = productCategoryMenuTuples[menu.id], method = menu.methods.trim().toUpperCase();
  const canonical = menu.menuPath === '' && menu.uniqueAuth === '';
  const original = tuple && menu.menuPath === tuple.path && menu.uniqueAuth === (tuple.auth ?? '');
  const identity = !tuple || method === tuple.method && route === tuple.route;
  const valid = menu.authType === 2 && !/\s/.test(menu.apiUrl.trim()) && identity && (canonical || original);
  return { protected: true, permission: valid ? productCategoryPermission(method, route) : null };
}
function productBrandMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const path = menu.menuPath.trim().toLowerCase(), auth = menu.uniqueAuth.trim().toLowerCase();
  const route = normalizeAdminRoute(menu.apiUrl);
  const pageClaim = menu.id === 1338 || path === '/admin/product/product_brand' || auth === 'admin-store-storebrand-index';
  if (!pageClaim && !isProductBrandRoute(route)) return { protected: false, permission: null };
  if (pageClaim) {
    const valid = menu.id === 1338 && menu.authType === 1 && menu.menuPath === '/admin/product/product_brand'
      && menu.uniqueAuth === 'admin-store-storeBrand-index' && menu.apiUrl === '' && menu.methods === '';
    return { protected: true, permission: valid ? 'brand.view' : null };
  }
  const method = menu.methods.trim().toUpperCase();
  const valid = menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === ''
    && !/\s/.test(menu.apiUrl.trim()) && ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method);
  return { protected: true, permission: valid ? productBrandPermission(method, route) : null };
}
function productLabelMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const path = menu.menuPath.trim().toLowerCase(), auth = menu.uniqueAuth.trim().toLowerCase();
  const route = normalizeAdminRoute(menu.apiUrl);
  const pageClaim = menu.id === 1380 || path === '/admin/product/label' || auth === 'admin-storeproduct-label';
  if (!pageClaim && !isProductLabelRoute(route)) return { protected: false, permission: null };
  if (pageClaim) {
    // Install seed 1380 binds the page and auth string; it is a read grant.
    const valid = menu.id === 1380 && menu.authType === 1 && menu.menuPath === '/admin/product/label'
      && menu.uniqueAuth === 'admin-storeProduct-label' && menu.apiUrl === '' && menu.methods === '';
    return { protected: true, permission: valid ? 'label.view' : null };
  }
  const method = menu.methods.trim().toUpperCase();
  const valid = menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === ''
    && !/\s/.test(menu.apiUrl.trim()) && ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method);
  return { protected: true, permission: valid ? productLabelPermission(method, route) : null };
}
const legacyAdminActionIds = new Set([20,331,332,333,334,335,336,337,610,635]);
const legacyAdminCapabilities = new Set(['system.legacy_admin_view','system.legacy_admin_form_view','system.legacy_admin_manage']);
/** A protected identity/path/auth/API claim must match its complete proved
 * tuple. It cannot fall back to generic system/config or opaque membership. */
/** Fixed PHP read menu identities; copied paths or drifted seeds do not
 * acquire record/statistics access through the generic menu fallback. */
/** Only the fixed page plus fixed generic-save seed together prove a base
 * writer. Neither the generic endpoint nor copied modern claims confer it. */
function pcBaseBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  // Shared315 remains owned by the existing shared-save binding. A PC page
  // identity supplies view only; its composition with315 is handled separately.
  if (menu.id === 315) return { protected: false, permission: null };
  const bound = pcBaseMenuBinding(menu);
  return { protected: bound.protected, permission: bound.view ? 'pc_base.view' : null };
}
function wechatOpenBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const compact = (value: string) => value.toLowerCase().replace(/\s+/gu, '');
  const route = normalizeAdminRoute(menu.apiUrl);
  const claimed = menu.id === 1360 || ['/admin/app/wechat_open','/content/wechat-open'].includes(compact(menu.menuPath))
    || compact(menu.uniqueAuth) === 'app-wechat-open' || compact(menu.uniqueAuth).startsWith('wechat_open.')
    || /^wechat\/open(?:\/|$)/u.test(route) || route === 'setting/config/edit_new_build/wxopen';
  if (!claimed) return { protected: false, permission: null };
  const exact = menu.id === 1360 && menu.pid === 135 && menu.type === 1 && menu.module === 'admin' && menu.controller === '' && menu.action === ''
    && menu.authType === 1 && menu.menuPath === '/admin/app/wechat_open' && menu.uniqueAuth === 'app-wechat-open' && menu.apiUrl === '' && menu.methods === '';
  return { protected: true, permission: exact ? 'wechat_open.view' : null };
}
function wechatBaseBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null; save: boolean } {
  const route = normalizeAdminRoute(menu.apiUrl), compact = (value: string) => value.toLowerCase().replace(/\s+/gu, '');
  const claimed = [1362,315].includes(menu.id) || compact(menu.menuPath) === '/admin/app/wechat/base'
    || compact(menu.menuPath) === '/content/wechat-base' || compact(menu.uniqueAuth) === 'app-wechat-base'
    || compact(menu.uniqueAuth).startsWith('wechat_base.') || /^wechat\/base(?:\/|$)/u.test(route)
    || /^setting\/config\/(?:save_basics(?:\/|$)|edit_new_build(?:\/|$))/u.test(route);
  if (!claimed) return { protected: false, permission: null, save: false };
  const common = menu.type === 1 && menu.module === 'admin' && menu.controller === '' && menu.action === '';
  if (common && menu.id === 1362 && menu.pid === 69 && menu.authType === 1 && menu.menuPath === '/admin/app/wechat/base'
    && menu.uniqueAuth === 'app-wechat-base' && menu.apiUrl === '' && menu.methods === '') return { protected: true, permission: 'wechat_base.view', save: false };
  const save = common && menu.id === 315 && menu.pid === 23 && menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === ''
    && menu.apiUrl === 'setting/config/save_basics' && menu.methods === 'POST';
  return { protected: true, permission: save ? 'config.manage' : null, save };
}

function wechatMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const route = normalizeAdminRoute(menu.apiUrl);
  const claimed = [92,507,508].includes(menu.id) || menu.menuPath.toLowerCase().replace(/\s+/gu,'') === '/admin/app/wechat/setting/menus/index'
    || menu.uniqueAuth.toLowerCase().replace(/\s+/gu,'') === 'application-wechat-menus'
    || /^(?:app\/)?wechat\/menu(?:\/|$)/u.test(route);
  if (!claimed) return { protected: false, permission: null };
  if (menu.id === 92 && menu.pid === 69 && menu.type === 1 && menu.module === 'admin'
    && menu.controller === 'application.wechat_menus' && menu.action === 'index' && menu.authType === 1 && menu.menuPath === '/admin/app/wechat/setting/menus/index'
    && menu.uniqueAuth === 'application-wechat-menus' && menu.apiUrl === '' && menu.methods === '') return { protected: true, permission: 'wechat_menu.view' };
  const api = menu.pid === 92 && menu.type === 1 && menu.module === 'admin' && menu.controller === '' && menu.action === ''
    && menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === '' && menu.apiUrl === 'app/wechat/menu';
  if (api && menu.id === 507 && menu.methods === 'GET') return { protected: true, permission: 'wechat_menu.view' };
  if (api && menu.id === 508 && menu.methods === 'POST') return { protected: true, permission: 'wechat_menu.manage' };
  return { protected: true, permission: null };
}

function bargainReadMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const globalPath='/admin/marketing/store_bargain/bargain_list', statisticsPath='/admin/marketing/store_bargain/statistics';
  const route=normalizeAdminRoute(menu.apiUrl), legacyRoute=/^marketing\/(?:bargain_list(?:_info)?(?:\/|$)|bargain\/statistics\/)/u.test(route);
  const claims=[755,807,833,1551].includes(menu.id) || [globalPath,statisticsPath].includes(menu.menuPath)
    || menu.uniqueAuth==='marketing-store_bargain-bargain_list' || legacyRoute;
  if(!claims)return {protected:false,permission:null};
  const page=menu.authType===1 && menu.apiUrl==='' && menu.methods==='';
  if(menu.id===755 && page && menu.menuPath===globalPath && menu.uniqueAuth==='marketing-store_bargain-bargain_list')return {protected:true,permission:'bargain_record.view'};
  if(menu.id===1551 && page && menu.menuPath===statisticsPath && menu.uniqueAuth==='')return {protected:true,permission:'bargain_statistics.view'};
  const api=menu.authType===2 && menu.methods==='GET' && menu.menuPath==='' && menu.uniqueAuth==='';
  if(api && ((menu.id===807 && menu.apiUrl==='marketing/bargain_list') || (menu.id===833 && menu.apiUrl==='marketing/bargain_list_info/<id>')))
    return {protected:true,permission:'bargain_record.view'};
  return {protected:true,permission:null};
}

function legacyAdminMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const path = menu.menuPath.trim(), auth = menu.uniqueAuth.trim(), route = normalizeAdminRoute(menu.apiUrl);
  const adminApi = /^(?:setting\/(?:admin(?:\/|$)|set_status(?:\/|$)|admin-authority(?:\/|$))|system\/legacy-staff(?:\/|$))/.test(route);
  const protectedClaim = legacyAdminActionIds.has(menu.id) || adminApi
    || /^\/admin\/setting\/system_admin(?:\/|$)/.test(path.toLowerCase().replace(/\s+/g,'')) || path.toLowerCase() === '/system/legacy-staff'
    || auth.toLowerCase() === 'setting-system-list' || auth.toLowerCase().startsWith('setting-system_admin-') || legacyAdminCapabilities.has(auth.toLowerCase());
  if (!protectedClaim) return { protected:false,permission:null };
  let permission: string | null = null;
  if (menu.authType === 1 && menu.apiUrl === '' && menu.methods === '' && menu.menuPath === path && menu.uniqueAuth === auth) {
    if (path === '/admin/setting/system_admin/index' && auth === 'setting-system-list') permission = 'system.legacy_admin_view';
    if ([['/admin/setting/system_admin/add','setting-system_admin-add'],['/admin/setting/system_admin/edit','setting-system_admin-edit']]
      .some(([page,key]) => path === page && auth === key)) permission = 'system.legacy_admin_form_view';
  } else if (menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === '' && !/\s/.test(menu.apiUrl.trim())) {
    const methods = menu.methods.trim().toUpperCase();
    // One exact method, rather than the generic non-GET -> POST folding.
    if (['GET','HEAD','POST','PUT','DELETE'].includes(methods)) permission = legacyAdminPermission(methods,route);
  }
  const expected: Record<number,string> = {
    20:'system.legacy_admin_view',
    331:'system.legacy_admin_form_view',332:'system.legacy_admin_form_view',333:'system.legacy_admin_manage',
    334:'system.legacy_admin_form_view',335:'system.legacy_admin_form_view',336:'system.legacy_admin_manage',
    337:'system.legacy_admin_manage',610:'system.legacy_admin_view',635:'system.legacy_admin_manage',
  };
  // Preserve the audited operation identity, not just its capability category.
  const methods = menu.methods.trim().toUpperCase();
  const identityMatches = !legacyAdminActionIds.has(menu.id) || (
    menu.id === 20 ? menu.authType === 1 && path === '/admin/setting/system_admin/index' :
    menu.id === 331 ? menu.authType === 1 && path === '/admin/setting/system_admin/add' :
    menu.id === 334 ? menu.authType === 1 && path === '/admin/setting/system_admin/edit' :
    menu.id === 332 ? ['GET','HEAD'].includes(methods) && route === 'setting/admin/create' :
    menu.id === 333 ? methods === 'POST' && route === 'setting/admin' :
    menu.id === 335 ? ['GET','HEAD'].includes(methods) && /^setting\/admin\/(?:<id>|:id|[1-9]\d*)\/edit$/.test(route) :
    menu.id === 336 ? methods === 'PUT' && /^setting\/admin\/(?:<id>|:id|[1-9]\d*)$/.test(route) :
    menu.id === 337 ? methods === 'DELETE' && /^setting\/admin\/(?:<id>|:id|[1-9]\d*)$/.test(route) :
    menu.id === 610 ? ['GET','HEAD'].includes(methods) && route === 'setting/admin' :
    methods === 'PUT' && /^setting\/set_status\/(?:<id>|:id|[1-9]\d*)\/(?:<status>|:status|[01])$/.test(route)
  );
  return { protected:true,permission:identityMatches && (!expected[menu.id] || permission === expected[menu.id]) ? permission : null };
}

const legacyRoleActionIds = new Set([19,325,326,327,328,329,330,611]);
const legacyRoleCapabilities = new Set(['system.legacy_role_view','system.legacy_role_form_view',
  'system.legacy_role_manage','system.legacy_role_status','system.legacy_role_delete',legacyRolePreviewPermission]);
/** The old save, status and deletion menus represent independent actions.
 * Protect every claimed identity before generic non-GET -> POST or opaque
 * fallback, even when a forged row would otherwise produce no permissions. */
function legacyRoleMenuBinding(menu: LegacyAdminMenuMetadata): { protected: boolean; permission: string | null } {
  const path = menu.menuPath.trim(), auth = menu.uniqueAuth.trim(), route = normalizeAdminRoute(menu.apiUrl);
  const roleApi = /^(?:setting\/(?:role(?:\/|$)|role-authority(?:\/|$))|system\/legacy-roles(?:\/|$))/.test(route);
  const protectedClaim = legacyRoleActionIds.has(menu.id) || roleApi
    || /^\/admin\/setting\/system_role(?:\/|$)/.test(path.toLowerCase().replace(/\s+/g,'')) || path.toLowerCase() === '/system/legacy-roles'
    || auth.toLowerCase() === 'setting-system-role' || auth.toLowerCase().startsWith('setting-system_role-') || legacyRoleCapabilities.has(auth.toLowerCase());
  if (!protectedClaim) return { protected:false,permission:null };
  const method = menu.methods.trim().toUpperCase();
  let permission: string | null = null;
  if (menu.authType === 1 && menu.apiUrl === '' && menu.methods === '' && menu.menuPath === path && menu.uniqueAuth === auth) {
    if (path === '/admin/setting/system_role/index' && auth === 'setting-system-role') permission = 'system.legacy_role_view';
    if (path === '/admin/setting/system_role/add' && auth === 'setting-system_role-add') permission = 'system.legacy_role_form_view';
  } else if (menu.authType === 2 && menu.menuPath === '' && menu.uniqueAuth === '' && !/\s/.test(menu.apiUrl)
    && menu.apiUrl.replace(/^\/(?:api\/admin|adminapi)\//,'') === route && ['GET','HEAD','POST','PUT','DELETE'].includes(method)) {
    permission = legacyRolePermission(method,route);
  }
  const expected: Record<number,string> = {
    19:'system.legacy_role_view',325:'system.legacy_role_form_view',326:'system.legacy_role_form_view',
    327:'system.legacy_role_manage',328:'system.legacy_role_form_view',329:'system.legacy_role_status',
    330:'system.legacy_role_delete',611:'system.legacy_role_view',
  };
  const identityMatches = !legacyRoleActionIds.has(menu.id) || (
    menu.id === 19 ? menu.authType === 1 && path === '/admin/setting/system_role/index' :
    menu.id === 325 ? menu.authType === 1 && path === '/admin/setting/system_role/add' :
    menu.id === 326 ? ['GET','HEAD'].includes(method) && route === 'setting/role/create' :
    menu.id === 327 ? method === 'POST' && /^setting\/role\/(?:<id>|:id|0|[1-9]\d*)$/.test(route) :
    menu.id === 328 ? ['GET','HEAD'].includes(method) && /^setting\/role\/(?:<id>|:id|[1-9]\d*)\/edit$/.test(route) :
    menu.id === 329 ? method === 'PUT' && /^setting\/role\/set_status\/(?:<id>|:id|[1-9]\d*)\/(?:<status>|:status|[01])$/.test(route) :
    menu.id === 330 ? method === 'DELETE' && /^setting\/role\/(?:<id>|:id|[1-9]\d*)$/.test(route) :
    ['GET','HEAD'].includes(method) && route === 'setting/role'
  );
  return { protected:true,permission:identityMatches && (!expected[menu.id] || permission === expected[menu.id]) ? permission : null };
}

export function canRetainOpaqueLegacyMenu(menu: Pick<typeof systemMenus.$inferSelect,
  'id' | 'authType' | 'apiUrl' | 'methods' | 'menuPath' | 'uniqueAuth'>): boolean {
  if (wechatRoutineMenuBinding(menu).protected || wechatAppMenuBinding(menu).protected || pcBaseBinding(menu).protected || wechatOpenBinding(menu).protected || wechatBaseBinding(menu).protected || wechatMenuBinding(menu).protected || bargainReadMenuBinding(menu).protected || unprovedProductStockMenuClaim(menu) || unprovedProductModerationMenuClaim(menu) || productGenerationMenuBinding(menu).protected || productRecycleMenuBinding(menu).protected || unprovedErpMenuClaim(menu) || productCatalogReadMenuBinding(menu).protected || productReplyMenuBinding(menu).protected || operationalGroupMenuBinding(menu).protected || productCategoryMenuBinding(menu).protected || productBrandMenuBinding(menu).protected || productLabelMenuBinding(menu).protected || legacyAdminMenuBinding(menu).protected || legacyRoleMenuBinding(menu).protected) return false;
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
    return ADMIN_PERMISSION_GROUPS.filter(group => !['wechat_app', 'wechat_routine'].includes(group.key)).map((group) => ({
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
          { key: "system.legacy_admin_form_view", label: "旧管理员表单（下一层级）" },
          { key: "system.legacy_admin_manage", label: "旧管理员管理（下一层级）" },
          { key: "system.legacy_role_view", label: "旧角色列表（下一层级）" },
          { key: "system.legacy_role_form_view", label: "旧角色表单（下一层级）" },
          { key: "system.legacy_role_manage", label: "旧角色保存（下一层级）" },
          { key: "system.legacy_role_status", label: "旧角色启停（下一层级）" },
          { key: "system.legacy_role_delete", label: "旧角色删除（下一层级）" },
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
            pid: systemMenus.pid, type: systemMenus.type, module: systemMenus.module, controller: systemMenus.controller, action: systemMenus.action,
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
                and(eq(systemMenus.id,1361),eq(systemMenus.uniqueAuth,'app-pc'),eq(systemMenus.menuPath,'/admin/app/pc')),
                and(eq(systemMenus.id,1379),eq(systemMenus.uniqueAuth,'app-app'),eq(systemMenus.menuPath,'/admin/app/app')),
                and(eq(systemMenus.id,1346),eq(systemMenus.uniqueAuth,'routine-download'),eq(systemMenus.menuPath,'/admin/app/routine/download')),
                and(eq(systemMenus.id,1360),eq(systemMenus.uniqueAuth,'app-wechat-open'),eq(systemMenus.menuPath,'/admin/app/wechat_open')),
                and(eq(systemMenus.id,1362),eq(systemMenus.uniqueAuth,'app-wechat-base'),eq(systemMenus.menuPath,'/admin/app/wechat/base')),
                and(eq(systemMenus.id,755),eq(systemMenus.uniqueAuth,'marketing-store_bargain-bargain_list'),eq(systemMenus.menuPath,'/admin/marketing/store_bargain/bargain_list')),
                and(eq(systemMenus.id,1551),eq(systemMenus.uniqueAuth,''),eq(systemMenus.menuPath,'/admin/marketing/store_bargain/statistics')),
                and(eq(systemMenus.id, 227), eq(systemMenus.uniqueAuth, 'user-user-group'), eq(systemMenus.menuPath, '/admin/user/group')),
                and(eq(systemMenus.id, 263), eq(systemMenus.uniqueAuth, 'admin-user-group'), eq(systemMenus.menuPath, '/admin/user/group')),
                and(eq(systemMenus.id, 6), eq(systemMenus.uniqueAuth, 'product-product-reply'),
                  eq(systemMenus.menuPath, '/admin/product/product_reply')),
                and(eq(systemMenus.id, 2), eq(systemMenus.uniqueAuth, 'admin-store-storeProuduct-index'),
                  eq(systemMenus.menuPath, '/admin/product/product_list')),
                and(eq(systemMenus.id, 99), eq(systemMenus.uniqueAuth, 'product-product-attr'),
                  eq(systemMenus.menuPath, '/admin/product/product_attr')),
                and(eq(systemMenus.id, 1349), eq(systemMenus.uniqueAuth, 'admin-storeProduct-unit'),
                  eq(systemMenus.menuPath, '/admin/product/unitList')),
                and(eq(systemMenus.id, 1381), eq(systemMenus.uniqueAuth, 'admin-storeProduct-specs'),
                  eq(systemMenus.menuPath, '/admin/product/specs')),
                and(eq(systemMenus.id, 1382), eq(systemMenus.uniqueAuth, 'admin-storeProduct-ensure'),
                  eq(systemMenus.menuPath, '/admin/product/ensure')),
                and(eq(systemMenus.uniqueAuth, "setting-system-list"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system_admin-add"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/add")),
                and(eq(systemMenus.uniqueAuth, "setting-system_admin-edit"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/edit")),
                and(eq(systemMenus.uniqueAuth, "setting-system-role"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system_role-add"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/add")),
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
                and(eq(systemMenus.uniqueAuth, "system-maintain-system-log"),
                  eq(systemMenus.menuPath, "/admin/system/maintain/system_log/index")),
                and(eq(systemMenus.id, 720), eq(systemMenus.uniqueAuth, 'setting-delivery-service'),
                  eq(systemMenus.menuPath, '/admin/setting/delivery_service/index'),
                  eq(systemMenus.apiUrl, ''), eq(systemMenus.methods, '')),
                and(eq(systemMenus.id, 1380), eq(systemMenus.uniqueAuth, "admin-storeProduct-label"),
                  eq(systemMenus.menuPath, "/admin/product/label")),
                and(eq(systemMenus.id, 3), eq(systemMenus.uniqueAuth, 'admin-store-storeCategory-index'), eq(systemMenus.menuPath, '/admin/product/product_classify')),
                and(eq(systemMenus.id, 1338), eq(systemMenus.uniqueAuth, "admin-store-storeBrand-index"),
                  eq(systemMenus.menuPath, "/admin/product/product_brand")),
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
    if (isAdminWechatRoutineRecoveryRoute(method,routePath) || isAdminWechatAppRecoveryRoute(method,routePath) || isAdminPcBaseRecoveryRoute(method,routePath) || isAdminWechatOpenRecoveryRoute(method,routePath) || isAdminWechatBaseRecoveryRoute(method,routePath) || isAdminAuthorityRecoveryRoute(method,routePath) || isAdminProductEditorRecoveryRoute(method,routePath) || isAdminProductVideoRecoveryRoute(method,routePath)) return;
    if (isAdminProfileRoute(method,routePath) || isAdminPlatformMenuRecoveryRoute(method,routePath) || isAdminExpressRecoveryRoute(method,routePath) || isAdminLevelRecoveryRoute(method,routePath) || isAdminUserLabelRecoveryRoute(method,routePath) || isAdminStoreRecoveryRoute(method,routePath) || isAdminStaffRecoveryRoute(method,routePath) || isAdminDeliveryRecoveryRoute(method,routePath) || isAdminGroupRecoveryRoute(method,routePath) || isAdminUnitRecoveryRoute(method,routePath) || isAdminEnsureRecoveryRoute(method,routePath) || isAdminRuleRecoveryRoute(method,routePath) || isAdminParameterRecoveryRoute(method,routePath) || isAdminHotwordRecoveryRoute(method,routePath) || isAdminProductLabelRecoveryRoute(method,routePath)) return;
    if (admin.level === 0) return;
    // Common header: authenticated financial/product-only roles need not hold
    // dashboard access. The controller independently filters EVERY count by role.
    if (["GET", "HEAD"].includes(method.toUpperCase()) && normalizeAdminRoute(routePath) === "new_push") return;
    const required = requiredAdminPermission(method, routePath);
    if (!required) {
      throw new AuthException("该管理接口尚未登记权限规则", ApiErrorCode.ERR_AUTH);
    }
    const granted = await this.resolveAdminPermissionKeys(admin);
    // Shared legacy URL admission only. Strict complete-body dispatch repeats
    // fresh authority inside the corresponding domain transaction. The default
    // route permission remains Base for existing permission/introspection callers.
    if (method.toUpperCase() === 'POST' && normalizeAdminRoute(routePath) === 'setting/config/save_basics'
      && (hasAdminPermission(granted, 'wechat_open.manage') || hasAdminPermission(granted, 'pc_base.manage') || hasAdminPermission(granted, 'wechat_app.manage') || hasAdminPermission(granted, 'wechat_routine.manage'))) return;
    if (!hasAdminPermission(granted, required)) {
      throw new AuthException("暂时没有权限访问", ApiErrorCode.ERR_AUTH);
    }
  }

  buildMenus(keys: ReadonlySet<string>): Array<Record<string, unknown>> {
    const menus: Array<Record<string, unknown>> = ADMIN_PERMISSION_GROUPS.filter(
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
    if (hasAdminPermission(keys, 'system.legacy_admin_view')) menus.push({
      id: 20_001, pid: 0, path: '/system/legacy-staff', name: '下一层级管理员',
      icon: '', sort: 0, type: 1, children: [],
    });
    if (hasAdminPermission(keys, 'system.legacy_role_view')) menus.push({
      id: 20_002, pid: 0, path: '/system/legacy-roles', name: '下一层级角色',
      icon: '', sort: 0, type: 1, children: [],
    });
    return menus;
  }

  private async resolveRuleTokens(tokens: readonly string[], lockForDecision = false): Promise<Set<string>> {
    const legacyIds = tokens.filter(isNumericToken).map(Number);
    const menuQuery = this.container.db
          .select({
            id: systemMenus.id,
            pid: systemMenus.pid, type: systemMenus.type, module: systemMenus.module, controller: systemMenus.controller, action: systemMenus.action,
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
                and(eq(systemMenus.id,1361),eq(systemMenus.uniqueAuth,'app-pc'),eq(systemMenus.menuPath,'/admin/app/pc')),
                and(eq(systemMenus.id,1379),eq(systemMenus.uniqueAuth,'app-app'),eq(systemMenus.menuPath,'/admin/app/app')),
                and(eq(systemMenus.id,1346),eq(systemMenus.uniqueAuth,'routine-download'),eq(systemMenus.menuPath,'/admin/app/routine/download')),
                and(eq(systemMenus.id,1360),eq(systemMenus.uniqueAuth,'app-wechat-open'),eq(systemMenus.menuPath,'/admin/app/wechat_open')),
                and(eq(systemMenus.id,1362),eq(systemMenus.uniqueAuth,'app-wechat-base'),eq(systemMenus.menuPath,'/admin/app/wechat/base')),
                and(eq(systemMenus.id,755),eq(systemMenus.uniqueAuth,'marketing-store_bargain-bargain_list'),eq(systemMenus.menuPath,'/admin/marketing/store_bargain/bargain_list')),
                and(eq(systemMenus.id,1551),eq(systemMenus.uniqueAuth,''),eq(systemMenus.menuPath,'/admin/marketing/store_bargain/statistics')),
                and(eq(systemMenus.id, 227), eq(systemMenus.uniqueAuth, 'user-user-group'), eq(systemMenus.menuPath, '/admin/user/group')),
                and(eq(systemMenus.id, 263), eq(systemMenus.uniqueAuth, 'admin-user-group'), eq(systemMenus.menuPath, '/admin/user/group')),
                and(eq(systemMenus.id, 6), eq(systemMenus.uniqueAuth, 'product-product-reply'),
                  eq(systemMenus.menuPath, '/admin/product/product_reply')),
                and(eq(systemMenus.id, 2), eq(systemMenus.uniqueAuth, 'admin-store-storeProuduct-index'),
                  eq(systemMenus.menuPath, '/admin/product/product_list')),
                and(eq(systemMenus.id, 99), eq(systemMenus.uniqueAuth, 'product-product-attr'),
                  eq(systemMenus.menuPath, '/admin/product/product_attr')),
                and(eq(systemMenus.id, 1349), eq(systemMenus.uniqueAuth, 'admin-storeProduct-unit'),
                  eq(systemMenus.menuPath, '/admin/product/unitList')),
                and(eq(systemMenus.id, 1381), eq(systemMenus.uniqueAuth, 'admin-storeProduct-specs'),
                  eq(systemMenus.menuPath, '/admin/product/specs')),
                and(eq(systemMenus.id, 1382), eq(systemMenus.uniqueAuth, 'admin-storeProduct-ensure'),
                  eq(systemMenus.menuPath, '/admin/product/ensure')),
                and(eq(systemMenus.uniqueAuth, "setting-system-list"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system_admin-add"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/add")),
                and(eq(systemMenus.uniqueAuth, "setting-system_admin-edit"),
                  eq(systemMenus.menuPath, "/admin/setting/system_admin/edit")),
                and(eq(systemMenus.uniqueAuth, "setting-system-role"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/index")),
                and(eq(systemMenus.uniqueAuth, "setting-system_role-add"),
                  eq(systemMenus.menuPath, "/admin/setting/system_role/add")),
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
                and(eq(systemMenus.uniqueAuth, "system-maintain-system-log"),
                  eq(systemMenus.menuPath, "/admin/system/maintain/system_log/index")),
                and(eq(systemMenus.id, 720), eq(systemMenus.uniqueAuth, 'setting-delivery-service'),
                  eq(systemMenus.menuPath, '/admin/setting/delivery_service/index'),
                  eq(systemMenus.apiUrl, ''), eq(systemMenus.methods, '')),
                and(eq(systemMenus.id, 1380), eq(systemMenus.uniqueAuth, "admin-storeProduct-label"),
                  eq(systemMenus.menuPath, "/admin/product/label")),
                and(eq(systemMenus.id, 3), eq(systemMenus.uniqueAuth, 'admin-store-storeCategory-index'), eq(systemMenus.menuPath, '/admin/product/product_classify')),
                and(eq(systemMenus.id, 1338), eq(systemMenus.uniqueAuth, "admin-store-storeBrand-index"),
                  eq(systemMenus.menuPath, "/admin/product/product_brand")),
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
      pid?: number; type?: number; module?: string; controller?: string; action?: string;
    }>,
  ): Set<string> {
    // App and Routine view/manage require their whole fixed legacy selection.
    // Keys remain available for computed grants and level0; opaque role strings
    // cannot manufacture either domain's exact page/shared-save authority.
    const resolved = new Set(tokens.filter((token) => permissionKeys.has(token)
      && !token.startsWith('wechat_app.') && !token.startsWith('wechat_routine.')));
    const allowedLegacyIds = new Set(tokens.filter(isNumericToken).map(Number));
    if (allowedLegacyIds.size) {
      const selected = menus.filter(menu => allowedLegacyIds.has(menu.id));
      for (const key of pcBasePermissionsFromMenus(selected)) resolved.add(key);
      for (const key of wechatAppPermissionsFromMenus(selected)) resolved.add(key);
      for (const key of wechatRoutinePermissionsFromMenus(selected)) resolved.add(key);
      if (selected.some(menu => wechatOpenBinding(menu).permission === 'wechat_open.view')
        && selected.some(menu => wechatBaseBinding(menu).save)) resolved.add('wechat_open.manage');
      if (selected.some(menu => wechatBaseBinding(menu).permission === 'wechat_base.view')
        && selected.some(menu => wechatBaseBinding(menu).save)) resolved.add('wechat_base.manage');
      for (const menu of menus) {
        if (!allowedLegacyIds.has(menu.id)) continue;
        // Wildcard attachment rows cannot acquire a grant by rewriting their
        // metadata into a protected or generic API tuple.
        if (menu.id === 579 || menu.id === 580) continue;
        if (unprovedProductStockMenuClaim(menu)) continue;
        if (unprovedProductModerationMenuClaim(menu)) continue;
        const generationBinding = productGenerationMenuBinding(menu);
        if (generationBinding.protected) {
          if (generationBinding.permission) resolved.add(generationBinding.permission);
          continue;
        }
        const recycleBinding = productRecycleMenuBinding(menu);
        if (recycleBinding.protected) {
          if (recycleBinding.permission) resolved.add(recycleBinding.permission);
          continue;
        }
        const catalogReadBinding = productCatalogReadMenuBinding(menu);
        if (catalogReadBinding.protected) {
          if (catalogReadBinding.permission) resolved.add(catalogReadBinding.permission);
          continue;
        }
        const replyBinding = productReplyMenuBinding(menu);
        if (replyBinding.protected) {
          if (replyBinding.permission) resolved.add(replyBinding.permission);
          continue;
        }
        // Only the exact PHP specification page seed grants catalog reads.
        if (menu.id === 99 || menu.menuPath.toLowerCase() === '/admin/product/product_attr'
          || menu.uniqueAuth.toLowerCase() === 'product-product-attr') {
          if (menu.id === 99 && menu.authType === 1 && menu.menuPath === '/admin/product/product_attr'
            && menu.uniqueAuth === 'product-product-attr' && menu.apiUrl === '' && menu.methods === '') {
            resolved.add('product.view');
          }
          continue;
        }
        // Seed 1383 routes to the parameter editor in the old SPA despite its
        // guarantee-page URL. It is not a proved catalog read/write grant.
        if (menu.id === 1383 || menu.menuPath.toLowerCase() === '/admin/product/ensure/create'
          || menu.uniqueAuth.toLowerCase() === 'admin-storeproduct-ensure-create') continue;
        if (menu.id === 1382 || menu.menuPath.toLowerCase() === '/admin/product/ensure'
          || menu.uniqueAuth.toLowerCase() === 'admin-storeproduct-ensure') {
          if (menu.id === 1382 && menu.authType === 1 && menu.menuPath === '/admin/product/ensure'
            && menu.uniqueAuth === 'admin-storeProduct-ensure' && menu.apiUrl === '' && menu.methods === '') {
            resolved.add('product.view');
          }
          continue;
        }
        // Exact PHP parameter-template page seed grants reads. Its neighbouring
        // create-page seed 1383 belongs to product guarantees, not parameters.
        if (menu.id === 1381 || menu.menuPath.toLowerCase() === '/admin/product/specs'
          || menu.uniqueAuth.toLowerCase() === 'admin-storeproduct-specs') {
          if (menu.id === 1381 && menu.authType === 1 && menu.menuPath === '/admin/product/specs'
            && menu.uniqueAuth === 'admin-storeProduct-specs' && menu.apiUrl === '' && menu.methods === '') {
            resolved.add('product.view');
          }
          continue;
        }
        // The original unit page grants reads only. A copied path/auth or
        // rewritten API tuple cannot turn its page seed into a writer grant.
        if (menu.id === 1349 || menu.menuPath.toLowerCase() === '/admin/product/unitlist'
          || menu.uniqueAuth.toLowerCase() === 'admin-storeproduct-unit') {
          if (menu.id === 1349 && menu.authType === 1 && menu.menuPath === '/admin/product/unitList'
            && menu.uniqueAuth === 'admin-storeProduct-unit' && menu.apiUrl === '' && menu.methods === '') {
            resolved.add('product.view');
          }
          continue;
        }
        if ([227, 263].includes(menu.id) || menu.menuPath.toLowerCase() === '/admin/user/group'
          || ['user-user-group', 'admin-user-group'].includes(menu.uniqueAuth.toLowerCase())) {
          const expectedAuth = menu.id === 227 ? 'user-user-group' : menu.id === 263 ? 'admin-user-group' : '';
          if (expectedAuth && menu.authType === 1 && menu.menuPath === '/admin/user/group'
            && menu.uniqueAuth === expectedAuth && menu.apiUrl === '' && menu.methods === '') resolved.add('user.view');
          continue;
        }
        if (unprovedErpMenuClaim(menu)) continue;
        const operationalBinding = operationalGroupMenuBinding(menu);
        if (operationalBinding.protected) {
          if (operationalBinding.permission) resolved.add(operationalBinding.permission);
          continue;
        }
        const categoryBinding = productCategoryMenuBinding(menu);
        if (categoryBinding.protected) {
          if (categoryBinding.permission) resolved.add(categoryBinding.permission);
          continue;
        }
        const brandBinding = productBrandMenuBinding(menu);
        if (brandBinding.protected) {
          if (brandBinding.permission) resolved.add(brandBinding.permission);
          continue;
        }
        const labelBinding = productLabelMenuBinding(menu);
        if (labelBinding.protected) {
          if (labelBinding.permission) resolved.add(labelBinding.permission);
          continue;
        }
        const pcBinding = pcBaseBinding(menu);
        if (pcBinding.protected) { if (pcBinding.permission) resolved.add(pcBinding.permission); continue; }
        const openBinding = wechatOpenBinding(menu);
        if (openBinding.protected) { if (openBinding.permission) resolved.add(openBinding.permission); continue; }
        const baseBinding = wechatBaseBinding(menu);
        if (baseBinding.protected) {
          if (baseBinding.permission) resolved.add(baseBinding.permission);
          continue;
        }
        // Shared315 keeps its existing Base/Open/PC meaning above. App and
        // Routine composition independently use the whole selected set.
        const appBinding = wechatAppMenuBinding(menu);
        if (appBinding.protected) { if (appBinding.view) resolved.add('wechat_app.view'); continue; }
        const routineBinding = wechatRoutineMenuBinding(menu);
        // All Routine grants were derived from the unique complete selection;
        // a per-row fallback must not weaken duplicate/partial-tuple rejection.
        if (routineBinding.protected) continue;
        const wechatBinding = wechatMenuBinding(menu);
        if (wechatBinding.protected) {
          if (wechatBinding.permission) resolved.add(wechatBinding.permission);
          continue;
        }
        const bargainBinding = bargainReadMenuBinding(menu);
        if (bargainBinding.protected) {
          if (bargainBinding.permission) resolved.add(bargainBinding.permission);
          continue;
        }
        const legacyAdmin = legacyAdminMenuBinding(menu);
        if (legacyAdmin.protected) {
          if (legacyAdmin.permission) resolved.add(legacyAdmin.permission);
          continue;
        }
        const legacyRole = legacyRoleMenuBinding(menu);
        if (legacyRole.protected) {
          if (legacyRole.permission) resolved.add(legacyRole.permission);
          continue;
        }
        // Fixed PHP page 720 is a read grant, never an order writer. A row
        // claiming its identity cannot fall through to generic API rules.
        if (menu.id === 720 || menu.menuPath === '/admin/setting/delivery_service/index'
          || menu.uniqueAuth === 'setting-delivery-service') {
          if (menu.id === 720 && menu.authType === 1 && menu.menuPath === '/admin/setting/delivery_service/index'
            && menu.uniqueAuth === 'setting-delivery-service' && menu.apiUrl === '' && menu.methods === '') {
            resolved.add('order.view');
          }
          continue;
        }
        // This is the server operation-log page, separate from Vuex's local
        // frontend log. Its legacy page/auth tuple grants only log reads.
        if (menu.menuPath === "/admin/system/maintain/system_log/index"
          || menu.uniqueAuth === "system-maintain-system-log") {
          if (menu.authType === 1 && menu.menuPath === "/admin/system/maintain/system_log/index"
            && menu.uniqueAuth === "system-maintain-system-log" && menu.apiUrl === "" && menu.methods === "") {
            resolved.add("log.view");
          }
          continue;
        }
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
      if (key === "system.legacy_admin_manage") {
        resolved.add("system.legacy_admin_view");
        resolved.add("system.legacy_admin_form_view");
      }
      if (key === "system.legacy_role_manage") {
        resolved.add("system.legacy_role_view");
        resolved.add("system.legacy_role_form_view");
      }
      if (key === "system.legacy_role_status" || key === "system.legacy_role_delete") resolved.add("system.legacy_role_view");
    }
    return resolved;
  }
}
