import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainerFromDb } from "@/lib/di";
import { systemMenus, systemRole } from "@/models/schema";
import { AdminPermissionService, requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { financePostgres } from "./helpers/financePostgres";

describe("legacy server operation-log permissions", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let permissions: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financePostgres([systemMenus, systemRole]);
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemMenus).values([
      { id: 1, authType: 1, type: 1, menuPath: "/admin/system/maintain/system_log/index", uniqueAuth: "system-maintain-system-log" },
      { id: 930002, authType: 2, type: 1, apiUrl: "system/log", methods: "GET" },
      { id: 930003, authType: 2, type: 1, apiUrl: "system/log/search_admin", methods: "HEAD" },
      // The old synthetic IDs are real protected product/category page IDs.
      // Keep their conflicting tuples as explicit rejection evidence.
      { id: 2, authType: 2, type: 1, apiUrl: "system/log", methods: "GET" },
      { id: 3, authType: 2, type: 1, apiUrl: "system/log/search_admin", methods: "HEAD" },
      { id: 4, authType: 1, type: 1, menuPath: "/admin/system/maintain/system_log/index", uniqueAuth: "wrong-page" },
      { id: 5, authType: 1, type: 1, menuPath: "/admin/product", uniqueAuth: "system-maintain-system-log" },
      { id: 6, authType: 2, type: 1, apiUrl: "system/log", methods: "DELETE" },
      { id: 7, authType: 1, type: 4, menuPath: "/admin/system/maintain/system_log/index", uniqueAuth: "system-maintain-system-log" },
      { id: 8, authType: 1, type: 1, menuPath: "/admin/system/maintain/system_log/index", uniqueAuth: "system-maintain-system-log", access: 0 },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: "legacy-log-page", type: 1, rules: "1" },
      { id: 2, roleName: "settings-reader", type: 1, rules: "config.view,system.view" },
      { id: 3, roleName: "supplier-log-role", type: 4, relationId: 1, rules: "log.view,1" },
    ]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); }, 30_000);

  it("maps only the two legacy reads on both admin surfaces", () => {
    for (const base of ["/adminapi", "/api/admin"]) {
      for (const path of ["system/log", "system/log/search_admin"]) {
        for (const method of ["GET", "HEAD"]) expect(requiredAdminPermission(method, `${base}/${path}`)).toBe("log.view");
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(requiredAdminPermission(method, `${base}/${path}`)).toBeNull();
      }
      for (const path of ["system/log/cleanup", "system/log/search_admin/1", "system/logging"]) {
        expect(requiredAdminPermission("GET", `${base}/${path}`)).toBeNull();
      }
    }
  });

  it("resolves the reviewed legacy page and API tuples to read authority", async () => {
    expect(await permissions.resolveManyRulePermissionKeys(["1", "930002", "930003", "4,5,6,7,8"]))
      .toEqual([["log.view"], ["log.view"], ["log.view"], []]);
    expect(await permissions.resolveRulePermissionKeys("1,930002,930003")).toEqual(["log.view"]);
  });

  it("rejects the former synthetic log tuples on protected product/category IDs in single and batch resolution", async () => {
    expect(await permissions.resolveManyRulePermissionKeys(["2", "3", "2,3"])).toEqual([[], [], []]);
    for (const rules of ["2", "3", "2,3"]) expect(await permissions.resolveRulePermissionKeys(rules)).toEqual([]);
  });

  it("admits log readers without granting settings or a log writer", async () => {
    const actor = { id: 10, account: "reader", realName: "", divisionId: 0, level: 1, roles: "1" };
    for (const base of ["/adminapi", "/api/admin"]) {
      for (const path of ["system/log", "system/log/search_admin"]) {
        await expect(permissions.assertAuthorized(actor, "GET", `${base}/${path}`)).resolves.toBeUndefined();
        await expect(permissions.assertAuthorized(actor, "DELETE", `${base}/${path}`)).rejects.toThrow();
      }
      await expect(permissions.assertAuthorized(actor, "GET", `${base}/system_admin/list`)).rejects.toThrow();
      for (const roles of ["2", "3"]) {
        await expect(permissions.assertAuthorized({ ...actor, roles }, "GET", `${base}/system/log`)).rejects.toThrow();
      }
    }
    expect(permissions.buildMenus(new Set(["log.view"]))).toEqual([expect.objectContaining({ path: "/system/log" })]);
  });
});
