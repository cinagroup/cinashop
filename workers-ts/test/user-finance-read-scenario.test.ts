import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  user, userBill, userBrokerage, userExtract, userSpread, storeOrder,
  storeOrderCartInfo, storeProduct, userAddress,
  storeSeckill, storeBargain, storeCombination,
} from "@/models/schema";
import { UserFinanceReadService, financeRankPeriod, parseFinanceReadQuery } from "@/services/user/UserFinanceReadService";
import * as controller from "@/controllers/api/v1/UserFinanceReadController";
import type { AppVariables, Env } from "@/env";
import type { Container } from "@/lib/di";

const tables = [user, userBill, userBrokerage, userExtract, userSpread, storeOrder, storeOrderCartInfo, storeProduct, userAddress, storeSeckill, storeBargain, storeCombination];
const dialect = new PgDialect();
const now = Date.parse("2026-09-05T04:30:00Z") / 1_000;
const september = Date.parse("2026-08-31T16:00:00Z") / 1_000;
const august = september - 1;
let pg: PGlite;
let db: ReturnType<typeof drizzle>;
let service: UserFinanceReadService;
let container: Container;
let config: Record<string, string>;
const statements: string[] = [];
const env = { CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;

beforeAll(async () => {
  pg = await PGlite.create();
  db = drizzle(pg);
  // Real current Drizzle column types/defaults, not a hand-maintained imitation of query results.
  for (const table of tables) {
    const definition = getTableConfig(table);
    const columns = definition.columns.map((column) => {
      const initial = column.default;
      const defaultSql = initial === undefined ? "" : ` default ${initial instanceof SQL
        ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? " not null" : ""}${column.primary ? " primary key" : ""}`;
    });
    await pg.exec(`create table "${definition.name}" (${columns.join(", ")})`);
  }
}, 30_000);

afterAll(async () => { await pg?.close(); });

beforeEach(async () => {
  await pg.exec(`truncate ${tables.map((table) => `"${getTableConfig(table).name}"`).join(", ")} restart identity`);
  await db.insert(user).values([
    { uid: 7, nickname: "当前用户", avatar: "/avatar.png", brokeragePrice: "123.45" },
    { uid: 8, nickname: "其他用户", avatar: "javascript:alert(1)" },
    { uid: 9, nickname: "买家", phone: "13800000009" },
    { uid: 10, nickname: "已删除用户", isDel: 1 },
  ]);
  config = {};
  statements.length = 0;
  container = {
    db: { execute: async (statement: SQL) => {
      const { sql: query, params } = dialect.sqlToQuery(statement);
      statements.push(query);
      return (await pg.query(query, params)).rows;
    } },
    systemConfigDao: {
      getValue: async (key: string) => config[key] ?? "",
      getValues: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, config[key] ?? ""])),
    },
  } as unknown as Container;
  service = new UserFinanceReadService(container, env);
});

describe("API-013 actual PostgreSQL user-finance read contracts", () => {
  it("bounds pagination/timestamps and uses Shanghai Monday/month boundaries", () => {
    expect(parseFinanceReadQuery({ page: 999_999, limit: 999, start: "999999999999", stop: -1 })).toMatchObject({ limit: 100, offset: 10_000, start: 2_147_483_647, stop: 0 });
    expect(parseFinanceReadQuery({})).toMatchObject({ limit: 20, offset: 0 });
    expect(financeRankPeriod("week", now).start).toBe(Date.parse("2026-08-30T16:00:00Z") / 1_000);
    expect(financeRankPeriod("month", now).start).toBe(september);
    expect(financeRankPeriod("", now).start).toBe(0);
    expect(() => financeRankPeriod("month';drop table", now)).toThrow("排行周期");
  });

  it("returns UID-isolated integral rows, full count, page-local months and PHP integer/time fields", async () => {
    await db.insert(userBill).values([
      { uid: 7, category: "integral", number: "8.99", balance: "29.99", addTime: august, eventKey: "internal-key" },
      { uid: 7, category: "integral", number: "1.50", balance: "31.49", addTime: september, status: 0 },
      { uid: 7, category: "now_money", number: "999.00" },
      { uid: 8, category: "integral", number: "888.00" },
    ]);
    const page = await service.integralList(7, { page: 1, limit: 1, uid: 8 });
    expect(page).toMatchObject({ count: 2, times: ["2026-09"], list: [{ uid: 7, number: 1, balance: 31, status: 0, day: "2026-09-01", add_time: "2026-09-01 00:00:00" }] });
    expect(page.list?.[0]).not.toHaveProperty("event_key");
    const next = await service.integralList(7, { page: 2, limit: 1 });
    expect(next).toMatchObject({ times: ["2026-08"], list: [{ number: 8, time: "2026-08", day: "2026-08-31" }] });
    expect(await service.integralList(7, { page: 3, limit: 1 })).toEqual({ list: [], times: [], count: 2 });
    expect(statements).toHaveLength(3);
  });

  it("handles empty and zero-time integral ledgers without epoch dates", async () => {
    expect(await service.integralList(7, {})).toEqual({ list: [], times: [], count: 0 });
    await db.insert(userBill).values({ uid: 7, category: "integral", addTime: 0 });
    expect(await service.integralList(7, {})).toMatchObject({ times: [""], list: [{ add_time: "", day: "", time_key: "" }] });
  });

  it("uses only valid future frozen credits and preserves exact cents/config defaults", async () => {
    await db.insert(userBrokerage).values([
      { uid: 7, pm: 1, status: 1, number: "20.01", frozenTime: now + 1 },
      { uid: 7, pm: 1, status: 1, number: "1.02", frozenTime: now + 200 },
      { uid: 7, pm: 1, status: 1, number: "800.00", frozenTime: now },
      { uid: 7, pm: 0, status: 1, number: "800.00", frozenTime: now + 1 },
      { uid: 7, pm: 1, status: -1, number: "800.00", frozenTime: now + 1 },
      { uid: 8, pm: 1, status: 1, number: "800.00", frozenTime: now + 1 },
    ]);
    config = { user_extract_bank: JSON.stringify(["银行甲\r\n银行乙\r\n"]), user_extract_min_price: "10.00", user_extract_max_price: "5000.00", withdraw_fee: "2.5", brokerage_type: "1", user_extract_balance_status: "0", unrelated_secret: "never-return" };
    expect(await service.extractBank(7, now)).toEqual({
      brokerage_price: "123.45", broken_commission: "21.03", commissionCount: "102.42",
      extractBank: ["银行甲", "银行乙"], minPrice: "10.00", maxPrice: "5000.00", withdraw_fee: "2.5", extract_wechat_type: 1, user_extract_balance_status: 0,
    });
    config = {};
    expect(await service.extractBank(7, now)).toMatchObject({ extractBank: [], user_extract_balance_status: 1 });
    await expect(service.extractBank(999, now)).rejects.toThrow("数据不存在");
  });

  it("does not hide an inconsistent negative available commission balance", async () => {
    await db.insert(userBrokerage).values({ uid: 7, pm: 1, status: 1, number: "124.00", frozenTime: now + 1 });
    expect(await service.extractBank(7, now)).toMatchObject({ broken_commission: "124.00", commissionCount: "-0.55" });
  });

  it("counts net valid commission and pending/approved withdrawals, never another user's funds", async () => {
    await db.insert(userBrokerage).values([
      { uid: 7, pm: 1, status: 1, number: "10.10" },
      { uid: 7, pm: 0, status: 1, number: "3.01" },
      { uid: 7, pm: 1, status: 0, number: "100.00" },
      { uid: 8, pm: 1, status: 1, number: "900.00" },
    ]);
    await db.insert(userExtract).values([
      { uid: 7, status: 0, extractPrice: "1.01" }, { uid: 7, status: 1, extractPrice: "2.02" },
      { uid: 7, status: -1, extractPrice: "800.00" }, { uid: 8, status: 1, extractPrice: "900.00" },
    ]);
    expect(await service.spreadCount(7, "3")).toEqual({ count: 7.09 });
    expect(await service.spreadCount(7, "4")).toEqual({ count: 3.03 });
    expect(await service.spreadCount(7, "invalid")).toEqual({ count: 0 });
    await expect(service.spreadCount(999, "3")).rejects.toThrow("数据不存在");
  });

  it("ranks positive brokerage globally before pagination, excluding refund restoration and missing/deleted users", async () => {
    await db.insert(userBrokerage).values([
      { uid: 7, pm: 1, type: "one_brokerage", number: "1.10", addTime: september },
      { uid: 8, pm: 1, type: "one_brokerage", number: "3.30", addTime: september },
      { uid: 9, pm: 1, type: "two_brokerage", number: "2.20", addTime: september },
      { uid: 7, pm: 1, type: "refund", number: "999.00", addTime: september },
      { uid: 7, pm: 1, type: "extract_fail", number: "999.00", addTime: september },
      { uid: 7, pm: 1, type: "one_brokerage", number: "999.00", addTime: august },
      { uid: 7, pm: 1, type: "one_brokerage", number: "999.00", addTime: now + 1 },
      { uid: 10, pm: 1, type: "one_brokerage", number: "999.00", addTime: september },
      { uid: 999, pm: 1, type: "one_brokerage", number: "999.00", addTime: september },
    ]);
    expect(await service.brokerageRank(7, { type: "month", limit: 1, page: 1 }, now)).toMatchObject({
      position: 3, brokerage_price: "1.10", nickname: "当前用户", rank: [{ uid: 8, brokerage_price: "3.30", avatar: "" }],
    });
    expect(await service.brokerageRank(7, { type: "month", limit: 1, page: 3 }, now)).toMatchObject({ position: 3, rank: [{ uid: 7 }] });
    expect(await service.brokerageRank(7, { type: "month", limit: 1, page: 4 }, now)).toMatchObject({ position: 3, rank: [] });
  });

  it("ranks referral events (not current user parents), with global rank and PHP rolling-month statistics", async () => {
    config.h5_avatar = "/default.png";
    await db.update(user).set({ nickname: "", avatar: "" }).where(sql`uid = 8`);
    await db.insert(userSpread).values([
      { uid: 9, spreadUid: 8, spreadTime: september }, { uid: 7, spreadUid: 8, spreadTime: now },
      { uid: 8, spreadUid: 7, spreadTime: september }, { uid: 9, spreadUid: 7, spreadTime: august },
      { uid: 9, spreadUid: 7, spreadTime: now + 1 }, { uid: 9, spreadUid: 999, spreadTime: september },
    ]);
    const result = await service.spreadRank(7, { type: "month", page: 1, limit: 1 }, now);
    expect(result).toMatchObject({ rank: 2, week: 2, month: 2, start: "2026-09-01 00:00", end: "2026-09-05 12:30", uid: 7, list: [{ spread_uid: 8, count: 2, nickname: "神秘人", avatar: "/default.png" }] });
    expect(await service.spreadRank(7, { type: "month", page: 2, limit: 1 }, now)).toMatchObject({ rank: 2, list: [{ spread_uid: 7, count: 1 }] });
  });

  async function orders() {
    await db.insert(storeOrder).values([
      { id: 1, orderId: "ONE", uid: 9, paid: 1, spreadUid: 7, oneBrokerage: "1.01", payPrice: "10.10", addTime: august },
      { id: 2, orderId: "TWO", uid: 9, paid: 1, spreadTwoUid: 7, twoBrokerage: "2.02", payPrice: "20.20", addTime: september },
      { id: 3, orderId: "DIV", uid: 9, paid: 1, divisionId: 7, divisionBrokerage: "3.03", payPrice: "30.30", addTime: september },
      { id: 4, orderId: "AGENT", uid: 9, paid: 1, divisionAgentId: 7, divisionAgentBrokerage: "4.04", payPrice: "40.40", addTime: september },
      { id: 5, orderId: "STAFF", uid: 9, paid: 1, divisionStaffId: 7, divisionStaffBrokerage: "5.05", payPrice: "50.50", addTime: september, status: 2, cartId: '["cart-a","cart-b"]' },
      { id: 6, orderId: "UNPAID", uid: 9, spreadUid: 7, oneBrokerage: "900.00" },
      { id: 7, orderId: "REFUND", uid: 9, paid: 1, spreadUid: 7, refundStatus: 1, oneBrokerage: "900.00" },
      { id: 8, orderId: "CHILD", uid: 9, paid: 1, spreadUid: 7, pid: 1, oneBrokerage: "900.00" },
      { id: 9, orderId: "DELETED", uid: 9, paid: 1, spreadUid: 7, isDel: 1, oneBrokerage: "900.00" },
      { id: 10, orderId: "OTHER", uid: 9, paid: 1, spreadUid: 8, oneBrokerage: "900.00" },
    ]);
  }

  it("serves all five referral roles, full month aggregates across pages and snapshot product titles", async () => {
    await orders();
    await db.insert(storeOrderCartInfo).values([
      { oid: 5, cartInfo: JSON.stringify({ productInfo: { store_name: "商品甲" } }) },
      { oid: 5, cartInfo: JSON.stringify({ productInfo: { storeName: "商品乙" } }) },
      { oid: 5, cartInfo: "invalid JSON" },
    ]);
    await db.insert(userBrokerage).values([
      { uid: 7, linkId: "5", pm: 1, type: "staff_brokerage", addTime: now - 60, frozenTime: now + 1 },
      { uid: 8, linkId: "5", pm: 1, type: "staff_brokerage", addTime: 1, frozenTime: 0 },
      { uid: 7, linkId: "5", pm: 0, type: "refund", addTime: 1, frozenTime: 0 },
    ]);
    const result = await service.spreadOrder(7, { limit: 1, uid: 8 }, now);
    expect(result).toMatchObject({ count: 5, sum_brokerage: "15.15", time: [{ time: "2026-09", count: 4, sumPrice: "141.40" }], list: [{ id: 5, number: "5.05", store_name: "商品甲|商品乙", type: "brokerage", time: "2026-09-05 12:29", is_frozen: 1 }] });
    expect(result.list?.[0]).not.toHaveProperty("user_phone");
    expect(result.list?.[0]).not.toHaveProperty("real_name");
    expect(result.list?.[0]?.cart_id).toEqual(["cart-a", "cart-b"]);
    expect(statements).toHaveLength(2); // Own profile + one report, independent of page length.
    const all = await service.spreadOrder(7, {}, now);
    expect(all.list?.map((v) => v.number)).toEqual(["5.05", "4.04", "3.03", "2.02", "1.01"]);
    expect(await service.spreadOrder(7, { page: 6, limit: 1 }, now)).toEqual({ count: 5, sum_brokerage: "15.15", list: [], time: [] });
  });

  it("filters keyword/time before pagination while keeping the PHP keyword-independent commission total", async () => {
    await orders();
    expect(await service.spreadOrder(7, { keyword: "ONE", limit: 1 }, now)).toMatchObject({ count: 1, sum_brokerage: "15.15", list: [{ id: 1 }] });
    expect(await service.spreadOrder(7, { keyword: "买家", start: september, stop: now }, now)).toMatchObject({ count: 4, sum_brokerage: "14.14" });
    expect(await service.spreadOrder(7, { keyword: "%' OR true --" }, now)).toMatchObject({ count: 0, list: [], sum_brokerage: "15.15" });
    expect(await service.spreadOrder(7, { start: now, stop: september }, now)).toMatchObject({ count: 0, list: [], sum_brokerage: "0.00" });
  });

  it("uses staff/agent/division precedence for a row, but adds each entitled role to total commission", async () => {
    await db.insert(storeOrder).values({ id: 1, uid: 9, paid: 1, spreadUid: 7, oneBrokerage: "1.01", divisionStaffId: 7, divisionStaffBrokerage: "2.02", addTime: september });
    expect(await service.spreadOrder(7, {}, now)).toMatchObject({ sum_brokerage: "3.03", list: [{ number: "2.02" }] });
  });

  it("does not overflow a single-row money precision when aggregating multiple large rows", async () => {
    await db.insert(userBrokerage).values([
      { uid: 7, pm: 1, status: 1, type: "one_brokerage", number: "9999999999.99", addTime: september, frozenTime: now + 1 },
      { uid: 7, pm: 1, status: 1, type: "two_brokerage", number: "9999999999.99", addTime: september, frozenTime: now + 1 },
    ]);
    expect(await service.brokerageRank(7, {}, now)).toMatchObject({ brokerage_price: "19999999999.98" });
    expect(await service.extractBank(7, now)).toMatchObject({ broken_commission: "19999999999.98", commissionCount: "-19999999876.53" });
    await db.insert(storeOrder).values([
      { uid: 9, paid: 1, spreadUid: 7, oneBrokerage: "9999999999.99", payPrice: "9999999999.99", addTime: september },
      { uid: 9, paid: 1, spreadUid: 7, oneBrokerage: "9999999999.99", payPrice: "9999999999.99", addTime: september },
    ]);
    expect(await service.spreadOrder(7, {}, now)).toMatchObject({ sum_brokerage: "19999999999.98", time: [{ sumPrice: "19999999999.98" }] });
  });

  it("retains buyer/address/product/activity searches without leaking matched private fields", async () => {
    await orders();
    await db.insert(userAddress).values({ uid: 9, realName: "地址收件人" });
    await db.insert(storeProduct).values({ id: 1, storeName: "查询商品", keyword: "独有标签" });
    await db.insert(storeOrderCartInfo).values({ oid: 1, productId: 1 });
    await db.insert(storeSeckill).values({ id: 1, storeName: "活动标题" });
    await db.update(storeOrder).set({ activityId: 1 }).where(sql`id = 2`);
    expect(await service.spreadOrder(7, { keyword: "地址收件人" }, now)).toMatchObject({ count: 5 });
    expect(await service.spreadOrder(7, { keyword: "独有标签" }, now)).toMatchObject({ count: 1, list: [{ id: 1 }] });
    expect(await service.spreadOrder(7, { keyword: "活动标题" }, now)).toMatchObject({ count: 1, list: [{ id: 2 }] });
  });

  it("signs canonical avatar references and keeps tied ranks deterministic", async () => {
    await db.update(user).set({ avatar: "/api/assets/7" }).where(sql`uid = 7`);
    await db.insert(userBrokerage).values([
      { uid: 7, pm: 1, type: "one_brokerage", number: "1.00", addTime: september },
      { uid: 8, pm: 1, type: "one_brokerage", number: "1.00", addTime: september },
    ]);
    const signedService = new UserFinanceReadService(container, { ...env, APP_KEY: "finance-read-test-signing-key" });
    const result = await signedService.brokerageRank(7, { type: "month" }, now);
    expect(result).toMatchObject({ position: 2, avatar: expect.stringMatching(/^\/api\/assets\/7\?expires=\d+&signature=/) });
    expect(Array.isArray(result.rank) && result.rank.map((row) => row.uid)).toEqual([8, 7]);
  });

  it("keeps all six route authentication/StationOpen gates and rejects anonymous controllers without querying", async () => {
    const source = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const [method, path, name] of [
      ["get", "/integral/list", "integralList"], ["get", "/extract/bank", "extractBank"],
      ["post", "/spread/order", "spreadOrder"], ["get", "/spread/count/:type", "spreadCount"],
      ["get", "/brokerage_rank", "brokerageRank"], ["get", "/rank", "spreadRank"],
    ]) expect(source).toContain(`v1Routes.${method}("${path}", stationOpenMiddleware, authMiddleware({ force: true }), UserFinanceReadController.${name})`);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.get("/integral/list", controller.integralList);
    const response = await app.request("/integral/list?uid=7", {}, env);
    expect(await response.json()).toMatchObject({ status: 400, msg: "请先登录" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(statements).toHaveLength(0);
  });

  it("reads POST pagination from JSON, ignores injected uid and returns the legacy envelope", async () => {
    await orders();
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("uid", 7); c.set("container", container); await next(); });
    app.post("/spread/order", controller.spreadOrder);
    const response = await app.request("/spread/order?page=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page: 2, limit: 1, uid: 8 }) }, env);
    expect(await response.json()).toMatchObject({ status: 200, data: { count: 5, list: [{ id: 4 }] } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
