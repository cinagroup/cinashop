import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { storeCouponIssue, storeCouponUser, systemAdmin, systemRole, user } from "../src/models/schema";
import { list } from "../src/controllers/api/v1/AdminCouponRecordController";
import { adminAuthMiddleware } from "../src/middleware/admin-auth";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { ApiException } from "../src/utils/errors";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

type Reply = { status: number; msg: string; data: any };

describe("read-only Admin coupon claim records", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let bindings: Env;
  let viewerToken: string;
  let couponToken: string;

  beforeEach(async () => {
    fixture = await financePostgres([user, storeCouponIssue, storeCouponUser, systemAdmin, systemRole]);
    await fixture.db.insert(user).values([
      { uid: 11, realName: "张爱丽", nickname: "Alice", account: "alice-account", phone: "13800138000" },
      { uid: 22, realName: "李乙", nickname: "百分%_\\", account: "second-account", phone: "13900139000" },
    ]);
    await fixture.db.insert(storeCouponIssue).values([
      { id: 101, couponTitle: "现金券", type: 1 },
      { id: 102, couponTitle: "折扣券", type: 2 },
      { id: 103, couponTitle: "停用旧券", type: 1, status: -1, isDel: 1 },
    ]);
    const startTime = new Date("2026-09-01T00:00:00.000Z");
    const endTime = new Date("2026-09-30T23:59:59.000Z");
    await fixture.db.insert(storeCouponUser).values([
      { id: 1, uid: 11, issueCouponId: 101, couponTitle: "十元券", couponPrice: "10.00", useMinPrice: "100.00", type: 1, receiveSource: "get", status: 0, isFail: 0, startTime, endTime },
      { id: 2, uid: 11, issueCouponId: 102, couponTitle: "八五折券", couponPrice: "85.00", useMinPrice: "50.00", type: 2, receiveSource: "send", status: 0, isFail: 1, startTime, endTime },
      { id: 3, uid: 22, issueCouponId: 102, couponTitle: "会员券", couponPrice: "80.00", useMinPrice: "100.00", type: 2, receiveSource: "newcomer", status: 1, isFail: 0, startTime, endTime },
      { id: 4, uid: 22, issueCouponId: 103, couponTitle: "已过期券", couponPrice: "5.00", useMinPrice: "30.00", type: 1, receiveSource: "order", status: 2, isFail: 1, startTime, endTime },
      { id: 5, uid: 11, issueCouponId: 102, couponTitle: "占用券", couponPrice: "90.00", useMinPrice: "90.00", type: 2, receiveSource: "luck_lottery", status: 3, isFail: 0, startTime, endTime },
      { id: 6, uid: 99, issueCouponId: 999, couponTitle: "历史孤券", couponPrice: "10.00", useMinPrice: "20.00", type: 1, receiveSource: "old-custom", status: 0, isFail: 0 },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "领券记录查看", rules: "coupon_record.view" },
      { id: 2, roleName: "发行券管理", rules: "coupon.view,coupon.manage" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 91, account: "record-reader", pwd: "record-fixture", level: 1, roles: "1", adminType: 1 },
      { id: 92, account: "issue-manager", pwd: "issue-fixture", level: 1, roles: "2", adminType: 1 },
    ]);
    bindings = { APP_KEY: "coupon-records-test-signing-key", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
    viewerToken = (await createToken(91, "admin", md5("record-fixture"), bindings.APP_KEY)).token;
    couponToken = (await createToken(92, "admin", md5("issue-fixture"), bindings.APP_KEY)).token;
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", createContainerFromDb(fixture.db)); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.get("/adminapi/marketing/coupon-records/list", adminAuthMiddleware(), list);
  });
  afterEach(async () => { await fixture?.close(); });

  async function get(query = "", token = viewerToken) {
    const response = await app.request(`/adminapi/marketing/coupon-records/list${query}`,
      { headers: token ? { "Authori-zation": `Bearer ${token}` } : {} }, bindings);
    return { response, body: await response.json<Reply>() };
  }

  it("requires independent coupon_record.view despite existing coupon management authority", async () => {
    expect(requiredAdminPermission("GET", "/adminapi/marketing/coupon-records/list")).toBe("coupon_record.view");
    expect(requiredAdminPermission("GET", "/adminapi/coupon/list")).toBe("coupon.view");
    expect((await get()).body.status).toBe(200);
    expect((await get("", couponToken)).body.status).not.toBe(200);
    expect((await get("", "")).body.status).not.toBe(200);
  });

  it("pages global claims in id order and preserves both independent status flags", async () => {
    const all = await get();
    expect(all.body).toMatchObject({ status: 200, data: { count: 6, page: 1, limit: 15 } });
    expect(all.body.data.list.map((row: { id: number }) => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(all.body.data.list[4]).toMatchObject({ status: 0, status_label: "未使用", is_fail: 1, receive_source_label: "后台发放", coupon_type: 2 });
    expect(all.body.data.list[1]).toMatchObject({ status: 3, status_label: "未支付订单占用中", receive_source_label: "抽奖赠送" });
    expect(all.body.data.list[0]).toMatchObject({ nickname: "", coupon_type: null, receive_source: "old-custom", receive_source_label: "其他获取方式", start_time: null });
    expect(all.body.data.list.at(-1)).toMatchObject({ coupon_price: "10.00", use_min_price: "100.00", coupon_type: 1, start_time: "2026-09-01T00:00:00.000Z" });
    expect(all.response.headers.get("cache-control")).toContain("private");
    expect(all.response.headers.get("cache-control")).toContain("no-store");
    expect((await get("?page=2&limit=2")).body.data.list.map((row: { id: number }) => row.id)).toEqual([4, 3]);
    const beyond = await get("?page=2&limit=15");
    expect(beyond.body.data).toMatchObject({ count: 6, list: [] });
  });

  it("filters stored status, member identity and coupon title literally", async () => {
    const unused = await get("?status=0");
    expect(unused.body.data.list.map((row: { id: number }) => row.id)).toEqual([6, 2, 1]);
    expect((await get("?status=3")).body.data.list.map((row: { id: number }) => row.id)).toEqual([5]);
    expect((await get("?nickname=13900139000")).body.data.list.map((row: { id: number }) => row.id)).toEqual([4, 3]);
    expect((await get("?nickname=张爱丽")).body.data.count).toBe(3);
    expect((await get("?nickname=22")).body.data.count).toBe(2);
    expect((await get("?nickname=99")).body.data.count).toBe(0);
    expect((await get("?coupon_title=八五折")).body.data.list.map((row: { id: number }) => row.id)).toEqual([2]);
    for (const token of ["%", "_", "\\"]) {
      expect((await get(`?nickname=${encodeURIComponent(token)}`)).body.data.list.map((row: { id: number }) => row.id)).toEqual([4, 3]);
    }
  });

  it("rejects malformed filters and page limits", async () => {
    for (const query of ["?page=0", "?page=10001", "?limit=101", "?limit=1e2", "?status=-1", "?status=4",
      `?nickname=${"x".repeat(101)}`, `?coupon_title=${"x".repeat(101)}`]) {
      expect((await get(query)).body.status, query).toBe(400);
    }
  });
});
