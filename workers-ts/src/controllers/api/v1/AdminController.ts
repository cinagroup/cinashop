/**
 * 管理后台 + 客服 WebSocket 控制器 (M7)
 *
 * 对应 PHP:
 *   - app/controller/admin/Login.php (admin 登录)
 *   - app/controller/admin/Common.php (Dashboard homeStatics)
 *   - app/webscoket/Manager.php (WebSocket 入口)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail, jsonRaw } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { AdminAuthService } from "@/services/admin/AdminAuthService";
import {
  AdminDashboardService,
  parseAdminHomeCycle,
} from "@/services/admin/AdminDashboardService";
import {
  AdminStatisticService,
  parseAdminStatisticRange,
  parseCategoryIds,
  parseMobileOrderDataQuery,
  parseMobileOrderPeriod,
  parseProductRankingSort,
} from "@/services/admin/AdminStatisticService";
import { AdminMobileOrderReadService } from "@/services/admin/AdminMobileOrderReadService";
import { AdminMobileOrderOperationService } from "@/services/admin/AdminMobileOrderOperationService";
import { AdminMobileFulfillmentService } from "@/services/admin/AdminMobileFulfillmentService";
import { AdminMobileRefundOperationService } from "@/services/admin/AdminMobileRefundOperationService";
import {
  AdminAssistedOrderService,
  parseAssistedUid,
} from "@/services/admin/AdminAssistedOrderService";
import {
  AdminExtendedStatisticService,
  parseAdminStatisticChannel,
  parseUserRegionSort,
} from "@/services/admin/AdminExtendedStatisticService";
import type { AppVariables, Env } from "@/env";
import { upgradeChatSocket } from "@/services/kefu/KefuSocketGateway";
import { ErpCapabilityService } from "@/services/system/ErpCapabilityService";
import { readBoundedJsonObject } from "@/utils/request-body";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import {
  ADMIN_LOGIN_POLICY,
  enforceAdminLoginAccountLimit,
  enforceAdminLoginSourceLimit,
} from "@/middleware/admin-login-security";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** POST /api/admin/login — 管理员登录 */
export async function adminLogin(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  await enforceAdminLoginSourceLimit(c);
  const body = await readBoundedJsonObject(c.req.raw, ADMIN_LOGIN_POLICY.bodyLimitBytes);
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const password = typeof body.pwd === "string" ? body.pwd : "";
  if (!account || !password || account.length > 64 || password.length > 256) {
    return jsonFail(c, "请输入有效的账号和密码");
  }
  await enforceAdminLoginAccountLimit(c, account);
  const svc = new AdminAuthService(c.get("container"), c.env);
  try {
    const result = await svc.login(account, password);
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /adminapi/home/header — PHP 首页四项统计卡片。 */
export async function adminHomeHeader(c: C) {
  return jsonOk(c, await new AdminDashboardService(c.get("container")).header());
}

/** Historical v1 controller name retained for the /api/admin alias. */
export const adminDashboard = adminHomeHeader;

/** GET /adminapi/home/order?cycle=... — 订单金额/数量周期图。 */
export async function adminOrderChart(c: C) {
  const cycle = parseAdminHomeCycle(c.req.query("cycle"));
  return jsonOk(c, await new AdminDashboardService(c.get("container")).orderChart(cycle));
}

/** GET /adminapi/home/user — 30 天新增用户与消费分层。 */
export async function adminUserChart(c: C) {
  return jsonOk(c, await new AdminDashboardService(c.get("container")).userChart());
}

/** GET /adminapi/home/rank — PHP 当前稳定契约为空列表。 */
export async function adminPurchaseRanking(c: C) {
  return jsonOk(c, new AdminDashboardService(c.get("container")).purchaseRanking());
}

function statisticService(c: C): AdminStatisticService {
  return new AdminStatisticService(c.get("container"));
}

function extendedStatisticService(c: C): AdminExtendedStatisticService {
  return new AdminExtendedStatisticService(c.get("container"));
}

function privateAdminResponse(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
}

function mobileOrderReadService(c: C): AdminMobileOrderReadService {
  return new AdminMobileOrderReadService(c.get("container"));
}

function mobileOrderOperationService(c: C): AdminMobileOrderOperationService {
  return new AdminMobileOrderOperationService(c.get("container"));
}

function mobileFulfillmentService(c: C): AdminMobileFulfillmentService {
  return new AdminMobileFulfillmentService(c.get("container"), c.env);
}

function mobileRefundOperationService(c: C): AdminMobileRefundOperationService {
  return new AdminMobileRefundOperationService(c.get("container"), c.env);
}

function assistedOrderService(c: C): AdminAssistedOrderService {
  return new AdminAssistedOrderService(c.get("container"), c.env);
}

function verifiedAdminId(c: C): number {
  const actor = c.get("adminInfo");
  if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0) {
    throw new ValidateException("管理员身份不存在");
  }
  return actor.id;
}

function boundedClientIp(c: C): string {
  return clientIp(c).trim().slice(0, 45);
}

/** GET /api/admin/order/cart/:uid — actor-scoped assisted cart rows. */
export async function adminAssistedCartList(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).cartList(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    c.req.query(),
  ));
}

/** POST /api/admin/order/cart/add/:uid — add one normal product to an assisted cart. */
export async function adminAssistedCartAdd(c: C) {
  privateAdminResponse(c);
  const result = await assistedOrderService(c).cartAdd(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  );
  return jsonOk(c, result);
}

/** DELETE /api/admin/order/cart/del/:uid — exact-set assisted cart deletion. */
export async function adminAssistedCartDel(c: C) {
  privateAdminResponse(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  for (const [key, value] of Object.entries(c.req.query())) {
    if (!(key in body)) body[key] = value;
  }
  await assistedOrderService(c).cartDel(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    body,
  );
  return jsonOk(c, "删除成功");
}

/** POST /api/admin/order/cart/num/:uid — locked assisted cart quantity update. */
export async function adminAssistedCartNum(c: C) {
  privateAdminResponse(c);
  await assistedOrderService(c).cartNum(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  );
  return jsonOk(c, "修改成功");
}

/** GET /api/admin/order/place/list — only orders created by the current administrator. */
export async function adminAssistedPlaceList(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).placeList(verifiedAdminId(c), c.req.query()));
}

/** POST /api/admin/order/confirm/:uid — create an actor-bound checkout snapshot. */
export async function adminAssistedConfirm(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).confirm(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    await readBoundedJsonObject(c.req.raw, 16 * 1024),
  ));
}

/** POST /api/admin/order/computed/:key/:uid — recompute exclusively from the stored cart set. */
export async function adminAssistedComputed(c: C) {
  privateAdminResponse(c);
  const result = await assistedOrderService(c).computed(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    c.req.param("key") ?? "",
    await readBoundedJsonObject(c.req.raw, 16 * 1024),
  );
  if (result.extended) return jsonOk(c, { result: { orderId: result.orderId, key: result.key } }, "订单已生成");
  return jsonOk(c, { result: result.result });
}

/** GET /api/admin/order/coupons/:uid — server-authoritative applicable coupon list. */
export async function adminAssistedCoupons(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).coupons(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    c.req.query(),
  ));
}

/** POST /api/admin/order/create/:key/:uid — atomically claim inventory and create an audited order. */
export async function adminAssistedCreate(c: C) {
  privateAdminResponse(c);
  const result = await assistedOrderService(c).create(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    c.req.param("key") ?? "",
    await readBoundedJsonObject(c.req.raw, 32 * 1024),
    boundedClientIp(c),
  );
  return jsonOk(c, { result }, result.extended ? "订单已创建，请点击查看完成支付" : "订单创建成功");
}

/** POST /api/admin/order/pay/:uid — provider initiation or audited cash settlement. */
export async function adminAssistedPay(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).pay(
    verifiedAdminId(c),
    parseAssistedUid(c.req.param("uid")),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
    boundedClientIp(c),
  ));
}

/** GET /api/admin/order/pay/status — actor-scoped payment polling. */
export async function adminAssistedPayStatus(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await assistedOrderService(c).payStatus(verifiedAdminId(c), c.req.query()));
}

/** GET /api/admin/order/statistics — embedded admin order counters/cards. */
export async function adminMobileOrderStatistics(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await statisticService(c).mobileOrderStatistics());
}

/** GET /api/admin/order/staging — embedded admin workbench badges. */
export async function adminMobileOrderStaging(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await statisticService(c).mobileOrderStaging());
}

/** GET /api/admin/order/data — embedded admin daily order/visit rows. */
export async function adminMobileOrderData(c: C) {
  privateAdminResponse(c);
  const query = parseMobileOrderDataQuery(c.req.query());
  return jsonOk(c, await statisticService(c).mobileOrderData(query));
}

/** GET /api/admin/order/time — embedded admin period comparison. */
export async function adminMobileOrderTime(c: C) {
  privateAdminResponse(c);
  const period = parseMobileOrderPeriod(c.req.query("type"));
  return jsonOk(c, await statisticService(c).mobileOrderTime(period));
}

/** GET /api/admin/order/time/chart — embedded admin chronological daily chart. */
export async function adminMobileOrderTimeChart(c: C) {
  privateAdminResponse(c);
  const period = parseMobileOrderPeriod(c.req.query("type"));
  return jsonOk(c, await statisticService(c).mobileOrderTimeChart(period));
}

/** GET /api/admin/order/delivery/gain/:orderId — paid-order shipping summary. */
export async function adminMobileOrderDeliveryGain(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderReadService(c).deliveryGain(c.req.param("orderId")));
}

/** GET /api/admin/order/delivery — active platform delivery agents. */
export async function adminMobileOrderDeliveryAgents(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderReadService(c).deliveryAgents(c.req.query()));
}

/** GET /api/admin/order/delivery_info — direct database-backed sender defaults. */
export async function adminMobileOrderDeliveryInfo(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderReadService(c).deliveryConfig());
}

/** GET /api/admin/order/export_all — safe carrier catalog without credentials. */
export async function adminMobileOrderExpressList(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderReadService(c).expressList());
}

/** GET /api/admin/order/split_cart_info/:id — remaining splittable cart snapshots. */
export async function adminMobileOrderSplitCartInfo(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderReadService(c).splitCartInfo(c.req.param("id")));
}

/** POST /api/admin/order/price — absolute unpaid-order price update. */
export async function adminMobileOrderPrice(c: C) {
  privateAdminResponse(c);
  await mobileOrderOperationService(c).changePrice(
    verifiedAdminId(c),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  );
  return jsonOk(c, null, "改价成功");
}

/** POST /api/admin/order/remark[/:orderId] — bounded, audited order remark. */
export async function adminMobileOrderRemark(c: C) {
  privateAdminResponse(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  const pathOrderId = c.req.param("orderId");
  if (pathOrderId) body.order_id = pathOrderId;
  await mobileOrderOperationService(c).updateRemark(verifiedAdminId(c), body);
  return jsonOk(c, null, "备注成功");
}

/** POST /api/admin/order/wirteoff/records/:id — legacy read-only writeoff history. */
export async function adminMobileOrderWriteoffRecords(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileOrderOperationService(c).writeoffRecords(
    c.req.param("id"),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  ));
}

/** POST /api/admin/order/delivery/keep/:id — manual fulfillment or durable waybill job. */
export async function adminMobileOrderDeliveryKeep(c: C) {
  privateAdminResponse(c);
  const result = await mobileFulfillmentService(c).deliver(
    verifiedAdminId(c),
    c.req.param("id"),
    await readBoundedJsonObject(c.req.raw, 32 * 1024),
  );
  return jsonOk(
    c,
    result.queued ? result : null,
    result.queued ? "电子面单任务已受理" : "发货成功!",
  );
}

/** PUT /api/admin/order/split_delivery/:id — split fulfillment over the shared state machine. */
export async function adminMobileOrderSplitDelivery(c: C) {
  privateAdminResponse(c);
  const result = await mobileFulfillmentService(c).deliver(
    verifiedAdminId(c),
    c.req.param("id"),
    await readBoundedJsonObject(c.req.raw, 32 * 1024),
    true,
  );
  return jsonOk(
    c,
    result.queued ? result : "SUCCESS",
    result.queued ? "电子面单任务已受理" : "SUCCESS",
  );
}

/** GET /api/admin/order/export_temp — bounded electronic-waybill provider catalog. */
export async function adminMobileOrderExportTemp(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileFulfillmentService(c).waybillTemplates(c.req.query()));
}

/** POST /api/admin/order/order_verific — read-only legacy scan lookup under Admin authority. */
export async function adminMobileOrderVerificationLookup(c: C) {
  privateAdminResponse(c);
  return jsonOk(c, await mobileFulfillmentService(c).writeoffLookup(
    verifiedAdminId(c),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  ));
}

/** POST /api/admin/order/offline — administrator confirmation of offline funds received. */
export async function adminMobileOrderOffline(c: C) {
  privateAdminResponse(c);
  await mobileRefundOperationService(c).offline(
    verifiedAdminId(c),
    await readBoundedJsonObject(c.req.raw, 8 * 1024),
  );
  return jsonOk(c, null, "修改成功!");
}

/** POST /api/admin/order/refund — exact refund decision by public refund/order number. */
export async function adminMobileOrderRefund(c: C) {
  privateAdminResponse(c);
  const result = await mobileRefundOperationService(c).refund(
    verifiedAdminId(c),
    await readBoundedJsonObject(c.req.raw, 32 * 1024),
  );
  return jsonOk(
    c,
    result,
    "status" in result && result.status === "PROCESSING" ? "退款已受理，等待渠道确认" : "审核成功",
  );
}

/** POST /api/admin/order/refund_agree/:id — approve return shipment, without moving funds. */
export async function adminMobileOrderRefundAgree(c: C) {
  privateAdminResponse(c);
  await mobileRefundOperationService(c).agreeReturn(verifiedAdminId(c), c.req.param("id"));
  return jsonOk(c, null, "操作成功");
}

/** POST /api/admin/order/open/refund/:id — proactive whole/split administrator refund. */
export async function adminMobileOrderOpenRefund(c: C) {
  privateAdminResponse(c);
  const result = await mobileRefundOperationService(c).openRefund(
    verifiedAdminId(c),
    c.req.param("id"),
    await readBoundedJsonObject(c.req.raw, 32 * 1024),
  );
  return jsonOk(
    c,
    result,
    "status" in result && result.status === "PROCESSING" ? "退款已受理，等待渠道确认" : "操作成功",
  );
}

/** GET /adminapi/statistic/order/get_basic — PHP 订单统计基础卡片。 */
export async function adminStatisticOrderBasic(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await statisticService(c).orderBasic(range));
}

/** GET /adminapi/statistic/order/get_trend — PHP 订单六序列趋势。 */
export async function adminStatisticOrderTrend(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await statisticService(c).orderTrend(range));
}

/** GET /adminapi/statistic/order/get_channel — 订单渠道分布。 */
export async function adminStatisticOrderChannel(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await statisticService(c).orderChannel(range));
}

/** GET /adminapi/statistic/order/get_type — 订单类型金额分布。 */
export async function adminStatisticOrderType(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await statisticService(c).orderType(range));
}

/** GET /adminapi/statistic/product/get_basic — PHP 商品漏斗与环比。 */
export async function adminStatisticProductBasic(c: C) {
  const range = parseAdminStatisticRange(c.req.query("data"));
  return jsonOk(c, await statisticService(c).productBasic(range));
}

/** GET /adminapi/statistic/product/get_trend — 商品访问/支付/退款趋势。 */
export async function adminStatisticProductTrend(c: C) {
  const range = parseAdminStatisticRange(c.req.query("data"));
  return jsonOk(c, await statisticService(c).productTrend(range));
}

/** GET /adminapi/statistic/product/get_product_ranking — 商品经营排行。 */
export async function adminStatisticProductRanking(c: C) {
  const range = parseAdminStatisticRange(c.req.query("data"));
  const sort = parseProductRankingSort(c.req.query("sort"));
  const categoryValues = c.req.queries("cate_id") ?? [];
  const categoryIds = parseCategoryIds(categoryValues);
  const limit = Number(c.req.query("limit") ?? 20);
  return jsonOk(c, await statisticService(c).productRanking(range, sort, categoryIds, limit));
}

/** GET /adminapi/statistic/product/get_excel — PHP 商品统计导出元数据。 */
export async function adminStatisticProductExport(c: C) {
  const range = parseAdminStatisticRange(c.req.query("data"));
  return jsonOk(c, await extendedStatisticService(c).productExport(range));
}

function userStatisticRequest(c: C) {
  return {
    range: parseAdminStatisticRange(c.req.query("data")),
    channel: parseAdminStatisticChannel(c.req.query("channel_type")),
  };
}

/** GET /adminapi/statistic/user/get_basic — 用户基础指标与环比。 */
export async function adminStatisticUserBasic(c: C) {
  const { range, channel } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userBasic(range, channel));
}

/** GET /adminapi/statistic/user/get_trend — 用户五序列趋势。 */
export async function adminStatisticUserTrend(c: C) {
  const { range, channel } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userTrend(range, channel));
}

/** GET /adminapi/statistic/user/get_wechat — 微信关注概况。 */
export async function adminStatisticUserWechat(c: C) {
  const { range } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userWechat(range));
}

/** GET /adminapi/statistic/user/get_wechat_trend — 微信关注趋势。 */
export async function adminStatisticUserWechatTrend(c: C) {
  const { range } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userWechatTrend(range));
}

/** GET /adminapi/statistic/user/get_region — 用户地域分布。 */
export async function adminStatisticUserRegion(c: C) {
  const { range, channel } = userStatisticRequest(c);
  const sort = parseUserRegionSort(c.req.query("sort"));
  return jsonOk(c, await extendedStatisticService(c).userRegion(range, channel, sort));
}

/** GET /adminapi/statistic/user/get_sex — 用户性别分布。 */
export async function adminStatisticUserSex(c: C) {
  const { range, channel } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userSex(range, channel));
}

/** GET /adminapi/statistic/user/get_excel — PHP 用户统计导出元数据。 */
export async function adminStatisticUserExport(c: C) {
  const { range, channel } = userStatisticRequest(c);
  return jsonOk(c, await extendedStatisticService(c).userExport(range, channel));
}

/** GET /adminapi/statistic/trade/top_trade — 今日与本月交易概况。 */
export async function adminStatisticTradeTop(c: C) {
  return jsonOk(c, await extendedStatisticService(c).tradeTop());
}

/** GET /adminapi/statistic/trade/bottom_trade — 交易十项指标。 */
export async function adminStatisticTradeBottom(c: C) {
  const range = parseAdminStatisticRange(c.req.query("data"));
  return jsonOk(c, await extendedStatisticService(c).tradeBottom(range));
}

/** GET /adminapi/statistic/balance/get_basic — 余额生命周期总览。 */
export async function adminStatisticBalanceBasic(c: C) {
  return jsonOk(c, await extendedStatisticService(c).balanceBasic());
}

/** GET /adminapi/statistic/balance/get_trend — 余额积累/消耗趋势。 */
export async function adminStatisticBalanceTrend(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await extendedStatisticService(c).balanceTrend(range));
}

/** GET /adminapi/statistic/balance/get_channel — 余额来源分布。 */
export async function adminStatisticBalanceChannel(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await extendedStatisticService(c).balanceChannel(range));
}

/** GET /adminapi/statistic/balance/get_type — 余额消耗类型。 */
export async function adminStatisticBalanceType(c: C) {
  const range = parseAdminStatisticRange(c.req.query("time"));
  return jsonOk(c, await extendedStatisticService(c).balanceType(range));
}

/** Deprecated TypeScript-only overview alias, now backed by the canonical service. */
export async function adminStatisticOverview(c: C) {
  return jsonOk(c, await statisticService(c).legacyOverview());
}

/** Deprecated TypeScript-only trend alias, now backed by the canonical service. */
export async function adminStatisticTrend(c: C) {
  const days = Number(c.req.query("days") ?? 7);
  return jsonOk(c, await statisticService(c).legacyTrend(days));
}

/** Deprecated TypeScript-only rank alias, now backed by the canonical service. */
export async function adminStatisticRank(c: C) {
  const limit = Number(c.req.query("limit") ?? 10);
  return jsonOk(c, await statisticService(c).legacyRank(limit));
}

/** GET /api/admin/new_push — 管理员消息通知数 */
export async function adminNewPush(c: C) {
  const svc = new AdminAuthService(c.get("container"), c.env);
  const push = await svc.adminNewPush();
  return jsonOk(c, push);
}

/**
 * GET /api/admin/service/chat — 客服聊天记录
 * query: uid (对方), limit
 */
export async function chatHistory(c: C) {
  return jsonRaw(c, 501, "管理员不能充当客服身份，请使用独立客服工作台");
}

/** GET /api/admin/erp/config — 只返回 ERP 能力开关，不暴露任何 ERP 凭据。 */
export async function adminErpConfig(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  const capability = await new ErpCapabilityService(c.get("container"), c.env).getCapability();
  return jsonOk(c, capability);
}

/** GET /api/admin/service/sessions — 客服会话列表 (按用户聚合最近消息) */
export async function chatSessions(c: C) {
  return jsonRaw(c, 501, "管理员不能读取客服私有会话，请使用独立客服工作台");
}

/**
 * GET /api/ws/kefu — WebSocket 客服连接升级
 *
 * 对应 PHP swoole websocket 入口。
 * 通过 Durable Object (ChatRoomDO) 处理。
 * query: type (1=user 2=kefu), to_uid。uid 只能来自已验证 token。
 */
export async function wsUpgrade(c: C): Promise<Response> {
  if (c.req.query("type") && c.req.query("type") !== "1") {
    return jsonRaw(c, 403, "客服 WebSocket 必须使用独立客服 token");
  }
  return upgradeChatSocket(c, {
    role: 1,
    principalUid: c.get("uid"),
    toUid: c.req.query("to_uid"),
  });
}

/** POST /api/admin/service/send — 客服回复用户 (REST 持久化) */
export async function serviceReply(c: C) {
  return jsonRaw(c, 501, "管理员不能发送客服消息，请使用独立客服工作台");
}
