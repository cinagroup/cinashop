import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  storeProductCate,
  storeProductCategoryBrand,
  storeProductLabelAuxiliary,
} from "@/models/schema";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("superseded product auxiliary migration", () => {
  it("preserves all three source-shaped tables and stable migration keys", () => {
    expect(getTableName(storeProductCategoryBrand)).toBe("store_product_category_brand");
    expect(getTableName(storeProductCate)).toBe("store_product_cate");
    expect(getTableName(storeProductLabelAuxiliary)).toBe("store_product_label_auxiliary");
    expect(Object.keys(getTableColumns(storeProductCategoryBrand))).toEqual([
      "id", "productId", "cateId", "brandId", "brandName", "status", "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeProductCate))).toEqual([
      "id", "productId", "cateId", "addTime", "catePid", "status",
    ]);
    expect(Object.keys(getTableColumns(storeProductLabelAuxiliary))).toEqual([
      "id", "labelId", "productId",
    ]);
    for (const table of [
      "store_product_category_brand",
      "store_product_cate",
      "store_product_label_auxiliary",
    ]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external and embedded 0068 SQL equivalent without inventing constraints", () => {
    const migration = readFileSync("migrations/0068_superseded_product_relations.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0075\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"|CREATE UNIQUE INDEX/i);
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(migration).toContain('("label_id", "product_id")');
  });

  it("keeps store_product_relation authoritative and writes the PHP immediate-parent semantics", () => {
    const service = readFileSync(
      "src/services/supplier/SupplierProductManagementService.ts",
      "utf8",
    );
    expect(service).toContain("relationPid: category.pid");
    expect(service).toContain(".set({ relationPid: storeProductCategory.pid })");
    expect(service).toContain("inArray(storeProductCategory.id, affectedCategoryIds)");
    expect(service).not.toContain(
      'relationPid: Number(category.path.split(",").filter(Boolean)[0] ?? category.id)',
    );
    expect(service).not.toMatch(
      /\bstoreProductCategoryBrand\b|\bstoreProductCate\b|\bstoreProductLabelAuxiliary\b/,
    );
  });
});
