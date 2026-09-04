export type LegacyRouteCoverage = "candidate_covered" | "partial_replacement";

export interface LegacyRouteRule {
  target: string;
  coverage: LegacyRouteCoverage;
  queryAliases?: Readonly<Record<string, string>>;
}

/**
 * Keep this list in lock-step with pages.json. Runtime links are server-managed
 * content, so accepting an arbitrary /pages/* string only turns stale content
 * into a silent UniApp navigation failure.
 */
export const REGISTERED_PAGE_ROUTES = new Set<string>([
  "/pages/index/index",
  "/pages/goods/cate",
  "/pages/discover/index",
  "/pages/discover/people",
  "/pages/cart/index",
  "/pages/user/index",
  "/pages/goods/list",
  "/pages/goods/detail",
  "/pages/article/list",
  "/pages/article/detail",
  "/pages/diy/detail",
  "/pages/auth/login",
  "/pages/auth/register",
  "/pages/auth/reset",
  "/pages/auth/smsChallenge",
  "/pages/auth/scanLogin",
  "/pages/user/changePassword",
  "/pages/user/phone",
  "/pages/order/confirm",
  "/pages/order/list",
  "/pages/order/detail",
  "/pages/order/express",
  "/pages/order/reply",
  "/pages/order/refundApply",
  "/pages/order/refundList",
  "/pages/order/refundDetail",
  "/pages/user/integral",
  "/pages/user/sign",
  "/pages/user/profile",
  "/pages/user/couponCenter",
  "/pages/user/messageDetail",
  "/pages/user/integralLogs",
  "/pages/user/kefu",
  "/pages/user/balanceLogs",
  "/pages/user/address",
  "/pages/user/collect",
  "/pages/user/coupon",
  "/pages/user/finance",
  "/pages/user/spread",
  "/pages/user/bank",
  "/pages/user/payPassword",
  "/pages/user/vipOpen",
  "/pages/annex/vip_active/index",
  "/pages/user/invoice",
  "/pages/goods/search",
  "/pages/goods/commentList",
  "/pages/goods/commentDetail",
  "/pages/activity/index",
  "/pages/activity/detail",
  "/pages/activity/seckillDetail",
  "/pages/activity/bargainDetail",
  "/pages/order/payResult",
  "/pages/user/level",
  "/pages/user/recharge",
  "/pages/user/message",
  "/pages/activity/lottery",
  "/pages/activity/lotteryRecords",
  "/pages/user/supplierApply",
  "/pages/operator/writeoff",
] as const);

export const TAB_ROUTES = new Set<string>([
  "/pages/index/index",
  "/pages/goods/cate",
  "/pages/discover/index",
  "/pages/cart/index",
  "/pages/user/index",
] as const);

const orderIdAlias = { order_id: "orderId" } as const;

/**
 * Only routes with a real target are listed. A partial replacement deliberately
 * lands on a consolidated screen, but is not counted as full functional parity.
 */
export const LEGACY_ROUTE_RULES: Readonly<Record<string, LegacyRouteRule>> = {
  "/pages/guide/index": { target: "/pages/index/index", coverage: "partial_replacement" },
  "/pages/order_addcart/order_addcart": { target: "/pages/cart/index", coverage: "candidate_covered" },
  "/pages/goods_details/index": { target: "/pages/goods/detail", coverage: "candidate_covered" },
  "/pages/goods_cate/goods_cate": { target: "/pages/goods/cate", coverage: "candidate_covered" },
  "/pages/discoverIndex/index": { target: "/pages/discover/index", coverage: "candidate_covered" },

  "/pages/users/user_vip_areer/index": { target: "/pages/user/level", coverage: "partial_replacement" },
  "/pages/users/message_center/index": { target: "/pages/user/message", coverage: "candidate_covered" },
  "/pages/users/message_center/messageDetail": { target: "/pages/user/messageDetail", coverage: "candidate_covered" },
  "/pages/users/user_invoice_order/index": { target: "/pages/user/invoice", coverage: "partial_replacement" },
  "/pages/users/scan_login/index": { target: "/pages/auth/scanLogin", coverage: "candidate_covered" },
  "/pages/users/user_invoice_list/index": { target: "/pages/user/invoice", coverage: "candidate_covered" },
  "/pages/users/user_invoice_form/index": { target: "/pages/user/invoice", coverage: "partial_replacement" },
  "/pages/users/wechat_login/index": { target: "/pages/auth/login", coverage: "partial_replacement" },
  "/pages/users/binding_phone/index": { target: "/pages/user/phone", coverage: "candidate_covered" },
  "/pages/users/retrievePassword/index": { target: "/pages/auth/reset", coverage: "candidate_covered" },
  "/pages/users/user_set/index": { target: "/pages/user/profile", coverage: "partial_replacement" },
  "/pages/users/user_info/index": { target: "/pages/user/profile", coverage: "candidate_covered" },
  "/pages/users/user_goods_collection/index": { target: "/pages/user/collect", coverage: "candidate_covered" },
  "/pages/users/user_sgin/index": { target: "/pages/user/sign", coverage: "candidate_covered" },
  "/pages/users/user_sgin_list/index": { target: "/pages/user/integralLogs", coverage: "partial_replacement" },
  "/pages/users/user_money/index": { target: "/pages/user/balanceLogs", coverage: "partial_replacement" },
  "/pages/users/user_bill/index": { target: "/pages/user/balanceLogs", coverage: "candidate_covered" },
  "/pages/users/user_integral/index": { target: "/pages/user/integral", coverage: "candidate_covered" },
  "/pages/users/user_integral_detail/index": { target: "/pages/user/integralLogs", coverage: "candidate_covered" },
  "/pages/users/user_coupon/index": { target: "/pages/user/coupon", coverage: "candidate_covered" },
  "/pages/users/user_spread_user/index": { target: "/pages/user/finance", coverage: "candidate_covered" },
  "/pages/users/user_spread_code/index": { target: "/pages/user/spread", coverage: "candidate_covered" },
  "/pages/users/user_spread_money/index": { target: "/pages/user/finance", coverage: "candidate_covered" },
  "/pages/users/user_distribution_info/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/user_cash/index": { target: "/pages/user/finance", coverage: "candidate_covered" },
  "/pages/users/user_cash/status": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/user_vip/index": { target: "/pages/user/vipOpen", coverage: "candidate_covered" },
  "/pages/users/user_distribution_level/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/user_address_list/index": { target: "/pages/user/address", coverage: "candidate_covered" },
  "/pages/users/user_address/index": { target: "/pages/user/address", coverage: "candidate_covered" },
  "/pages/users/user_address/addClient": { target: "/pages/user/address", coverage: "partial_replacement" },
  "/pages/users/user_phone/index": { target: "/pages/user/phone", coverage: "candidate_covered" },
  "/pages/users/user_payment/index": { target: "/pages/user/recharge", coverage: "partial_replacement" },
  "/pages/users/user_pwd_edit/index": { target: "/pages/user/changePassword", coverage: "candidate_covered" },
  "/pages/users/promoter-list/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/promoter-order/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/promoter_rank/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/commission_rank/index": { target: "/pages/user/finance", coverage: "partial_replacement" },
  "/pages/users/user_return_list/index": { target: "/pages/order/refundList", coverage: "candidate_covered" },
  "/pages/users/login/index": { target: "/pages/auth/login", coverage: "candidate_covered" },
  "/pages/users/supplier/index": { target: "/pages/user/supplierApply", coverage: "candidate_covered" },
  "/pages/users/supplier/state": { target: "/pages/user/supplierApply", coverage: "candidate_covered" },
  "/pages/users/supplier/record": { target: "/pages/user/supplierApply", coverage: "candidate_covered" },

  "/pages/activity/goods_bargain/index": { target: "/pages/activity/index", coverage: "candidate_covered" },
  "/pages/activity/goods_bargain_details/index": { target: "/pages/activity/bargainDetail", coverage: "candidate_covered" },
  "/pages/activity/goods_combination/index": { target: "/pages/activity/index", coverage: "candidate_covered" },
  "/pages/activity/goods_combination_status/index": { target: "/pages/activity/detail", coverage: "partial_replacement" },
  "/pages/activity/goods_seckill/index": { target: "/pages/activity/index", coverage: "candidate_covered" },
  "/pages/activity/goods_details/index": { target: "/pages/goods/detail", coverage: "partial_replacement" },
  "/pages/activity/bargain/index": { target: "/pages/activity/index", coverage: "partial_replacement" },
  "/pages/activity/points_mall/index": { target: "/pages/user/integral", coverage: "candidate_covered" },
  "/pages/activity/coupon/index": { target: "/pages/user/couponCenter", coverage: "candidate_covered" },

  "/pages/admin/distribution/scanning/index": { target: "/pages/operator/writeoff", coverage: "partial_replacement" },
  "/pages/admin/distribution/scanning/detail/index": { target: "/pages/operator/writeoff", coverage: "partial_replacement" },
  "/pages/admin/writeRecordList/index": { target: "/pages/operator/writeoff", coverage: "partial_replacement" },
  "/pages/admin/offOrderResult/index": { target: "/pages/operator/writeoff", coverage: "partial_replacement" },
  "/pages/admin/writeOffCard/index": { target: "/pages/operator/writeoff", coverage: "candidate_covered" },

  "/pages/annex/vip_paid/index": { target: "/pages/user/vipOpen", coverage: "candidate_covered" },
  "/pages/annex/vip_paid_active/index": { target: "/pages/user/vipOpen", coverage: "partial_replacement" },
  "/pages/annex/vip_paid_rights/index": { target: "/pages/user/vipOpen", coverage: "candidate_covered" },
  "/pages/annex/vip_grade/index": { target: "/pages/user/level", coverage: "candidate_covered" },
  "/pages/annex/vip_grade_active/index": { target: "/pages/user/level", coverage: "partial_replacement" },
  "/pages/annex/vip_coupon/index": { target: "/pages/user/vipOpen", coverage: "partial_replacement" },
  "/pages/annex/vip_clause/index": { target: "/pages/user/vipOpen", coverage: "partial_replacement" },
  "/pages/annex/special/index": { target: "/pages/diy/detail", coverage: "candidate_covered" },

  "/pages/extension/invite_friend/index": { target: "/pages/user/spread", coverage: "candidate_covered" },
  "/pages/extension/customer_list/chat": { target: "/pages/user/kefu", coverage: "candidate_covered" },
  "/pages/extension/news_list/index": { target: "/pages/article/list", coverage: "candidate_covered" },
  "/pages/extension/news_details/index": { target: "/pages/article/detail", coverage: "candidate_covered" },

  "/pages/goods/goods_list/index": { target: "/pages/goods/list", coverage: "candidate_covered" },
  "/pages/goods/goods_search/index": {
    target: "/pages/goods/search",
    coverage: "candidate_covered",
    queryAliases: { searchVal: "keyword" },
  },
  "/pages/goods/order_pay_status/index": {
    target: "/pages/order/payResult",
    coverage: "partial_replacement",
    queryAliases: { order_id: "orderId", totalPrice: "amount" },
  },
  "/pages/goods/goods_comment_list/index": { target: "/pages/goods/commentList", coverage: "candidate_covered" },
  "/pages/goods/goods_comment_con/index": { target: "/pages/order/reply", coverage: "candidate_covered" },
  "/pages/goods/goods_comment_con/comment_con": { target: "/pages/goods/commentDetail", coverage: "candidate_covered" },
  "/pages/goods/goods_comment_con/lottery_comment": { target: "/pages/order/reply", coverage: "partial_replacement" },
  "/pages/goods/goods_logistics/index": { target: "/pages/order/express", coverage: "candidate_covered" },
  "/pages/goods/goods_return_list/index": { target: "/pages/order/refundList", coverage: "candidate_covered" },
  "/pages/goods/goods_return/index": { target: "/pages/order/refundApply", coverage: "candidate_covered" },
  "/pages/goods/order_details/index": {
    target: "/pages/order/detail",
    coverage: "candidate_covered",
    queryAliases: orderIdAlias,
  },
  "/pages/goods/order_list/index": { target: "/pages/order/list", coverage: "candidate_covered" },
  "/pages/goods/order_refund_goods/index": { target: "/pages/order/refundApply", coverage: "partial_replacement" },
  "/pages/goods/order_confirm/index": { target: "/pages/order/confirm", coverage: "candidate_covered" },
  "/pages/goods/lottery/grids/index": { target: "/pages/activity/lottery", coverage: "candidate_covered" },
  "/pages/goods/lottery/wheel/index": { target: "/pages/activity/lottery", coverage: "candidate_covered" },
  "/pages/goods/lottery/grids/record": { target: "/pages/activity/lotteryRecords", coverage: "candidate_covered" },
  "/pages/goods/order_after_details/index": { target: "/pages/order/refundDetail", coverage: "partial_replacement" },
  "/pages/goods/goodsDiscover/index": { target: "/pages/discover/index", coverage: "partial_replacement" },

  "/pages/discover/discoverUser/index": { target: "/pages/discover/people", coverage: "partial_replacement" },
  "/pages/discover/discoverCreate/index": { target: "/pages/discover/index", coverage: "partial_replacement" },
  "/pages/discover/discoverDetails/index": { target: "/pages/discover/index", coverage: "partial_replacement" },
  "/pages/discover/discoverFollow/index": { target: "/pages/discover/people", coverage: "partial_replacement" },
} as const;

function aliasQuery(query: string, aliases: Readonly<Record<string, string>> | undefined): string {
  if (!query || !aliases) return query;
  return query.split("&").map((part) => {
    const separator = part.indexOf("=");
    const key = separator < 0 ? part : part.slice(0, separator);
    const targetKey = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
    return separator < 0 ? targetKey : `${targetKey}${part.slice(separator)}`;
  }).join("&");
}

export function resolveRegisteredPageRoute(path: string, query = ""): string {
  const rule = LEGACY_ROUTE_RULES[path];
  const target = rule?.target ?? path;
  if (!REGISTERED_PAGE_ROUTES.has(target)) return "";
  const normalizedQuery = aliasQuery(query, rule?.queryAliases);
  return normalizedQuery ? `${target}?${normalizedQuery}` : target;
}
