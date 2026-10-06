import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createContainerFromDb, type Container } from "../src/lib/di";
import { systemAdmin, systemLog, systemMenus, systemRole } from "../src/models/schema";
import { AdminPermissionService, requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { createToken, md5 } from "../src/utils/jwt";
import { financePostgres } from "./helpers/financePostgres";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("../src/lib/di", async (original) => ({
  ...await original<typeof import("../src/lib/di")>(),
  createContainer: () => {
    if (!wiring.container) throw Error("Isolated menu-rules fixture unavailable");
    return wiring.container;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error("Isolated menu-rules fixture unavailable");
    return { container: wiring.container, close: async () => {} };
  },
}));

const app = createApp();
const env = { APP_KEY: "local-supplier-menu-rule-only", UPSTASH_REDIS_URL: "",
  UPSTASH_REDIS_TOKEN: "" } as Env;
const password = "supplier-menu-role";
const identities = { reader: 9901, manager: 9902, page: 9903,
  wrongPage: 9904, config: 9905, other: 9906 } as const;
type Identity = keyof typeof identities;
const tokens = new Map<Identity, string>();
let fixture: Awaited<ReturnType<typeof financePostgres>>;

beforeEach(async () => {
  fixture = await financePostgres([systemAdmin, systemLog, systemMenus, systemRole]);
  wiring.container = createContainerFromDb(fixture.db);
  await fixture.db.insert(systemMenus).values([
    { id: 8201, type: 1, authType: 1, menuName: "供应商菜单规则页面",
      menuPath: "/admin/supplier/supplier/index", uniqueAuth: "admin-supplier-supplier-index" },
    { id: 8202, type: 1, authType: 1, menuName: "伪页面",
      menuPath: "/admin/supplier/supplier/index", uniqueAuth: "admin-supplier-menu-list" },
    { id: 8203, type: 4, authType: 1, menuName: "商品菜单", menuPath: "/supplier/product" },
    { id: 8204, type: 4, authType: 2, menuName: "商品接口", pid: 8203,
      methods: "GET", apiUrl: "product/product/list" },
    { id: 8205, type: 1, authType: 1, menuName: "平台其它" },
  ]);
  const rules: Record<Identity, string> = {
    reader: "supplier_menu_rules.view", manager: "supplier_menu_rules.manage",
    page: "8201", wrongPage: "8202", config: "config.manage", other: "supplier_directory.manage",
  };
  await fixture.db.insert(systemRole).values(Object.entries(identities).map(([name, id]) => ({
    id, roleName: `Menu ${name}`, rules: rules[name as Identity],
  })));
  await fixture.db.insert(systemAdmin).values(Object.entries(identities).map(([name, id]) => ({
    id, account: `menu-${name}`, pwd: password, roles: String(id), level: 1,
    adminType: 1, status: 1, isDel: 0,
  })));
  for (const [name, id] of Object.entries(identities)) {
    tokens.set(name as Identity, (await createToken(id, "admin", md5(password), env.APP_KEY)).token);
  }
}, 30_000);

afterEach(async () => {
  wiring.container = undefined;
  tokens.clear();
  await fixture?.close();
});

async function request(base: string, identity: Identity | "anonymous", path: string,
  method = "GET", data?: Record<string, unknown>) {
  const response = await app.request(`${base}/${path}`, {
    method,
    headers: identity === "anonymous" ? {} : { Authorization: `Bearer ${tokens.get(identity)}`,
      ...(data ? { "Content-Type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }, env);
  return { status: response.status, cache: response.headers.get("Cache-Control"),
    body: await response.json<{ status: number; msg: string; data: any }>() };
}

it.each(["/adminapi", "/api/admin"])("isolates type-4 menu reads and no-store responses on %s", async (base) => {
  for (const name of ["anonymous", "wrongPage", "config", "other"] as const) {
    expect((await request(base, name, "supplier/menu-rules")).body.status).not.toBe(200);
  }
  for (const name of ["reader", "manager", "page"] as const) {
    const list = await request(base, name, "supplier/menu-rules");
    expect(list).toMatchObject({ status: 200, body: { status: 200, data: { count: 2,
      list: [{ id: 8203, children: [{ id: 8204 }] }] } } });
    expect(list.cache).toContain("no-store");
    expect((await request(base, name, "supplier/menu-rules/8204")).body.data)
      .toMatchObject({ id: 8204, type: 4, effective_permissions: ["supplier.product.view"] });
    expect((await request(base, name, "supplier/menu-rules/catalog")).body.data.navigation)
      .toEqual(expect.arrayContaining([{ path: "/products", name: "商品管理",
        permission: "supplier.product.view" }]));
  }
  expect((await request(base, "manager", "supplier/menu-rules/8205")).body.status).toBe(404);
  expect((await request(base, "manager", "supplier/menu-rules?is_show=2")).body.status).toBe(400);
});

it.each(["/adminapi", "/api/admin"])("fails closed for write before the reviewed database capability exists on %s", async (base) => {
  const create = { pid: 0, auth_type: 1, menu_name: "新规则", menu_path: "/supplier/products",
    unique_auth: "supplier-new-menu", api_url: "", methods: "", icon: "", sort: 1,
    is_show: 1, is_show_path: 0, access: 1 };
  for (const name of ["anonymous", "reader", "page", "config", "other"] as const) {
    expect((await request(base, name, "supplier/menu-rules", "POST", create)).body.status).not.toBe(200);
  }
  const manager = await request(base, "manager", "supplier/menu-rules", "POST", create);
  expect(manager.status).toBe(503);
  expect(manager.body.status).toBe(503);
  expect(manager.cache).toContain("no-store");
  const catalog = await request(base, "manager", "supplier/menu-rules/catalog");
  expect(catalog.body.data.write_ready).toBe(false);
  expect(await fixture.db.select().from(systemLog)).toEqual([]);
});

it("maps only the exact legacy page rule to view and never lets config own the new endpoint", async () => {
  const permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  expect(await permissions.resolveManyRulePermissionKeys(["8201", "8202"]))
    .toEqual([["supplier_menu_rules.view"], []]);
  for (const base of ["/adminapi", "/api/admin"]) {
    for (const path of ["supplier/menu-rules", "supplier/menu-rules/catalog", "supplier/menu-rules/8204"]) {
      expect(requiredAdminPermission("GET", `${base}/${path}`)).toBe("supplier_menu_rules.view");
      expect(requiredAdminPermission("POST", `${base}/${path}`)).toBe("supplier_menu_rules.manage");
    }
  }
});
