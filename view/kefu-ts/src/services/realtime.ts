import { KEFU_TOKEN_KEY, websocketUrl } from "@/api/client";
import type { ChatMessage, RealtimeEvent, SessionRecord } from "@/types/kefu";

export interface RealtimeCallbacks {
  onEvent(event: RealtimeEvent): void;
  onState(state: "connecting" | "open" | "closed"): void;
}

export function kefuSocketPath(toUid: number, isTourist: 0 | 1): string {
  const query = new URLSearchParams({ is_tourist: String(isTourist) });
  if (toUid > 0) query.set("to_uid", String(toUid));
  return `/kefuapi/ws?${query.toString()}`;
}

export function upsertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (list.some((item) => item.id === message.id)) return list;
  return [...list, message].sort((a, b) => a.id - b.id);
}

export function sessionMessagePreview(message: string, messageType: number): string {
  return messageType === 3 ? "[图片]" : message;
}

export function updateSessionFromMessage(
  sessions: SessionRecord[],
  message: ChatMessage,
  kefuUid: number,
): SessionRecord[] {
  const peerUid = message.uid === kefuUid ? message.to_uid : message.uid;
  const index = sessions.findIndex((item) =>
    item.to_uid === peerUid && item.is_tourist === message.is_tourist
  );
  if (index < 0) return sessions;
  const next = [...sessions];
  const current = next[index];
  next[index] = {
    ...current,
    message: sessionMessagePreview(message.msn, message.msn_type),
    message_type: message.msn_type,
    update_time: message.add_time,
  };
  const [updated] = next.splice(index, 1);
  next.unshift(updated);
  return next;
}

export class KefuRealtimeClient {
  private socket: WebSocket | null = null;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private manuallyClosed = false;
  private currentToUid = 0;
  private currentIsTourist: 0 | 1 = 0;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  connect(toUid?: number, isTourist?: 0 | 1): void {
    if (toUid !== undefined && toUid >= 0) this.currentToUid = toUid;
    if (isTourist !== undefined) this.currentIsTourist = isTourist;
    this.stopHeartbeat();
    this.stopReconnect();
    if (this.socket) {
      const previous = this.socket;
      this.socket = null;
      previous.close(1000, "reconnecting");
    }
    const token = localStorage.getItem(KEFU_TOKEN_KEY);
    if (!token) throw new Error("客服登录状态无效");
    this.manuallyClosed = false;
    this.callbacks.onState("connecting");
    const connectedToUid = this.currentToUid;
    const connectedIsTourist = this.currentIsTourist;
    const socket = new WebSocket(websocketUrl(kefuSocketPath(connectedToUid, connectedIsTourist)), [
      "cinashop",
      `cinashop-auth.${token}`,
    ]);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.callbacks.onState("open");
      this.heartbeat = window.setInterval(() => this.send("ping", {}), 25_000);
      if (
        this.currentToUid > 0
        && this.currentIsTourist === connectedIsTourist
        && this.currentToUid !== connectedToUid
      ) {
        this.send("to_chat", { id: this.currentToUid });
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as RealtimeEvent;
        this.callbacks.onEvent(parsed);
      } catch {
        this.callbacks.onEvent({ type: "err_tip", data: { msg: "收到无法识别的实时消息" } });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.callbacks.onState("closed");
      if (!this.manuallyClosed) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2_500);
      }
    });
  }

  selectConversation(uid: number, isTourist: 0 | 1): void {
    if (this.currentIsTourist !== isTourist) {
      this.currentToUid = uid;
      this.currentIsTourist = isTourist;
      this.connect();
      return;
    }
    this.currentToUid = uid;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send("to_chat", { id: uid });
    }
  }

  sendMessage(uid: number, message: string, messageType = 1): void {
    this.send("chat", {
      to_uid: uid,
      msn: message,
      msn_type: messageType,
      is_tourist: this.currentIsTourist,
    });
  }

  setOnline(online: boolean): void {
    this.send("online", { online: online ? 1 : 0 });
  }

  close(manual = true): void {
    this.manuallyClosed = manual;
    this.stopHeartbeat();
    this.stopReconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client closed");
  }

  private send(type: string, data: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("实时连接尚未就绪");
    }
    this.socket.send(JSON.stringify({ type, data }));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
