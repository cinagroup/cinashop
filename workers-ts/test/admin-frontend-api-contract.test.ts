import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  adminProductDetail,
  adminProductUpdate,
} from "@/controllers/api/v1/AdminCrudController";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "..", "..");

describe("Admin frontend API contract", () => {
  it("registers dashboard notification and aligns destructive action methods", () => {
    const backend = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "routes", "adminapi.ts"),
      "utf8",
    );
    const product = readFileSync(join(repositoryRoot, "view", "admin-ts", "src", "api", "product.ts"), "utf8");
    const refund = readFileSync(join(repositoryRoot, "view", "admin-ts", "src", "api", "refund.ts"), "utf8");

    expect(backend).toContain('adminapiRoutes.get("/new_push", adminAuth, AdminController.adminNewPush)');
    expect(backend).toContain('adminapiRoutes.delete("/product/del/:id"');
    expect(product).toContain("request.delete(`/product/del/${id}`)");
    expect(refund).toContain("request.post(`/refund/refund/${id}`)");
    expect(refund).not.toContain("request.post(`/refund/agree/${id}`)");
  });

  it("uses the transactional idempotent user balance contract and quarantines generic config", () => {
    const backend = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "routes", "adminapi.ts"),
      "utf8",
    );
    const users = readFileSync(join(repositoryRoot, "view", "admin-ts", "src", "api", "order.ts"), "utf8");
    const configApi = readFileSync(join(repositoryRoot, "view", "admin-ts", "src", "api", "config.ts"), "utf8");
    const configPage = readFileSync(join(repositoryRoot, "view", "admin-ts", "src", "pages", "ConfigList.vue"), "utf8");

    expect(backend).toContain('adminapiRoutes.post("/user/update_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther)');
    expect(backend).toContain('adminapiRoutes.post("/user/set_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther)');
    expect(users).toContain("request.post(`/user/update_other/${id}`");
    expect(users).toContain('"Idempotency-Key": crypto.randomUUID()');
    expect(users).not.toContain("request.post(`/user/money/${id}`");
    expect(configApi).not.toContain("request.");
    expect(configPage).toContain("通用键值编辑器已安全停用");
    expect(configPage).toContain('to="/config/newcomer"');
    expect(configPage).toContain('to="/config/runtime-content"');
  });

  it("uses the registered product create and edit routes instead of the 501 fallback", () => {
    const frontend = readFileSync(
      join(repositoryRoot, "view", "admin-ts", "src", "api", "product.ts"),
      "utf8",
    );
    const backend = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "routes", "adminapi.ts"),
      "utf8",
    );

    expect(frontend).toContain('request.post("/product/add", data)');
    expect(frontend).toContain("request.post(`/product/edit/${id}`, data)");
    expect(frontend).not.toContain('request.post("/product/create", data)');
    expect(frontend).not.toContain("request.post(`/product/update/${id}`, data)");
    expect(backend).toContain('adminapiRoutes.post("/product/add"');
    expect(backend).toContain('adminapiRoutes.post("/product/edit/:id"');
  });

  it("projects product detail to the snake-case fields consumed by the Admin form", async () => {
    const json = vi.fn((body: unknown) => body);
    const product = {
      id: 8,
      productType: 0,
      type: 0,
      relationId: 0,
      storeName: "测试商品",
      storeInfo: "简介",
      image: "/image.png",
      price: "12.30",
      otPrice: "15.00",
      stock: 9,
      sales: 2,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      cateId: "3",
      keyword: "测试",
      unitName: "件",
      sort: 6,
      isVip: 1,
      vipPrice: "10.00",
    };
    const context = {
      req: { param: () => "8" },
      get: () => ({ storeProductDao: { getById: vi.fn().mockResolvedValue(product) } }),
      json,
    } as never;

    await adminProductDetail(context);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      status: 200,
      data: expect.objectContaining({
        store_name: "测试商品",
        store_info: "简介",
        ot_price: "15.00",
        unit_name: "件",
        is_vip: 1,
        vip_price: "10.00",
      }),
    }));
  });

  it("maps the Admin form snake-case edit payload to database model fields", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const context = {
      req: {
        param: () => "8",
        json: vi.fn().mockResolvedValue({
          store_name: "已更新",
          store_info: "新简介",
          ot_price: 15,
          cate_id: "4",
          is_show: 0,
          unit_name: "盒",
          is_vip: 1,
          vip_price: 10,
        }),
      },
      get: () => ({
        storeProductDao: {
          getById: vi.fn().mockResolvedValue({ id: 8 }),
          update,
        },
      }),
      json: vi.fn((body: unknown) => body),
    } as never;

    await adminProductUpdate(context);
    expect(update).toHaveBeenCalledWith(8, {
      storeName: "已更新",
      storeInfo: "新简介",
      otPrice: 15,
      cateId: "4",
      isShow: 0,
      unitName: "盒",
      isVip: 1,
      vipPrice: 10,
    });
  });
});
