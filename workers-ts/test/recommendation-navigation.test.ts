import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { storeActivity, storeBargain, storeBrand, storeCombination, storeProduct, storeProductAttrValue,
  storeProductLabel, storeSeckill, storeSeckillTime, user, systemConfig, memberRight, storePromotions } from "../src/models/schema";
import { RecommendationNavigationService } from "../src/services/product/RecommendationNavigationService";
import { productHot } from "../src/controllers/api/v1/ProductController";
import { seckillDetail } from "../src/controllers/api/v1/UserActivityController";
import { financePostgres } from "./helpers/financePostgres";

const NOW = new Date("2026-09-21T02:00:00.000Z"), END = new Date("2026-09-21T03:00:00.000Z");
const DAY = Date.parse("2026-09-20T16:00:00.000Z") / 1000;
const input = (id = 170, activity = "1,2,3,0", extra = {}) => ({ id, activity, is_presale_product: 0, ...extra });

describe("hot recommendation navigation against real disposable SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: RecommendationNavigationService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres([storeActivity, storeBargain, storeBrand, storeCombination, storeProduct, storeProductAttrValue,
      storeProductLabel, storeSeckill, storeSeckillTime, user, systemConfig, memberRight, storePromotions]);
    const container = createContainerFromDb(f.db); service = new RecommendationNavigationService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/product/hot", productHot); app.get("/api/seckill/detail/:id", seckillDetail);
  }, 60_000);
  afterAll(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await f?.close(); }, 60_000);
  beforeEach(async () => {
    vi.setSystemTime(NOW); await f.reset();
    await f.db.insert(storeProduct).values({ id: 170, storeName: "推荐基础商品", stock: 5, price: "12.30",
      isShow: 1, isVerify: 1, isHot: 1, activity: "1,2,3,0" });
    await f.db.insert(storeActivity).values({ id: 700, type: 1, status: 1, startDay: DAY, endDay: DAY, timeId: "7,8" });
    await f.db.insert(storeSeckillTime).values([
      { id: 7, status: 1, startTime: "0900", endTime: "11:00" }, { id: 8, status: 1, startTime: "1200", endTime: "1300" },
    ]);
    await f.db.insert(storeSeckill).values({ id: 900, productId: 170, activityId: 700, timeId: "7,8",
      storeName: "真实秒杀目标", price: "8.00", stock: 5, quota: 5, num: 5, onceNum: 2 });
    await f.db.insert(storeBargain).values({ id: 1000, productId: 170, title: "真实砍价目标", startTime: NOW, stopTime: END });
    await f.db.insert(storeCombination).values({ id: 1100, productId: 170, storeName: "真实拼团目标", startTime: NOW, stopTime: END });
    await f.db.insert(storeProductAttrValue).values([
      { id: 1, productId: 170, type: 0, unique: "baseA001", suk: "标准", stock: 5, price: "12.30" },
      { id: 2, productId: 900, type: 1, unique: "seckA001", suk: "标准", stock: 5, quota: 5, price: "8.00" },
    ]);
  });
  const read = async (activity = "1,2,3,0", extra = {}, now = NOW) => (await service.decorate([input(170, activity, extra)], now))[0].recommendation_target;
  const ordinary = { version: 1, product_id: 170, kind: "product", id: 170, ends_at: null };

  it("selects real activity IDs by PHP priority, keeping a leading ordinary preference and ignoring a later zero", async () => {
    expect(await read()).toEqual({ version: 1, product_id: 170, kind: "seckill", id: 900, ends_at: END.toISOString() });
    expect(await read("2,1,3,0")).toMatchObject({ kind: "bargain", id: 1000, ends_at: "2026-09-21T03:00:00.001Z" });
    expect(await read("3,1,2,0")).toMatchObject({ kind: "combination", id: 1100 });
    expect(await read("0,1,2,3")).toEqual(ordinary); expect(await read("")).toEqual(ordinary);
    await f.db.update(storeSeckill).set({ status: 0 });
    expect(await read("1,0,2,3")).toMatchObject({ kind: "bargain", id: 1000 });
  });
  it("uses the existing China-time slot and parent policy, never an end timestamp as an activity/slot ID", async () => {
    expect(await read("1", {}, new Date("2026-09-21T00:59:59.999Z"))).toEqual(ordinary);
    expect(await read("1", {}, new Date("2026-09-21T01:00:00.000Z"))).toMatchObject({ kind: "seckill", id: 900 });
    expect(await read("1", {}, END)).toEqual(ordinary);
    expect(await read("1", {}, new Date("2026-09-21T04:00:00.000Z"))).toMatchObject({ kind: "seckill", ends_at: "2026-09-21T05:00:00.000Z" });
    for (const change of [{ status: 0 }, { isDel: 1 }, { type: 2 }, { timeId: "99" }, { endDay: DAY - 86400 }]) {
      await f.db.update(storeActivity).set({ status: 1, isDel: 0, type: 1, timeId: "7,8", endDay: DAY, ...change });
      expect(await read()).toMatchObject({ kind: "bargain", id: 1000 });
    }
  });
  it("respects inclusive date-only seckill ends and rejects malformed or disabled daily slots", async () => {
    await f.db.update(storeSeckill).set({ startTime: new Date(DAY * 1000), stopTime: new Date(DAY * 1000) });
    expect(await read("1")).toMatchObject({ kind: "seckill" });
    expect(await read("1", {}, new Date((DAY + 86400) * 1000))).toEqual(ordinary);
    for (const change of [{ status: 0 }, { endTime: "invalid" }, { startTime: "2300", endTime: "0200" }]) {
      await f.db.update(storeSeckillTime).set({ status: 1, startTime: "0900", endTime: "1100", ...change }).where(eq(storeSeckillTime.id, 7));
      expect(await read("1")).toEqual(ordinary);
    }
  });
  it("filters inactive, hidden, deleted, expired and future candidates before choosing the next type", async () => {
    for (const change of [{ status: 0 }, { isShow: 0 }, { isDel: 1 }, { productId: 999 }]) {
      await f.db.update(storeSeckill).set({ status: 1, isShow: 1, isDel: 0, productId: 170, ...change });
      expect(await read()).toMatchObject({ kind: "bargain", id: 1000 });
    }
    for (const change of [{ status: 0 }, { isDel: 1 }, { startTime: END }, { stopTime: new Date(NOW.getTime() - 1) }]) {
      await f.db.update(storeBargain).set({ status: 1, isDel: 0, startTime: NOW, stopTime: END, ...change });
      expect(await read("2,3,0")).toMatchObject({ kind: "combination", id: 1100 });
    }
    for (const change of [{ status: 0 }, { isShow: 0 }, { isDel: 1 }, { startTime: END }, { stopTime: new Date(NOW.getTime() - 1) }]) {
      await f.db.update(storeCombination).set({ status: 1, isShow: 1, isDel: 0, startTime: NOW, stopTime: END, ...change });
      expect(await read("3")).toEqual(ordinary);
    }
  });
  it("includes the precise bargain/combination stop instant and resolves duplicate types deterministically", async () => {
    expect(await read("2", {}, END)).toMatchObject({ kind: "bargain" });
    expect(await read("3", {}, END)).toMatchObject({ kind: "combination" });
    expect(await read("2,3", {}, new Date(END.getTime() + 1))).toEqual(ordinary);
    await f.db.insert(storeBargain).values([{ id: 1001, productId: 170, sort: 1 }, { id: 1002, productId: 170, sort: 1 }]);
    expect(await read("2")).toMatchObject({ kind: "bargain", id: 1002, ends_at: null });
    await f.db.insert(storeCombination).values({ id: 1101, productId: 170, sort: 1 });
    expect(await read("3")).toMatchObject({ kind: "combination", id: 1101, ends_at: null });
    await f.db.insert(storeSeckill).values({ id: 901, productId: 170, sort: 1, timeId: "7" });
    expect(await read("1")).toMatchObject({ kind: "seckill", id: 901 });
  });
  it("never resolves presale or invalid priority through ordinary/activity targets and avoids needless SQL", async () => {
    const spy = vi.spyOn(f.db, "select");
    try {
      expect(await read("1", { is_presale_product: 1 })).toMatchObject({ kind: "presale", id: 170 });
      for (const extra of [{ activity: "0,0" }, { activity: "4" }, { activity: "1;select" }, { activity: {} }, { is_presale_product: null }]) {
        expect(await read("1", extra)).toMatchObject({ kind: "unavailable", id: null });
      }
      expect(await read("0,1,2,3")).toEqual(ordinary); expect(await service.decorate([])).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("batches an entire page in four reads without modifying business rows or leaking other products", async () => {
    const tables = [storeProduct, storeActivity, storeSeckill, storeSeckillTime, storeBargain, storeCombination, storeProductAttrValue];
    const snapshot = async () => Promise.all(tables.map(table => f.db.select().from(table)));
    const before = await snapshot(), spy = vi.spyOn(f.db, "select");
    try {
      const rows = await service.decorate([input(), ...Array.from({ length: 99 }, (_, i) => input(200 + i))], NOW);
      expect(rows).toHaveLength(100); expect(spy).toHaveBeenCalledTimes(4);
      expect(rows[0].recommendation_target).toMatchObject({ id: 900, product_id: 170 });
      expect(rows.slice(1).every(row => (row.recommendation_target as { kind: string }).kind === "product")).toBe(true);
    } finally { spy.mockRestore(); }
    expect(await snapshot()).toEqual(before);
  });
  it("rejects oversized/duplicate/invalid input before querying and fails explicitly on candidate overflow", async () => {
    const spy = vi.spyOn(f.db, "select");
    try {
      for (const rows of [[input(0)], [input(), input()], Array.from({ length: 101 }, (_, i) => input(i + 1))]) {
        await expect(service.decorate(rows, NOW)).rejects.toThrow();
      }
      await expect(service.decorate([input()], new Date(NaN))).rejects.toThrow(); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    await f.db.insert(storeBargain).values(Array.from({ length: 500 }, (_, i) => ({ id: 2000 + i, productId: 170 })));
    await expect(read("2")).rejects.toThrow("超过500项");
  });
  it("adds exact target metadata at the real hot endpoint and reaches the same base through the real seckill detail", async () => {
    const response = await app.request("/api/product/hot?limit=1&uid=999&vip=1");
    const result = await response.json() as { status: number; data: Array<{ activity: string; recommendation_target: { id: number; kind: string } }> };
    expect(result.status).toBe(200); expect(result.data[0].activity).toBe("1,2,3,0");
    expect(result.data[0].recommendation_target).toMatchObject({ kind: "seckill", id: 900, product_id: 170 });
    const detail = await app.request(`/api/seckill/detail/${result.data[0].recommendation_target.id}?view=skus`);
    const detailResult = await detail.json();
    expect(detailResult, JSON.stringify(detailResult)).toMatchObject({ status: 200, data: { seckill_id: 900, product_id: 170,
      skus: [{ unique: "seckA001", base_unique: "baseA001", catalog_price: "8.00" }] } });
    await f.db.update(storeProduct).set({ isVipProduct: 1 });
    expect(await (await app.request("/api/product/hot?uid=999&vip=1")).json()).toMatchObject({ status: 200, data: [] });
  });
});
