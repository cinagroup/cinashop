import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import { StaffNotificationAuthService } from "@/services/notification/StaffNotificationAuthService";
import { staffPrincipalName, type StaffSocketSession } from "@/services/notification/StaffNotificationProtocol";
import { AuthException } from "@/utils/errors";

const bindings = env as Env;
const session = (id = 71): StaffSocketSession => ({ audience: "admin", id, authId: id, tokenKey: "a".repeat(32),
  authVersion: "b".repeat(32), expiresAt: Math.floor(Date.now() / 1000) + 600 });
const request = (s: StaffSocketSession) => new Request("https://staff-notice.internal/connect", {
  headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "cinashop", "X-Staff-Session": JSON.stringify(s) },
});
function nextFrame(socket: WebSocket) {
  return new Promise<unknown>((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}
async function connect(s = session()) {
  const stub = bindings.STAFF_NOTICE.getByName(staffPrincipalName(s));
  const response = await stub.fetch(request(s)); expect(response.status).toBe(101);
  const client = response.webSocket; if (!client) throw new Error("Missing WebSocket upgrade");
  const hello = nextFrame(client); client.accept();
  expect(await hello).toMatchObject({ type: "staff_notification_ready", refresh: true });
  return { stub, client };
}
afterEach(async () => { await reset(); vi.restoreAllMocks(); });

describe("isolated staff notification workerd transport", () => {
  it("rejects malformed upgrades and the wrong principal partition", async () => {
    const stub = bindings.STAFF_NOTICE.getByName(staffPrincipalName(session()));
    expect((await stub.fetch("https://staff-notice.internal/connect")).status).toBe(426);
    expect((await stub.fetch(new Request("https://staff-notice.internal/connect", { headers: { Upgrade: "websocket", "X-Staff-Session": "{}" } }))).status).toBe(401);
    expect((await stub.fetch(request(session(72)))).status).toBe(401);
    // Assert rejecting methods inside the real DO: the pool RPC wrapper leaks a second rejection.
    // https://github.com/cloudflare/workers-sdk/issues/14736 (do not ignore unhandled errors).
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.publish(session(72), "withdrawal.staff.refresh:19")).rejects.toThrow("分区");
      await expect(instance.publish(session(), "order.paid:19")).rejects.toThrow("通知事件键无效");
      expect(state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM signals").one().count).toBe(0);
    });
  });
  it("persists revisions through eviction, redelivers a stable revision on retry and requests catch-up on reconnect", async () => {
    vi.spyOn(StaffNotificationAuthService.prototype, "assertSession").mockResolvedValue(undefined);
    const { stub, client } = await connect();
    let next = nextFrame(client);
    const first = await stub.publish(session(), "withdrawal.staff.refresh:19");
    expect(await next).toEqual({ type: "staff_notification_changed", revision: first.revision });
    const attached = await runInDurableObject(stub, (_instance, state) => state.getWebSockets()[0]?.deserializeAttachment());
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => { expect(state.getWebSockets()[0]?.deserializeAttachment()).toEqual(attached); });
    next = nextFrame(client); expect((await stub.publish(session(), "withdrawal.staff.refresh:19")).revision).toBe(first.revision);
    expect(await next).toEqual({ type: "staff_notification_changed", revision: first.revision });
    await runInDurableObject(stub, (_instance, state) => { expect(state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM signals").one().count).toBe(1); });
    client.close(1000, "reconnect");
    const response = await stub.fetch(request(session())), other = response.webSocket!;
    const hello = nextFrame(other); other.accept();
    expect(await hello).toEqual({ type: "staff_notification_ready", revision: first.revision, refresh: true }); other.close();
  });
  it("never shares admin/kefu or other-principal frames, and caps connections per principal", async () => {
    vi.spyOn(StaffNotificationAuthService.prototype, "assertSession").mockResolvedValue(undefined);
    const { stub, client } = await connect(); const other = await connect(session(72));
    const kefuSession = { ...session(71), audience: "kefu" as const, authId: 2 };
    const kefu = await connect(kefuSession);
    const seen: string[] = []; other.client.addEventListener("message", (event) => seen.push(String(event.data))); kefu.client.addEventListener("message", (event) => seen.push(String(event.data)));
    const received = nextFrame(client); await stub.publish(session(), "withdrawal.staff.refresh:19"); await received;
    expect(seen).toEqual([]);
    const sockets: WebSocket[] = [client];
    for (let i = 0; i < 7; i++) sockets.push((await connect()).client);
    expect((await stub.fetch(request(session()))).status).toBe(429);
    for (const socket of [...sockets, other.client, kefu.client]) socket.close();
  });
  it("revalidates hibernated sessions before server delivery and closes a revoked reader without emitting data", async () => {
    const auth = vi.spyOn(StaffNotificationAuthService.prototype, "assertSession").mockResolvedValue(undefined);
    const { stub, client } = await connect(); await evictDurableObject(stub);
    const frames: string[] = []; client.addEventListener("message", (event) => frames.push(String(event.data)));
    const closed = new Promise<CloseEvent>((resolve) => client.addEventListener("close", resolve, { once: true }));
    auth.mockRejectedValue(new AuthException("revoked"));
    expect((await stub.publish(session(), "withdrawal.staff.refresh:19")).connected).toBe(0);
    expect((await closed).code).toBe(4001); expect(frames).toEqual([]);
  });
  it("keeps infrastructure failures retryable and rejects client financial commands", async () => {
    const auth = vi.spyOn(StaffNotificationAuthService.prototype, "assertSession").mockResolvedValue(undefined);
    const { stub, client } = await connect();
    const frames: string[] = []; client.addEventListener("message", (event) => frames.push(String(event.data)));
    const unavailable = new Promise<CloseEvent>((resolve) => client.addEventListener("close", resolve, { once: true }));
    auth.mockRejectedValue(new Error("database unavailable"));
    // Same pool workaround as above; storage, sockets and method execution remain in workerd.
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.publish(session(), "withdrawal.staff.refresh:19")).rejects.toThrow("database unavailable");
    });
    expect((await unavailable).code).toBe(1013); expect(frames).toEqual([]);
    const savedRevision = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ revision: number }>("SELECT revision FROM signals WHERE event_key = ?", "withdrawal.staff.refresh:19").one().revision);
    auth.mockResolvedValue(undefined); const second = await connect();
    const received = nextFrame(second.client);
    expect((await stub.publish(session(), "withdrawal.staff.refresh:19")).revision).toBe(savedRevision);
    expect(await received).toEqual({ type: "staff_notification_changed", revision: savedRevision });
    const closed = new Promise<CloseEvent>((resolve) => second.client.addEventListener("close", resolve, { once: true }));
    second.client.send(JSON.stringify({ type: "withdraw", amount: 100 })); expect((await closed).code).toBe(1008); client.close();
  });
  it("rechecks idle sessions using the durable alarm", async () => {
    const auth = vi.spyOn(StaffNotificationAuthService.prototype, "assertSession").mockResolvedValue(undefined);
    const { stub, client } = await connect();
    const closed = new Promise<CloseEvent>((resolve) => client.addEventListener("close", resolve, { once: true }));
    auth.mockRejectedValue(new AuthException("expired"));
    expect(await runDurableObjectAlarm(stub)).toBe(true); expect((await closed).code).toBe(4001);
  });
});
