import { DurableObject } from "cloudflare:workers";
import type { Env } from "@/env";
import { createContainer } from "@/lib/di";
import { AuthException } from "@/utils/errors";
import { StaffNotificationAuthService } from "@/services/notification/StaffNotificationAuthService";
import { parseStaffEventKey, parseStaffSession, staffPrincipalName, type StaffPrincipal } from "@/services/notification/StaffNotificationProtocol";

/** Per-admin or per-bound-kefu-UID invalidation stream, never a financial data store. */
export class StaffNotificationDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS signals (revision INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE)");
    });
  }
  private assertPrincipal(p: StaffPrincipal) {
    if (!this.env.STAFF_NOTICE.idFromName(staffPrincipalName(p)).equals(this.ctx.id)) throw new AuthException("通知分区不匹配");
  }
  private async authorize(value: unknown) {
    const s = parseStaffSession(value); this.assertPrincipal(s);
    const container = createContainer(this.env);
    try { await new StaffNotificationAuthService(container, this.env).assertSession(s); }
    finally { await container.db.$client.end({ timeout: 1 }); }
    return s;
  }
  private revision(): number {
    return this.ctx.storage.sql.exec<{ revision: number }>("SELECT coalesce(max(revision), 0) AS revision FROM signals").one().revision;
  }
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/connect" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const raw = request.headers.get("X-Staff-Session");
    if (!raw || raw.length > 1024) return new Response("Unauthorized", { status: 401 });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return new Response("Unauthorized", { status: 401 }); }
    let session;
    try { session = await this.authorize(parsed); }
    catch (error) { return new Response("Notification session unavailable", { status: error instanceof AuthException ? 401 : 503 }); }
    if (this.ctx.getWebSockets().length >= 8) return new Response("Too many notification connections", { status: 429 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server); server.serializeAttachment(session);
    await this.scheduleCheck();
    server.send(JSON.stringify({ type: "staff_notification_ready", revision: this.revision(), refresh: true }));
    return new Response(null, { status: 101, webSocket: client, headers: request.headers.get("Sec-WebSocket-Protocol") === "cinashop" ? { "Sec-WebSocket-Protocol": "cinashop" } : undefined });
  }
  /** RPC from the durable outbox only. Retry resends the SAME revision; clients deduplicate it. */
  async publish(principal: StaffPrincipal, key: string): Promise<{ revision: number; connected: number }> {
    this.assertPrincipal(principal); parseStaffEventKey(key);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO signals(event_key) VALUES (?)", key);
    const revision = this.ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM signals WHERE event_key = ?", key).one().revision;
    // Bound dedup storage. A very old replay is a harmless extra refresh, not a duplicated message/payment.
    this.ctx.storage.sql.exec("DELETE FROM signals WHERE revision < (SELECT max(revision) FROM signals) - 2048");
    let connected = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (!await this.active(socket)) continue;
      try { socket.send(JSON.stringify({ type: "staff_notification_changed", revision })); connected++; }
      catch { socket.close(1011, "Reconnect and refresh"); }
    }
    return { revision, connected };
  }
  private async active(socket: WebSocket): Promise<boolean> {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try { await this.authorize(socket.deserializeAttachment()); return true; }
    catch (error) {
      socket.close(error instanceof AuthException ? 4001 : 1013, "Notification session unavailable");
      // Revocation is terminal for this socket. Infrastructure failure must retain outbox retry.
      if (!(error instanceof AuthException)) throw error;
      return false;
    }
  }
  override async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    if (value !== "ping") { socket.close(1008, "Read-only notification connection"); return; }
    if (await this.active(socket)) socket.send("pong");
  }
  override async alarm(): Promise<void> {
    try { for (const socket of this.ctx.getWebSockets()) await this.active(socket); }
    finally { if (this.ctx.getWebSockets().length) await this.scheduleCheck(); }
  }
  private async scheduleCheck(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const next = Date.now() + 30000;
    if (current === null || current <= Date.now() || current > next) await this.ctx.storage.setAlarm(next);
  }
  override async webSocketClose(socket: WebSocket, code: number): Promise<void> { socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, "Closed"); }
  override async webSocketError(socket: WebSocket): Promise<void> { socket.close(1011, "Reconnect and refresh"); }
}
