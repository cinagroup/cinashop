import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { financePostgres } from "./helpers/financePostgres";
import { createContainerFromDb } from "../src/lib/di";
import { LegacyPinkStatusService } from "../src/services/activity/LegacyPinkStatusService";
import { pinkInfo } from "../src/controllers/api/v1/ActivityJoinController";
import { ApiException } from "../src/utils/errors";
import { storePink, storeCombination, storeProduct, storeProductAttr, storeProductAttrValue, storeOrder, systemConfig, user } from "../src/models/schema";
import type { AppVariables, Env } from "../src/env";
import { parsePinkStatus } from "../../view/common/pinkStatus";

describe("legacy pink status through real HTTP and disposable SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, svc: LegacyPinkStatusService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const now = new Date("2026-09-08T00:00:00Z"), future = new Date("2026-09-09T00:00:00Z");
  const tables = [user, storePink, storeCombination, storeProduct, storeProductAttr, storeProductAttrValue, storeOrder, systemConfig];
  beforeEach(async () => {
    f = await financePostgres(tables); const container = createContainerFromDb(f.db); svc = new LegacyPinkStatusService(container);
    await f.db.insert(user).values([{ uid: 11, nickname: "Viewer", avatar: "/viewer.svg" }, { uid: 22, nickname: "Leader" }, { uid: 33, nickname: "Member" }]);
    await f.db.insert(storeProduct).values({ id: 70, storeName: "Base product", stock: 10, price: "20.00", isVerify: 1 });
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, storeName: "Legacy group", image: "/group.svg", price: "6.25", people: 4,
      stock: 9, quota: 6, quotaShow: 10, onceNum: 3, num: 6, deliveryType: "1,2", isHost: 1 });
    await f.db.insert(storePink).values([
      { id: 400, uid: 22, nickname: "Leader", avatar: "/leader.svg", combinationId: 30, productId: 70, people: 4, memberCount: 999,
        orderId: "private-leader", orderIdKey: "500", stopTime: future },
      { id: 401, uid: 33, nickname: "Member", avatar: "/member.svg", combinationId: 30, productId: 70, people: 4, kId: 400,
        orderId: "private-member", orderIdKey: "501", stopTime: future, totalPrice: "99.00", totalNum: 8 },
    ]);
    await f.db.insert(storeOrder).values([
      { id: 500, uid: 22, orderId: "private-leader", type: 3, activityId: 30, pinkId: 400, paid: 1 },
      { id: 501, uid: 33, orderId: "private-member", type: 3, activityId: 30, pinkId: 400, paid: 1 },
      { id: 502, uid: 11, orderId: "private-pending", type: 3, activityId: 30, pinkId: 400, paid: 0, totalNum: 3 },
    ]);
    await f.db.insert(storeProductAttr).values([{ id: 1, productId: 70, type: 0, attrName: "Colour", attrValues: "Red,Blue,Green" }]);
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 70, unique: "basered1", suk: "Red", stock: 2, price: "20.00" },
      { id: 2, productId: 30, type: 3, unique: "actred30", suk: "Red", stock: 7, quota: 6, quotaShow: 8,
        price: "6.25", cost: "4.00", brokerage: "2.00", image: "/red.svg" },
    ]);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", Number(c.req.header("x-fixture-user") ?? 0)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/api/combination/pink/:id", pinkInfo);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const read = (uid = 11, id = "400") => svc.read(uid, id, now);
  const request = async (id: string, uid = 11) => {
    const response = await app.request(`/api/combination/pink/${id}`, { headers: { "x-fixture-user": String(uid) } });
    return { response, body: await response.json<{ status: number; data: Awaited<ReturnType<typeof read>>; msg: string }>() };
  };
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    // Canonical row order: physical tuple order may change after fixture UPDATEs.
    for (const table of ["user", "store_pink", "store_combination", "store_product", "store_product_attr", "store_product_attr_value", "store_order", "system_config"]) {
      result[table] = await f.exec(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`);
    }
    return result;
  };

  it("resolves a member ID through k_id and returns the legacy envelope without treating activity IDs as records", async () => {
    const { response, body } = await request("401");
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(body.status).toBe(200);
    expect(body.data.pinkT.id).toBe(400); expect(body.data.resolved_pink_id).toBe(401);
    expect(body.data.store_combination).toMatchObject({ id: 30, product_id: 70, title: "Legacy group", product_price: "20.00", pink_count: 4 });
    expect(body.data.pinkAll.map(row => row.id)).toEqual([401]); expect(body.data.count).toBe(2);
    expect(body.data.userBool).toBe(0); expect(body.data.current_pink_order).toBeNull();
    expect((await request("30")).body.status).toBe(404);
  });
  it("exposes only the current member's canonical order, including viewing another member's link", async () => {
    expect((await read(22, "401")).current_pink_order).toBe("private-leader");
    expect((await read(33)).current_pink_order).toBe("private-member");
    expect((await read(33)).userBool).toBe(1); expect((await read(11)).userBool).toBe(0);
    const publicData = JSON.stringify(await read(11));
    for (const secret of ["private-leader", "private-member", "private-pending", "order_id_key", "total_price", "brokerage", '"cost"', "memberCount"]) expect(publicData).not.toContain(secret);
  });
  it("feeds the replacement status page parser without confusing member, leader or activity identity", async () => {
    const data = parsePinkStatus(await read(33, "401"), 33);
    expect(data).toMatchObject({ resolvedId: 401, joined: true, orderId: "private-member", activity: { id: 30, productId: 70 }, leader: { id: 400 } });
    expect(() => parsePinkStatus(data, 11)).toThrow();
  });
  it("encodes timestamp filter parameters with the actual column codecs before the driver boundary", async () => {
    const start = vi.spyOn(storeCombination.startTime, "mapToDriverValue"), stop = vi.spyOn(storeCombination.stopTime, "mapToDriverValue");
    await read();
    // PGlite accepts a raw Date parameter; postgres-js with a server-described
    // timestamptz parameter does not. Both detail and host filters need the codec.
    expect(start).toHaveBeenCalledWith(now); expect(stop).toHaveBeenCalledWith(now);
    expect(start.mock.calls.length).toBe(2); expect(stop.mock.calls.length).toBe(2);
    for (const result of [...start.mock.results, ...stop.mock.results]) expect(result.value).toBe(now.toISOString());
  });
  it.each(["0", "-1", "1.5", "1e2", "0400", "Infinity", "2147483648", "400junk"])("rejects noncanonical record ID %s", async id => {
    const { response, body } = await request(id); expect(body.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects anonymous, missing, disabled and deleted users, including injected uid query parameters", async () => {
    expect((await request("400?uid=22", 0)).body.status).toBe(410000);
    expect((await request("400", 999)).body.status).toBe(410000);
    await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11)); expect((await request("400")).body.status).toBe(410000);
    await f.db.update(user).set({ status: 1, isDel: 1 }).where(eq(user.uid, 11)); expect((await request("400")).body.status).toBe(410000);
  });
  it("counts actual non-refunded members, not cached counts, pending orders, purchased pieces or unrelated groups", async () => {
    await f.db.insert(storePink).values([
      { id: 402, uid: 11, combinationId: 30, productId: 70, kId: 400, people: 4, isRefund: 402, totalNum: 99 },
      { id: 403, uid: 11, combinationId: 30, productId: 70, kId: 999, people: 4 },
    ]);
    const result = await read(); expect(result.count).toBe(2); expect(result.userBool).toBe(0); expect(result.pinkAll).toHaveLength(1);
  });
  it.each([2, 3])("projects persisted terminal status %i without settling or refunding anything", async status => {
    await f.db.update(storePink).set({ status }).where(eq(storePink.id, 400)); const before = await snapshot();
    const result = await read(); expect(result.is_ok).toBe(status === 2 ? 1 : 0); expect(result.pinkBool).toBe(status === 2 ? 1 : -1);
    expect(result.settlement_pending).toBe(false); expect(await snapshot()).toEqual(before);
  });
  it.each(["expired", "full", "null-deadline"])("does not fabricate success/refund for an unsettled %s group", async mode => {
    await f.db.update(storePink).set(mode === "full" ? { people: 2 } : { stopTime: mode === "expired" ? now : null }).where(eq(storePink.id, 400));
    const before = await snapshot(); const result = await read(); expect(result.pinkBool).toBe(0); expect(result.is_ok).toBe(0);
    expect(result.state).toBe("settlement_pending"); expect(result.settlement_pending).toBe(true); expect(await snapshot()).toEqual(before);
  });
  it("follows a same-activity replacement but rejects self-refund, cycles and missing or foreign replacements", async () => {
    await f.db.update(storePink).set({ isRefund: 401 }).where(eq(storePink.id, 400));
    // A replacement cannot still point to the refunded leader.
    await expect(read()).rejects.toThrow("团长记录无效");
    await f.db.update(storePink).set({ kId: 0 }).where(eq(storePink.id, 401)); expect((await read()).pinkT.id).toBe(401);
    await f.db.update(storePink).set({ isRefund: 400 }).where(eq(storePink.id, 401)); await expect(read()).rejects.toThrow("循环");
    await f.db.update(storePink).set({ isRefund: 401 }).where(eq(storePink.id, 401)); await expect(read()).rejects.toThrow("订单已退款");
    await f.db.update(storePink).set({ isRefund: 999 }).where(eq(storePink.id, 400)); await expect(read()).rejects.toThrow("记录不存在");
    await f.db.update(storePink).set({ isRefund: 401 }).where(eq(storePink.id, 400));
    await f.db.update(storePink).set({ isRefund: 0, combinationId: 31 }).where(eq(storePink.id, 401)); await expect(read()).rejects.toThrow("指向不匹配");
  });
  it("rejects missing/nested/foreign leaders and foreign children instead of leaking their profiles", async () => {
    await f.db.update(storePink).set({ kId: 999 }).where(eq(storePink.id, 401)); await expect(read(11, "401")).rejects.toThrow("团长记录无效");
    await f.db.update(storePink).set({ kId: 400 }).where(eq(storePink.id, 401));
    await f.db.update(storePink).set({ kId: 401 }).where(eq(storePink.id, 400)); await expect(read(11, "401")).rejects.toThrow("团长记录无效");
    await f.db.update(storePink).set({ kId: 0 }).where(eq(storePink.id, 400));
    await f.db.update(storePink).set({ productId: 71 }).where(eq(storePink.id, 401)); await expect(read()).rejects.toThrow("成员数据无效");
  });
  it("bounds replacement chains before unbounded lookup and leaves all rows untouched on failure", async () => {
    await f.db.insert(storePink).values(Array.from({ length: 33 }, (_, i) => ({ id: 1000 + i, uid: 22,
      combinationId: 30, productId: 70, people: 4, isRefund: i === 32 ? 0 : 1001 + i })));
    const before = await snapshot(); await expect(read(11, "1000")).rejects.toThrow("层级过多");
    expect(await snapshot()).toEqual(before);
  });
  it("validates order ownership/type/activity/deletion and never falls back to another group", async () => {
    for (const patch of [{ uid: 11 }, { type: 0 }, { activityId: 31 }, { pinkId: 999 }, { isDel: 1 }, { isSystemDel: 1 }]) {
      await f.db.update(storeOrder).set({ uid: 33, type: 3, activityId: 30, pinkId: 400, isDel: 0, isSystemDel: 0, ...patch }).where(eq(storeOrder.id, 501));
      expect((await read(33)).current_pink_order).toBeNull();
    }
    await f.db.update(storeOrder).set({ isSystemDel: 0 }).where(eq(storeOrder.id, 501));
    for (const key of ["501abc", "0501", "9999999999", "99999999999999999999999999999999"]) {
      await f.db.update(storePink).set({ orderIdKey: key }).where(eq(storePink.id, 401)); expect((await read(33)).current_pink_order).toBeNull();
    }
  });
  it("preserves activity SKU identity, base stock/price and permitted attributes without private cost fields", async () => {
    const result = await read();
    expect(result.store_combination.productAttr[0].attr_values).toEqual(["Red"]);
    expect(result.store_combination.productValue.Red).toMatchObject({ product_id: 30, type: 3, unique: "actred30", price: "6.25", product_stock: 2, product_price: "20.00", quota: 6 });
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    expect((await read()).store_combination.productValue.Red).toMatchObject({ product_stock: 0, stock: 0, quota: 0 });
    await f.db.insert(storeProductAttr).values({ id: 2, productId: 30, type: 3, attrName: "Activity colour", attrValues: '["Red","Green"]' });
    expect((await read()).store_combination.productAttr[0]).toMatchObject({ product_id: 30, attr_name: "Activity colour", attr_values: ["Red"] });
  });
  it("handles empty SKUs and zero sales limits as readable status, not fabricated purchasability", async () => {
    await f.db.delete(storeProductAttrValue); await f.db.update(storeCombination).set({ num: 0, onceNum: 0 });
    expect((await read()).store_combination).toMatchObject({ num: 0, once_num: 0, productValue: {} });
  });
  it("uses absent-only configuration defaults, scoped authoritative ordering and the master self-pickup gate", async () => {
    expect(await read()).toMatchObject({ store_func_status: 1, store_self_mention: 0 });
    await f.db.insert(systemConfig).values([{ id: 1, menuName: "store_func_status", value: "0", sort: 9 },
      { id: 2, menuName: "store_func_status", value: "1", sort: 0 }, { id: 3, menuName: "store_self_mention", value: "1" },
      { id: 4, menuName: "store_func_status", value: "1", isStore: 1, sort: 99 }]);
    expect(await read()).toMatchObject({ store_func_status: 0, store_self_mention: 0 });
    await f.db.update(systemConfig).set({ value: '"1"' }).where(eq(systemConfig.id, 1)); expect((await read()).store_self_mention).toBe(1);
    await f.db.update(systemConfig).set({ value: "" }).where(eq(systemConfig.id, 1)); expect((await read()).store_func_status).toBe(0);
  });
  it("filters hidden, unreviewed, VIP-only and expired products before exposing group data", async () => {
    for (const patch of [{ isShow: 0 }, { isDel: 1 }, { isVerify: 0 }, { isVipProduct: 1 }]) {
      await f.db.update(storeProduct).set({ isShow: 1, isDel: 0, isVerify: 1, isVipProduct: 0, ...patch }); await expect(read()).rejects.toThrow("已下架");
    }
    await f.db.update(user).set({ isMoneyLevel: 1 }).where(eq(user.uid, 11)); expect((await read()).pinkT.id).toBe(400);
    await f.db.update(storeCombination).set({ stopTime: new Date(now.getTime() - 1) }); await expect(read()).rejects.toThrow("已下架");
  });
  it("provides bounded host recommendations with a truncation signal and safe image schemes", async () => {
    await f.db.insert(storeCombination).values(Array.from({ length: 22 }, (_, i) => ({ id: 100 + i, productId: 70, storeName: `Host ${i}`, isHost: 1 })));
    await f.db.update(storeCombination).set({ image: "javascript:alert(1)" }).where(eq(storeCombination.id, 30));
    await f.db.update(storePink).set({ avatar: "https://private:credential@example.test/a" }).where(eq(storePink.id, 401));
    const result = await read(); expect(result.store_combination_host).toHaveLength(20); expect(result.store_combination_host_truncated).toBe(true);
    expect(result.store_combination_host[0].id).toBe(121); expect(result.store_combination.image).toBe(""); expect(result.pinkAll[0].avatar).toBe("");
  });
  it("rejects over-limit or duplicate data without silent truncation or SKU overwrite", async () => {
    await f.db.update(storePink).set({ people: 501 }).where(eq(storePink.id, 400)); await expect(read()).rejects.toThrow("人数或状态");
    await f.db.update(storePink).set({ people: 4 }).where(eq(storePink.id, 400));
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 30, type: 3, unique: "other30", suk: "Red" });
    await expect(read()).rejects.toThrow("规格标识");
  });
  it("rejects oversized attribute payloads before parsing and excessive member arrays without truncating them", async () => {
    await f.db.update(storeProductAttr).set({ attrValues: "x".repeat(32_769) }); await expect(read()).rejects.toThrow("属性内容超限");
    await f.db.update(storeProductAttr).set({ attrValues: "Red" });
    await f.db.insert(storePink).values(Array.from({ length: 500 }, (_, i) => ({ id: 1000 + i, uid: 0,
      combinationId: 30, productId: 70, kId: 400, people: 4, isVirtual: 1 })));
    await expect(read()).rejects.toThrow("成员数据无效或超过500人");
  });
  it("performs repeated GETs in read-only repeatable snapshots and preserves every fixture row", async () => {
    const outgoing = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external I/O permitted"));
    const before = await snapshot(); await read(); await read(33, "401"); await read(22);
    expect(await snapshot()).toEqual(before); expect(outgoing).not.toHaveBeenCalled();
    // Verify the database engine actually enforces the same transaction mode.
    await expect(f.db.transaction(async tx => { await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.update(storePink).set({ status: 2 }); })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
