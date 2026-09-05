import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog, type CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";

const manifest = JSON.parse(readFileSync("audit/orm-query-index-reconciliation.json", "utf8")) as {
  entries: Array<{ key: string; source: string; sourceLine: number; sourceSql: string; catalog: CatalogRow }>;
};
const catalog: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes: manifest.entries.map((entry) => entry.catalog) };
const keys = manifest.entries.map((entry) => entry.key);
// Fixed reviewed cohort: editing only the manifest must not shrink this gate.
const expectedKeys = [
  "category.category_kefu_speechcraft",
  "store_bargain.store_bargain_system_form_active",
  "store_combination.store_combination_system_form_active",
  "store_delivery_order.sdo_dada_reconcile_scan",
  "store_integral.store_integral_system_form_active",
  "store_order.so_kefu_customer_orders",
  "store_order_cart_info.soci_kefu_order_product",
  "store_order_refund.sor_kefu_customer_refunds",
  "store_product.sp_supplier_list",
  "store_product.store_product_system_form_active",
  "store_product_attr_value.spav_product_type_suk",
  "store_product_category.spc_supplier_tree",
  "store_product_relation.spr_kefu_category_product",
  "store_product_relation.spr_kefu_product_category",
  "store_product_relation.spr_product_type_relation",
  "store_product_reply.spr_product_id",
  "store_product_reply.spr_unique",
  "store_product_reply_comment.sprc_reply_id",
  "store_seckill.store_seckill_system_form_active",
  "store_visit.sv_kefu_recent",
  "system_supplier.supplier_admin_id_uq",
  "work_callback_event.wce_payload_redaction_ready",
];

describe("DB-009D2b1 exact ORM query-index contracts", () => {
  it("binds all 22 reviewed definitions to real source statements and the immutable PG16 evidence", () => {
    const baseline = JSON.parse(readFileSync("audit/orm-ddl-catalog-baseline.json", "utf8"));
    expect(keys).toHaveLength(22);
    expect(keys).toEqual(expectedKeys);
    expect(new Set(keys).size).toBe(22);
    expect(manifest.entries.filter((entry) => entry.catalog.unique).map((entry) => entry.key)).toEqual(["system_supplier.supplier_admin_id_uq"]);
    expect(manifest.entries.filter((entry) => entry.catalog.definition!.toString().includes(" WHERE "))).toHaveLength(8);
    for (const entry of manifest.entries) {
      const source = readFileSync(entry.source, "utf8").replace(/\r\n/g, "\n");
      expect(source.split("\n").slice(entry.sourceLine - 1).join("\n")).toMatch(new RegExp("^" + entry.sourceSql.replace(/\r\n/g, "\n").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const record = baseline.records.find((item: { comparison: string; category: string; change: string; value: CatalogRow }) =>
        item.comparison === "externalVsOrm" && item.category === "indexes" && item.change === "referenceOnly" && item.value.key === entry.key);
      expect(record?.value).toEqual(entry.catalog);
    }
    const runner = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(runner).toContain("assertIndexContracts(catalogs.external, catalogs.embedded, requiredIndexKeys)");
    expect(runner).toContain("assertIndexContracts(catalogs.external, catalogs.orm, requiredIndexKeys)");
  });

  it("rejects missing, duplicate and empty contracts instead of turning inventory mode into an implicit waiver", () => {
    expect(() => assertIndexContracts(catalog, catalog, keys)).not.toThrow();
    expect(() => assertIndexContracts(catalog, catalog, [])).toThrow("Invalid or duplicate");
    expect(() => assertIndexContracts(catalog, catalog, [keys[0], keys[0]])).toThrow("Invalid or duplicate");
    expect(() => assertIndexContracts({ ...catalog, indexes: catalog.indexes.slice(1) }, catalog, keys)).toThrow("Required reference index missing");
    expect(() => assertIndexContracts(catalog, { ...catalog, indexes: catalog.indexes.slice(1) }, keys)).toThrow("Required candidate index missing");
    expect(() => assertIndexContracts(catalog, { ...catalog, indexes: [...catalog.indexes, catalog.indexes[0]] }, keys)).toThrow("Duplicate indexes");
  });

  it("rejects changed predicates, ordering, uniqueness and ownership even if index names are unchanged", () => {
    for (const patch of [{ definition: "different predicate/order/include" }, { unique: true }, { constraintOwned: true }, { valid: false }, { name: "different-name" }]) {
      const changed = { ...catalog, indexes: [{ ...catalog.indexes[0], ...patch }, ...catalog.indexes.slice(1)] };
      expect(() => assertIndexContracts(catalog, changed, keys)).toThrow("Index contract drift");
    }
    // Unrelated catalog differences are deliberately still reported elsewhere.
    expect(() => assertIndexContracts(catalog, { ...catalog, columns: [{ key: "unreviewed.extra", name: "extra" }] }, keys)).not.toThrow();
  });
});
