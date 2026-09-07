import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { UserCouponWalletService, couponWalletQuery, couponWalletFilter } from "../src/services/activity/UserCouponWalletService";
import { storeCouponIssue, storeCouponUser } from "../src/models/schema";
import { normalizeCouponPage, normalizeCouponCounts } from "../../view/common/couponWallet";

describe("wallet filters, rules and counts through actual controllers and SQL", () => {
  let f: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => {
    f = await createPcCouponFixture();
    await f.db.insert(storeCouponIssue).values([{ id: 4, couponType: 1, type: 2, rule: "仅限指定品类\n不可兑现<script>alert(1)</script>" }, { id: 5, couponType: 3, type: 1 }]);
    await f.db.insert(storeCouponUser).values([{ id: 60, uid: 11, issueCouponId: 4, couponPrice: "90.00" }, { id: 61, uid: 11, issueCouponId: 5, couponPrice: "1.00" }, { id: 62, uid: 11, issueCouponId: 999, couponPrice: "1.00" }]);
  }, 30000);
  afterAll(async () => { await f?.close(); });
  async function read(path: string, uid = "11") {
    const response = await f.app.request(`/api/coupons/user/${path}`, { headers: { "x-fixture-user": uid } }, f.env);
    const body = await response.json() as { status: number; data: unknown };
    return { response, body };
  }
  it("keeps legacy count keys, adds reserved, and matches each list with no owner leakage or writes", async () => {
    const before = await f.snapshot(), coupons = await f.db.select().from(storeCouponUser);
    const { response, body } = await read("num");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body.status).toBe(200); const counts = normalizeCouponCounts(body.data);
    expect(counts).toEqual({ not_used: 7, used: 1, expired: 3, reserved: 1 });
    for (const [status, key] of ["not_used", "used", "expired", "reserved"].entries()) {
      const result = await read(`${status}`); expect(result.body.status).toBe(200);
      expect(normalizeCouponPage(result.body.data, "").list).toHaveLength(counts[key as keyof typeof counts]);
    }
    expect((await read("num", "22")).body.data).toEqual({ not_used: 1, used: 0, expired: 0, reserved: 0 });
    expect((await read("num", "")).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await f.db.select().from(storeCouponUser)).toEqual(coupons); expect(f.writes).toEqual([]);
  });
  it("filters by scope rather than discount mode, honors type/issue_type and keeps cursor pages bounded", async () => {
    for (const [type, expected] of [[0, [50, 46, 42, 41]], [1, [60]], [2, [49]], [3, [61]]] as const) {
      for (const param of ["type", "issue_type"]) {
        const result = await read(`0?${param}=${type}&include_counts=1`);
        expect(result.body.status).toBe(200);
        expect(normalizeCouponPage(result.body.data, "").list.map(row => row.id)).toEqual(expected);
        expect(JSON.parse(result.response.headers.get("X-Coupon-Counts")!).not_used).toBe(expected.length);
      }
    }
    const first = await read("0?type=0&limit=2"); expect(first.response.headers.get("X-Coupon-Next-Cursor")).toBe("46");
    const second = await read("0?type=0&limit=2&before=46"); expect(normalizeCouponPage(second.body.data, "").list.map(row => row.id)).toEqual([42, 41]);
    expect((await read("num?type=3&before=999&page=8")).body.data).toEqual({ not_used: 1, used: 0, expired: 0, reserved: 0 });
  });
  it("defines imminent expiry inclusively as now through 24 hours, excludes null and already expired", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    await f.db.insert(storeCouponUser).values([-1, 0, 86400000, 86400001].map((offset, i) => ({ id: 100 + i, uid: 22, issueCouponId: 1, couponPrice: "1.00", endTime: new Date(now.getTime() + offset) })));
    const service = new UserCouponWalletService(f.container);
    const page = await service.list(22, couponWalletQuery("0", { type: "-1" }), now);
    expect(page.list.map(row => row.id)).toEqual([102, 101]);
    expect(await service.counts(22, -1, now)).toEqual({ not_used: 2, used: 0, expired: 0, reserved: 0 });
  });
  it("returns rule text without executing markup, signals truncation and rejects invalid filter/count contracts", async () => {
    const result = await read("0?type=1");
    expect(normalizeCouponPage(result.body.data, "").list[0].rule).toBe("仅限指定品类\n不可兑现<script>alert(1)</script>");
    await f.db.update(storeCouponIssue).set({ rule: "规".repeat(8001) }).where(eq(storeCouponIssue.id, 4));
    const long = normalizeCouponPage((await read("0?type=1")).body.data, "").list[0]; expect(long.rule).toHaveLength(8000); expect(long.ruleTruncated).toBe(true);
    for (const type of ["4", "-2", "NaN", "1x", "1.0"]) { expect(() => couponWalletFilter({ type })).toThrow(); expect((await read(`num?type=${type}`)).body.status).not.toBe(200); }
    expect(() => couponWalletFilter({ type: "0", issue_type: "2" })).toThrow(); expect(couponWalletFilter({ type: "" })).toBeNull();
    expect(() => normalizeCouponCounts({ not_used: "1", used: 0, expired: 0, reserved: 0 })).toThrow();
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('v1Routes.get("/coupons/user/num", authMiddleware({ force: true }), UserActivityController.myCouponCounts)');
    expect(routes.indexOf('"/coupons/user/num"')).toBeLessThan(routes.indexOf('"/coupons/user/:types"'));
  });
});
