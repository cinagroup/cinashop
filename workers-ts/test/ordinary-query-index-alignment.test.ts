import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog, type CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { assertRetiredIndexesAbsent, extendOrdinaryIndexContracts } from "../scripts/data-migration/ordinary-index-contracts";
import { WORKER_QUERY_INDEX_ALIGNMENT_SQL } from "../src/migrations/workerQueryIndexAlignment";

type Entry = { key: string; decision: string; catalog: CatalogRow; columns: string[]; replacementCatalog?: CatalogRow;
  queryEvidence: { source: string; sourceLine: number; sourceSql: string; purpose: string };
  previousSnapshotIndex?: { name: string; isUnique: boolean; method: string; columns: Array<{ expression: string; asc: boolean; nulls: string }> } };
const read = (name: string) => JSON.parse(readFileSync(`audit/${name}`, "utf8")) as { entries: Entry[] };
const manifest = read("orm-ordinary-index-reconciliation.json");
const historical = read("orm-extra-index-reconciliation.json");
const restored = manifest.entries.filter((entry) => entry.decision === "restore-worker-query-index");
const retired = manifest.entries.filter((entry) => entry.decision === "remove-redundant-orm-declaration");
const prior = [...read("orm-query-index-reconciliation.json").entries, ...read("orm-index-definition-reconciliation.json").entries,
  ...historical.entries.filter((entry) => entry.decision === "restore-missing-legacy-query-index")];
const baseKeys = prior.map((entry) => entry.key);

describe("DB-009D2b3b complete ordinary index disposition", () => {
  it("binds all remaining 22 objects and ordered columns to immutable history and real query source lines", () => {
    const expected = historical.entries.filter((entry) => entry.decision === "review-orm-only");
    expect(manifest.entries).toHaveLength(22);
    expect(manifest.entries.map((entry) => entry.key)).toEqual(expected.map((entry) => entry.key));
    expect(restored).toHaveLength(20);
    expect(retired.map((entry) => entry.key)).toEqual(["store_order.so_order_id", "system_supplier.supplier_admin_id"]);
    for (const [index, entry] of manifest.entries.entries()) {
      expect(entry.catalog).toEqual(expected[index].catalog);
      expect(entry.columns).toEqual(expected[index].columns);
      const query = entry.queryEvidence;
      expect(query.purpose).toBeTruthy();
      const source = readFileSync(query.source, "utf8").replace(/\r\n/g, "\n");
      expect(source.split("\n").slice(query.sourceLine - 1).join("\n").startsWith(query.sourceSql),
        `${entry.key}: ${query.source}:${query.sourceLine}`).toBe(true);
      for (const column of entry.columns) {
        const camel = column.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
        expect(query.sourceSql.includes(column) || query.sourceSql.includes(camel), `${entry.key}.${column}`).toBe(true);
      }
    }
  });

  it("restores exactly 20 ordinary definitions through an additive, registered and byte-equivalent SQL mirror", () => {
    const sql = WORKER_QUERY_INDEX_ALIGNMENT_SQL;
    expect(readFileSync("migrations/0137_worker_query_index_alignment.sql", "utf8").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', ARRAY\[/g)].map((match) => `${match[1]}.${match[2]}`))
      .toEqual(restored.map((entry) => entry.key));
    for (const entry of restored) expect(sql).toContain(`('${entry.catalog.table}', '${entry.catalog.name}', ARRAY[${entry.columns.map((column) => `'${column}'`).join(", ")}]::text[], false)`);
    expect(sql).not.toMatch(/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    for (const guard of ["current_schema()", "pg_get_indexdef(i.indexrelid)=expected_definition", "owner.conindid=i.indexrelid",
      "i.indpred IS NULL", "i.indexprs IS NULL", "i.indnatts=i.indnkeyatts", "i.indisunique=item.is_unique", "0137 index definition drift"])
      expect(sql).toContain(guard);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service.match(/this\.migration_0143\(\)/g)).toHaveLength(1);
    expect(service).toContain("return WORKER_QUERY_INDEX_ALIGNMENT_SQL");
  });

  it("removes only the two redundant declarations while pinning their complete retained unique definitions", () => {
    for (const entry of retired) {
      expect(entry.previousSnapshotIndex).toMatchObject({ name: entry.catalog.name, isUnique: false, method: "btree" });
      expect(entry.previousSnapshotIndex!.columns.map((column) => column.expression)).toEqual(entry.columns);
      expect(entry.previousSnapshotIndex!.columns.every((column) => column.asc && column.nulls === "last")).toBe(true);
      expect(entry.replacementCatalog).toEqual({ ...entry.catalog, key: entry.key + "_uq", name: entry.catalog.name + "_uq", unique: true });
      const filename = entry.catalog.table === "store_order" ? "order" : "supplier";
      const model = readFileSync(`src/models/schema/${filename}.ts`, "utf8");
      expect(model).not.toContain(`index("${entry.catalog.name}")`);
      expect(model).toContain(`uniqueIndex("${entry.replacementCatalog!.name}")`);
    }
  });

  it("gates 128 exact positive contracts and refuses contraction, overlap, unknown decisions or invalid replacements", () => {
    const result = extendOrdinaryIndexContracts(baseKeys, manifest);
    expect(result.keys).toHaveLength(128);
    expect(new Set(result.keys).size).toBe(128);
    const available = [...prior.map((entry) => entry.catalog), ...restored.map((entry) => entry.catalog), ...retired.map((entry) => entry.replacementCatalog!)];
    const catalog: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes: result.keys.map((key) => available.find((row) => row.key === key)!) };
    expect(() => assertIndexContracts(catalog, catalog, result.keys)).not.toThrow();
    for (const entry of [...restored.map((entry) => entry.catalog), ...retired.map((entry) => entry.replacementCatalog!)]) {
      expect(() => assertIndexContracts(catalog, { ...catalog, indexes: catalog.indexes.filter((row) => row.key !== entry.key) }, result.keys)).toThrow(entry.key);
    }
    expect(() => extendOrdinaryIndexContracts(baseKeys.slice(1), manifest)).toThrow();
    expect(() => extendOrdinaryIndexContracts([...baseKeys.slice(1), baseKeys[1]], manifest)).toThrow();
    for (const mutate of [
      (copy: typeof manifest) => copy.entries.pop(),
      (copy: typeof manifest) => { copy.entries[0].decision = "waive"; },
      (copy: typeof manifest) => { copy.entries[0].key = copy.entries[1].key; },
      (copy: typeof manifest) => { copy.entries.find((entry) => entry.replacementCatalog)!.replacementCatalog!.unique = false; },
      (copy: typeof manifest) => { copy.entries.find((entry) => entry.replacementCatalog)!.replacementCatalog!.definition = "different"; },
    ]) {
      const copy = structuredClone(manifest); mutate(copy);
      expect(() => extendOrdinaryIndexContracts(baseKeys, copy)).toThrow();
    }
  });

  it("rejects either retired physical name even on a different table and applies the gate to all four paths", () => {
    const { retiredKeys } = extendOrdinaryIndexContracts(baseKeys, manifest);
    const empty: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes: [] };
    expect(() => assertRetiredIndexesAbsent(empty, retiredKeys)).not.toThrow();
    expect(() => assertRetiredIndexesAbsent(empty, [])).toThrow();
    for (const entry of retired) for (const row of [entry.catalog, { ...entry.catalog, key: `unexpected.${entry.catalog.name}`, table: "unexpected" }]) {
      expect(() => assertRetiredIndexesAbsent({ ...empty, indexes: [row] }, retiredKeys)).toThrow(entry.key);
    }
    const runner = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(runner).toContain('"orm-ordinary-index-reconciliation.json"');
    expect(runner).toContain("for (const catalog of Object.values(catalogs)) assertRetiredIndexesAbsent(catalog, retiredKeys)");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_upgrade)");
  });
});
