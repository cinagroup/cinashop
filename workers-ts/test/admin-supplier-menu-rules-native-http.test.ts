import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createContainerFromDb, type Container } from "../src/lib/di";
import { installRuntimeAdminBoundaryInTransaction } from "../src/migrations/runtimeAdminBoundary";
import { installAdminSupplierMenuWriteCapability } from "../src/migrations/adminSupplierMenuWriteCapability";
import { systemAdmin, systemLog, systemMenus, systemRole } from "../src/models/schema";
import { createToken, md5 } from "../src/utils/jwt";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";

const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined,
  admin: undefined as Container | undefined }));
vi.mock("../src/lib/di", async (original) => ({
  ...await original<typeof import("../src/lib/di")>(),
  createContainer: () => {
    if (!wiring.application) throw Error("Isolated menu HTTP application fixture unavailable");
    return wiring.application;
  },
  createAdminDatabaseSession: () => {
    if (!wiring.admin) throw Error("Isolated menu HTTP Admin fixture unavailable");
    return { container: wiring.admin, close: async () => {} };
  },
}));

const native = process.env.TEST_FINANCE_POSTGRES_URL ? describe : describe.skip;
const app = createApp();
const env = { APP_KEY: "native-supplier-menu-http", UPSTASH_REDIS_URL: "",
  UPSTASH_REDIS_TOKEN: "" } as Env;
const password = "native-supplier-menu-password";
type Identity = "reader" | "manager" | "page";
const ids: Record<Identity, number> = { reader: 901, manager: 902, page: 903 };
const tokens = new Map<Identity, string>();
const form = { pid: 8301, auth_type: 1, menu_name: "新菜单", menu_path: "/supplier/products",
  unique_auth: "supplier-new-native-menu", api_url: "", methods: "", icon: "", sort: 1,
  is_show: 1, is_show_path: 0, access: 1 };

native("Admin supplier menu HTTP with a restricted PG16 LOGIN", () => {
  let fixture: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let ddl: string;
  let owner: string;
  let ownerCreated = false;

  beforeAll(async () => {
    const kit = await import("drizzle-kit/api");
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus, systemLog }))).join("\n");
  });

  beforeEach(async () => {
    fixture = await sequenceRunnerDatabase();
    if (!fixture.withRuntimeRole) throw Error("Owned native PG16 required");
    await fixture.exec(ddl);
    await fixture.db.insert(systemMenus).values([
      { id: 8201, type: 1, authType: 1, menuName: "旧页面",
        menuPath: "/admin/supplier/supplier/index", uniqueAuth: "admin-supplier-supplier-index" },
      { id: 8301, type: 4, authType: 1, menuName: "供应商商品", menuPath: "/supplier/products",
        uniqueAuth: "supplier-product-root" },
      { id: 8401, type: 1, authType: 1, menuName: "平台其它" },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 891, type: 1, roleName: "只读", rules: "supplier_menu_rules.view" },
      { id: 892, type: 1, roleName: "管理", rules: "supplier_menu_rules.manage" },
      { id: 893, type: 1, roleName: "旧页面", rules: "8201" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 901, account: "menu-reader", pwd: password, roles: "891", level: 1, adminType: 1 },
      { id: 902, account: "menu-manager", pwd: password, roles: "892", level: 1, adminType: 1 },
      { id: 903, account: "menu-page", pwd: password, roles: "893", level: 1, adminType: 1 },
    ]);
    for (const [name, id] of Object.entries(ids)) {
      tokens.set(name as Identity, (await createToken(id, "admin", md5(password), env.APP_KEY)).token);
    }
    wiring.application = createContainerFromDb(fixture.db);
    owner = `cinashop_menu_owner_${randomUUID().replaceAll("-", "")}`;
    await fixture.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    ownerCreated = true;
  }, 60_000);

  afterEach(async () => {
    wiring.application = wiring.admin = undefined;
    tokens.clear();
    try {
      if (ownerCreated) await fixture.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
      ownerCreated = false;
    } finally { await fixture?.close(); }
  }, 30_000);

  async function request(base: string, identity: Identity | "anonymous", path: string,
    method = "GET", body?: Record<string, unknown>) {
    const response = await app.request(`${base}/${path}`, { method,
      headers: identity === "anonymous" ? {} : { Authorization: `Bearer ${tokens.get(identity)}`,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, env);
    return { status: response.status, cache: response.headers.get("Cache-Control"),
      body: await response.json<{ status: number; msg: string; data: any }>() };
  }

  it("executes and audits CAS writes on both prefixes while reader/page grants remain view-only", async () => {
    await fixture.withRuntimeRole!(application => fixture.withRuntimeRole!(async admin => {
      await fixture.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, application.role, "finance_test"));
      await fixture.exec(`GRANT SELECT ON public.system_menus, public.system_role, public.system_log TO "${admin.role}";
        GRANT UPDATE(id) ON public.system_menus TO "${admin.role}";
        GRANT INSERT ON public.system_log TO "${admin.role}";
        GRANT USAGE ON SEQUENCE public.system_log_id_seq TO "${admin.role}"`);
      wiring.admin = createContainerFromDb(admin.db);
      const uninstalled = await request("/adminapi", "manager", "supplier/menu-rules", "POST", form);
      expect(uninstalled.status).toBe(503);
      expect((await request("/adminapi", "manager", "supplier/menu-rules/catalog")).body.data.write_ready).toBe(false);
      await installAdminSupplierMenuWriteCapability(fixture.db,
        { app: application.role, admin: admin.role, maintenance: "finance_test", owner });
      expect((await request("/api/admin", "manager", "supplier/menu-rules/catalog")).body.data.write_ready).toBe(true);
      for (const name of ["anonymous", "reader", "page"] as const) {
        expect((await request("/adminapi", name, "supplier/menu-rules", "POST", form)).body.status).not.toBe(200);
      }
      const created = await request("/adminapi", "manager", "supplier/menu-rules", "POST", form);
      expect(created).toMatchObject({ status: 200,
        body: { status: 200, data: { type: 4, auth_type: 1, menu_name: "新菜单" } } });
      expect(created.cache).toContain("no-store");
      const id = created.body.data.id as number;
      const revision = created.body.data.revision as string;
      const changed = await request("/api/admin", "manager", `supplier/menu-rules/${id}`, "PUT",
        { ...form, menu_name: "新版菜单", expected_revision: revision });
      expect(changed).toMatchObject({ status: 200,
        body: { status: 200, data: { id, menu_name: "新版菜单" } } });
      expect(changed.body.data.revision).not.toBe(revision);
      expect((await request("/adminapi", "manager", `supplier/menu-rules/${id}`, "PUT",
        { ...form, menu_name: "陈旧覆盖", expected_revision: revision })).status).toBe(409);
      const hidden = await request("/adminapi", "manager", `supplier/menu-rules/${id}/visibility`, "PUT",
        { is_show: 0, expected_revision: changed.body.data.revision });
      expect(hidden).toMatchObject({ status: 200, body: { data: { id, is_show: 0 } } });
      const deleted = await request("/api/admin", "manager", `supplier/menu-rules/${id}`, "DELETE",
        { expected_revision: hidden.body.data.revision });
      expect(deleted).toMatchObject({ status: 200, body: { data: { id, is_del: 1 } } });
      expect((await request("/adminapi", "manager", `supplier/menu-rules/${id}`)).body.status).toBe(404);
      expect((await request("/api/admin", "manager", "supplier/menu-rules/8401")).body.status).toBe(404);
      const logs = await fixture.db.select().from(systemLog);
      expect(logs.map((row) => row.action)).toEqual([
        `supplier_menu_rules.create:${id}`, `supplier_menu_rules.update:${id}`,
        `supplier_menu_rules.visibility:${id}`, `supplier_menu_rules.delete:${id}`,
      ]);
      const apiForm = { ...form, auth_type: 2, menu_name: "订单查看", menu_path: "",
        unique_auth: "", api_url: "order/list", methods: "GET" };
      expect((await request("/adminapi", "manager", "supplier/menu-rules", "POST",
        { ...apiForm, api_url: "order/ghost" })).body.status).toBe(400);
      const apiCreated = await request("/api/admin", "manager", "supplier/menu-rules", "POST", apiForm);
      expect(apiCreated).toMatchObject({ status: 200, body: { data: {
        auth_type: 2, effective_permissions: ["supplier.order.view"],
      } } });
      const apiId = apiCreated.body.data.id as number;
      await fixture.db.insert(systemRole).values({ id: 8501, type: 4, roleName: "暂时停用的数字角色",
        status: 0, rules: String(apiId) });
      const forbiddenUpdate = await request("/adminapi", "manager", `supplier/menu-rules/${apiId}`,
        "PUT", { ...apiForm, access: 0, expected_revision: apiCreated.body.data.revision });
      expect(forbiddenUpdate.body.status).toBe(400);
      const forbiddenDelete = await request("/api/admin", "manager", `supplier/menu-rules/${apiId}`,
        "DELETE", { expected_revision: apiCreated.body.data.revision });
      expect(forbiddenDelete.body.status).toBe(400);
      expect((await fixture.db.select().from(systemLog))).toHaveLength(5);
    }));
  }, 60_000);
});
