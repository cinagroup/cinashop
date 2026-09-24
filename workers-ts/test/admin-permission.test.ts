import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSION_GROUPS,
  AdminPermissionService,
  assertDelegablePermissions,
  normalizeAdminRoute,
  normalizeRoleRules,
  requiredAdminPermission,
} from "@/services/admin/AdminPermissionService";
import { createContainerFromDb } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { financePostgres } from "./helpers/financePostgres";

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

  it("separates platform cash-flow reads from remark edits on both admin route surfaces", () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/flow/get_list`)).toBe("capital_flow.view");
      expect(requiredAdminPermission("POST", `${prefix}/flow/set_mark/7`)).toBe("capital_flow.manage");
      expect(requiredAdminPermission("GET", `${prefix}/bill/list`)).toBe("bill.view");
    }
  });

  it("maps the exact legacy page-only capital menu to view without granting remark writes", async () => {
    const fixture = await financePostgres([systemMenus, systemRole]);
    try {
      await fixture.db.insert(systemMenus).values([
        { id: 1384, type: 1, authType: 1, access: 1, menuPath: "/admin/statistic/capital", uniqueAuth: "admin-statistic-capital" },
        { id: 1385, type: 1, authType: 1, access: 1, menuPath: "/admin/statistic/capital", uniqueAuth: "unrelated-page" },
      ]);
      await fixture.db.insert(systemRole).values({ id: 7, roleName: "legacy-cash-reader", rules: "1384" });
      const service = new AdminPermissionService(createContainerFromDb(fixture.db));
      const admin = { level: 1, roles: "7", id: 21, account: "reader", realName: "", divisionId: 0 };
      const keys = await service.resolveAdminPermissionKeys(admin);
      expect([...keys]).toEqual(["capital_flow.view"]);
      expect(service.buildMenus(keys)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/finance/capital-flow" })]));
      await expect(service.assertAuthorized(admin, "GET", "/adminapi/flow/get_list")).resolves.toBeUndefined();
      await expect(service.assertAuthorized(admin, "POST", "/adminapi/flow/set_mark/1")).rejects.toThrow("暂时没有权限访问");
      expect(await service.resolveRulePermissionKeys("1385")).toEqual([]);
      expect(await service.resolveManyRulePermissionKeys(["1384", "1385"]))
        .toEqual([["capital_flow.view"], []]);
    } finally {
      await fixture.close();
    }
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
