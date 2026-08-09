/**
 * 管理后台 + 客服 WebSocket 控制器 (M7)
 *
 * 对应 PHP:
 *   - app/controller/admin/Login.php (admin 登录)
 *   - app/controller/admin/Common.php (Dashboard homeStatics)
 *   - app/webscoket/Manager.php (WebSocket 入口)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { AdminAuthService } from "@/services/admin/AdminAuthService";
import type { AppVariables, Env } from "@/env";

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

/** GET /api/admin/home/header — Dashboard 统计 */
export async function adminDashboard(c: C) {
  const svc = new AdminAuthService(c.get("container"), c.env);
  const stats = await svc.dashboard();
  return jsonOk(c, stats);
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
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const toUid = Number(c.req.query("uid") ?? 0);
  const limit = Number(c.req.query("limit") ?? 50);
  if (!toUid) return jsonFail(c, "参数错误");
  const list = await c.get("container").storeServiceLogDao.getConversation(uid, toUid, limit);
  return jsonOk(c, list);
}

/** GET /api/admin/service/sessions — 客服会话列表 (按用户聚合最近消息) */
export async function chatSessions(c: C) {
  const adminId = c.get("adminId") ?? 0;
  if (!adminId) return jsonFail(c, "请先登录");
  const container = c.get("container");
  const { sql, desc } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const storeServiceLog = schema.storeServiceLog;
  const userTable = schema.user;

  // 最近 30 条消息按对方 uid 去重, 取每个会话的最新一条
  const rows = await container.db
    .select({
      peerUid: sql<number>`CASE WHEN ${storeServiceLog.uid} = ${adminId} THEN ${storeServiceLog.toUid} ELSE ${storeServiceLog.uid} END`,
      msn: storeServiceLog.msn,
      addTime: storeServiceLog.addTime,
      type: storeServiceLog.type,
    })
    .from(storeServiceLog)
    .where(
      sql`${storeServiceLog.uid} = ${adminId} OR ${storeServiceLog.toUid} = ${adminId} OR ${storeServiceLog.toUid} = 0`,
    )
    .orderBy(desc(storeServiceLog.addTime))
    .limit(100);

  // 按 peerUid 保留最新一条
  const sessionsMap = new Map<number, { peerUid: number; msn: string; addTime: number; unread: number }>();
  for (const row of rows) {
    if (!sessionsMap.has(row.peerUid)) {
      sessionsMap.set(row.peerUid, {
        peerUid: row.peerUid,
        msn: row.msn,
        addTime: row.addTime,
        unread: row.type === 0 ? 1 : 0,
      });
    } else if (row.type === 0) {
      const s = sessionsMap.get(row.peerUid)!;
      s.unread += 1;
    }
  }

  // 补用户昵称
  const sessions = [...sessionsMap.values()].sort((a, b) => b.addTime - a.addTime).slice(0, 20);
  const peers = sessions.map((s) => s.peerUid);
  let userMap = new Map<number, { nickname: string; avatar: string; phone: string }>();
  if (peers.length) {
    const users = await container.db
      .select({ uid: userTable.uid, nickname: userTable.nickname, avatar: userTable.avatar, phone: userTable.phone })
      .from(userTable)
      .where(sql`${userTable.uid} IN (${sql.join(peers, sql`,` )})`);
    userMap = new Map(users.map((u) => [u.uid, { nickname: u.nickname, avatar: u.avatar, phone: u.phone }]));
  }

  return jsonOk(
    c,
    sessions.map((s) => ({
      ...s,
      nickname: userMap.get(s.peerUid)?.nickname ?? `用户${s.peerUid}`,
      avatar: userMap.get(s.peerUid)?.avatar ?? "",
      phone: userMap.get(s.peerUid)?.phone ?? "",
    })),
  );
}

/**
 * GET /api/ws/kefu — WebSocket 客服连接升级
 *
 * 对应 PHP swoole websocket 入口。
 * 通过 Durable Object (ChatRoomDO) 处理。
 * query: uid, type (1=user 2=kefu), to_uid
 */
export async function wsUpgrade(c: C): Promise<Response> {
  const url = new URL(c.req.url);
  const uid = url.searchParams.get("uid") ?? "0";
  const type = url.searchParams.get("type") ?? "1";
  const toUid = url.searchParams.get("to_uid") ?? "0";

  // 路由到 ChatRoomDO (单例, 全部连接共享一个 DO 实例)
  // v2: 新实例名强制使用含持久化逻辑的新类 (旧实例保留旧代码不自动重启)
  const id = c.env.CHAT_ROOM.idFromName("global-v2");
  const stub = c.env.CHAT_ROOM.get(id);

  // 转发 WebSocket 升级请求到 DO (必须保留原始 Upgrade/Connection 头, 否则 DO 返回 426)
  const doUrl = new URL("https://internal/ws");
  doUrl.searchParams.set("uid", uid);
  doUrl.searchParams.set("type", type);
  doUrl.searchParams.set("to_uid", toUid);

  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");
  const upstream = new Request(doUrl.toString(), {
    method: "GET",
    headers,
  });
  return stub.fetch(upstream);
}

/** POST /api/internal/chat_save — DO 回调: 持久化客服消息到 store_service_log */
export async function chatSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    uid?: number;
    to_uid?: number;
    msn?: string;
    msn_type?: number;
    add_time?: number;
    is_tourist?: number;
  };
  const container = c.get("container");
  await container.storeServiceLogDao.save({
    merId: 0,
    uid: body.uid ?? 0,
    toUid: body.to_uid ?? 0,
    msn: body.msn ?? "",
    isTourist: body.is_tourist ?? 0,
    timeNode: 0,
    addTime: body.add_time ?? Math.floor(Date.now() / 1000),
    type: 0,
    remind: 0,
    msnType: body.msn_type ?? 1,
  });
  return c.json({ status: 200, msg: "ok", data: null });
}

/** POST /api/admin/service/send — 客服回复用户 (REST 持久化) */
export async function serviceReply(c: C) {
  const adminId = c.get("adminId") ?? 0;
  if (!adminId) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    to_uid?: number;
    msn?: string;
    msn_type?: number;
  };
  const toUid = Number(body.to_uid ?? 0);
  const msn = String(body.msn ?? "").trim();
  if (!toUid) return jsonFail(c, "参数错误");
  if (!msn) return jsonFail(c, "消息不能为空");
  const container = c.get("container");
  const now = Math.floor(Date.now() / 1000);
  const row = await container.storeServiceLogDao.save({
    merId: 0,
    uid: adminId,
    toUid,
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
