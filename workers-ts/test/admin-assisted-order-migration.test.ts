import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseAssistedCartIds,
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

  it("mounts all eleven PHP routes behind one explicit assisted-order permission", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const expected = [
      ['get', '/admin/order/cart/:uid'],
      ['post', '/admin/order/cart/add/:uid'],
      ['delete', '/admin/order/cart/del/:uid'],
      ['post', '/admin/order/cart/num/:uid'],
      ['get', '/admin/order/place/list'],
      ['post', '/admin/order/confirm/:uid'],
      ['post', '/admin/order/computed/:key/:uid'],
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
      ["POST", "/api/admin/order/confirm/41"],
      ["POST", "/api/admin/order/computed/0123456789abcdef0123456789abcdef/41"],
      ["GET", "/api/admin/order/coupons/41"],
      ["POST", "/api/admin/order/create/0123456789abcdef0123456789abcdef/41"],
      ["POST", "/api/admin/order/pay/41"],
      ["GET", "/api/admin/order/pay/status"],
    ] as const) {
      expect(requiredAdminPermission(method, route)).toBe("order.assisted");
    }
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
    expect(service).toContain("authorizeBeforePayment: this.authorizePayment(adminId, uid)");
    expect(service).toContain('changeType: "admin_assisted_pay"');
    expect(service).toContain("appendOrderStatusConditions(conditions, status)");
    expect(service).toContain('"1": "weixin"');
    expect(service).toContain("refundedNum === refundableCartNum");
    expect(cart).toContain("eq(storeCart.staffId, params.adminId)");
    expect(cart).toContain("pg_advisory_xact_lock");
    expect(create).toContain("cart.staffId !== assisted.adminId");
    expect(create).toContain("eq(storeCart.staffId, assisted?.adminId ?? 0)");
    expect(create).toContain('changeType: "admin_assisted_create"');
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 32 * 1024)");
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
