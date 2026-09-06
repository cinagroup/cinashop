import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAllIndexesAligned, extendExternalDuplicateContracts } from "../scripts/data-migration/external-duplicate-index-contracts";
import { extendOrdinaryIndexContracts } from "../scripts/data-migration/ordinary-index-contracts";
import { extendIndexNameContracts } from "../scripts/data-migration/index-name-contracts";
import { extendConstraintNameContracts } from "../scripts/data-migration/constraint-name-contracts";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { EXTERNAL_DUPLICATE_INDEX_RETIREMENT_SQL as sql } from "../src/migrations/externalDuplicateIndexRetirement";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
type Source = { file: string; line: number; sql: string };
type Entry = { key: string; retainedKey: string; column: string; catalog: CatalogRow; retainedCatalog: CatalogRow;
  source: Source; retainedSource: Source; model: Source; consumer: Source; decision: string };
const manifest = JSON.parse(read("audit/external-duplicate-index-reconciliation.json")) as { entries: Entry[] };
const prior = (name: string) => JSON.parse(read(`audit/${name}`)) as { entries: Array<Entry> };
const base = [...prior("orm-query-index-reconciliation.json").entries, ...prior("orm-index-definition-reconciliation.json").entries,
  ...prior("orm-extra-index-reconciliation.json").entries.filter(e => e.decision === "restore-missing-legacy-query-index")].map(e => e.key);
const ordinary = extendOrdinaryIndexContracts(base, JSON.parse(read("audit/orm-ordinary-index-reconciliation.json")));
const named = extendIndexNameContracts(ordinary.keys, JSON.parse(read("audit/orm-index-name-reconciliation.json")));
const owning = extendConstraintNameContracts(named.keys, JSON.parse(read("audit/orm-constraint-name-reconciliation.json")));
const catalog: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes: manifest.entries.map(e => e.retainedCatalog) };

describe("DB-009D2b3e external physical duplicate retirement", () => {
  it("binds exactly five actual historical catalog rows to untouched CREATEs, retained declarations and consumers", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison: string; category: string; change: string; value: CatalogRow }> };
    for (const e of manifest.entries) {
      expect(baseline.records.find(r => r.comparison === "externalVsEmbedded" && r.category === "indexes"
        && r.change === "referenceOnly" && r.value.key === e.key)?.value).toEqual(e.catalog);
      expect(e.retainedCatalog).toEqual({ ...e.catalog, key: e.retainedKey, name: e.retainedKey.split(".")[1] });
      for (const source of [e.source, e.retainedSource, e.model, e.consumer]) {
        expect(read(source.file).split("\n").slice(source.line - 1, source.line - 1 + source.sql.split("\n").length).join("\n")).toBe(source.sql);
      }
    }
    expect(manifest.entries.filter(e => e.catalog.unique)).toHaveLength(1);
  });

  it("registers a byte-exact guarded forward mirror without modifying the canonical models", () => {
    expect(read("migrations/0140_external_duplicate_index_retirement.sql").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', '([a-z0-9_]+)', '([a-z0-9_]+)', (true|false)\)/g)]
      .map(m => [m[1], m[2], m[3], m[4], m[5] === "true"])).toEqual(manifest.entries.map(e => [e.catalog.table, e.catalog.name, e.retainedCatalog.name, e.column, e.catalog.unique]));
    expect([...sql.matchAll(/EXECUTE format\('([^']+)'/g)].map(m => m[1])).toEqual([
      "LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE", "DROP INDEX %I.%I RESTRICT",
    ]);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CASCADE|REINDEX|CONCURRENTLY)\b/);
    for (const guard of ["current_schema()", "set_config('lock_timeout', '2s', true)", "conindid=old_index", "refobjid=old_index",
      "FROM pg_shdepend", "a.indclass=b.indclass", "a.indcollation=b.indcollation", "a.indoption=b.indoption",
      "NOT i.indisreplident", "NOT i.indisclustered", "i.indisunique=item.is_unique", "IS DISTINCT FROM retained_file"])
      expect(sql).toContain(guard);
    const service = read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0146\(\)/g)).toHaveLength(1);
    expect(service).toContain("return EXTERNAL_DUPLICATE_INDEX_RETIREMENT_SQL");
  });

  it("preserves the 175 contracts and adds precisely the five retained identities", () => {
    const result = extendExternalDuplicateContracts(owning.keys, manifest);
    expect(result.keys).toHaveLength(180);
    expect(result.keys.slice(0, 175)).toEqual(owning.keys);
    expect(result.keys.slice(175)).toEqual(manifest.entries.map(e => e.retainedKey));
    expect(result.retiredKeys).toEqual(manifest.entries.map(e => e.key));
    expect(() => extendExternalDuplicateContracts(owning.keys.slice(1), manifest)).toThrow();
    for (const mutate of [(copy: typeof manifest) => copy.entries.pop(),
      (copy: typeof manifest) => { copy.entries[0].retainedCatalog.unique = true; },
      (copy: typeof manifest) => { copy.entries[2].catalog.constraintOwned = true; },
      (copy: typeof manifest) => { copy.entries[0].decision = "waive"; }]) {
      const copy = structuredClone(manifest); mutate(copy); expect(() => extendExternalDuplicateContracts(owning.keys, copy)).toThrow();
    }
  });

  it("gates the entire index category, including additions, missing rows, aliases, drift and duplicated identities", () => {
    expect(() => assertAllIndexesAligned(catalog, catalog)).not.toThrow();
    for (const indexes of [catalog.indexes.slice(1), [...catalog.indexes, catalog.indexes[0]],
      [...catalog.indexes, { ...catalog.indexes[0], key: "other.extra", name: "extra", table: "other" }],
      catalog.indexes.map((row, i) => i ? row : { ...row, unique: !row.unique }),
      catalog.indexes.map((row, i) => i ? row : { ...row, key: "other.alias", name: "alias" })]) {
      expect(() => assertAllIndexesAligned(catalog, { ...catalog, indexes })).toThrow();
    }
    for (const e of manifest.entries) for (const row of [e.catalog, { ...e.catalog, key: `other.${e.catalog.name}`, table: "other" }]) {
      expect(() => assertAllIndexesAligned(catalog, { ...catalog, indexes: [...catalog.indexes, row] })).toThrow("External duplicate reintroduced");
    }
    const runner = read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain("for (const catalog of Object.values(catalogs)) assertAllIndexesAligned(catalogs.external, catalog)");
    expect(runner).toContain("if (!externalDuplicateIndexRetirement) throw");
  });

  it("executes guarded retirement against full current ORM plus actual historical CREATEs with sockets denied", () => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-external-duplicate-"));
    const report = join(directory, "audit.json");
    try {
      const environment = { ...process.env };
      const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", DATABASE_URL: "postgresql://audit:audit@127.0.0.1:9/audit", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"), join(root, "test/helpers/externalDuplicateIndexLocalAudit.cjs")], {
        cwd: root, env: environment, encoding: "utf8", timeout: 90_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("DB-009D2b3e pglite: 5 guarded duplicate removals, 34 dependency/drift refusals");
      const audit = JSON.parse(readFileSync(report, "utf8"));
      expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);
});
