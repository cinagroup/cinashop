import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseAssistedCartIds,
  parseExpectedAssistedPayPriceCents,
  parseAssistedTouristUid,
  parseAssistedUid,
} from "@/services/admin/AdminAssistedOrderService";
import {
  normalizeRoleRules,
  requiredAdminPermission,
} from "@/services/admin/AdminPermissionService";

describe("admin assisted order migration", () => {
  it("parses target and cart scope without treating a tourist label as authority", () => {
    expect(parseAssistedUid("0")).toBe(0);
    expect(parseAssistedUid("41")).toBe(41);
    expect(() => parseAssistedUid("-1")).toThrow("用户参数无效");
    expect(parseAssistedTouristUid("guest_41", 0)).toBe("guest_41");
    expect(parseAssistedTouristUid("ignored", 41)).toBe("");
    expect(() => parseAssistedTouristUid("../guest", 0)).toThrow("游客标识无效");
    expect(parseAssistedCartIds("3,7,11")).toEqual([3, 7, 11]);
    expect(() => parseAssistedCartIds("3,3")).toThrow("请提交有效的购物车商品");
  });

  it("requires a canonical exact-cent assisted payment quote", () => {
    expect(parseExpectedAssistedPayPriceCents("0.00")).toBe(0);
    expect(parseExpectedAssistedPayPriceCents("12.34")).toBe(1234);
    expect(parseExpectedAssistedPayPriceCents("9999999999.99")).toBe(999999999999);
    for (const value of [undefined, null, 0, 12.34, "", "0", "0.0", "0.001", "01.00", "1e2", "-0.01", " 1.00", "10000000000.00"]) {
      expect(() => parseExpectedAssistedPayPriceCents(value)).toThrow("请刷新订单并提交预期应付金额");
    }
  });

  it("mounts PHP and private detail routes behind one explicit assisted-order permission", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const expected = [
      ['get', '/admin/order/cart/:uid'],
      ['post', '/admin/order/cart/add/:uid'],
      ['delete', '/admin/order/cart/del/:uid'],
      ['post', '/admin/order/cart/num/:uid'],
      ['get', '/admin/order/place/list'],
      ['get', '/admin/order/place/detail/:orderId'],
      ['post', '/admin/order/confirm/:uid'],
      ['post', '/admin/order/computed/:key/:uid'],
      ['post', '/admin/order/form_image/:key/:uid'],
      ['post', '/admin/order/form_preview/:key/:uid'],
      ['get', '/admin/order/form/:orderId/:uid'],
      ['get', '/admin/order/coupons/:uid'],
      ['post', '/admin/order/create/:key/:uid'],
      ['post', '/admin/order/pay/:uid'],
      ['get', '/admin/order/pay/status'],
    ] as const;
    for (const [method, route] of expected) {
      expect(routes).toContain(`v1Routes.${method}("${route}", adminAuth, AdminController.`);
    }
    for (const [method, route] of [
      ["GET", "/api/admin/order/cart/0"],
      ["POST", "/api/admin/order/cart/add/41"],
      ["DELETE", "/api/admin/order/cart/del/41"],
      ["POST", "/api/admin/order/cart/num/41"],
      ["GET", "/api/admin/order/place/list"],
      ["GET", "/api/admin/order/place/detail/local-order"],
      ["POST", "/api/admin/order/confirm/41"],
      ["POST", "/api/admin/order/computed/0123456789abcdef0123456789abcdef/41"],
      ["POST", "/api/admin/order/form_image/0123456789abcdef0123456789abcdef/41"],
      ["POST", "/api/admin/order/form_preview/0123456789abcdef0123456789abcdef/41"],
      ["GET", "/api/admin/order/form/local-order/41"],
      ["GET", "/api/admin/order/coupons/41"],
      ["POST", "/api/admin/order/create/0123456789abcdef0123456789abcdef/41"],
      ["POST", "/api/admin/order/pay/41"],
      ["GET", "/api/admin/order/pay/status"],
    ] as const) {
      expect(requiredAdminPermission(method, route)).toBe("order.assisted");
    }
    expect(requiredAdminPermission("GET", "/api/admin/order/detail/local-order")).toBe("order.view");
    expect(normalizeRoleRules("order.assisted")).toBe("order.assisted");
    expect(requiredAdminPermission("POST", "/api/admin/order/price")).toBe("order.manage");
  });

  it("binds cache, carts, orders, payment and audit to the authenticated actor", () => {
    const service = readFileSync("src/services/admin/AdminAssistedOrderService.ts", "utf8");
    const cart = readFileSync("src/services/order/StoreCartService.ts", "utf8");
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminController.ts", "utf8");
    expect(service).toContain("admin:assisted:checkout:");
    expect(service).toContain("snapshot.adminId !== adminId");
    expect(service).toContain("eq(storeOrder.staffId, adminId)");
    expect(service).toContain("authorizeBeforePayment: this.authorizePayment(adminId, uid, expectedPayCents)");
    expect(service).toContain('changeType: "admin_assisted_pay"');
    expect(service).toContain("appendOrderStatusConditions(conditions, status)");
    expect(service).toContain('"1": "weixin"');
    const placeList = service.split('async placeList(adminId: number')[1]?.split('/** Minimal actor-scoped mobile detail')[0];
    expect(placeList).toContain('id: storeOrder.id');
    expect(placeList).not.toContain('select().from(storeOrder)');
    expect(placeList).not.toContain('storeOrderCartInfo');
    expect(placeList).not.toContain('storeOrderRefund');
    expect(cart).toContain("eq(storeCart.staffId, params.adminId)");
    expect(cart).toContain("pg_advisory_xact_lock");
    expect(create).toContain("cart.staffId !== assisted.adminId");
    expect(create).toContain("eq(storeCart.staffId, assisted?.adminId ?? 0)");
    expect(create).toContain('changeType: "admin_assisted_create"');
    const createHandler = controller.split('export async function adminAssistedCreate(c: C)')[1]?.split('/** POST /api/admin/order/pay/')[0];
    expect(createHandler).toContain("readBoundedJsonObject(c.req.raw, 1_100_000)");
    expect(createHandler).toContain("error instanceof AssistedOrderCreateRejected");
    expect(controller).toContain("clientIp(c).trim().slice(0, 45)");
    expect(controller).toContain('c.header("Cache-Control", "private, no-store, max-age=0")');
  });

  it("keeps provider I/O outside database transactions and batches coupon scope reads", () => {
    const service = readFileSync("src/services/admin/AdminAssistedOrderService.ts", "utf8");
    expect(service).toContain("const provider = await service.pay");
    expect(service).toContain("inArray(storeCouponProduct.couponId, issueIds)");
    expect(service).toContain("calculateCouponEligibleSubtotalCents");
    expect(service).not.toContain("fetch(");
  });
});
