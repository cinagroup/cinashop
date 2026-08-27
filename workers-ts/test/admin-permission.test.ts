import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSION_GROUPS,
  assertDelegablePermissions,
  normalizeAdminRoute,
  normalizeRoleRules,
  requiredAdminPermission,
} from "@/services/admin/AdminPermissionService";

function registeredAdminRoutes(
  file: string,
  routeVariable: string,
  mountPrefix: string,
): Array<{ method: string; path: string }> {
  const source = readFileSync(file, "utf8");
  const pattern = new RegExp(
    `${routeVariable}\\.(get|post|put|delete|patch)\\(\\s*[\"']([^\"']+)[\"']\\s*,\\s*adminAuth\\b`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => ({
    method: match[1].toUpperCase(),
    path: `${mountPrefix}${match[2]}`,
  }));
}

describe("admin permission catalog", () => {
  it("covers every route guarded by adminAuth in both compatibility surfaces", () => {
    const routes = [
      ...registeredAdminRoutes("src/routes/adminapi.ts", "adminapiRoutes", "/adminapi"),
      ...registeredAdminRoutes("src/routes/v1/index.ts", "v1Routes", "/api"),
      { method: "GET", path: "/api/ws/kefu" },
    ];
    expect(routes.length).toBeGreaterThan(200);
    const missing = routes.filter((route) => !requiredAdminPermission(route.method, route.path));
    expect(missing).toEqual([]);
  });

  it("keeps route aliases in the same permission domain", () => {
    expect(requiredAdminPermission("POST", "/adminapi/product/add")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/api/admin/product/create")).toBe("product.manage");
    expect(requiredAdminPermission("GET", "/adminapi/order/outbox")).toBe("outbox.view");
    expect(requiredAdminPermission("GET", "/api/admin/order/list")).toBe("order.view");
    expect(requiredAdminPermission("GET", "/adminapi/merchant/store")).toBe("store.view");
    expect(requiredAdminPermission("PUT", "/api/admin/merchant/store_staff/set_show/:id/:status"))
      .toBe("store.manage");
    expect(normalizeAdminRoute("/API/Admin/Agent/Division/Detail/:uid")).toBe("agent/division/detail/:uid");
  });

  it("fails closed for unregistered management routes", () => {
    expect(requiredAdminPermission("GET", "/adminapi/not-registered/list")).toBeNull();
  });

  it("normalizes role rules and makes manage imply view", () => {
    expect(normalizeRoleRules("division.manage,42,division.manage")).toBe("division.view,division.manage,42");
    expect(() => normalizeRoleRules("division.root")).toThrow("未知权限规则");
  });

  it("prevents restricted administrators from delegating permissions they do not hold", () => {
    const granted = new Set(["dashboard.view", "division.view", "division.manage"]);
    expect(() => assertDelegablePermissions(granted, ["division.view", "division.manage"])).not.toThrow();
    expect(() => assertDelegablePermissions(granted, ["system.manage"])).toThrow("不能授予超出当前管理员范围");
  });

  it("publishes a unique view permission for every menu group", () => {
    const keys = ADMIN_PERMISSION_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const group of ADMIN_PERMISSION_GROUPS) {
      const matcher = group.matches[0];
      const sampleRoute = matcher.endsWith("/") ? `${matcher}list` : matcher;
      expect(requiredAdminPermission("GET", `/adminapi/${sampleRoute}`)).toBe(`${group.key}.view`);
    }
  });
});
