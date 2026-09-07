import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPcCouponFixture } from "./helpers/pcCouponFixture";
import { normalizeCouponPage } from "../../view/pc-ts/src/api/couponWallet";
import { StoreOrderCreateService } from "../src/services/order/StoreOrderCreateService";
import { orderCreate } from "../src/controllers/api/v1/OrderController";
import { storeCouponUser } from "../src/models/schema";

describe("PC coupon wallet and checkout through real controller and isolated SQL", () => {
  let fixture: Awaited<ReturnType<typeof createPcCouponFixture>>;
  beforeAll(async () => { fixture = await createPcCouponFixture(); fixture.app.post("/api/order/create/:key", orderCreate); }, 30000);
  afterAll(async () => { vi.restoreAllMocks(); await fixture?.close(); });
  async function wallet(path: string, uid = "11") {
    const response = await fixture.app.request(`/api/coupons/user/${path}`, { headers: { "x-fixture-user": uid } }, fixture.env);
    const body = await response.json() as { status: number; data: unknown; msg: string };
    return { response, body, page: body.status === 200 ? normalizeCouponPage(body.data, response.headers.get("X-Coupon-Next-Cursor")) : null };
  }
  async function post(path: string, body: object) {
    const response = await fixture.app.request(path, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-user": "11" }, body: JSON.stringify(body) }, fixture.env);
    return response.json() as Promise<{ status: number; msg: string; data: Record<string, unknown> }>;
  }
  it("separates unused/future, used, expired/invalid and reserved states, with no cache or owner leakage", async () => {
    const before = await fixture.snapshot();
    const current = await wallet("0");
    expect(current.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(current.page!.list.map((x) => x.id)).toEqual([50, 49, 46, 42, 41]);
    expect(current.page!.list.find((x) => x.id === 46)?.availability).toBe("future");
    expect((await wallet("1")).page!.list.map((x) => x.id)).toEqual([44]);
    expect((await wallet("0?status=1")).page!.list.map((x) => x.id)).toEqual([44]);
    expect((await wallet("2")).page!.list.map((x) => x.id)).toEqual([47, 43]);
    expect((await wallet("3")).page!.list.map((x) => x.id)).toEqual([45]);
    expect((await wallet("0", "22")).page!.list.map((x) => x.id)).toEqual([48]);
    expect((await wallet("0", "")).body.status).not.toBe(200);
    expect(await fixture.snapshot()).toEqual(before);
  });
  it("keeps both field contracts, safe discount labels and bounded cursor pages", async () => {
    const first = await wallet("0?limit=2");
    expect(first.page!.nextCursor).toBe(49);
    const second = await wallet("0?limit=2&before=49");
    expect(second.page!.list.map((x) => x.id)).toEqual([46, 42]);
    expect(second.page!.list[1].benefit).toBe("8.5折");
    expect(second.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 42, couponTitle: "八五折", coupon_title: "八五折", coupon_type: 2, applicable_type: 0 })]));
    expect((await wallet("0?limit=2&before=42")).page!.nextCursor).toBeNull();
    for (const path of ["4", "0?status=NaN", "0?limit=101", "0?before=-1"]) expect((await wallet(path)).body.status).not.toBe(200);
  });
  it("reprices money/percentage coupons under the same key and rejects invalid scope, threshold, state or ownership", async () => {
    const before = await fixture.snapshot(); const coupons = await fixture.db.select().from(storeCouponUser);
    const base = { cartIds: [1], addressId: 11, couponId: 0, shippingType: 1, type: 0 };
    const initial = await post("/api/order/confirm", base); expect(initial.status, initial.msg).toBe(200);
    const key = initial.data.orderKey;
    const cash = await post(`/api/order/computed/${key}`, { ...base, couponId: 41 });
    expect(cash.status, cash.msg).toBe(200); expect(cash.data).toMatchObject({ couponPrice: "5.00", pay_price: "16.00" });
    const percent = await post(`/api/order/computed/${key}`, { ...base, couponId: 42 });
    expect(percent.status, percent.msg).toBe(200); expect(percent.data).toMatchObject({ couponPrice: "2.70", pay_price: "18.30" });
    for (const couponId of [43, 44, 45, 46, 47, 48, 49, 50]) {
      const result = await post(`/api/order/computed/${key}`, { ...base, couponId });
      expect(result.status, `${couponId}: ${result.msg}`).not.toBe(200);
    }
    expect((await post(`/api/order/computed/${key}`, base)).data.pay_price).toBe("21.00");
    expect(await fixture.snapshot()).toEqual(before); expect(await fixture.db.select().from(storeCouponUser)).toEqual(coupons);
  });
  it("reports first-order priority explicitly in the real amounts without consuming the requested coupon", async () => {
    fixture.config.first_order_status = "1";
    try {
      const result = await post("/api/order/confirm", { cartIds: [1], addressId: 11, couponId: 41 });
      expect(result.status, result.msg).toBe(200);
      expect(result.data.priceGroup).toMatchObject({ couponPrice: "0.00", firstOrderPrice: "1.80", pay_price: "19.20" });
    } finally { fixture.config.first_order_status = "0"; }
  });
  it("creates exactly one unpaid order with the selected coupon and reserves it once on an identical retry", async () => {
    vi.spyOn(StoreOrderCreateService.prototype, "createOrder").mockImplementation((params) => StoreOrderCreateService.createWithRuntime(fixture.container,
      { CONFIG_KV: fixture.env.CONFIG_KV, nextOrderId: async () => "local_coupon_order" }, params));
    const body = { cartIds: [1], addressId: 11, couponId: 41, shippingType: 1, type: 0 };
    const first = await post("/api/order/create/local_coupon_key", body); expect(first.status, first.msg).toBe(200);
    const snapshot = await fixture.snapshot();
    expect(snapshot.orders).toHaveLength(1); expect(snapshot.orders[0]).toMatchObject({ couponId: 41, couponPrice: "5.00", payPrice: "16.00", paid: 0 });
    expect((await wallet("3")).page!.list.map((x) => x.id)).toEqual([45, 41]);
    expect((await post("/api/order/create/local_coupon_key", body)).status).toBe(200);
    expect(await fixture.snapshot()).toEqual(snapshot);
    vi.restoreAllMocks();
  });
});
