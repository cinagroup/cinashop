import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allSupplierPermissionKeys,
  assertSupplierDelegablePermissions,
  normalizeSupplierRoleRules,
  normalizeSupplierRoute,
  requiredSupplierPermissions,
  SUPPLIER_PERMISSION_GROUPS,
} from "@/services/supplier/SupplierPermissionService";
import {
  normalizeSupplierAdminInput,
  normalizeSupplierRoleInput,
} from "@/services/supplier/SupplierAdminService";

function authenticatedSupplierRoutes() {
  const source = readFileSync("src/routes/supplierapi.ts", "utf8");
  const protectedSource = source.slice(source.indexOf('use("/*", supplierPermissionMiddleware)'));
  const matches = [...protectedSource.matchAll(/supplierapiRoutes\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g)];
  return matches.map((match) => ({ method: match[1].toUpperCase(), path: `/supplierapi${match[2]}` }));
}

describe("supplier permission catalog", () => {
  it("covers every authenticated Supplier route and fails closed for unknown routes", () => {
    const routes = authenticatedSupplierRoutes();
    expect(routes.length).toBeGreaterThan(110);
    expect(routes.filter((route) => requiredSupplierPermissions(route.method, route.path) === null)).toEqual([]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/not-registered")).toBeNull();
  });

  it("requires combined capabilities for manual print and waybill actions", () => {
    expect(requiredSupplierPermissions("POST", "/supplierapi/order/print/12")).toEqual([
      "supplier.order.view",
      "supplier.print.manage",
    ]);
    expect(requiredSupplierPermissions("POST", "/supplierapi/order/waybill/12")).toEqual([
      "supplier.order.view",
      "supplier.waybill.manage",
    ]);
    expect(requiredSupplierPermissions("PUT", "/supplierapi/refund/refund/7")).toEqual([
      "supplier.refund.manage",
    ]);
    expect(normalizeSupplierRoute("/SupplierApi/Admin/Set_Status/1/0")).toBe("admin/set_status/1/0");
  });

  it("normalizes stable and legacy rules without permitting delegated escalation", () => {
    expect(normalizeSupplierRoleRules("supplier.order.manage,42,supplier.order.manage")).toBe(
      "supplier.order.view,supplier.order.manage,42",
    );
    expect(() => normalizeSupplierRoleRules("supplier.order.root")).toThrow("未知供应商权限规则");
    const granted = new Set(["supplier.order.view", "supplier.order.manage"]);
    expect(() => assertSupplierDelegablePermissions(granted, ["supplier.order.view"])).not.toThrow();
    expect(() => assertSupplierDelegablePermissions(granted, ["supplier.admin.manage"]))
      .toThrow("不能授予超出当前供应商管理员范围");
  });

  it("publishes unique view/manage keys for every Supplier domain", () => {
    const all = allSupplierPermissionKeys();
    expect(new Set(SUPPLIER_PERMISSION_GROUPS.map((group) => group.key)).size)
      .toBe(SUPPLIER_PERMISSION_GROUPS.length);
    for (const group of SUPPLIER_PERMISSION_GROUPS) {
      expect(all.has(`supplier.${group.key}.view`)).toBe(true);
      if (group.manage) expect(all.has(`supplier.${group.key}.manage`)).toBe(true);
    }
  });
});

describe("supplier child-administrator contracts", () => {
  it("normalizes bounded administrator input and rejects weak or ambiguous credentials", () => {
    expect(normalizeSupplierAdminInput({
      account: " warehouse.manager ",
      real_name: " 仓库主管 ",
      phone: "13800138000",
      pwd: "correct-horse-battery",
      conf_pwd: "correct-horse-battery",
      roles: [9, 7, 9],
      status: 1,
      head_pic: "https://assets.example/avatar.png",
    }, true)).toMatchObject({
      account: "warehouse.manager",
      realName: "仓库主管",
      roles: [7, 9],
      status: 1,
    });
    expect(() => normalizeSupplierAdminInput({
      account: "child", real_name: "子账号", phone: "13800138000",
      pwd: "short", conf_pwd: "short", roles: [1], status: 1,
    }, true)).toThrow("至少需要12位");
    expect(() => normalizeSupplierAdminInput({
      account: "child", real_name: "子账号", phone: "13800138000",
      pwd: "correct-horse-battery", conf_pwd: "different-password", roles: [1], status: 1,
    }, true)).toThrow("两次输入的密码不一致");
    expect(() => normalizeSupplierAdminInput({
      account: "child", real_name: "子账号", phone: "13800138000",
      pwd: "correct-horse-battery", conf_pwd: "correct-horse-battery", roles: [1],
      head_pic: "javascript:alert(1)", status: 1,
    }, true)).toThrow("头像地址不安全");
  });

  it("normalizes scoped roles and requires at least one stable Supplier capability", () => {
    expect(normalizeSupplierRoleInput({
      role_name: " 仓库履约 ",
      rules: ["supplier.order.manage", "supplier.print.view"],
      status: 1,
    })).toEqual({
      name: "仓库履约",
      rules: "supplier.order.view,supplier.order.manage,supplier.print.view",
      status: 1,
    });
    expect(() => normalizeSupplierRoleInput({
      role_name: "旧菜单", rules: ["42"], status: 1,
    })).toThrow("至少选择一项");
  });

  it("mounts all eight exact legacy contracts after auth and permission middleware", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const route of [
      'get("/admin"',
      'get("/admin/create"',
      'post("/admin"',
      'get("/admin/:id/edit"',
      'get("/admin/:id"',
      'put("/admin/:id"',
      'delete("/admin/:id"',
      'put("/admin/set_status/:id/:status"',
    ]) expect(routes).toContain(route);
    expect(routes.indexOf('use("/*", supplierAuthMiddleware)')).toBeLessThan(
      routes.indexOf('use("/*", supplierPermissionMiddleware)'),
    );
    expect(routes.indexOf('use("/*", supplierPermissionMiddleware)')).toBeLessThan(
      routes.indexOf('get("/admin"'),
    );
  });

  it("mounts scoped role extensions before dynamic administrator routes", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const route of [
      'get("/admin/roles"',
      'post("/admin/roles"',
      'put("/admin/roles/:id"',
      'delete("/admin/roles/:id"',
    ]) expect(routes).toContain(route);
    expect(routes.indexOf('get("/admin/roles"')).toBeLessThan(routes.indexOf('get("/admin/:id"'));
  });

  it("keeps every child mutation scoped, locked and unable to target the primary account", () => {
    const service = readFileSync("src/services/supplier/SupplierAdminService.ts", "utf8");
    const auth = readFileSync("src/middleware/supplier-auth.ts", "utf8");
    const login = readFileSync("src/services/supplier/SupplierService.ts", "utf8");
    expect(service).toContain("eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE)");
    expect(service).toContain("eq(systemAdmin.relationId, supplierId)");
    expect(service).toContain("eq(systemAdmin.level, SUPPLIER_CHILD_LEVEL)");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('for("update")');
    expect(service).toContain("supplier.adminId === actor.id");
    expect(service).toContain("assertSupplierDelegablePermissions(granted, requested)");
    expect(service).toContain("resolveManyRulePermissionKeys([input.rules])");
    expect(service).toContain("rows.map((row) => row.rules)");
    expect(service).toContain('type: "supplier_admin"');
    expect(auth).toContain("supplier.adminId === admin.id");
    expect(auth).toContain("findActiveById(admin.relationId)");
    expect(login).toContain("子账号尚未配置有效权限");
    expect(login).toContain("async profile(supplierId: number, adminId: number)");
    expect(login).toContain("input.account !== actor.account");
  });

  it("filters the new Supplier navigation and exposes a guarded administrator page", () => {
    const shell = readFileSync("../view/supplier-ts/src/components/AppShell.vue", "utf8");
    const router = readFileSync("../view/supplier-ts/src/router.ts", "utf8");
    const page = readFileSync("../view/supplier-ts/src/pages/Administrators.vue", "utf8");
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    expect(shell).toContain("navigationCatalog.filter");
    expect(shell).toContain('permission: "supplier.admin.view"');
    expect(router).toContain('meta: { permission: "supplier.admin.view" }');
    expect(page).toContain('auth.can("supplier.admin.manage")');
    expect(page).toContain("子账号也不能给他人授予自己没有的权限");
    expect(page).toContain("供应商角色权限");
    expect(api).toContain('"/admin/create"');
    expect(api).toContain('"/admin/roles"');
    expect(api).toContain('`/admin/set_status/${id}/${status}`');
  });
});
