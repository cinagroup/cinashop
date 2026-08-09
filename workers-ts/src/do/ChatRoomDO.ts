/**
 * ChatRoom Durable Object (M7)
 *
 * 对应 PHP app/webscoket/Manager.php + BaseHandler.php + Room.php
 *
 * 设计 (基于 Cloudflare WebSocket Hibernation API):
 *   - 每个 DO 实例是一个"会话中枢", 管理所有活跃连接
 *   - 连接通过 wsUpgrade → this.ctx.acceptWebSocket(webSocket) 接入
 *   - hibernation API: 闲置连接自动休眠, 消息唤醒, 省内存
 *   - 存储: ctx.storage 持久化 per-connection 元数据 (uid/type/toUid)
 *
 * 消息协议 (与 PHP 完全一致):
 *   client→server: { type: 'chat'|'login'|'to_chat'|'ping', data: {...} }
 *   server→client: { type: 'chat'|'reply'|'mssage_num'|'online'|'user_online'|'ping', data: {...} }
 *
 * 关键逻辑:
 *   - chat: 存消息到 DB (通过 fetch 回 Worker 主体), 推给接收方
 *   - 接收方在线且在当前会话 → reply; 在线但在其他会话 → mssage_num (未读)
 *   - login: 注册 uid+type+toUid 到 connection tag
 */
import { DurableObject } from "cloudflare:workers";

interface SessionState {
  uid: number;
  type: number; // 1=user 2=kefu
  toUid: number; // 当前对话对象
}

export class ChatRoomDO extends DurableObject {
  /**
   * 接收 WebSocket 消息 (Hibernation API)
   * 对应 PHP BaseHandler::handle 的动态方法分发
   */
  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const msg =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    let data: { type?: string; data?: Record<string, unknown>; form_type?: string };
    try {
      data = JSON.parse(msg);
    } catch {
      return; // 无效 JSON, 忽略
    }

    if (!data.type) return;

    // ping 心跳
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "ping", data: { now: Math.floor(Date.now() / 1000) } }));
      return;
    }

    // 获取当前连接的状态
    const state = await this.getSession(ws);

    switch (data.type) {
      case "chat":
        await this.handleChat(ws, state, data.data ?? {});
        break;
      case "to_chat":
        await this.handleToChat(ws, state, data.data ?? {});
        break;
      case "online":
        // 客服上线/下线状态切换
        break;
      default:
        break;
    }
  }

  /**
   * 处理聊天消息 (对应 PHP BaseHandler::chat)
   *
   * 流程:
   *   1. 构建消息数据
   *   2. 通过 fetch 回 Worker 主体持久化到 DB (store_service_log)
   *   3. 查找接收方连接
   *   4. 在线且在当前会话 → reply; 在线但其他会话 → mssage_num; 离线 → 忽略 (公众号通知留后续)
   *   5. 给发送方回确认
   */
  private async handleChat(
    senderWs: WebSocket,
    state: SessionState | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!state) return;

    const toUid = Number(data.to_uid ?? 0);
    const msn = String(data.msn ?? "");
    const msnType = Number(data.msn_type ?? 1);
    const isTourist = Number(data.is_tourist ?? 0);
    const now = Math.floor(Date.now() / 1000);

    // 消息对象
    const messageData = {
      uid: state.uid,
      to_uid: toUid,
      msn,
      msn_type: msnType,
      add_time: now,
      is_tourist: isTourist,
    };

    // 持久化 (通过 fetch 回 Worker, DO 不能直接访问 DB)
    try {
      await this.ctx.storage.put(`last_msg_${state.uid}_${toUid}`, messageData);
    } catch {
      // 非关键路径
    }
    // 写入 DB (store_service_log) — 通过内部端点
    try {
      const resp = await fetch("https://cinashop-api.cinagroup.workers.dev/api/internal/chat_save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageData),
      });
      if (!resp.ok) {
        await this.ctx.storage.put(`persist_err_${now}`, `status=${resp.status}`);
      }
    } catch (e) {
      // 持久化失败不阻断转发
      await this.ctx.storage.put(`persist_err_${now}`, `ex=${e instanceof Error ? e.message : String(e)}`);
    }

    // 查找接收方: 在线且 toUid 匹配 → reply
    const recipientOnline = await this.isRecipientInChat(toUid, state.uid);
    const recipientConnected = await this.isRecipientConnected(toUid);

    const response = JSON.stringify({ type: "chat", data: messageData });

    if (recipientOnline) {
      // 接收方在当前会话 → 推送 reply
      await this.pushToUser(toUid, { type: "reply", data: messageData });
    } else if (recipientConnected) {
      // 接收方在线但在其他会话 → 推送未读计数
      await this.pushToUser(toUid, {
        type: "mssage_num",
        data: { uid: state.uid, num: 1, recored: messageData },
      });
    }
    // 接收方离线: 公众号客服消息通知 (留后续)

    // 给发送方回确认
    senderWs.send(response);
  }

  /** 切换对话对象 (对应 PHP BaseHandler::to_chat) */
  private async handleToChat(
    ws: WebSocket,
    state: SessionState | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!state) return;
    const toUid = Number(data.to_uid ?? 0);
    await this.setSession(ws, { ...state, toUid });
  }

  /** 连接关闭 */
  override async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const state = await this.getSession(ws);
    if (state) {
      // 通知对方下线 (对应 PHP close)
      await this.pushToUser(state.toUid, {
        type: "online",
        data: { online: 0, uid: state.uid },
      });
    }
    await this.ctx.storage.delete(`ws_${this.getWsId(ws)}`);
  }

  /** 连接出错 */
  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("[ChatRoomDO] ws error:", error);
    ws.close();
  }

  /**
   * HTTP 入口: 升级为 WebSocket 连接
   * 对应 PHP Manager::onOpen
   */
  override async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const uid = Number(url.searchParams.get("uid") ?? 0);
    const type = Number(url.searchParams.get("type") ?? 1); // 1=user 2=kefu
    const toUid = Number(url.searchParams.get("to_uid") ?? 0);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 注册 session
    await this.setSession(server, { uid, type, toUid });

    // 接受连接 (Hibernation API)
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Session 管理 (基于 ctx.storage) ─────────────────────

  private getWsId(ws: WebSocket): string {
    // Hibernation API 不提供 fd, 用对象的内部 id
    // 实际用 tag 存储, 这里用简化方案
    return (ws as unknown as { id?: string }).id ?? Math.random().toString(36);
  }

  private async getSession(ws: WebSocket): Promise<SessionState | null> {
    return (await this.ctx.storage.get<SessionState>(`ws_${this.getWsId(ws)}`)) ?? null;
  }

  private async setSession(ws: WebSocket, state: SessionState): Promise<void> {
    await this.ctx.storage.put(`ws_${this.getWsId(ws)}`, state);
  }

  // ─── 推送 ─────────────────────────────────────────────────

  /** 接收方是否已连接 */
  private async isRecipientConnected(uid: number): Promise<boolean> {
    // Hibernation API: 遍历 hibernated + active connections
    const wsList = this.ctx.getWebSockets();
    for (const ws of wsList) {
      const state = await this.getSession(ws);
      if (state?.uid === uid) return true;
    }
    return false;
  }

  /** 接收方是否在当前会话 (toUid 匹配发送方) */
  private async isRecipientInChat(uid: number, senderUid: number): Promise<boolean> {
    const wsList = this.ctx.getWebSockets();
    for (const ws of wsList) {
      const state = await this.getSession(ws);
      if (state?.uid === uid && state.toUid === senderUid) return true;
    }
    return false;
  }

  /** 推送消息给指定 uid 的所有连接 */
  private async pushToUser(uid: number, payload: Record<string, unknown>): Promise<void> {
    const msg = JSON.stringify(payload);
    const wsList = this.ctx.getWebSockets();
    for (const ws of wsList) {
      const state = await this.getSession(ws);
      if (state?.uid === uid) {
        try {
          ws.send(msg);
        } catch {
          // 连接已断开
        }
      }
    }
  }
}
