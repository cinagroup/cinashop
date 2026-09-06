import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog, type CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { extendOrdinaryIndexContracts } from "../scripts/data-migration/ordinary-index-contracts";
import { extendIndexNameContracts, assertOldIndexNamesAbsent } from "../scripts/data-migration/index-name-contracts";
import { ORDINARY_INDEX_NAME_ALIGNMENT_SQL as sql } from "../src/migrations/ordinaryIndexNameAlignment";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

type Entry = { key: string; previousKey: string; catalog: CatalogRow; previousCatalog: CatalogRow; columns: string[];
  previousSnapshotIndex: { name: string; isUnique: boolean; method: string;
    columns: Array<{ expression: string; isExpression: boolean; asc: boolean; nulls: string }> };
  model: { file: string; line: number; previousDeclaration: string; declaration: string };
  sources: Array<{ source: string; sourceLine: number; sourceSql: string }> };
type PriorEntry = { key: string; decision: string; catalog: CatalogRow; replacementCatalog?: CatalogRow };
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(read("audit/orm-index-name-reconciliation.json")) as { entries: Entry[] };
const prior = (name: string) => JSON.parse(read(`audit/${name}`)) as { entries: PriorEntry[] };
const previous = [...prior("orm-query-index-reconciliation.json").entries, ...prior("orm-index-definition-reconciliation.json").entries,
  ...prior("orm-extra-index-reconciliation.json").entries.filter((entry) => entry.decision === "restore-missing-legacy-query-index")];
const ordinary = prior("orm-ordinary-index-reconciliation.json");
const baseKeys = extendOrdinaryIndexContracts(previous.map((entry) => entry.key), ordinary).keys;
const empty: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes: [] };

describe("DB-009D2b3c identity-preserving ordinary index names", () => {
  it("binds the complete 44-name cohort to immutable PG16 rows, unchanged models and all 45 source declarations", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison?: string; category?: string; change?: string; value: CatalogRow & { reference: string; candidate: string } }> };
    const records = baseline.records.filter((row) => row.comparison === "externalVsOrm" && row.category === "indexes");
    const source = (key: string, change: string) => records.find((row) => row.change === change && row.value.key === key)!.value;
    const aliases = records.filter((row) => row.change === "possibleRenames")
      .filter((row) => source(row.value.reference, "referenceOnly").constraintOwned === false);
    expect(aliases).toHaveLength(44);
    expect(manifest.entries.map((entry) => [entry.key, entry.previousKey]))
      .toEqual(aliases.map((row) => [row.value.reference, row.value.candidate]));
    expect(new Set(manifest.entries.map((entry) => entry.model.file)).size).toBe(10);
    expect(new Set(manifest.entries.map((entry) => entry.catalog.table)).size).toBe(25);
    expect(manifest.entries.flatMap((entry) => entry.sources)).toHaveLength(45);
    for (const entry of manifest.entries) {
      expect(entry.catalog).toEqual(source(entry.key, "referenceOnly"));
      expect(entry.previousCatalog).toEqual(source(entry.previousKey, "candidateOnly"));
      expect(entry.catalog).toEqual({ ...entry.previousCatalog, key: entry.key, name: entry.catalog.name });
      expect(entry.previousSnapshotIndex).toMatchObject({ name: entry.previousCatalog.name, isUnique: false, method: "btree" });
      expect(entry.previousSnapshotIndex.columns).toEqual(entry.columns.map((expression) => ({ expression, isExpression: false, asc: true, nulls: "last" })));
      expect(entry.model.previousDeclaration.replace(`index("${entry.previousCatalog.name}")`, `index("${entry.catalog.name}")`)).toBe(entry.model.declaration);
      assertModelDeclaration(read(entry.model.file), String(entry.catalog.table), entry.model.declaration);
      for (const source of entry.sources) expect(read(source.source).split("\n")[source.sourceLine - 1]).toBe(source.sourceSql);
    }
  });

  it("registers a byte-equivalent guarded rename mirror without executing rebuilds or business writes", () => {
    expect(read("migrations/0138_ordinary_index_name_alignment.sql").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/\('([A-Za-z0-9_]+)', '([A-Za-z0-9_]+)', '([A-Za-z0-9_]+)', ARRAY\[/g)]
      .map((match) => [match[1], match[2], match[3]]))
      .toEqual(manifest.entries.map((entry) => [entry.catalog.table, entry.previousCatalog.name, entry.catalog.name]));
    for (const entry of manifest.entries) expect(sql).toContain(`('${entry.catalog.table}', '${entry.previousCatalog.name}', '${entry.catalog.name}', ARRAY[${entry.columns.map((column) => `'${column}'`).join(", ")}]::text[])`);
    expect([...sql.matchAll(/EXECUTE format\('([^']+)'/g)].map((match) => match[1])).toEqual([
      "LOCK TABLE %I.%I IN SHARE UPDATE EXCLUSIVE MODE", "ALTER INDEX %I.%I RENAME TO %I",
    ]);
    expect(sql).not.toMatch(/\b(?:DROP|REINDEX|INSERT|DELETE|TRUNCATE|CASCADE)\b/i);
    for (const guard of ["current_schema()", "set_config('lock_timeout', '2s', true)", "old_oid IS NOT NULL AND target_oid IS NOT NULL",
      "old_oid IS NULL AND target_oid IS NULL", "pg_get_indexdef(i.indexrelid)=expected_definition", "owner.conindid=i.indexrelid",
      "NOT i.indisunique", "i.indpred IS NULL", "i.indexprs IS NULL", "i.indnatts=i.indnkeyatts", "target_oid IS DISTINCT FROM old_oid"])
      expect(sql).toContain(guard);
    const service = read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0144\(\)/g)).toHaveLength(1);
    expect(service).toContain("return ORDINARY_INDEX_NAME_ALIGNMENT_SQL");
  });

  it("adds 44 exact named definitions to all 128 previous positive contracts", () => {
    const result = extendIndexNameContracts(baseKeys, manifest);
    expect(result.keys).toHaveLength(172);
    expect(result.keys.slice(0, 128)).toEqual(baseKeys);
    const available = [...previous.map((entry) => entry.catalog), ...ordinary.entries.map((entry) => entry.catalog),
      ...ordinary.entries.flatMap((entry) => entry.replacementCatalog ? [entry.replacementCatalog] : []), ...manifest.entries.map((entry) => entry.catalog)];
    const catalog = { ...empty, indexes: result.keys.map((key) => available.find((row) => row.key === key)!) };
    expect(() => assertIndexContracts(catalog, catalog, result.keys)).not.toThrow();
    for (const entry of manifest.entries) {
      expect(() => assertIndexContracts(catalog, { ...catalog, indexes: catalog.indexes.filter((row) => row.key !== entry.key) }, result.keys)).toThrow(entry.key);
      expect(() => assertIndexContracts(catalog, { ...catalog, indexes: catalog.indexes.map((row) => row.key === entry.key ? { ...row, unique: true } : row) }, result.keys)).toThrow(entry.key);
    }
  });

  it("refuses cohort contraction, alias overlap and any non-name definition change", () => {
    expect(() => extendIndexNameContracts(baseKeys.slice(1), manifest)).toThrow();
    for (const mutate of [
      (copy: typeof manifest) => copy.entries.pop(),
      (copy: typeof manifest) => { copy.entries[0] = copy.entries[1]; },
      (copy: typeof manifest) => { copy.entries[0].key = baseKeys[0]; },
      (copy: typeof manifest) => { copy.entries[0].previousKey = copy.entries[1].key; },
      (copy: typeof manifest) => { copy.entries[0].catalog.unique = true; },
      (copy: typeof manifest) => { copy.entries[0].catalog.constraintOwned = true; },
      (copy: typeof manifest) => { copy.entries[0].catalog.definition = "different"; },
    ]) {
      const copy = structuredClone(manifest); mutate(copy);
      expect(() => extendIndexNameContracts(baseKeys, copy)).toThrow();
    }
  });

  it("rejects all 44 obsolete physical names on every table and gates all four catalog paths", () => {
    const { oldKeys } = extendIndexNameContracts(baseKeys, manifest);
    expect(() => assertOldIndexNamesAbsent(empty, oldKeys)).not.toThrow();
    expect(() => assertOldIndexNamesAbsent(empty, [])).toThrow();
    expect(() => assertOldIndexNamesAbsent(empty, [...oldKeys.slice(1), oldKeys[1]])).toThrow();
    for (const entry of manifest.entries) for (const row of [entry.previousCatalog, { ...entry.previousCatalog, key: `wrong.${entry.previousCatalog.name}`, table: "wrong" }]) {
      expect(() => assertOldIndexNamesAbsent({ ...empty, indexes: [row] }, oldKeys)).toThrow(entry.previousKey);
    }
    const runner = read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain("for (const catalog of Object.values(catalogs)) assertOldIndexNamesAbsent(catalog, oldKeys)");
    for (const path of ["embedded", "orm", "orm_upgrade"]) expect(runner).toContain(`assertIndexContracts(catalogs.external, catalogs.${path}, requiredIndexKeys)`);
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_upgrade)");
  });
});
