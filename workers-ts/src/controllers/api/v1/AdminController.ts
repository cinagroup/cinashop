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
  parseProductRankingSort,
} from "@/services/admin/AdminStatisticService";
import {
  AdminExtendedStatisticService,
  parseAdminStatisticChannel,
  parseUserRegionSort,
} from "@/services/admin/AdminExtendedStatisticService";
import type { AppVariables, Env } from "@/env";
import { upgradeChatSocket } from "@/services/kefu/KefuSocketGateway";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** POST /api/admin/login — 管理员登录 */
export async function adminLogin(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    account?: string;
    pwd?: string;
  };
  if (!body.account || !body.pwd) return jsonFail(c, "请输入账号和密码");
  const svc = new AdminAuthService(c.get("container"), c.env);
  try {
    const result = await svc.login(body.account, body.pwd);
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
