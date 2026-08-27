import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeBranchProduct,
  storeBranchProductAttrValue,
  storeConfig,
  storeExtract,
} from "../src/models/schema";
import {
  buildSupplierConfigView,
  normalizeSupplierConfigUpdates,
  requestedConfigGroup,
} from "../src/services/store/StoreScopedConfigService";

describe("store legacy auxiliary migration", () => {
  it("preserves all four source tables and deterministic keys", () => {
    expect(getTableName(storeConfig)).toBe("store_config");
    expect(getTableName(storeBranchProduct)).toBe("store_branch_product");
    expect(getTableName(storeBranchProductAttrValue)).toBe("store_branch_product_attr_value");
    expect(getTableName(storeExtract)).toBe("store_extract");
    expect(Object.keys(getTableColumns(storeConfig))).toEqual([
      "id", "type", "relationId", "keyName", "value", "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeBranchProduct))).toEqual([
      "id", "productId", "image", "storeName", "storeInfo", "keyword", "barCode",
      "cateId", "storeId", "sales", "stock", "sort", "labelId", "isShow", "addTime",
      "isDel",
    ]);
    expect(Object.keys(getTableColumns(storeBranchProductAttrValue))).toEqual([
      "id", "productId", "storeId", "attrUnique", "sales", "stock", "type", "barCode",
      "code",
    ]);
    expect(Object.keys(getTableColumns(storeExtract))).toHaveLength(21);
    for (const table of [
      "store_config",
      "store_branch_product",
      "store_branch_product_attr_value",
      "store_extract",
    ]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("keeps historical tables unconstrained and both migration paths equivalent", () => {
    const migration = readFileSync("migrations/0064_store_legacy_auxiliary.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0071\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX|FOREIGN KEY|REFERENCES/i);
    expect(migration).toContain('"unique" CHAR(8) DEFAULT \'\' NOT NULL');
    expect(migration).toContain('"extract_price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL');
  });

  it("accepts only allowlisted, bounded supplier configuration values", () => {
    expect(normalizeSupplierConfigUpdates({
      type: "store_electronic_sheet",
      values: {
        store_config_export_open: true,
        store_config_export_to_name: "  Cina Shop  ",
      },
    }, "store_electronic_sheet")).toEqual([
      { keyName: "store_config_export_open", value: 1, preserveBlankSecret: false },
      { keyName: "store_config_export_to_name", value: "Cina Shop", preserveBlankSecret: false },
    ]);
    expect(requestedConfigGroup({ group: "store_printing_deploy" }))
      .toBe("store_printing_deploy");
    expect(() => normalizeSupplierConfigUpdates({ arbitrary: "value" }))
      .toThrow("不支持的配置项");
    expect(() => normalizeSupplierConfigUpdates({
      store_config_export_to_address: "x".repeat(256),
    })).toThrow("不能超过255个字符");
  });

  it("never returns stored secret values and preserves blank secret submissions", () => {
    const view = buildSupplierConfigView("store_printing_deploy", [
      { id: 1, keyName: "store_printing_api_key", value: '"top-secret"' },
      { id: 2, keyName: "store_pay_success_printing_switch", value: "true" },
    ]);
    const fields = view.groups.flatMap((group) => group.fields);
    expect(fields.find((field) => field.key === "store_printing_api_key")).toMatchObject({
      value: "",
      configured: true,
      input_type: "password",
    });
    expect(fields.find((field) => field.key === "store_pay_success_printing_switch")?.value).toBe(1);
    expect(normalizeSupplierConfigUpdates({ store_fey_ukey: "" })).toEqual([
      { keyName: "store_fey_ukey", value: "", preserveBlankSecret: true },
    ]);
  });

  it("fails explicitly on ambiguous history and mounts authenticated supplier routes", () => {
    expect(() => buildSupplierConfigView("store_electronic_sheet", [
      { id: 1, keyName: "store_config_export_open", value: "1" },
      { id: 2, keyName: "store_config_export_open", value: "0" },
    ])).toThrow("存在重复历史记录");
    const service = readFileSync("src/services/store/StoreScopedConfigService.ts", "utf8");
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(service).toContain("SUPPLIER_CONFIG_SCOPE_TYPE = 2");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("preserveBlankSecret");
    expect(routes).toContain('"/config/edit_new_build/:type"');
    expect(routes).toContain('"/config/store/:type"');
    expect(routes).toContain('post("/config"');
  });
});
