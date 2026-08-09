/**
 * 充值 + 站内信控制器
 *
 * 对应原版端点:
 *   - POST /api/recharge/recharge  创建充值订单
 *   - GET  /api/recharge/index     充值套餐
 *   - GET  /api/user/message       站内信列表
 *   - GET  /api/user/message_system/list  系统消息
 *   - GET  /api/user/message_system/detail/:id  消息详情
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

// ═══ 充值 ═══════════════════════════════════════════════════

/** POST /api/recharge/recharge — 创建充值订单 */
export async function rechargeCreate(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    price?: number;
    channel?: string;
  };
  const svc = new UserFinanceService(c.get("container"), c.env);
  try {
    const result = await svc.recharge(
      uid,
      Number(body.price ?? 0),
      body.channel ?? "h5",
    );
    return jsonOk(c, result, "充值订单已创建");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/recharge/index — 充值套餐 */
export async function rechargeIndex(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"), c.env);
  return jsonOk(c, await svc.rechargeIndex());
}

// ═══ 站内信 ═════════════════════════════════════════════════

/** GET /api/user/message — 站内信列表 */
export async function messageList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemMessage } = await import("@/models/schema");
  try {
    const rows = await container.db
      .select()
      .from(systemMessage)
      .where(
        sql`${systemMessage.status} = 1 AND (${systemMessage.userId} = 0 OR ${systemMessage.userId} = ${uid})`,
      )
      .orderBy(sql`${systemMessage.addTime} DESC`)
      .limit(20);
    return jsonOk(c, rows);
  } catch {
    return jsonOk(c, []);
  }
}

/** GET /api/user/message_system/detail/:id — 消息详情 */
export async function messageDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemMessage } = await import("@/models/schema");
  try {
    const rows = await container.db
      .select()
      .from(systemMessage)
      .where(eq(systemMessage.id, id))
      .limit(1);
    return jsonOk(c, rows[0] ?? null);
  } catch {
    return jsonOk(c, null);
  }
}

/** GET /api/user/info — 用户基本信息 (对应 PHP User::info) */
export async function userInfo(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const container = c.get("container");
  const user = await container.userDao.findForAuth(uid);
  if (!user) return jsonFail(c, "用户不存在");
  const { nowMoney, integral, brokeragePrice, spreadCount, nickname, avatar, phone, spreadUid, isPromoter } = user;
  return jsonOk(c, {
    uid,
    account: user.account,
    nickname,
    avatar,
    phone,
    now_money: nowMoney,
    integral,
    brokerage_price: brokeragePrice,
    spread_count: spreadCount,
    spread_uid: spreadUid,
    is_promoter: isPromoter,
  });
}

/** POST /api/user/edit — 编辑用户资料 (昵称) */
export async function userEdit(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    nickname?: string;
    avatar?: string;
  };
  const container = c.get("container");
  const user = await container.userDao.findForAuth(uid);
  if (!user) return jsonFail(c, "用户不存在");

  const nickname = (body.nickname ?? "").trim();
  if (nickname && nickname.length > 16) return jsonFail(c, "昵称最长 16 个字符");
  if (nickname === user.nickname && !body.avatar) return jsonOk(c, null, "资料未变更");

  await container.userDao.update(uid, {
    ...(nickname ? { nickname } : {}),
    ...(body.avatar ? { avatar: body.avatar } : {}),
  });
  return jsonOk(c, null, "保存成功");
}

/** GET /api/service/chat_history?to_uid= — 用户端客服聊天记录 */
export async function serviceChatHistory(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const toUid = Number(c.req.query("to_uid") ?? 0);
  const container = c.get("container");
  const list = await container.storeServiceLogDao.getConversation(uid, toUid, 50);
  return jsonOk(c, list);
}

/** POST /api/service/send — 用户发送客服消息 (REST 持久化, WS 仅实时推送) */
export async function serviceSend(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    to_uid?: number;
    msn?: string;
    msn_type?: number;
  };
  const msn = String(body.msn ?? "").trim();
  if (!msn) return jsonFail(c, "消息不能为空");
  const container = c.get("container");
  const now = Math.floor(Date.now() / 1000);
  const row = await container.storeServiceLogDao.save({
    merId: 0,
    uid,
    toUid: body.to_uid ?? 0,
    msn,
    isTourist: 0,
    timeNode: 0,
    addTime: now,
    type: 0,
    remind: 0,
    msnType: body.msn_type ?? 1,
  });
  return jsonOk(c, { id: row.id, addTime: now });
}
