import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createContainerFromDb, type DbClient } from "../src/lib/di";
import { storeCart, storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue,
  storeProductCategory, storeProductDescription, storeProductRelation, storeProductStockRecord,
  systemAdmin, systemLog, systemMenus, systemRole, systemSupplier } from "../src/models/schema";
import { lockSupplierCategoryScope, SupplierProductCategoryService, type SupplierCategoryActor } from "../src/services/supplier/SupplierProductCategoryService";
import { SupplierProductManagementService } from "../src/services/supplier/SupplierProductManagementService";
import { md5 } from "../src/utils/jwt";
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from "./helpers/financePeers";

function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function readyOrFailure(ready: { promise: Promise<void> }, held: Promise<{ ok: boolean; error?: unknown }>) {
  await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
}
const tables = [storeProductCategory, storeProduct, storeProductRelation, systemAdmin, systemRole, systemSupplier, systemLog, systemMenus,
  storeCart, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription, storeProductStockRecord];
const category = (db: DbClient) => new SupplierProductCategoryService(createContainerFromDb(db));
const products = (db: DbClient) => new SupplierProductManagementService(createContainerFromDb(db));
const productBody = (id: number) => ({ product_type: 0, store_name: `binding-${id}`, cate_id: [id],
  slider_image: ["https://images.example/native.png"], spec_type: 0,
  attrs: [{ suk: "默认", image: "https://images.example/native.png", price: "10.00", settle_price: "8.00", stock: 3 }],
  description: "<p>isolated fixture</p>", freight: 1, is_postage: 1 });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("Supplier category native PG16 concurrent writes and column-lock LOGIN", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let actor: SupplierCategoryActor;
  beforeAll(async () => {
    f = await financePostgres(tables);
    await f.exec("ALTER TABLE store_product_description ADD UNIQUE(product_id,type)");
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("External I/O forbidden"); }));
    await f.reset(); actor = { id: 21, authVersion: md5(""), expiresAt: Math.floor(Date.now() / 1000) + 300 };
    await f.db.insert(systemSupplier).values({ id: 20, adminId: 29, supplierName: "isolated" });
    await f.db.insert(systemAdmin).values({ id: 21, account: "category-native", adminType: 4, relationId: 20, roles: "21", level: 1 });
    await f.db.insert(systemRole).values({ id: 21, type: 4, relationId: 20, rules: "supplier.product.manage" });
    await f.db.insert(storeProductCategory).values([
      { id: 100, type: 2, relationId: 20, cateName: "A" },
      { id: 101, type: 2, relationId: 20, cateName: "A-child", pid: 100, path: "100", level: 1 },
      { id: 110, type: 2, relationId: 20, cateName: "B" },
      { id: 120, type: 2, relationId: 20, cateName: "empty" },
    ]);
    await f.exec("SELECT setval('store_product_category_id_seq',120,true)");
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

  it("serializes simultaneous parent moves so exactly one commits and no cycle can survive", async () => {
    await withFinancePeers(f.db, async ([gate, left, right]) => {
      const ready = signal(), release = signal();
      const held = outcome(gate.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const a = outcome(category(left.db).save(20, 100, { pid: 110, cate_name: "A", is_show: 1 }, actor));
      const b = outcome(category(right.db).save(20, 110, { pid: 100, cate_name: "B", is_show: 1 }, actor));
      try { await waitForFinanceBlock(f.db, left.pid, gate.pid); await waitForFinanceBlock(f.db, right.pid, gate.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); const results = await Promise.all([a, b]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      const tree = await category(f.db).modernTree(20); expect(tree).toHaveLength(2);
      expect((await f.db.select().from(systemLog))).toHaveLength(1);
    });
  });

  it("serializes same-parent duplicate creates instead of racing the absence check", async () => {
    await withFinancePeers(f.db, async ([gate, left, right]) => {
      const ready = signal(), release = signal();
      const held = outcome(gate.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const a = outcome(category(left.db).save(20, 0, { cate_name: "unique-sibling", pid: 110 }, actor));
      const b = outcome(category(right.db).save(20, 0, { cate_name: "unique-sibling", pid: 110 }, actor));
      try { await waitForFinanceBlock(f.db, left.pid, gate.pid); await waitForFinanceBlock(f.db, right.pid, gate.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await Promise.all([a, b])).filter(result => result.ok)).toHaveLength(1);
      expect(await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.cateName, "unique-sibling"))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
    });
  });

  it("commits deletion first, then the actual product save rejects the missing category without product or SKU writes", async () => {
    await withFinancePeers(f.db, async ([deleting, binding]) => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => {
        await category(tx as unknown as DbClient).delete(20, 120, undefined, actor); ready.resolve(); await release.promise;
      }));
      await readyOrFailure(ready, held);
      const saved = outcome(products(binding.db).saveProduct(20, 0, productBody(120)));
      try { await waitForFinanceBlock(f.db, binding.pid, deleting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await saved).ok).toBe(false);
      expect(await f.db.select().from(storeProduct)).toEqual([]); expect(await f.db.select().from(storeProductAttrValue)).toEqual([]);
      expect(await f.db.select().from(storeProductRelation)).toEqual([]);
    });
  });

  it("commits the actual product/SKU/category binding first, then deletion rejects the new reference", async () => {
    await withFinancePeers(f.db, async ([binding, deleting]) => {
      const ready = signal(), release = signal();
      const held = outcome(binding.db.transaction(async tx => {
        const result = await products(tx as unknown as DbClient).saveProduct(20, 0, productBody(120)); ready.resolve(); await release.promise; return result;
      }));
      await readyOrFailure(ready, held);
      const removal = outcome(category(deleting.db).delete(20, 120, undefined, actor));
      try { await waitForFinanceBlock(f.db, deleting.pid, binding.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await removal).ok).toBe(false);
      expect(await f.db.select().from(storeProduct)).toHaveLength(1);
      expect(await f.db.select().from(storeProductAttrValue)).toHaveLength(1);
      expect((await f.db.select().from(storeProductRelation))[0]).toMatchObject({ type: 1, relationId: 120, relationPid: 0 });
      expect(await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id, 120))).toHaveLength(1);
    });
  });

  it("waits for a category move before actual product binding and writes the new relation_pid", async () => {
    await withFinancePeers(f.db, async ([moving, binding]) => {
      const ready = signal(), release = signal();
      const held = outcome(moving.db.transaction(async tx => {
        await category(tx as unknown as DbClient).save(20, 101, { cate_name: "A-child", pid: 110, is_show: 1 }, actor); ready.resolve(); await release.promise;
      }));
      await readyOrFailure(ready, held);
      const saved = outcome(products(binding.db).saveProduct(20, 0, productBody(101)));
      try { await waitForFinanceBlock(f.db, binding.pid, moving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await saved).ok).toBe(true);
      expect((await f.db.select().from(storeProductRelation))[0]).toMatchObject({ relationId: 101, relationPid: 110 });
      expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id, 101)))[0].path).toBe("110");
    });
  });

  it("rejects password rotation occurring after HTTP-style claims were captured but before the scope lock is acquired", async () => {
    await withFinancePeers(f.db, async ([gate, writing, rotating]) => {
      const ready = signal(), release = signal();
      const held = outcome(gate.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const pending = outcome(category(writing.db).save(20, 0, { cate_name: "stale-password" }, actor));
      try {
        await waitForFinanceBlock(f.db, writing.pid, gate.pid);
        await rotating.db.update(systemAdmin).set({ pwd: "rotated-during-wait" }).where(eq(systemAdmin.id, 21));
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
      const result = await pending; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: 410001 });
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });

  it("rejects an authenticated claim expiring while it waits for the category scope", async () => {
    await withFinancePeers(f.db, async ([gate, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(gate.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const expiry = Math.floor(Date.now() / 1000) + 1;
      const pending = outcome(category(writing.db).save(20, 0, { cate_name: "expired-during-wait" }, { ...actor, expiresAt: expiry }));
      try {
        await waitForFinanceBlock(f.db, writing.pid, gate.pid);
        await waitForFinanceClock(f.db, expiry * 1000);
      } finally { release.resolve(); }
      expect((await held).ok).toBe(true); const result = await pending; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: 410001 });
      expect(await f.db.select().from(storeProductCategory)).toHaveLength(4); expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });

  it.each(["role", "menu"] as const)("holds selected %s grants stable through commit, then observes revocation", async source => {
    await f.db.insert(systemMenus).values({ id: 900, type: 4, authType: 2, access: 1, apiUrl: "/supplierapi/product/category", methods: "POST" });
    await f.db.update(systemRole).set({ rules: source === "menu" ? "900" : "supplier.product.manage" }).where(eq(systemRole.id, 21));
    await withFinancePeers(f.db, async ([writing, revoking]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => {
        await category(tx as unknown as DbClient).save(20, 0, { cate_name: `stable-${source}` }, actor); ready.resolve(); await release.promise;
      }));
      await readyOrFailure(ready, held);
      const changed = outcome(source === "role"
        ? revoking.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21))
        : revoking.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 900)));
      try { await waitForFinanceBlock(f.db, revoking.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await changed).ok).toBe(true);
      await expect(category(f.db).save(20, 0, { cate_name: "after-revocation" }, actor)).rejects.toMatchObject({ code: 400011 });
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
    });
  });

  it("uses menu SELECT plus UPDATE(id) lock privilege under a true restricted LOGIN without semantic menu DML", async () => {
    await numericMenuRole();
    await withRuntimeLogin(true, async runtime => {
      expect((await category(runtime).save(20, 0, { cate_name: "restricted-login" }, actor)).id).toBeGreaterThan(120);
      await expect(runtime.execute(sql`UPDATE system_menus SET access=0 WHERE id=900`)).rejects.toMatchObject({ cause: { code: "42501" } });
      await runtime.execute(sql`RESET ROLE`);
      const [current] = await runtime.select({ role: sql<string>`current_user`, session: sql<string>`session_user` }).from(sql`(values (1)) as probe(n)`);
      expect(current.role).toBe(current.session); expect(current.role).toMatch(/^category_runtime_/);
    });
    expect((await f.db.select().from(systemMenus).where(eq(systemMenus.id, 900)))[0].access).toBe(1);
  });

  it("fails closed without UPDATE(id) menu lock privilege and leaves category/audit unchanged", async () => {
    await numericMenuRole();
    await withRuntimeLogin(false, async runtime => {
      await expect(category(runtime).save(20, 0, { cate_name: "missing-lock-privilege" }, actor)).rejects.toMatchObject({ code: 503, httpStatus: 503 });
    });
    expect(await f.db.select().from(storeProductCategory)).toHaveLength(4); expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  async function numericMenuRole() {
    await f.db.insert(systemMenus).values({ id: 900, type: 4, authType: 2, access: 1, apiUrl: "/supplierapi/product/category", methods: "POST" });
    await f.db.update(systemRole).set({ rules: "900" }).where(eq(systemRole.id, 21));
  }

  async function withRuntimeLogin<T>(menuLockPrivilege: boolean, callback: (db: DbClient) => Promise<T>): Promise<T> {
    const baseUrl = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? "");
    const [origin] = await f.db.select({ database: sql<string>`current_database()`, schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    if (!ownsFinanceFixtureTarget(origin.database, origin.schema, baseUrl.href)) throw Error("Unowned runtime category fixture");
    const role = `category_runtime_${randomUUID().replaceAll("-", "")}`, password = randomUUID().replaceAll("-", "");
    if (!/^category_runtime_[a-f0-9]{32}$/.test(role) || !/^finance_test_[a-f0-9]{32}$/.test(origin.schema)) throw Error("Invalid restricted runtime identity");
    let client: ReturnType<typeof postgres> | undefined, created = false;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA "${origin.schema}" TO "${role}";
        GRANT SELECT ON store_product_category,store_product,store_product_relation,system_admin,system_supplier,system_role,system_menus TO "${role}";
        GRANT INSERT,UPDATE,DELETE ON store_product_category TO "${role}"; GRANT UPDATE ON store_product_relation TO "${role}";
        GRANT INSERT ON system_log TO "${role}";
        GRANT UPDATE(id) ON system_admin,system_supplier,system_role TO "${role}";
        GRANT USAGE,SELECT ON SEQUENCE store_product_category_id_seq,system_log_id_seq TO "${role}"`);
      if (menuLockPrivilege) await f.exec(`GRANT UPDATE(id) ON system_menus TO "${role}"`);
      const url = new URL(baseUrl.href); url.pathname = `/${origin.database}`; url.username = role; url.password = password;
      client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0,
        connection: { options: `-c search_path=${origin.schema} -c statement_timeout=5000` } });
      const [current] = await client`SELECT current_database() AS database,current_schema() AS schema,current_user AS role,session_user AS session,current_setting('server_version_num') AS version`;
      if (current.database !== origin.database || current.schema !== origin.schema || current.role !== role || current.session !== role || Math.floor(Number(current.version) / 10000) !== 16) throw Error("Unexpected native runtime identity");
      return await callback(drizzle(client) as unknown as DbClient);
    } finally {
      await client?.end({ timeout: 2 });
      if (created) { await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
    }
  }
});
