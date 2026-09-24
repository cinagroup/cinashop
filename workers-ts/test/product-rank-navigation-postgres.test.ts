import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { storeActivity, storeBargain, storeBrand, storeCombination, storeProduct, storeProductLabel,
  storeSeckill, storeSeckillTime, user, systemConfig, memberRight } from "../src/models/schema";
import { rankList } from "../src/controllers/api/v1/ProductController";
import { financePostgres } from "./helpers/financePostgres";

const NOW = new Date("2026-09-24T02:00:00.000Z");
const END = new Date("2026-09-24T03:00:00.000Z");
const DAY = Date.parse("2026-09-23T16:00:00.000Z") / 1_000;
type Target = { version: number; product_id: number; kind: string; id: number | null; ends_at: string | null };
type RankResult = { status: number; data: Array<{ id: number; activity: string; recommendation_target: Target }> };

describe("ranked product activity navigation against disposable SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres([storeActivity, storeBargain, storeBrand, storeCombination, storeProduct,
      storeProductLabel, storeSeckill, storeSeckillTime, user, systemConfig, memberRight]);
    const container = createContainerFromDb(f.db);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); c.set("uid", 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get("/api/product/rank/:type", rankList);
  }, 60_000);
  afterAll(async () => { vi.useRealTimers(); await f?.close(); }, 60_000);
  beforeEach(async () => {
    vi.setSystemTime(NOW);
    await f.reset();
    await f.db.insert(storeProduct).values([
      { id: 170, storeName: "首位商品", isShow: 1, isVerify: 1, stock: 5, price: "12.30",
        sales: 100, star: "4.8", collect: 90, activity: "1,2,3,0" },
      { id: 171, storeName: "次位商品", isShow: 1, isVerify: 1, stock: 5, price: "12.30",
        sales: 80, star: "4.7", collect: 80, activity: "2,3,0" },
      { id: 172, storeName: "预售商品", isShow: 1, isVerify: 1, stock: 5, price: "12.30",
        sales: 60, star: "4.6", collect: 70, activity: "1,2,3", isPresaleProduct: 1 },
    ]);
    await f.db.insert(storeActivity).values({ id: 700, type: 1, status: 1, startDay: DAY, endDay: DAY, timeId: "7" });
    await f.db.insert(storeSeckillTime).values({ id: 7, status: 1, startTime: "0900", endTime: "1100" });
    await f.db.insert(storeSeckill).values({ id: 900, productId: 170, activityId: 700, timeId: "7",
      storeName: "首位秒杀", price: "8.00", stock: 5, quota: 5, num: 5, onceNum: 2 });
    await f.db.insert(storeBargain).values([
      { id: 1000, productId: 170, title: "首位砍价", startTime: NOW, stopTime: END },
      { id: 1001, productId: 171, title: "次位砍价", startTime: NOW, stopTime: END },
    ]);
    await f.db.insert(storeCombination).values({ id: 1100, productId: 170,
      storeName: "首位拼团", startTime: NOW, stopTime: END });
  });
  const read = async (query = "1?limit=10") => {
    const response = await app.request(`/api/product/rank/${query}`);
    return { response, result: await response.json() as RankResult };
  };

  it("adds only exact current-page activity identities while retaining the ranked rows and tabs", async () => {
    const first = await read("1?page=1&limit=1");
    expect(first.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(first.result.status).toBe(200);
    expect(first.result.data).toHaveLength(1);
    expect(first.result.data[0]).toMatchObject({ id: 170, activity: "1,2,3,0",
      recommendation_target: { version: 1, product_id: 170, kind: "seckill", id: 900,
        ends_at: END.toISOString() } });
    const second = (await read("1?page=2&limit=1")).result;
    expect(second.data).toMatchObject([{ id: 171, recommendation_target: { product_id: 171, kind: "bargain", id: 1001 } }]);
    const presale = (await read("1?page=3&limit=1")).result;
    expect(presale.data).toMatchObject([{ id: 172, recommendation_target: { product_id: 172, kind: "presale", id: 172 } }]);
    expect((await read("2?page=1&limit=1")).result.data[0].id).toBe(170);
    expect((await read("3?page=1&limit=1")).result.data[0].id).toBe(170);
  });

  it("uses priority and stable duplicate ordering only after activity, parent, visibility and slot checks", async () => {
    await f.db.update(storeProduct).set({ activity: "2,1,3,0" }).where(eq(storeProduct.id, 170));
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1000 });
    await f.db.insert(storeBargain).values([{ id: 1002, productId: 170, sort: 1, startTime: NOW, stopTime: END },
      { id: 1003, productId: 170, sort: 1, startTime: NOW, stopTime: END }]);
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1003 });
    await f.db.update(storeProduct).set({ activity: "1,2,3,0" }).where(eq(storeProduct.id, 170));
    await f.db.update(storeActivity).set({ status: 0 });
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1003 });
    await f.db.update(storeActivity).set({ status: 1 });
    await f.db.update(storeSeckillTime).set({ status: 0 });
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1003 });
    await f.db.update(storeBargain).set({ status: 0 });
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "combination", id: 1100 });
    await f.db.update(storeCombination).set({ isShow: 0 });
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "product", id: 170 });
  });

  it("projects only current date and time windows, with exact end instants", async () => {
    vi.setSystemTime(new Date("2026-09-24T00:59:59.999Z"));
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "product", id: 170 });
    vi.setSystemTime(new Date("2026-09-24T01:00:00.000Z"));
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "seckill", id: 900 });
    vi.setSystemTime(END);
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1000,
      ends_at: "2026-09-24T03:00:00.001Z" });
    vi.setSystemTime(new Date(END.getTime() + 1));
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "product", id: 170 });
  });

  it("fails closed on invalid priorities, mismatched products and page offsets", async () => {
    await f.db.update(storeProduct).set({ activity: "1,1" }).where(eq(storeProduct.id, 170));
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toEqual({
      version: 1, product_id: 170, kind: "unavailable", id: null, ends_at: null,
    });
    await f.db.update(storeProduct).set({ activity: "1,2,3,0" }).where(eq(storeProduct.id, 170));
    await f.db.update(storeSeckill).set({ productId: 999 });
    expect((await read("1?limit=1")).result.data[0].recommendation_target).toMatchObject({ kind: "bargain", id: 1000 });
    const outOfRange = await read("1?page=2147483648&limit=10");
    expect(outOfRange.result.status).toBe(400);
    expect(outOfRange.result.data).toBeNull();
  });
});
