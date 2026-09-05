/** Shared read-only invalidation protocol. Never carries financial commands or data. */
export type NoticeState = "idle" | "connecting" | "open" | "retrying" | "paused" | "denied";
export const noticeStateText: Record<NoticeState, string> = {
  idle: "通知未连接", connecting: "通知连接中", open: "通知实时连接", retrying: "通知重连中 · 定时检查兜底",
  paused: "通知已暂停", denied: "通知权限或登录状态已失效",
};
export function parseNoticeFrame(value: unknown): { type: "ready" | "changed"; revision: number } | null {
  if (typeof value !== "string" || value.length > 256) return null;
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(value); } catch { return null; }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
    || !Number.isSafeInteger(frame.revision) || Number(frame.revision) < 0) return null;
  if (frame.type === "staff_notification_ready" && frame.refresh === true && Object.keys(frame).length === 3)
    return { type: "ready", revision: Number(frame.revision) };
  if (frame.type === "staff_notification_changed" && Number(frame.revision) > 0 && Object.keys(frame).length === 2)
    return { type: "changed", revision: Number(frame.revision) };
  return null;
}

export interface NoticeSocket {
  readonly readyState: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends "open" | "message" | "close" | "error">(type: K,
    listener: (event: { open: Event; message: MessageEvent; close: CloseEvent; error: Event }[K]) => void): void;
}
export interface NoticeOptions {
  url(): string;
  onRefresh(): void;
  onState(state: NoticeState): void;
  onDenied(): void;
  connect?: (url: string, protocols: string[]) => NoticeSocket;
  random?: () => number;
}

export class StaffNoticeClient {
  private socket: NoticeSocket | null = null;
  private token = "";
  private enabled = true;
  private denied = false;
  private disposed = false;
  private attempt = 0;
  private revision = -1;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: NoticeOptions) {}

  setSession(token: string) {
    if (this.disposed || token === this.token) return;
    this.stop(); this.token = token; this.denied = false; this.attempt = 0; this.revision = -1;
    if (token && this.enabled) this.open(); else this.options.onState(token ? "paused" : "idle");
  }
  setActive(enabled: boolean) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) { this.stop(); if (!this.denied) this.options.onState(this.token ? "paused" : "idle"); }
    else if (this.token && !this.denied) this.open();
  }
  retry() {
    if (this.disposed || !this.token || !this.enabled) return;
    this.stop(); this.denied = false; this.attempt = 0; this.open();
  }
  deny() { this.stop(); this.denied = true; this.options.onState("denied"); this.options.onDenied(); }
  dispose() { this.disposed = true; this.token = ""; this.stop(); }
  private stop() {
    clearTimeout(this.retryTimer); clearTimeout(this.heartbeat); clearTimeout(this.deadline);
    this.retryTimer = this.heartbeat = this.deadline = undefined;
    const socket = this.socket; this.socket = null;
    try { socket?.close(1000, "Notification connection replaced"); } catch { /* already closed */ }
  }
  private recover() {
    this.stop();
    if (this.disposed || this.denied || !this.enabled || !this.token) return;
    this.options.onState("retrying");
    // A failed handshake exposes no HTTP status in browsers. Re-read the protected HTTP resource.
    this.options.onRefresh();
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.75 + (this.options.random ?? Math.random)() * 0.25);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
  private ping(socket: NoticeSocket) {
    this.heartbeat = setTimeout(() => {
      if (this.socket !== socket) return;
      try { socket.send("ping"); } catch { this.recover(); return; }
      this.deadline = setTimeout(() => { if (this.socket === socket) this.recover(); }, 10_000);
    }, 20_000);
  }
  private open() {
    if (this.disposed || this.denied || !this.enabled || !this.token || this.socket) return;
    this.options.onState("connecting");
    let socket: NoticeSocket;
    try { socket = (this.options.connect ?? ((url, protocols) => new WebSocket(url, protocols)))(this.options.url(), ["cinashop", `cinashop-auth.${this.token}`]); }
    catch { this.recover(); return; }
    this.socket = socket;
    let ready = false;
    this.deadline = setTimeout(() => { if (this.socket === socket) this.recover(); }, 12_000);
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (event.data === "pong" && ready) { clearTimeout(this.deadline); clearTimeout(this.heartbeat); this.ping(socket); return; }
      const frame = parseNoticeFrame(event.data);
      if (!frame) { this.recover(); return; }
      if (frame.type === "ready") {
        if (ready) { this.recover(); return; }
        ready = true; this.revision = frame.revision; this.attempt = 0;
        clearTimeout(this.deadline); this.options.onState("open"); this.ping(socket);
        this.options.onRefresh(); // Always refresh on reconnect, including an unchanged/lower revision.
      } else if (!ready) this.recover();
      else if (frame.revision > this.revision) { this.revision = frame.revision; this.options.onRefresh(); }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      if (event.code === 4001 || event.code === 1008) this.deny(); else this.recover();
    });
    socket.addEventListener("error", () => { /* close follows; the connection deadline covers a stalled handshake */ });
  }
}

/** Release connections for background/offline/bfcache; reconnect always forces authoritative catch-up. */
export function bindNoticeLifecycle(client: StaffNoticeClient, page: EventTarget, visibility: EventTarget & { readonly hidden: boolean }, online: () => boolean): () => void {
  const update = () => client.setActive(!visibility.hidden && online());
  const pause = () => client.setActive(false);
  const events = ["online", "offline", "pageshow"] as const;
  for (const event of events) page.addEventListener(event, update);
  page.addEventListener("pagehide", pause); visibility.addEventListener("visibilitychange", update); update();
  return () => {
    for (const event of events) page.removeEventListener(event, update);
    page.removeEventListener("pagehide", pause); visibility.removeEventListener("visibilitychange", update); client.dispose();
  };
}
