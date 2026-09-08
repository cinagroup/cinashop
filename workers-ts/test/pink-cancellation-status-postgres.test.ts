import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { createContainerFromDb } from "../src/lib/di";
import { PinkCancellationStatusService } from "../src/services/activity/PinkCancellationStatusService";
import { pinkCancellationStatus } from "../src/controllers/api/v1/ActivityJoinController";
import { ApiException } from "../src/utils/errors";
import { storeOrder, storeOrderRefund, storeOrderRefundPayment, storePink, user } from "../src/models/schema";
import type { AppVariables, Env } from "../src/env";

describe("owner-only pink cancellation receipt through read-only HTTP/SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: PinkCancellationStatusService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeEach(async () => {
    // Deliberately no activity/product tables: their visibility/lifetime cannot
    // prevent an owner reading an already accepted cancellation's receipt.
    f = await financePostgres([user, storeOrder, storeOrderRefund, storeOrderRefundPayment, storePink]);
    const container = createContainerFromDb(f.db); service = new PinkCancellationStatusService(container);
    await f.db.insert(user).values([{ uid: 11 }, { uid: 22 }]);
    await f.db.insert(storePink).values({ id: 400, uid: 11, combinationId: 30, productId: 70,
      orderId: "own-order", orderIdKey: "500", people: 4, stopTime: new Date(0) });
    await f.db.insert(storeOrder).values({ id: 500, uid: 11, orderId: "own-order", type: 3, activityId: 30,
      pinkId: 400, paid: 1, payType: "yue", payPrice: "6.25", totalNum: 2 });
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", Number(c.req.header("x-fixture-user") ?? 0)); await next(); });
    app.onError((e, c) => c.json({ status: e instanceof ApiException ? e.code : 500, msg: e.message, data: null }));
    app.get("/api/combination/remove/:id", pinkCancellationStatus);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GET must not contact providers"));
  }, 30_000);
  afterEach(async () => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); await f?.close(); });
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ["user", "store_order", "store_order_refund", "store_order_refund_payment", "store_pink"]) {
      rows[table] = await f.exec(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`);
    }
    return rows;
  };
  const read = async (uid = 11, id: unknown = "400", cid: unknown = "30") => {
    const before = await snapshot();
    try { return await service.read(uid, id, cid); }
    finally { expect(await snapshot()).toEqual(before); }
  };
  const request = async (id = "400", query = "cid=30", uid = 11) => {
    const before = await snapshot();
    const response = await app.request(`/api/combination/remove/${id}?${query}`, { headers: { "x-fixture-user": String(uid) } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await snapshot()).toEqual(before);
    return response.json<{ status: number; data: Awaited<ReturnType<typeof read>> | null }>();
  };
  const receipt = (patch: Partial<typeof storeOrderRefund.$inferInsert> = {}) => f.db.insert(storeOrderRefund).values({
    id: 1, uid: 11, storeOrderId: 500, orderId: "pink_cancel_400_500", applyType: 1, refundType: 0,
    refundNum: 2, refundPrice: "6.25", refundReason: "用户手动取消拼团", refundExplain: "用户手动取消未成团的拼团订单", ...patch,
  });
  const payment = async (providerStatus: string, patch: Partial<typeof storeOrderRefundPayment.$inferInsert> = {}) => {
    await f.db.update(storeOrder).set({ payType: "weixin" }).where(eq(storeOrder.id, 500));
    await f.db.insert(storeOrderRefundPayment).values({ id: 1, refundId: 1, storeOrderId: 500, provider: "wechat",
      outRefundNo: "CNSR1", providerStatus, requestAmount: 625, totalAmount: 625, lastError: "private provider diagnostic", ...patch });
  };
  const completedRows = async () => {
    await f.db.update(storeOrderRefund).set({ refundType: 6, refundedPrice: "6.25" });
    await f.db.update(storeOrder).set({ refundStatus: 2, refundPrice: "6.25" }).where(eq(storeOrder.id, 500));
    await f.db.update(storePink).set({ isRefund: 400, status: 3 });
  };

  it("registers a forced-auth read route separately from the unchanged mutation", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/combination/remove/:id", authMiddleware({ force: true }), ActivityJoinController.pinkCancellationStatus)');
    expect(routes).toContain('v1Routes.post("/combination/remove", authMiddleware({ force: true }), ActivityJoinController.removePink)');
  });
  it("reports snapshot absence, never creates an application or claims a failed in-flight POST", async () => {
    expect(await request()).toEqual({ status: 200, msg: "ok", data: { uid: 11, pink_id: 400, combination_id: 30,
      current_pink_order: "own-order", state: "not_applied", completed: false, resumable: false } });
    await receipt({ orderId: "ordinary-after-sales" }); expect((await read()).state).toBe("not_applied");
  });
  it.each([0, 1, 2, 4, 5])("reads accepted refund state %i after expiry without execution", async refundType => {
    await receipt({ refundType }); expect(await read()).toMatchObject({ state: "accepted", completed: false, resumable: true });
  });
  it.each([
    ["CREATED", "accepted", true], ["REQUESTING", "processing", true], ["PROCESSING", "processing", true],
    ["SUCCESS", "processing", true], ["UNKNOWN", "unknown", true], ["CLOSED", "needs_attention", false],
    ["ABNORMAL", "needs_attention", false], ["FAILED", "needs_attention", false],
  ])("projects provider %s as %s without querying it or fabricating business completion", async (provider, state, resumable) => {
    await receipt(); await payment(String(provider));
    expect(await read()).toMatchObject({ state, resumable, completed: false });
    expect(JSON.stringify(await read())).not.toMatch(/CNSR|pink_cancel_|lastError|private provider|providerRefundId|refundPrice/);
  });
  it.each(["yue", "weixin", "alipay"])("requires complete business evidence for %s", async payType => {
    await receipt();
    if (payType !== "yue") { await payment("SUCCESS", { provider: payType === "weixin" ? "wechat" : "alipay" }); await f.db.update(storeOrder).set({ payType }); }
    await completedRows(); expect(await read()).toMatchObject({ state: "completed", completed: true, resumable: false });
    for (const patch of [{ refundStatus: 0 }, { refundPrice: "0.00" }]) {
      await f.db.update(storeOrder).set({ refundStatus: 2, refundPrice: "6.25", ...patch });
      expect((await read()).state).toBe("needs_attention");
    }
  });
  it("reads the original leader after promotion but never follows the replacement's private data", async () => {
    await receipt(); await completedRows();
    await f.db.insert(storePink).values({ id: 401, uid: 22, combinationId: 30, productId: 70, orderIdKey: "501", orderId: "other-order" });
    await f.db.insert(storeOrder).values({ id: 501, uid: 22, orderId: "other-order", type: 3, pinkId: 401, activityId: 30, paid: 1 });
    expect((await request()).data).toMatchObject({ pink_id: 400, current_pink_order: "own-order", state: "completed" });
    expect((await request("401")).status).toBe(404);
  });
  it("requires both local and matching provider completion records", async () => {
    await receipt(); await payment("PROCESSING"); await completedRows(); expect((await read()).state).toBe("needs_attention");
    await f.db.delete(storeOrderRefundPayment); expect((await read()).state).toBe("needs_attention");
    await f.db.update(storeOrder).set({ payType: "yue" });
    await f.db.update(storePink).set({ isRefund: 401 }); expect((await read()).state).toBe("needs_attention");
  });
  it("does not hide duplicate, withdrawn, deleted, rejected, malformed or inconsistent receipts", async () => {
    for (const patch of [{ isCancel: 1 }, { isDel: 1 }, { refundType: 3 }, { refundType: 99 }, { uid: 22 },
      { applyType: 2 }, { refundNum: 1 }, { refundPrice: "1.00" }, { refundReason: "other" },
      { refundExplain: "other" }, { refundedPrice: "1.00" }]) {
      await f.db.delete(storeOrderRefund); await receipt(patch); expect((await read()).state).toBe("needs_attention");
    }
    await f.db.delete(storeOrderRefund); await receipt(); await receipt({ id: 2 });
    expect((await read()).state).toBe("needs_attention");
  });
  it("rejects changed provider identity and amounts without exposing diagnostic data", async () => {
    await receipt();
    for (const patch of [{ storeOrderId: 501 }, { outRefundNo: "other" }, { provider: "alipay" },
      { requestAmount: 1 }, { totalAmount: 999 }]) {
      await f.db.delete(storeOrderRefundPayment); await payment("PROCESSING", patch);
      expect((await read()).state).toBe("needs_attention");
    }
  });
  it("validates the parent payment amount and ownership for split payment orders", async () => {
    await receipt(); await payment("PROCESSING", { totalAmount: 1000 });
    await f.db.update(storeOrder).set({ pid: 600 }).where(eq(storeOrder.id, 500));
    await f.db.insert(storeOrder).values({ id: 600, uid: 11, orderId: "root-payment", paid: 1, payType: "weixin", payPrice: "10.00" });
    expect((await read()).state).toBe("processing");
    await f.db.update(storeOrder).set({ uid: 22 }).where(eq(storeOrder.id, 600)); expect((await read()).state).toBe("needs_attention");
    await f.db.delete(storeOrder).where(eq(storeOrder.id, 600)); expect((await read()).state).toBe("needs_attention");
  });
  it("denies anonymous/foreign/disabled/deleted principals and ignores forged identity parameters", async () => {
    await receipt();
    expect((await request("400", "cid=30&uid=11", 22)).status).toBe(404);
    expect((await request("400", "cid=30", 0)).status).toBe(410000);
    expect((await request("400", "cid=30", 999)).status).toBe(410000);
    for (const patch of [{ status: 0 }, { isDel: 1 }]) {
      await f.db.update(user).set({ status: 1, isDel: 0, ...patch }).where(eq(user.uid, 11));
      expect((await request()).status).toBe(410000);
    }
  });
  it("denies member/activity/mismatched order identities without fallback", async () => {
    for (const patch of [{ uid: 22 }, { orderId: "foreign" }, { type: 0 }, { activityId: 31 }, { pinkId: 401 },
      { paid: 0 }, { isDel: 1 }, { isSystemDel: 1 }]) {
      await f.db.update(storeOrder).set({ uid: 11, orderId: "own-order", type: 3, activityId: 30, pinkId: 400, paid: 1, isDel: 0, isSystemDel: 0, ...patch });
      expect((await request()).status).toBe(404);
    }
    expect((await request("30")).status).toBe(404); expect((await request("400", "cid=31")).status).toBe(404);
    await f.db.update(storePink).set({ kId: 399 }); expect((await request()).status).toBe(404);
  });
  it("rejects malformed route/query/order keys before unsafe casts and ignores duplicate cid", async () => {
    for (const raw of ["0", "0400", "400x", "-1", "1.2", "1e2", "2147483648"]) {
      expect((await request(raw)).status).toBe(400); expect((await request("400", `cid=${raw}`)).status).toBe(400);
    }
    for (const query of ["", "cid=", "cid=30&cid=30", "cid=30&cid=31"]) expect((await request("400", query)).status).toBe(400);
    for (const key of ["", "0500", "500abc", "9999999999", "99999999999999999999999"]) {
      await f.db.update(storePink).set({ orderIdKey: key }); expect((await request()).status).toBe(400);
    }
  });
  it("uses an engine-enforced read-only repeatable snapshot", async () => {
    await receipt(); const transaction = f.db.transaction.bind(f.db);
    const spy = vi.spyOn(f.db, "transaction").mockImplementation((fn, config) => transaction(async tx => {
      const value = await fn(tx);
      const mode = await tx.select({ ro: sql<string>`current_setting('transaction_read_only')`,
        isolation: sql<string>`current_setting('transaction_isolation')` }).from(user).limit(1);
      expect(mode).toMatchObject([{ ro: "on", isolation: "repeatable read" }]); return value;
    }, config));
    try { expect((await read()).state).toBe("accepted"); } finally { spy.mockRestore(); }
  });
});
