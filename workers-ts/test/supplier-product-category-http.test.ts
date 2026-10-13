import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { errorHandler } from "../src/middleware/error";
import { storeProduct, storeProductCategory, storeProductRelation, systemAdmin, systemLog, systemMenus, systemRole, systemSupplier } from "../src/models/schema";
import { supplierapiRoutes } from "../src/routes/supplierapi";
import { SupplierProductCategoryService } from "../src/services/supplier/SupplierProductCategoryService";
import { createToken, md5 } from "../src/utils/jwt";
import * as cache from "../src/utils/cache";
import { financePostgres } from "./helpers/financePostgres";

const base = "/supplierapi/product/category";
const env = { APP_KEY: "isolated-category-http-fixture", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;
type Role = "manager" | "reader" | "other" | "unrelated";

describe("Supplier complete category contracts through actual JWT, RBAC and SQL", () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let service: SupplierProductCategoryService;
  let tokens: Record<Role, string>;

  beforeAll(async () => {
    f = await financePostgres([storeProductCategory, storeProduct, storeProductRelation, systemAdmin, systemRole, systemSupplier, systemLog, systemMenus]);
    const container = createContainerFromDb(f.db); service = new SupplierProductCategoryService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.onError(errorHandler); app.route("/supplierapi", supplierapiRoutes);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.spyOn(cache, "getTokenBucket").mockResolvedValue(null); vi.spyOn(cache, "clearToken").mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("External I/O forbidden"); }));
    await f.reset();
    await f.db.insert(systemSupplier).values([{ id: 20, adminId: 29, supplierName: "current" }, { id: 30, adminId: 39, supplierName: "other" }]);
    await f.db.insert(systemRole).values([
      { id: 21, type: 4, relationId: 20, rules: "supplier.product.manage" },
      { id: 22, type: 4, relationId: 20, rules: "supplier.product.view" },
      { id: 23, type: 4, relationId: 20, rules: "supplier.finance.manage" },
      { id: 31, type: 4, relationId: 30, rules: "supplier.product.manage" },
    ]);
    await f.db.insert(systemAdmin).values([
      { id: 21, account: "category-manager", adminType: 4, relationId: 20, roles: "21", level: 1 },
      { id: 22, account: "category-reader", adminType: 4, relationId: 20, roles: "22", level: 1 },
      { id: 23, account: "category-unrelated", adminType: 4, relationId: 20, roles: "23", level: 1 },
      { id: 31, account: "category-other", adminType: 4, relationId: 30, roles: "31", level: 1 },
    ]);
    tokens = { manager: (await createToken(21, "supplier", md5(""), env.APP_KEY)).token,
      reader: (await createToken(22, "supplier", md5(""), env.APP_KEY)).token,
      unrelated: (await createToken(23, "supplier", md5(""), env.APP_KEY)).token,
      other: (await createToken(31, "supplier", md5(""), env.APP_KEY)).token };
    await f.db.insert(storeProductCategory).values([
      { id: 100, type: 2, relationId: 20, cateName: "父类A", sort: 20, addTime: 100, pic: "/images/a.png", bigPic: "https://images.example/a.png" },
      { id: 101, type: 2, relationId: 20, cateName: "子类A", pid: 100, path: "100", level: 1, sort: 10 },
      { id: 102, type: 2, relationId: 20, cateName: "孙类A", pid: 101, path: "100,101", level: 2 },
      { id: 110, type: 2, relationId: 20, cateName: "父类B", sort: 10 },
      { id: 120, type: 2, relationId: 20, cateName: "历史引用" },
      { id: 130, type: 2, relationId: 20, cateName: "停用父类", isShow: 0 },
      { id: 140, type: 2, relationId: 20, cateName: "可删空类" },
      { id: 200, type: 2, relationId: 30, cateName: "其他供应商" },
      { id: 300, type: 0, relationId: 0, cateName: "平台" },
      { id: 400, type: 1, relationId: 20, cateName: "门店" },
    ]);
    await f.db.insert(storeProduct).values([
      { id: 1, type: 2, relationId: 20, storeName: "现代引用", cateId: "102" },
      { id: 2, type: 2, relationId: 20, storeName: "仅旧CSV引用", cateId: "120" },
      { id: 3, type: 2, relationId: 30, storeName: "其他供应商商品", cateId: "140" },
      { id: 4, type: 2, relationId: 20, storeName: "回收站历史", cateId: "140", isDel: 1 },
      { id: 5, type: 2, relationId: 20, storeName: "移动类引用", cateId: "101" },
    ]);
    await f.db.insert(storeProductRelation).values([{ id: 1, type: 1, productId: 1, relationId: 102, relationPid: 101 },
      { id: 2, type: 1, productId: 5, relationId: 101, relationPid: 100 },
      { id: 3, type: 1, productId: 3, relationId: 140, relationPid: 0 }]);
    await f.exec("SELECT setval('store_product_category_id_seq',400,true)");
  }, 30_000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function request(path = base, role: Role | "anonymous" = "manager", method = "GET", data?: Record<string, unknown>) {
    const response = await app.request(path, { method, headers: {
      ...(role === "anonymous" ? {} : { Authorization: `Bearer ${tokens[role]}` }), "X-Supplier-Id": "30",
      ...(data ? { "Content-Type": "application/json" } : {}),
    }, ...(data ? { body: JSON.stringify(data) } : {}) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function stamp() { return (await request(`${base}/tree`)).body.data[0].revision as string; }
  const writes = () => f.db.select().from(systemLog).orderBy(systemLog.id);

  it("separates legacy lazy list/date DTO from the complete modern tree and bare detail", async () => {
    const legacy = await request(`${base}?type=0&relation_id=30&supplierId=30`, "reader");
    expect(legacy.body.data.count).toBe(5);
    expect(legacy.body.data.list.map((row: any) => row.id)).toEqual([100, 110, 140, 130, 120]);
    expect(legacy.body.data.list[0]).toMatchObject({ cate_name: "父类A", children: [], loading: false, _loading: false,
      type: 2, relation_id: 20, add_time: "1970-01-01 08:01:40", pic: "/images/a.png", big_pic: "https://images.example/a.png" });
    expect((await request(`${base}?pid=100&cate_name=子&is_show=1`)).body.data).toMatchObject({ count: 1, list: [{ id: 101, children: [] }] });
    const tree = (await request(`${base}/tree`, "reader")).body.data;
    expect(tree[0]).toMatchObject({ id: 100, add_time: 100, children: [{ id: 101, children: [{ id: 102 }] }] });
    expect(tree[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect(tree[0].children[0].revision).toBe(tree[0].revision);
    expect((await request(`${base}/101/detail`, "reader")).body.data).toMatchObject({ id: 101, pid: 100, add_time: 0, revision: tree[0].revision });
    expect((await request(base, "other")).body.data.list.map((row: any) => row.id)).toEqual([200]);
  });

  it("restores active flat tier options and the complete owned cascader shape", async () => {
    expect((await request(`${base}/tree/0`)).body.data.map((row: any) => row.id)).toEqual([100, 110, 140, 120]);
    expect((await request(`${base}/tree/1`)).body.data.map((row: any) => row.id)).toEqual([100, 101, 102, 110, 140, 120]);
    const cascade = (await request(`${base}/cascader_list/1`)).body.data;
    expect(cascade[0]).toEqual({ value: 100, label: "父类A", pid: 0, children: [
      { value: 101, label: "子类A", pid: 100, children: [{ value: 102, label: "孙类A", pid: 101 }] },
    ] });
    expect((await request(`${base}/cascader_list`)).body.data).toEqual(cascade);
  });

  it("restores create/edit dynamic forms with owner-correct parent choices and confirmations", async () => {
    const create = (await request(`${base}/create`)).body.data;
    expect(create).toMatchObject({ title: "添加分类", action: base, method: "POST", status: true });
    expect(create.rules.map((rule: any) => rule.field)).toEqual(["pid", "cate_name", "pic", "big_pic", "sort", "is_show"]);
    expect(JSON.stringify(create.rules[0].props.data)).not.toMatch(/其他供应商|平台|门店|孙类A/);
    const edit = (await request(`${base}/101`)).body.data;
    expect(edit).toMatchObject({ title: "编辑分类", action: `${base}/101`, method: "PUT" });
    expect(edit.rules[0].value).toEqual([100]);
    expect(JSON.stringify(edit.rules[0].props.data)).not.toMatch(/子类A|孙类A/);
    expect(edit.rules.find((rule: any) => rule.field === "expected_revision").value).toBe(await stamp());
  });

  it("runs complete create/edit/move/delete with both image fields, fixed owner and atomic audit", async () => {
    const created = await request(base, "manager", "POST", { pid: [0], cate_name: "新增类", pic: "/images/new.png",
      big_pic: "https://images.example/large.png", sort: 8, is_show: 1, type: 0, relation_id: 30 });
    expect(created.body.status).toBe(200); const id = created.body.data.id;
    expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id, id)))[0]).toMatchObject({ type: 2, relationId: 20, bigPic: "https://images.example/large.png" });
    const updated = await request(`${base}/${id}`, "manager", "PUT", { pid: [100], cate_name: "改名类", sort: 9, is_show: 1,
      expected_revision: created.body.data.revision });
    expect(updated.body.status).toBe(200);
    expect((await request(`${base}/${id}/detail`)).body.data).toMatchObject({ id, pid: 100, path: "100", level: 1, cate_name: "改名类", pic: "/images/new.png" });
    expect((await request(`${base}/${id}`, "manager", "DELETE", { expected_revision: updated.body.data.revision })).body.status).toBe(200);
    expect((await request(`${base}/${id}/detail`)).body.status).toBe(404);
    expect((await writes()).map(row => row.action)).toEqual([
      `category.create;supplier=20;category=${id}`, `category.update;supplier=20;category=${id}`, `category.delete;supplier=20;category=${id}`,
    ]);
    expect((await writes()).map(row => row.method)).toEqual(["POST", "PUT", "DELETE"]);
  });

  it("keeps legacy creates hidden when the request omits show state", async () => {
    const created = await request(base, "manager", "POST", { cate_name: "旧缺省状态", pid: 0 });
    expect(created.body.status).toBe(200); const id = created.body.data.id;
    expect((await f.db.select().from(storeProductCategory).where(eq(storeProductCategory.id, id)))[0]).toMatchObject({
      type: 2, relationId: 20, cateName: "旧缺省状态", isShow: 0,
    });
    expect((await request(`${base}/${id}/detail`)).body.data).toMatchObject({ id, is_show: 0 });
    expect((await request(`${base}/tree/1`)).body.data.map((row: any) => row.id)).not.toContain(id);
    expect((await request(`${base}/cascader_list/1`)).body.data.map((row: any) => row.value)).not.toContain(id);
    expect((await writes()).map(row => row.method)).toEqual(["POST"]);
  });

  it("keeps a hidden subtree hidden on a legacy name-only edit without show state", async () => {
    expect((await request(`${base}/set_show/100/0`, "manager", "PUT")).body.status).toBe(200);
    expect((await request(`${base}/100`, "manager", "PUT", { cate_name: "旧只改名称" })).body.status).toBe(200);
    expect((await f.db.select().from(storeProductCategory).where(inOwnSubtree())).map(row => row.isShow)).toEqual([0, 0, 0]);
    expect((await request(`${base}/100/detail`)).body.data).toMatchObject({ cate_name: "旧只改名称", is_show: 0 });
    const options = (await request(`${base}/tree/1`)).body.data.map((row: any) => row.id);
    for (const id of [100, 101, 102]) expect(options).not.toContain(id);
    expect((await request(`${base}/cascader_list/1`)).body.data.map((row: any) => row.value)).not.toContain(100);
    expect((await writes()).map(row => row.method)).toEqual(["PUT", "PUT"]);
  });

  it("moves the whole subtree and updates owned product relation parents in one transaction", async () => {
    const result = await request(`${base}/101`, "manager", "PUT", { pid: [110], cate_name: "子类A", sort: 10, is_show: 1, expected_revision: await stamp() });
    expect(result.body.status).toBe(200);
    expect((await request(`${base}/102/detail`)).body.data).toMatchObject({ path: "110,101", level: 2 });
    expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.id, 2)))[0].relationPid).toBe(110);
    expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.id, 3)))[0].relationPid).toBe(0);
  });

  it("rejects cycles, excess depth, other-owner parents and duplicate siblings without partial changes", async () => {
    const old = await f.db.select().from(storeProductCategory);
    for (const [id, pid, name] of [[100, 102, "父类A"], [100, 110, "父类A"], [101, 200, "子类A"], [110, 0, "父类A"]] as const) {
      expect((await request(`${base}/${id}`, "manager", "PUT", { pid, cate_name: name, sort: 0, is_show: 1 })).body.status).toBe(400);
    }
    expect(await f.db.select().from(storeProductCategory)).toEqual(old); expect(await writes()).toEqual([]);
  });

  it("recursively changes show state for explicit and full-edit workflows and rejects disabled parents", async () => {
    expect((await request(`${base}/set_show/100/0`, "manager", "PUT", { expected_revision: await stamp() })).body.data.updated).toBe(3);
    expect((await f.db.select().from(storeProductCategory).where(inOwnSubtree())).map(row => row.isShow)).toEqual([0, 0, 0]);
    expect((await request(`${base}/set_show/101/1`, "manager", "PUT")).body.status).toBe(400);
    expect((await request(`${base}/100`, "manager", "PUT", { pid: 0, cate_name: "父类A", sort: 20, is_show: 1, expected_revision: await stamp() })).body.status).toBe(200);
    expect((await f.db.select().from(storeProductCategory).where(inOwnSubtree())).map(row => row.isShow)).toEqual([1, 1, 1]);
    expect((await request(`${base}/set_show/100/0`, "manager", "PUT")).body.status).toBe(200); // Legacy no-body compatibility.
    expect((await writes()).map(row => row.method)).toEqual(["PUT", "PUT", "PUT"]);
  });

  it("rejects stale tree confirmations after a child is created or another category changes", async () => {
    const old = await stamp();
    expect((await request(base, "manager", "POST", { pid: 110, cate_name: "并发新增", is_show: 1 })).body.status).toBe(200);
    for (const [path, method, data] of [[`${base}/100`, "PUT", { cate_name: "父类A", pid: 0, is_show: 1 }],
      [`${base}/set_show/100/0`, "PUT", {}], [`${base}/140`, "DELETE", {}]] as const) {
      const result = await request(path, "manager", method, { ...data, expected_revision: old });
      expect(result.response.status).toBe(409); expect(result.body.data).toBeNull();
    }
    expect((await writes()).length).toBe(1);
  });

  it("protects children, active relation and legacy CSV references, then supports safe legacy deletion", async () => {
    for (const id of [100, 102, 120]) expect((await request(`${base}/${id}`, "manager", "DELETE")).body.status).toBe(400);
    expect((await request(`${base}/140`, "manager", "DELETE")).body.status).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 4)))[0].cateId).toBe("140");
    expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.id, 3)))[0].relationId).toBe(140);
  });

  it.each([200, 300, 400, 999999])("hides foreign or missing category %s identically for every operation", async id => {
    expect((await request(`${base}/${id}/detail`)).body.status).toBe(404);
    expect((await request(`${base}/${id}`)).body.status).toBe(404);
    expect((await request(`${base}/${id}`, "manager", "PUT", { cate_name: "编辑", pid: 0, is_show: 1 })).body.status).toBe(404);
    expect((await request(`${base}/${id}`, "manager", "DELETE")).body.status).toBe(404);
    expect((await request(`${base}/set_show/${id}/0`, "manager", "PUT")).body.status).toBe(404);
  });

  it("gates every mutation while allowing view-only modern/legacy selections and read-only form metadata", async () => {
    for (const path of [base, `${base}/tree`, `${base}/tree/1`, `${base}/cascader_list/1`, `${base}/101/detail`, `${base}/create`, `${base}/101`]) expect((await request(path, "reader")).body.status).toBe(200);
    for (const [path, method, data] of [[base, "POST", { cate_name: "无权" }], [`${base}/101`, "PUT", { cate_name: "无权" }],
      [`${base}/140`, "DELETE", undefined], [`${base}/set_show/100/0`, "PUT", undefined]] as const) {
      expect((await request(path, "reader", method, data)).body.status).toBe(400011);
    }
    expect(await writes()).toEqual([]);
    for (const role of ["anonymous", "unrelated"] as const) {
      const result = await request(`${base}/tree`, role); expect(result.body.status).toBe(role === "anonymous" ? 410000 : 400011);
      expect(result.response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("revalidates role and signed password claims inside writes and rejects expired claims", async () => {
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    expect((await request(base, "manager", "POST", { cate_name: "撤权" })).body.status).toBe(400011);
    await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 21));
    await f.db.update(systemAdmin).set({ pwd: "rotated" }).where(eq(systemAdmin.id, 21));
    const current = Math.floor(Date.now() / 1000);
    await expect(service.save(20, 0, { cate_name: "陈旧凭据" }, { id: 21, authVersion: md5(""), expiresAt: current + 100 })).rejects.toMatchObject({ code: 410001 });
    await expect(service.save(20, 0, { cate_name: "过期凭据" }, { id: 21, authVersion: md5("rotated"), expiresAt: current - 1 })).rejects.toMatchObject({ code: 410001 });
    expect(await writes()).toEqual([]);
  });

  it("keeps old menu-derived authority scoped to the current Supplier role", async () => {
    await f.db.insert(systemMenus).values({ id: 900, type: 4, authType: 2, access: 1, apiUrl: "/supplierapi/product/category", methods: "POST" });
    await f.db.update(systemRole).set({ rules: "900" }).where(eq(systemRole.id, 21));
    expect((await request(base, "manager", "POST", { cate_name: "菜单授权" })).body.status).toBe(200);
    await f.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 900));
    expect((await request(base, "manager", "POST", { cate_name: "菜单撤权" })).body.status).toBe(400011);
    expect((await writes()).length).toBe(1);
  });

  it("does not upgrade an old GET form menu into product write authority", async () => {
    await f.db.insert(systemMenus).values({ id: 901, type: 4, authType: 2, access: 1, apiUrl: "/supplierapi/product/category/create", methods: "GET" });
    await f.db.update(systemRole).set({ rules: "901" }).where(eq(systemRole.id, 21));
    expect((await request(`${base}/create`)).body.status).toBe(200);
    expect((await request(base, "manager", "POST", { cate_name: "不得升级" })).body.status).toBe(400011);
    expect(await writes()).toEqual([]);
  });

  it("rolls back category, descendant and relation writes when transactional audit fails", async () => {
    const old = await f.db.select().from(storeProductCategory);
    await f.exec("CREATE FUNCTION category_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit rollback'; END $$; CREATE TRIGGER category_fixture_audit_failure BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION category_fixture_audit_failure()");
    try {
      expect((await request(`${base}/101`, "manager", "PUT", { pid: 110, cate_name: "子类A", is_show: 1 })).body.status).toBe(500);
      expect(await f.db.select().from(storeProductCategory)).toEqual(old);
      expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.id, 2)))[0].relationPid).toBe(100);
      expect(await writes()).toEqual([]);
    } finally { await f.exec("DROP TRIGGER category_fixture_audit_failure ON system_log; DROP FUNCTION category_fixture_audit_failure()"); }
  });

  it("fails closed on malformed trees, duplicate queries, unsafe media and invalid confirmation values", async () => {
    expect((await request(`${base}?pid=0&pid=100`)).body.status).toBe(400);
    for (const data of [{ cate_name: "a".repeat(31) }, { cate_name: "分类", pic: "javascript:alert(1)" },
      { cate_name: "分类", big_pic: "/api/assets/123?signature=copied" }, { cate_name: "分类", expected_revision: "wrong" }]) {
      expect((await request(base, "manager", "POST", data)).body.status).toBe(400);
    }
    await f.db.update(storeProductCategory).set({ pid: 200, path: "200", level: 1 }).where(eq(storeProductCategory.id, 140));
    const broken = await request(`${base}/tree`); expect(broken.response.status).toBe(503);
    expect((await request(base, "manager", "POST", { cate_name: "不能跳过坏树" })).response.status).toBe(503);
    expect(await writes()).toEqual([]);
  });
});

function inOwnSubtree() { return and(eq(storeProductCategory.type, 2), eq(storeProductCategory.relationId, 20),
  inArray(storeProductCategory.id, [100, 101, 102])); }
