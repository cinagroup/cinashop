import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { capitalFlow, systemLog } from "../src/models/schema";
import { list, setMark } from "../src/controllers/api/v1/AdminCapitalFlowController";
import { ApiException } from "../src/utils/errors";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("platform capital-flow admin screen contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;

  beforeEach(async () => {
    fixture = await financePostgres([capitalFlow, systemLog]);
    await fixture.db.insert(capitalFlow).values([
      { id: 1, flowId: "FLOW1", orderId: "ORDERA", uid: 11, nickname: "Alice", phone: "13800138000", price: "12.00", tradingType: 1, payType: "weixin", mark: "original", addTime: 1_700_000_000 },
      { id: 2, flowId: "FLOW2", orderId: "ORDERB", uid: 22, nickname: "percent%_\\", phone: "13900139000", price: "-12.00", tradingType: 2, payType: "alipay", addTime: 1_700_000_100 },
      { id: 3, flowId: "FLOW3", orderId: "ORDERC", uid: 33, nickname: "Other", phone: "13700137000", price: "50.00", tradingType: 3, payType: "offline", addTime: 1_700_000_200 },
    ]);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("container", createContainerFromDb(fixture.db));
      c.set("adminInfo", { id: 91, account: "capital-admin", realName: "财务管理员", level: 0, roles: "", divisionId: 0 });
      await next();
    });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/adminapi/flow/get_list", list);
    app.post("/adminapi/flow/set_mark/:id", setMark);
  });
  afterEach(async () => { await fixture?.close(); });

  async function get(query = "") {
    const response = await app.request(`/adminapi/flow/get_list${query}`);
    return { response, body: await response.json<Reply>() };
  }
  async function mark(id: number, body: unknown) {
    const response = await app.request(`/adminapi/flow/set_mark/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json<Reply>() };
  }

  it("filters external cash movement by type, literal keyword and seconds, then pages in id order", async () => {
    const first = await get("?trading_type=2&keywords=22&start=1700000100&stop=1700000100");
    expect(first.body.status).toBe(200);
    expect(first.body.data).toMatchObject({ count: 1, list: [{ id: 2, trading_type_code: 2, price: "-12.00", pay_type_code: "alipay" }] });
    expect(first.body.data.status[2]).toBe("订单退款");
    expect(first.response.headers.get("cache-control")).toContain("no-store");
    for (const keyword of ["%", "_", "\\"]) {
      const result = await get(`?keywords=${encodeURIComponent(keyword)}`);
      expect(result.body.data.list.map((row: { id: number }) => row.id)).toEqual([2]);
    }
    expect((await get("?page=2&limit=1")).body.data.list.map((row: { id: number }) => row.id)).toEqual([2]);
    expect((await get("?keywords=ORDERA")).body.data.list.map((row: { id: number }) => row.id)).toEqual([1]);
    expect((await get("?keywords=2")).body.data.list.map((row: { id: number }) => row.id)).toEqual([2]);
  });

  it("rejects malformed filters before selecting a misleading unrestricted list", async () => {
    for (const query of ["?page=0", "?limit=101", "?page=1e2", "?start=1700000200&stop=1700000000", "?ids=1,bad", "?trading_type=9", `?keywords=${"x".repeat(101)}`]) {
      expect((await get(query)).body.status, query).toBe(400);
    }
  });

  it("writes at most 200 characters, returns committed value and records a content-free admin audit", async () => {
    const value = "备".repeat(200);
    const { response, body } = await mark(1, { mark: value });
    expect(body).toMatchObject({ status: 200, data: { id: 1, mark: value } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await fixture.db.select().from(capitalFlow).where(eq(capitalFlow.id, 1)))[0]?.mark).toBe(value);
    const logs = await fixture.db.select().from(systemLog);
    expect(logs).toMatchObject([{ adminId: 91, type: "capital_flow", method: "POST", page: "/finance/capital-flow" }]);
    expect(JSON.stringify(logs)).not.toContain(value);
    expect((await mark(1, { mark: "" })).body.status).toBe(200);
    expect((await fixture.db.select().from(capitalFlow).where(eq(capitalFlow.id, 1)))[0]?.mark).toBe("");
  });

  it("preserves existing notes on invalid input, missing ids and a failed audit insert", async () => {
    for (const body of [{}, { mark: 12 }, { mark: "x".repeat(201) }]) {
      expect((await mark(1, body)).body.status).toBe(400);
    }
    expect((await mark(999, { mark: "unreachable" })).body.status).toBe(404);
    expect((await fixture.db.select().from(capitalFlow).where(eq(capitalFlow.id, 1)))[0]?.mark).toBe("original");
    await fixture.exec("DROP TABLE system_log");
    expect((await mark(1, { mark: "must roll back" })).body.status).toBe(500);
    expect((await fixture.db.select().from(capitalFlow).where(eq(capitalFlow.id, 1)))[0]?.mark).toBe("original");
  });
});
