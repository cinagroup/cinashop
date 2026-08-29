import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("src/routes/v1/index.ts", "utf8");
const controller = readFileSync("src/controllers/api/v1/NewcomerController.ts", "utf8");
const service = readFileSync("src/services/activity/StoreNewcomerService.ts", "utf8");

describe("API006 newcomer storefront compatibility", () => {
  it("registers the four PHP marketing paths with their original auth boundaries", () => {
    for (const path of [
      "/marketing/newcomer/product_list",
      "/marketing/newcomer/product_detail/:id",
    ]) {
      expect(routes).toMatch(new RegExp(
        `"${path.replace("/:id", "/:id")}",[\\s\\S]{0,80}authMiddleware\\(\\{ force: false \\}\\)`,
      ));
    }
    for (const path of [
      "/marketing/newcomer/info",
      "/marketing/newcomer/gift",
    ]) {
      expect(routes).toContain(
        `v1Routes.get("${path}", authMiddleware({ force: true }), NewcomerController.`,
      );
    }
  });

  it("keeps user-specific storefront responses private", () => {
    expect(controller.match(/c\.header\("Cache-Control", "private, no-store"\)/g)).toHaveLength(4);
  });

  it("restores PHP list ordering, visibility, and base-product strike prices", () => {
    expect(service).toContain("eq(storeProduct.isVerify, 1)");
    expect(service).toContain(".orderBy(desc(storeNewcomer.id))");
    expect(service).toContain("ot_price: String(product.otPrice)");
  });

  it("keys activity SKUs by suk and returns selectable legacy attributes", () => {
    expect(service).toContain("return [sku.suk, {");
    expect(service).not.toContain("return [sku.unique, {");
    expect(service).toContain("const productAttr = legacy.productAttr.map");
    expect(service).toContain("product_stock: baseStock");
    expect(service).toContain("product_price: String(baseSku?.price");
    expect(service).toContain("productAttr,");
  });

  it("keeps gift and info response differences from the PHP controller", () => {
    expect(service).toContain("if (!giftOnly) {");
    expect(service).toContain("response.last_time = limitEnabled");
    expect(service).toContain("response.newcomer_agreement = await new DatabaseCacheService");
  });

  it("counts only legacy top-level paid or visible unpaid activity orders", () => {
    expect(service).toContain("inArray(storeOrder.pid, [0, -1])");
    expect(service).toContain("and(eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0))");
  });
});
