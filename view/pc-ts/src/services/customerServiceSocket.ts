export type CustomerServiceSocketIdentity =
  | { kind: "registered"; token: string }
  | { kind: "visitor"; token: string };

export interface CustomerServiceSocketEvent {
  type?: string;
  status?: number;
  msg?: string;
  data?: Record<string, unknown> | null;
}

export interface CustomerServiceSocketCallbacks {
  onState(state: "connecting" | "open" | "closed"): void;
  onEvent(event: CustomerServiceSocketEvent): void;
}

export function customerServiceSocketPath(identity: CustomerServiceSocketIdentity, serviceUid: number): string {
  if (identity.kind === "visitor") return "/kefuapi/tourist/ws";
  const query = new URLSearchParams({ type: "1", to_uid: String(serviceUid) });
  return `/api/ws/kefu?${query.toString()}`;
}

function websocketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

export class CustomerServiceSocket {
  private socket: WebSocket | null = null;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;

  constructor(
    private readonly identity: CustomerServiceSocketIdentity,
    private readonly serviceUid: () => number,
    private readonly callbacks: CustomerServiceSocketCallbacks,
  ) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopReconnect();
    this.stopHeartbeat();
    this.manuallyClosed = false;
    this.callbacks.onState("connecting");
    const socket = new WebSocket(
      websocketUrl(customerServiceSocketPath(this.identity, this.serviceUid())),
      [
        "cinashop",
        this.identity.kind === "visitor"
          ? `cinashop-visitor.${this.identity.token}`
          : `cinashop-auth.${this.identity.token}`,
      ],
    );
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.callbacks.onState("open");
      this.heartbeat = window.setInterval(() => {
        if (this.isOpen) this.send("ping", {});
      }, 25_000);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.callbacks.onEvent(parsed as CustomerServiceSocketEvent);
        }
      } catch {
        // Ignore malformed server frames; the authenticated socket remains usable.
      }
    });
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => {
      if (this.socket === socket) socket.close();
    });
  }

  send(type: string, data: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("客服实时连接尚未就绪");
    }
    this.socket.send(JSON.stringify({ type, data }));
  }

  close(): void {
    this.manuallyClosed = true;
    this.stopHeartbeat();
    this.stopReconnect();
    this.socket?.close(1000, "page closed");
    this.socket = null;
    this.callbacks.onState("closed");
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopHeartbeat();
    this.callbacks.onState("closed");
    if (this.manuallyClosed) return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
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
