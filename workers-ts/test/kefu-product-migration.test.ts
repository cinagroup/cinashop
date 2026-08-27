import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseKefuProductId,
  parseKefuProductPage,
} from "../src/services/kefu/KefuProductService";

describe("customer-service product context migration", () => {
  it("keeps bounded page and positive product identifiers", () => {
    expect(parseKefuProductPage(undefined)).toBe(1);
    expect(parseKefuProductPage("25")).toBe(25);
    expect(() => parseKefuProductPage("0")).toThrow("页码错误");
    expect(() => parseKefuProductPage("1000001")).toThrow("页码错误");
    expect(parseKefuProductId("17")).toBe(17);
    expect(() => parseKefuProductId("-1")).toThrow("商品ID错误");
  });

  it("keeps the external and Worker-embedded index definitions byte-equivalent", () => {
    const migration = readFileSync("migrations/0095_kefu_product_context_indexes.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0102\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    for (const index of [
      "soci_kefu_order_product",
      "sv_kefu_recent",
      "spr_kefu_product_category",
      "spr_kefu_category_product",
    ]) {
      expect(migration).toContain(`"${index}"`);
    }
  });

  it("scopes every customer-derived query by the current owned conversation", () => {
    const core = readFileSync("src/services/kefu/KefuCoreService.ts", "utf8");
    const products = readFileSync("src/services/kefu/KefuProductService.ts", "utf8");
    expect(core).toContain("export async function assertKefuConversation");
    expect(products).toContain("await assertKefuConversation(this.container, kefuUid, uid, 0)");
    expect(products).toContain("innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))");
    expect(products).toContain("innerJoin(storeVisit, eq(storeVisit.productId, storeProduct.id))");
    expect(products).toContain("eq(storeProductRelation.type, CATEGORY_RELATION_TYPE)");
    expect(products).toContain("eq(storeProductDescription.type, 0)");
  });
});
