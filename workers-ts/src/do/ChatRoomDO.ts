import { DurableObject } from "cloudflare:workers";
import type { Env } from "@/env";
import { createContainer } from "@/lib/di";
import {
  type ChatSocketSession,
  KefuRealtimeService,
  type PersistedRealtimeMessage,
  parseChatRole,
} from "@/services/kefu/KefuRealtimeService";
import {
  CHAT_TOKEN_KEY_PATTERN,
  type ChatEnvelope,
  parseChatEnvelope,
  parseChatSessionRequest,
} from "@/services/kefu/KefuSocketProtocol";
import {
  chatPrincipalName,
  type ChatRole,
} from "@/services/kefu/KefuSocketGateway";

export interface DeliveryResult {
  connected: number;
  viewing: number;
}

export type TransferDeliveryEvent =
  | {
      type: "transfer_out";
      data: {
        request_key: string;
        uid: number;
        toUid: number;
        is_tourist: 0 | 1;
        nickname: string;
        avatar: string;
      };
    }
  | {
      type: "transfer";
      data: {
        request_key: string;
        is_tourist: 0 | 1;
        recored: {
          id: number;
          user_id: number;
          to_uid: number;
          nickname: string;
          avatar: string;
          is_tourist: number;
          online: number;
          type: number;
          add_time: number;
          update_time: number;
          mssage_num: number;
          message: string;
          message_type: number;
        };
        kefuInfo: { uid: number; nickname: string; avatar: string };
      };
    }
  | {
      type: "to_transfer";
      data: {
        request_key: string;
        toUid: number;
        is_tourist: 0 | 1;
        nickname: string;
        avatar: string;
        online: number;
      };
    };

const TRANSFER_REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validTransferEvent(event: TransferDeliveryEvent): boolean {
  if (
    !event || !event.data || typeof event.data.request_key !== "string" ||
    !TRANSFER_REQUEST_KEY_PATTERN.test(event.data.request_key) ||
    (event.data.is_tourist !== 0 && event.data.is_tourist !== 1)
  ) return false;
  if (event.type === "transfer_out") {
    return Number.isSafeInteger(event.data.uid) && event.data.uid > 0 &&
      Number.isSafeInteger(event.data.toUid) && event.data.toUid > 0 &&
      typeof event.data.nickname === "string" && typeof event.data.avatar === "string" &&
      event.data.nickname.length <= 255 && event.data.avatar.length <= 2_048;
  }
  if (event.type === "to_transfer") {
    return Number.isSafeInteger(event.data.toUid) && event.data.toUid > 0 &&
      (event.data.online === 0 || event.data.online === 1) &&
      typeof event.data.nickname === "string" && typeof event.data.avatar === "string" &&
      event.data.nickname.length <= 255 && event.data.avatar.length <= 2_048;
  }
  return Boolean(event.data.recored && event.data.kefuInfo) &&
    Number.isSafeInteger(event.data.recored.id) && event.data.recored.id > 0 &&
    Number.isSafeInteger(event.data.recored.user_id) && event.data.recored.user_id > 0 &&
    Number.isSafeInteger(event.data.recored.to_uid) && event.data.recored.to_uid > 0 &&
    typeof event.data.recored.message === "string" &&
    typeof event.data.kefuInfo.nickname === "string" && typeof event.data.kefuInfo.avatar === "string" &&
    event.data.recored.message.length <= 2_000 &&
    event.data.kefuInfo.nickname.length <= 255 && event.data.kefuInfo.avatar.length <= 2_048;
}

function sessionOf(ws: WebSocket): ChatSocketSession | null {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const session = value as Partial<ChatSocketSession>;
  try {
    if (
      parseChatRole(session.role) !== session.role ||
      (session.isTourist !== 0 && session.isTourist !== 1) ||
      (session.role === 1 && session.isTourist !== 0) ||
      (session.role === 3 && session.isTourist !== 1) ||
      !Number.isSafeInteger(session.principalUid) ||
      Number(session.principalUid) <= 0 ||
      !Number.isSafeInteger(session.toUid) ||
      Number(session.toUid) < 0 ||
      !Number.isSafeInteger(session.authId) ||
      Number(session.authId) <= 0 ||
      !Number.isSafeInteger(session.expiresAt) ||
      Number(session.expiresAt) <= 0 ||
      !Number.isSafeInteger(session.connectedAt) ||
      Number(session.connectedAt) <= 0 ||
      !CHAT_TOKEN_KEY_PATTERN.test(String(session.tokenKey ?? "")) ||
      typeof session.authVersion !== "string" ||
      !session.authVersion
    ) return null;
    return session as ChatSocketSession;
  } catch {
    return null;
  }
}

function peerRole(session: ChatSocketSession): ChatRole {
  return session.role === 2 ? (session.isTourist === 1 ? 3 : 1) : 2;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message && !error.message.startsWith("invalid chat")) {
    return error.message;
  }
  return "消息格式错误";
}

function structuredError(event: string, error: unknown, session?: ChatSocketSession | null): void {
  console.error(JSON.stringify({
    event,
    principalUid: session?.principalUid ?? 0,
    role: session?.role ?? 0,
    error: error instanceof Error ? error.name : "unknown",
  }));
}

/** One Durable Object instance coordinates all sockets for one authenticated principal. */
export class ChatRoomDO extends DurableObject<Env> {
  private service(): KefuRealtimeService {
    return new KefuRealtimeService(createContainer(this.env), this.env);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    let session: ChatSocketSession;
    try {
      session = parseChatSessionRequest(request);
      await this.service().setOnline(session, true);
    } catch (error) {
      structuredError("chat_socket_upgrade_rejected", error);
      return new Response("Unauthorized WebSocket", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`role:${session.role}`]);
    server.serializeAttachment(session);
    server.send(JSON.stringify({ type: "ping", data: { now: Math.floor(Date.now() / 1000) } }));
    server.send(JSON.stringify({ status: 200, msg: "ok", data: null }));

    const responseHeaders = new Headers();
    const protocols = request.headers.get("Sec-WebSocket-Protocol")?.split(",") ?? [];
    if (protocols.some((value) => value.trim() === "cinashop")) {
      responseHeaders.set("Sec-WebSocket-Protocol", "cinashop");
    }
    return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
  }

  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const session = sessionOf(ws);
    if (!session) {
      ws.close(4001, "Invalid session");
      return;
    }
    if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
      ws.close(4001, "Session expired");
      return;
    }

    let envelope: ChatEnvelope;
    try {
      envelope = parseChatEnvelope(message);
    } catch (error) {
      ws.send(JSON.stringify({ type: "err_tip", data: { msg: errorMessage(error) } }));
      return;
    }

    if (envelope.type === "ping") {
      ws.send(JSON.stringify({ type: "ping", data: { now: Math.floor(Date.now() / 1000) } }));
      return;
    }

    try {
      if (envelope.type === "chat") {
        await this.handleChat(ws, session, envelope.data);
      } else if (envelope.type === "to_chat") {
        await this.handleToChat(ws, session, envelope.data);
      } else if (envelope.type === "online") {
        await this.handleOnline(ws, session, envelope.data);
      }
    } catch (error) {
      structuredError("chat_socket_event_rejected", error, session);
      ws.send(JSON.stringify({ type: "err_tip", data: { msg: errorMessage(error) } }));
    }
  }

  private async handleChat(
    senderWs: WebSocket,
    session: ChatSocketSession,
    data: Record<string, unknown>,
  ): Promise<void> {
    const persisted = await this.service().persistMessage(session, {
      toUid: data.to_uid,
      message: data.msn,
      messageType: data.msn_type ?? data.type,
    });
    const recipientRole = peerRole(session);
    const recipient = this.env.CHAT_ROOM.getByName(
      chatPrincipalName(recipientRole, persisted.to_uid),
    );
    try {
      const delivery = await recipient.deliver(persisted);
      if (delivery.viewing > 0) {
        await this.service().markMessageRead(persisted);
        persisted.type = 1;
        persisted.recored.mssage_num = 0;
      }
    } catch (error) {
      // Persistence already committed. A delivery outage must not invite a duplicate retry.
      structuredError("chat_recipient_delivery_failed", error, session);
    }
    senderWs.send(JSON.stringify({ type: "chat", data: persisted }));
  }

  private async handleToChat(
    ws: WebSocket,
    session: ChatSocketSession,
    data: Record<string, unknown>,
  ): Promise<void> {
    const toUid = await this.service().switchConversation(session, data.id ?? data.to_uid);
    const next = { ...session, toUid };
    ws.serializeAttachment(next);
    const recipientRole = peerRole(session);
    try {
      await this.env.CHAT_ROOM
        .getByName(chatPrincipalName(recipientRole, toUid))
        .deliverPresence(session.principalUid, true, session.isTourist);
    } catch (error) {
      structuredError("chat_presence_delivery_failed", error, session);
    }
    ws.send(JSON.stringify({
      type: "mssage_num",
      data: { uid: toUid, is_tourist: session.isTourist, num: 0, recored: {} },
    }));
  }

  private async handleOnline(
    ws: WebSocket,
    session: ChatSocketSession,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (session.role !== 2) throw new Error("only customer service can change availability");
    const online = Number(data.online);
    if (online !== 0 && online !== 1) throw new Error("invalid online state");
    await this.service().setOnline(session, online === 1);
    if (session.toUid > 0) {
      try {
        await this.env.CHAT_ROOM
          .getByName(chatPrincipalName(peerRole(session), session.toUid))
          .deliverPresence(session.principalUid, online === 1, session.isTourist);
      } catch (error) {
        structuredError("chat_presence_delivery_failed", error, session);
      }
    }
    ws.send(JSON.stringify({
      type: "online",
      data: { online, uid: session.principalUid, is_tourist: session.isTourist },
    }));
  }

  /** RPC invoked only after PostgreSQL persistence has committed. */
  async deliver(message: PersistedRealtimeMessage): Promise<DeliveryResult> {
    if (
      !Number.isSafeInteger(message.id) || message.id <= 0 ||
      !Number.isSafeInteger(message.uid) || message.uid <= 0 ||
      !Number.isSafeInteger(message.to_uid) || message.to_uid <= 0 ||
      (message.sender_role !== 1 && message.sender_role !== 2 && message.sender_role !== 3) ||
      (message.is_tourist !== 0 && message.is_tourist !== 1) ||
      typeof message.msn !== "string" || message.msn.length > 2_000
    ) throw new Error("invalid delivery payload");

    let connected = 0;
    let viewing = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const session = sessionOf(socket);
      if (
        !session || session.principalUid !== message.to_uid
        || session.isTourist !== message.is_tourist
      ) continue;
      connected += 1;
      const isViewing = session.toUid === message.uid;
      if (isViewing) viewing += 1;
      try {
        socket.send(JSON.stringify(isViewing
          ? { type: "reply", data: message }
          : {
              type: "mssage_num",
              data: {
                uid: message.uid,
                is_tourist: message.is_tourist,
                num: message.recored.mssage_num,
                recored: message.recored,
              },
            }));
      } catch {
        // The hibernation registry will discard closed sockets.
      }
    }
    return { connected, viewing };
  }

  async deliverPresence(uid: number, online: boolean, isTourist: 0 | 1): Promise<number> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("invalid presence payload");
    if (isTourist !== 0 && isTourist !== 1) throw new Error("invalid presence scope");
    let delivered = 0;
    const payload = JSON.stringify({
      type: "online",
      data: { uid, online: online ? 1 : 0, is_tourist: isTourist },
    });
    for (const socket of this.ctx.getWebSockets()) {
      const session = sessionOf(socket);
      if (!session || session.toUid !== uid || session.isTourist !== isTourist) continue;
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        // Closed connection.
      }
    }
    return delivered;
  }

  /** PostgreSQL transfer commit must happen before this RPC is invoked. */
  async deliverTransfer(event: TransferDeliveryEvent): Promise<number> {
    if (!validTransferEvent(event)) throw new Error("invalid transfer delivery payload");
    const expectedRole: ChatRole = event.type === "to_transfer"
      ? (event.data.is_tourist === 1 ? 3 : 1)
      : 2;
    let delivered = 0;
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      const session = sessionOf(socket);
      if (
        !session || session.role !== expectedRole
        || session.isTourist !== event.data.is_tourist
      ) continue;
      if (event.type === "transfer_out" && session.toUid === event.data.uid) {
        session.toUid = 0;
        socket.serializeAttachment(session);
      } else if (event.type === "to_transfer") {
        session.toUid = event.data.toUid;
        socket.serializeAttachment(session);
      }
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        // Closed connection.
      }
    }
    return delivered;
  }

  async disconnectToken(tokenKey: string): Promise<number> {
    if (!CHAT_TOKEN_KEY_PATTERN.test(tokenKey)) throw new Error("invalid token key");
    let disconnected = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const session = sessionOf(socket);
      if (session?.tokenKey !== tokenKey) continue;
      socket.close(4001, "Session revoked");
      disconnected += 1;
    }
    return disconnected;
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const session = sessionOf(ws);
    if (!session) return;
    const anotherConnection = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === ws) return false;
      const candidateSession = sessionOf(candidate);
      return candidateSession?.principalUid === session.principalUid;
    });
    if (anotherConnection) return;
    try {
      await this.service().setDisconnected(session);
      if (session.toUid > 0) {
        const recipientRole = peerRole(session);
        await this.env.CHAT_ROOM
          .getByName(chatPrincipalName(recipientRole, session.toUid))
          .deliverPresence(session.principalUid, false, session.isTourist);
      }
    } catch (error) {
      structuredError("chat_socket_offline_update_failed", error, session);
    }
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    structuredError("chat_socket_error", error, sessionOf(ws));
    ws.close(1011, "WebSocket error");
  }
}
