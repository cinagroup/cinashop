import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  it("projects product detail to the snake-case fields consumed by the Admin form", () => {
    const controller = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "controllers", "api", "v1", "AdminCrudController.ts"),
      "utf8",
    );
    const associations = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "services", "product", "ProductAssociationService.ts"),
      "utf8",
    );

    expect(controller).toContain("productAssociations(c).detail(id)");
    expect(associations).toContain("store_name: item.storeName");
    expect(associations).toContain("store_info: item.storeInfo");
    expect(associations).toContain("ot_price: item.otPrice");
    expect(associations).toContain("unit_name: item.unitName");
    expect(associations).toContain("is_vip: item.isVip");
    expect(associations).toContain("vip_price: item.vipPrice");
    expect(associations).toContain("cate_id: categoryIds");
    expect(associations).toContain("brand_id: brandIds");
    expect(associations).toContain("store_label_id: productLabelIds");
    expect(associations).toContain("ensure_id: ensureIds");
    expect(associations).toContain("specs_id: parameterTemplateId");
  });

  it("maps the Admin form payload through the bounded atomic association service", () => {
    const controller = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "controllers", "api", "v1", "AdminCrudController.ts"),
      "utf8",
    );
    const associations = readFileSync(
      join(repositoryRoot, "workers-ts", "src", "services", "product", "ProductAssociationService.ts"),
      "utf8",
    );

    expect(controller).toContain("await readBoundedJsonObject(c.req.raw, 64 * 1024)");
    expect(controller.match(/productAssociations\(c\)\.save\(/g)).toHaveLength(2);
    expect(associations).toContain('body.store_name ?? existing?.storeName');
    expect(associations).toContain('textValue(body.store_info, "商品简介", 256, existing?.storeInfo ?? "")');
    expect(associations).toContain('decimalValue(body.ot_price, "原价", existing?.otPrice ?? price)');
    expect(associations).toContain('textValue(body.unit_name, "单位", 32, existing?.unitName ?? "件")');
    expect(associations).toContain('integerValue(body.is_vip, "会员状态", existing?.isVip ?? 0, 0, 1)');
    expect(associations).toContain('decimalValue(body.vip_price, "会员价", existing?.vipPrice ?? "0")');
    expect(associations).toContain("associations_verified: associations !== null");
  });
});
