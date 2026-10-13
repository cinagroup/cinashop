import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVariables, Env } from "../src/env";
import { createContainerFromDb } from "../src/lib/di";
import { errorHandler } from "../src/middleware/error";
import { legacyCategory, storeBrand, storeProductLabel, systemAdmin, systemRole, systemSupplier } from "../src/models/schema";
import { supplierapiRoutes } from "../src/routes/supplierapi";
import { SupplierProductCatalogService } from "../src/services/supplier/SupplierProductCatalogService";
import { createToken, md5 } from "../src/utils/jwt";
import * as cache from "../src/utils/cache";
import { financePostgres } from "./helpers/financePostgres";

const labelPath = "/supplierapi/product/product_label";
const brandPath = "/supplierapi/product/brand/cascader_list";
type SupplierApp = { Bindings: Env; Variables: AppVariables };
type Node = { value: number; label: string; children?: Node[] };

describe("Supplier product selection catalogs on real SQL and registered authenticated routes", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: Hono<SupplierApp>;
  let service: SupplierProductCatalogService;
  let tokens: Record<"reader" | "other" | "unrelated", string>;
  const env = { APP_KEY: "isolated-supplier-catalog-test", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "" } as Env;

  beforeAll(async () => {
    fixture = await financePostgres([legacyCategory, storeProductLabel, storeBrand, systemAdmin, systemRole, systemSupplier]);
    const container = createContainerFromDb(fixture.db);
    service = new SupplierProductCatalogService(container);
    app = new Hono<SupplierApp>();
    app.use("*", async (c, next) => { c.set("container", container); await next(); });
    app.onError(errorHandler);
    app.route("/supplierapi", supplierapiRoutes);
  }, 60_000);

  afterAll(async () => { await fixture?.close(); }, 30_000);

  beforeEach(async () => {
    // Redis token persistence is the only substituted boundary. JWT, account,
    // Supplier identity, role resolution, controllers and SQL are real.
    vi.spyOn(cache, "getTokenBucket").mockResolvedValue(null);
    vi.spyOn(cache, "clearToken").mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External I/O forbidden"); }));
    await fixture.exec("DELETE FROM store_product_label; DELETE FROM category; DELETE FROM store_brand; DELETE FROM system_admin; DELETE FROM system_role; DELETE FROM system_supplier");
    await fixture.db.insert(systemSupplier).values([
      { id: 20, adminId: 29, supplierName: "current" },
      { id: 30, adminId: 39, supplierName: "other" },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 21, type: 4, relationId: 20, rules: "supplier.product.view" },
      { id: 31, type: 4, relationId: 30, rules: "supplier.product.view" },
      { id: 22, type: 4, relationId: 20, rules: "supplier.finance.view" },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 21, account: "catalog-current", adminType: 4, relationId: 20, roles: "21", level: 1 },
      { id: 31, account: "catalog-other", adminType: 4, relationId: 30, roles: "31", level: 1 },
      { id: 22, account: "catalog-unrelated", adminType: 4, relationId: 20, roles: "22", level: 1 },
    ]);
    tokens = {
      reader: (await createToken(21, "supplier", md5(""), env.APP_KEY)).token,
      other: (await createToken(31, "supplier", md5(""), env.APP_KEY)).token,
      unrelated: (await createToken(22, "supplier", md5(""), env.APP_KEY)).token,
    };
    await fixture.db.insert(legacyCategory).values([
      { id: 10, type: 0, relationId: 0, group: 2, name: "平台标签", sort: 20 },
      { id: 20, type: 2, relationId: 20, group: 2, name: "当前标签", sort: 10 },
      { id: 30, type: 2, relationId: 30, group: 2, name: "其他标签" },
      { id: 40, type: 2, relationId: 20, group: 3, name: "参数模版" },
      { id: 50, type: 2, relationId: 20, group: 2, isShow: 0, name: "停用标签组" },
      { id: 60, type: 0, relationId: 20, group: 2, name: "错误平台关系" },
      { id: 70, type: 1, relationId: 20, group: 2, name: "其他类型" },
      { id: 80, type: 2, relationId: 20, group: 2, name: "空标签组" },
      { id: 90, type: 0, relationId: 0, ownerId: 7, group: 2, name: "私有owner组" },
    ]);
    await fixture.db.insert(storeProductLabel).values([
      { id: 110, labelCate: 10, labelName: "平台可选", color: "#123456", addTime: 100 },
      { id: 120, type: 2, relationId: 20, labelCate: 20, labelName: "当前可选", sort: 10 },
      { id: 121, type: 2, relationId: 20, labelCate: 20, labelName: "当前第二" },
      { id: 222, type: 2, relationId: 20, labelCate: 10, labelName: "旧表单创建的当前标签", sort: -1 },
      { id: 223, type: 2, relationId: 20, labelCate: 90, labelName: "私有owner组标签" },
      { id: 130, type: 2, relationId: 30, labelCate: 30, labelName: "其他私有" },
      { id: 201, type: 2, relationId: 30, labelCate: 10, labelName: "他人挂平台" },
      { id: 202, type: 0, relationId: 0, labelCate: 20, labelName: "平台挂当前" },
      { id: 203, type: 2, relationId: 20, labelCate: 30, labelName: "当前挂他人" },
      { id: 204, type: 2, relationId: 20, labelCate: 20, labelName: "停用", status: 0 },
      { id: 205, type: 2, relationId: 20, labelCate: 20, labelName: "隐藏", isShow: 0 },
      { id: 206, type: 2, relationId: 20, labelCate: 999, labelName: "孤儿" },
      { id: 207, type: 2, relationId: 20, labelCate: 40, labelName: "错误组" },
      { id: 208, type: 2, relationId: 20, labelCate: 50, labelName: "挂停用组" },
    ]);
    await fixture.db.insert(storeBrand).values([
      { id: 1, brandName: "平台根", sort: 20 },
      { id: 2, brandName: "平台子", pid: 1 },
      { id: 3, brandName: "平台孙", pid: 2 },
      { id: 4, brandName: "隐藏父", isShow: 0 },
      { id: 5, brandName: "隐藏父之子", pid: 4 },
      { id: 6, brandName: "门店父", storeId: 20 },
      { id: 7, brandName: "跨归属之子", pid: 6 },
      { id: 8, brandName: "门店之子", pid: 1, storeId: 30 },
      { id: 9, brandName: "删除父", isDel: 1 },
      { id: 10, brandName: "删除父之子", pid: 9 },
      { id: 11, brandName: "孤儿", pid: 999 },
      { id: 12, brandName: "环一", pid: 13 },
      { id: 13, brandName: "环二", pid: 12 },
      { id: 14, brandName: "平台独立根" },
    ]);
  }, 30_000);

  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function request(path: string, identity: keyof typeof tokens | "anonymous" = "reader") {
    const response = await app.request(path, { headers: {
      ...(identity === "anonymous" ? {} : { Authorization: `Bearer ${tokens[identity]}` }),
      "X-Supplier-Id": "30",
    } }, env);
    const body = await response.json<{ status: number; msg: string; data: any }>();
    return { response, body };
  }

  it("preserves legacy Supplier labels in platform groups while isolating label and category ownership", async () => {
    const { body } = await request(`${labelPath}?type=0&relation_id=30&supplierId=30`);
    expect(body.status).toBe(200);
    expect(body.data.map((row: Node) => row.value)).toEqual([10, 20, 80]);
    expect(body.data[0]).toMatchObject({ id: 10, value: 10, label: "平台标签", label_cate: 0, label_name: "平台标签", type: 0, relation_id: 0 });
    expect(body.data[0].children.map((row: Node) => row.value)).toEqual([110, 222]);
    expect(body.data[0].children[0]).toEqual({
      id: 110, value: 110, label: "平台可选", type: 0, relation_id: 0,
      label_cate: 10, label_name: "平台可选", style_type: 1, color: "#123456", bg_color: "",
      border_color: "", icon: "", is_show: 1, status: 1, sort: 0, add_time: "1970-01-01 08:01:40",
    });
    expect(body.data[1].children.map((row: Node) => row.value)).toEqual([120, 121]);
    expect(body.data[1].children[0].add_time).toBe("1970-01-01 08:00:00");
    expect(body.data[2].children).toEqual([]);
    expect(JSON.stringify(body.data)).not.toContain("私有owner组");
  });

  it("derives the other Supplier from its signed account and returns only its labels plus platform", async () => {
    const { body } = await request(labelPath, "other");
    expect(body.data.map((row: Node) => row.value)).toEqual([10, 30]);
    expect(body.data[1].children.map((row: Node) => row.value)).toEqual([130]);
    expect(body.data[0].children.map((row: Node) => row.value)).toEqual([201, 110]);
    expect(JSON.stringify(body.data)).not.toContain("旧表单创建的当前标签");
    expect(JSON.stringify(body.data)).not.toContain("当前可选");
  });

  it("preserves PHP id DESC ties for categories, labels and brands", async () => {
    await fixture.db.insert(legacyCategory).values({ id: 81, type: 2, relationId: 20, group: 2, name: "同序空组" });
    await fixture.db.insert(storeProductLabel).values({ id: 122, type: 2, relationId: 20, labelCate: 20, labelName: "同序标签" });
    await fixture.db.insert(storeBrand).values({ id: 15, brandName: "同序根品牌" });
    const labels = await request(labelPath);
    expect(labels.body.data.map((row: Node) => row.value)).toEqual([10, 20, 81, 80]);
    expect(labels.body.data[1].children.map((row: Node) => row.value)).toEqual([120, 122, 121]);
    expect((await request(`${brandPath}/2`)).body.data.map((row: Node) => row.value)).toEqual([1, 15, 14]);
  });

  it("formats historical label dates in the PHP timezone including Chinese summer time", async () => {
    await fixture.db.update(storeProductLabel).set({ addTime: Date.UTC(1990, 6, 1) / 1000 })
      .where(eq(storeProductLabel.id, 120));
    expect((await request(labelPath)).body.data[1].children[0].add_time).toBe("1990-07-01 09:00:00");
  });

  it("allows product managers to read every catalog with private cache headers", async () => {
    await fixture.db.update(systemRole).set({ rules: "supplier.product.manage" }).where(eq(systemRole.id, 21));
    for (const path of [labelPath, brandPath, `${brandPath}/2`]) {
      const result = await request(path);
      expect(result.body.status).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(result.response.headers.get("pragma")).toBe("no-cache");
    }
  });

  it("rejects disabled Supplier or admin identities even with a still-valid JWT", async () => {
    await fixture.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 20));
    expect((await request(labelPath)).body.status).toBe(410002);
    await fixture.db.update(systemSupplier).set({ isShow: 1 }).where(eq(systemSupplier.id, 20));
    await fixture.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, 21));
    expect((await request(`${brandPath}/2`)).body.status).toBe(410002);
  });

  it("restores default/type=1 root choice and exactly two brand levels", async () => {
    const expected = [{ value: 0, label: "顶级品牌" },
      { value: 1, label: "平台根", pid: 0, children: [{ value: 2, label: "平台子", pid: 1 }] },
      { value: 14, label: "平台独立根", pid: 0 }];
    expect((await request(brandPath)).body.data).toEqual(expected);
    expect((await request(`${brandPath}/1`)).body.data).toEqual(expected);
  });

  it("restores type=2 full platform tree while excluding stores, invalid parents, orphans and cycles", async () => {
    const expected = [{ value: 1, label: "平台根", pid: 0, children: [
      { value: 2, label: "平台子", pid: 1, children: [{ value: 3, label: "平台孙", pid: 2 }] },
    ] }, { value: 14, label: "平台独立根", pid: 0 }];
    expect((await request(`${brandPath}/2?store_id=20`)).body.data).toEqual(expected);
    expect((await request(`${brandPath}/2`, "other")).body.data).toEqual(expected);
  });

  it.each([labelPath, brandPath, `${brandPath}/2`])("denies anonymous/unrelated roles with private cache policy on %s", async (path) => {
    for (const [identity, status] of [["anonymous", 410000], ["unrelated", 400011]] as const) {
      const result = await request(path, identity);
      expect(result.body.status).toBe(status);
      expect(result.response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("revalidates permission revocation and account tenant reassignment without renewing the JWT", async () => {
    expect((await request(labelPath)).body.status).toBe(200);
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    expect((await request(labelPath)).body.status).toBe(400011);
    await fixture.db.update(systemAdmin).set({ relationId: 30, roles: "31" }).where(eq(systemAdmin.id, 21));
    expect((await request(labelPath)).body.data.map((row: Node) => row.value)).toEqual([10, 30]);
  });

  it.each(["0", "3", "-1", "1.5", "1e0", "abc"])("rejects unsupported brand type %s", async (type) => {
    expect((await request(`${brandPath}/${type}`)).body.status).toBe(400);
  });

  it("fails explicitly instead of returning a truncated label directory", async () => {
    await fixture.exec("INSERT INTO store_product_label(id,type,relation_id,label_cate,label_name) SELECT 10000+n,2,20,20,'bounded-'||n FROM generate_series(1,5000) n");
    const result = await request(labelPath);
    expect(result.response.status).toBe(503);
    expect(result.body).toMatchObject({ status: 503, data: null, msg: "商品标签过多，请联系管理员整理" });
  });

  it("fails explicitly instead of truncating category or brand collections", async () => {
    await fixture.exec("INSERT INTO category(id,type,relation_id,\"group\",name) SELECT 10000+n,2,20,2,'category-'||n FROM generate_series(1,1000) n");
    expect((await request(labelPath)).response.status).toBe(503);
    await fixture.exec("INSERT INTO store_brand(id,brand_name) SELECT 10000+n,'brand-'||n FROM generate_series(1,1000) n");
    expect((await request(`${brandPath}/2`)).response.status).toBe(503);
  });

  it("bounds full brand depth and keeps the legacy two-level selection usable", async () => {
    await fixture.exec("INSERT INTO store_brand(id,brand_name,pid) SELECT 100+n,'deep-'||n,CASE WHEN n=1 THEN 0 ELSE 99+n END FROM generate_series(1,17) n");
    const result = await request(`${brandPath}/2`);
    expect(result.response.status).toBe(503);
    expect(result.body.msg).toContain("层级过深");
    expect((await request(brandPath)).body.status).toBe(200);
  });

  it("bounds response bytes and rejects direct calls with invalid supplier identities", async () => {
    await fixture.exec("INSERT INTO store_product_label(id,type,relation_id,label_cate,label_name,icon) SELECT 10000+n,2,20,20,repeat('界',255),repeat('图',255) FROM generate_series(1,1500) n");
    const result = await request(labelPath);
    expect(result.response.status).toBe(503);
    expect(result.body.msg).toContain("目录过大");
    await expect(service.labels(0)).rejects.toThrow("供应商ID错误");
    await expect(service.brands(2_147_483_648, 2)).rejects.toThrow("供应商ID错误");
  });

  it("returns deterministic empty catalogs without changing any rows", async () => {
    await fixture.db.delete(storeProductLabel);
    await fixture.db.delete(legacyCategory);
    await fixture.db.delete(storeBrand);
    expect((await request(labelPath)).body.data).toEqual([]);
    expect((await request(brandPath)).body.data).toEqual([{ value: 0, label: "顶级品牌" }]);
    expect((await request(`${brandPath}/2`)).body.data).toEqual([]);
    expect(await fixture.db.select().from(storeBrand)).toEqual([]);
    expect(await fixture.db.select().from(storeProductLabel)).toEqual([]);
  });
});
