import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog } from "../scripts/data-migration/postgres-catalog-audit";

const manifest = JSON.parse(readFileSync("audit/orm-index-definition-reconciliation.json", "utf8"));
const prior = JSON.parse(readFileSync("audit/orm-query-index-reconciliation.json", "utf8"));
const baseline = JSON.parse(readFileSync("audit/orm-ddl-catalog-baseline.json", "utf8"));
type Entry = {
  key: string; reason: string; source: string; sourceLine: number; sourceSql: string;
  catalog: Catalog["indexes"][number]; previousCatalog: Catalog["indexes"][number];
  previousSnapshotIndex: { name: string; isUnique: boolean; method: string; columns: Array<{ expression: string; isExpression: boolean }> };
};
const entries: Entry[] = manifest.entries;
const keys = entries.map((entry) => entry.key);

describe("DB-009D2b2 complete same-name index reconciliation", () => {
  it("binds all 57 keys, both catalog definitions and original SQL to the immutable reviewed cohort", () => {
    const records = baseline.records.filter((record: { comparison: string; category: string; change: string }) =>
      record.comparison === "externalVsOrm" && record.category === "indexes" && record.change === "changed");
    expect(entries).toHaveLength(57);
    expect(keys).toEqual(records.map((record: { value: { key: string } }) => record.value.key));
    expect(new Set(keys).size).toBe(57);
    for (const [index, entry] of entries.entries()) {
      expect(entry.catalog).toEqual(records[index].value.reference);
      expect(entry.previousCatalog).toEqual(records[index].value.candidate);
      expect(records[index].value.fields).toEqual(["definition"]);
      const source = readFileSync(entry.source, "utf8").replace(/\r\n/g, "\n");
      expect(source.split(entry.sourceSql)).toHaveLength(2);
      expect(source.split("\n").slice(entry.sourceLine - 1).join("\n").startsWith(entry.sourceSql)).toBe(true);
      expect(entry.previousSnapshotIndex.name).toBe(entry.catalog.name);
      expect(entry.previousSnapshotIndex.isUnique).toBe(false);
      expect(entry.previousSnapshotIndex.method).toBe("btree");
      expect(entry.previousSnapshotIndex.columns.every((column) => !column.isExpression)).toBe(true);
      expect(entry.catalog).toMatchObject({ unique: false, primary: false, constraintOwned: false, valid: true, ready: true });
    }
  });

  it("keeps the 24 null-order, 30 missing-DESC and 3 missing-predicate cases explicit instead of waiving them", () => {
    const counts = { nullOrdering: 0, missingDescending: 0, missingPartialPredicate: 0 };
    for (const entry of entries) {
      const canonical = String(entry.catalog.definition), old = String(entry.previousCatalog.definition);
      expect(canonical).not.toBe(old);
      if (entry.reason === "nullOrdering") {
        expect(old.replaceAll(" DESC NULLS LAST", " DESC")).toBe(canonical);
        counts.nullOrdering++;
      } else if (entry.reason === "missingDescending") {
        expect(canonical.replaceAll(" DESC", "")).toBe(old);
        counts.missingDescending++;
      } else {
        expect(entry.reason).toBe("missingPartialPredicate");
        expect(canonical.replace(/ WHERE .*$/, "")).toBe(old);
        counts.missingPartialPredicate++;
      }
    }
    expect(counts).toEqual({ nullOrdering: 24, missingDescending: 30, missingPartialPredicate: 3 });
    expect(entries.filter((entry) => entry.reason === "missingPartialPredicate").map((entry) => entry.key)).toEqual([
      "kefu_visitor_session.kvs_active_expiry", "kefu_visitor_session.kvs_kefu_active", "store_order_cart_info.soci_old_cart_id",
    ]);
  });

  it("rejects reverting any of the 57 definitions and retains the 22 previously reconciled contracts", () => {
    const indexes = [...prior.entries.map((entry: Entry) => entry.catalog), ...entries.map((entry) => entry.catalog)];
    const allKeys = indexes.map((row) => row.key);
    expect(allKeys).toHaveLength(79);
    expect(new Set(allKeys).size).toBe(79);
    const catalog: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes };
    expect(() => assertIndexContracts(catalog, catalog, allKeys)).not.toThrow();
    for (const entry of entries) {
      const changed = { ...catalog, indexes: indexes.map((row) => row.key === entry.key ? entry.previousCatalog : row) };
      expect(() => assertIndexContracts(catalog, changed, allKeys)).toThrow(`Index contract drift: ${entry.key}`);
    }
    const runner = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(runner).toContain('"orm-query-index-reconciliation.json"');
    expect(runner).toContain('"orm-index-definition-reconciliation.json"');
    expect(runner).toContain("assertIndexContracts(catalogs.external, catalogs.embedded, requiredIndexKeys)");
    expect(runner).toContain("assertIndexContracts(catalogs.external, catalogs.orm, requiredIndexKeys)");
    expect(runner).toContain("assertIndexContracts(catalogs.external, catalogs.orm_upgrade, requiredIndexKeys)");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_upgrade)");
    expect(runner).toContain('format: "pg16"');
  });
});
