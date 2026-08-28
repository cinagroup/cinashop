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
import { and, desc, eq, or } from "drizzle-orm";
import { jsonOk, jsonFail } from "@/utils/json";
import { AuthException, ValidateException } from "@/utils/errors";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import {
  type ChatSocketSession,
  KefuRealtimeService,
} from "@/services/kefu/KefuRealtimeService";
import { chatPrincipalName } from "@/services/kefu/KefuSocketGateway";
import type { AppVariables, Env } from "@/env";
import { systemMessage } from "@/models/schema";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_CHAT_BODY_BYTES = 8 * 1024;

function realtime(c: C) {
  return new KefuRealtimeService(c.get("container"), c.env);
}

function userSocketSession(c: C, toUid: number): ChatSocketSession {
  const principalUid = c.get("uid");
  const tokenKey = c.get("socketTokenKey") ?? "";
  const expiresAt = c.get("socketTokenExp") ?? 0;
  const authId = c.get("socketAuthId") ?? 0;
  const authVersion = c.get("socketAuthVersion") ?? "";
  if (!principalUid || !tokenKey || !expiresAt || !authId || !authVersion) {
    throw new AuthException("聊天登录状态无效");
  }
  return {
    principalUid,
    role: 1,
    toUid,
    authId,
    tokenKey,
    expiresAt,
    authVersion,
    connectedAt: Math.floor(Date.now() / 1000),
  };
}

export function visibleSystemMessageWhere(uid: number) {
  return and(
    eq(systemMessage.status, 1),
    eq(systemMessage.isDel, 0),
    or(eq(systemMessage.userId, 0), eq(systemMessage.userId, uid)),
  );
}

// ═══ 充值 ═══════════════════════════════════════════════════

/** POST /api/recharge/recharge — 创建充值订单 */
export async function rechargeCreate(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    price?: number;
    channel?: string;
    from?: string;
    rechar_id?: number;
    type?: number;
  };
  const type = Number(body.type ?? 0);
  const svc = new UserFinanceService(c.get("container"), c.env);
  try {
    if (type === 1) {
      const result = await svc.brokerageToBalance(uid, Number(body.price ?? 0));
      return jsonOk(c, result, "转入余额成功");
    }
    if (type !== 0) return jsonFail(c, "充值方式不支持");
    const result = await svc.recharge(
      uid,
      Number(body.price ?? 0),
      body.channel ?? body.from ?? "h5",
      Number(body.rechar_id ?? 0),
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
  try {
    const rows = await container.db
      .select()
      .from(systemMessage)
      .where(visibleSystemMessageWhere(uid))
      .orderBy(desc(systemMessage.addTime))
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
  try {
    const rows = await container.db
      .select()
      .from(systemMessage)
      .where(and(eq(systemMessage.id, id), visibleSystemMessageWhere(uid)))
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
  if (!Number.isSafeInteger(toUid) || toUid <= 0) throw new ValidateException("客服ID无效");
  const result = await realtime(c).userRecord(uid, {
    toUid: String(toUid),
    uidTo: c.req.query("upper_id") ?? "0",
    limit: c.req.query("limit") ?? "50",
  });
  return jsonOk(c, result.serviceList);
}

/** PHP-compatible public customer-service directory (safe identity fields only). */
export async function customerServiceList(c: C) {
  return jsonOk(c, await realtime(c).serviceList(false));
}

/** GET /api/user/service/record — choose an agent and return bounded keyset history. */
export async function customerServiceRecord(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await realtime(c).userRecord(uid, c.req.query()));
}

/** GET /api/user/record — current user's customer-service conversation summaries. */
export async function customerServiceConversationList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await realtime(c).userConversationList(uid, c.req.query()));
}

/** POST /api/service/send — persisted first, then delivered to the agent's principal DO. */
export async function serviceSend(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readBoundedJsonObject(c.req.raw, MAX_CHAT_BODY_BYTES);
  const toUid = Number(body.to_uid ?? 0);
  const service = realtime(c);
  const persisted = await service.persistMessage(userSocketSession(c, toUid), {
    toUid,
    message: body.msn,
    messageType: body.msn_type ?? 1,
  });
  try {
    const delivery = await c.env.CHAT_ROOM
      .getByName(chatPrincipalName(2, toUid))
      .deliver(persisted);
    if (delivery.viewing > 0) {
      await service.markMessageRead(persisted);
      persisted.type = 1;
      persisted.recored.mssage_num = 0;
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "chat_rest_delivery_failed",
      messageId: persisted.id,
      recipientUid: persisted.to_uid,
      error: error instanceof Error ? error.name : "unknown",
    }));
  }
  return jsonOk(c, persisted);
}
