import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog } from "../scripts/data-migration/postgres-catalog-audit";
import { LEGACY_QUERY_INDEX_ALIGNMENT_SQL } from "../src/migrations/legacyQueryIndexAlignment";

type LegacyIndex = { name: string; unique: boolean; sourceLine: number; sourceSql: string; columns: Array<{ name: string; prefix: string | null }> };
type Entry = { key: string; catalog: Catalog["indexes"][number]; columns: string[]; legacyTable: string; legacyTableFound: boolean;
  legacyIndexes: LegacyIndex[]; decision: "restore-missing-legacy-query-index" | "review-orm-only" };
const manifest = JSON.parse(readFileSync("audit/orm-extra-index-reconciliation.json", "utf8"));
const entries: Entry[] = manifest.entries;
const restore = entries.filter((entry) => entry.decision === "restore-missing-legacy-query-index");
const authority = JSON.parse(readFileSync("audit/legacy-index-authority.json", "utf8")) as {
  source: string; sourceSha256: string; tables: Array<{ table: string; sourceLine: number; indexes: LegacyIndex[] }>;
};

describe("DB-009D2b3a source-backed query indexes", () => {
  it("pins the complete 50 non-alias cohort against the immutable PG16 baseline", () => {
    const baseline = JSON.parse(readFileSync("audit/orm-ddl-catalog-baseline.json", "utf8"));
    const records = baseline.records.filter((r: { comparison: string; category: string }) => r.comparison === "externalVsOrm" && r.category === "indexes");
    const aliases = new Set(records.filter((r: { change: string }) => r.change === "possibleRenames")
      .map((r: { value: { candidate: string } }) => r.value.candidate));
    const candidates = records.filter((r: { change: string; value: { key: string; table: string } }) =>
      r.change === "candidateOnly" && !aliases.has(r.value.key) && r.value.table !== "store_pink_full")
      .map((r: { value: Catalog["indexes"][number] }) => r.value);
    expect(aliases.size).toBe(47);
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(50);
    expect(entries.map((entry) => entry.catalog)).toEqual(candidates);
    expect(restore).toHaveLength(28);
    expect(entries.filter((entry) => entry.decision === "review-orm-only")).toHaveLength(22);
    for (const entry of entries) {
      expect(entry.key).toBe(entry.catalog.key);
      expect(entry.catalog).toMatchObject({ unique: false, primary: false, constraintOwned: false, valid: true, ready: true });
    }
  });

  it("binds all decisions to 201 source table KEY inventories, including explicit negative evidence", () => {
    expect(authority.source).toBe("cinashop-php/public/install/crmeb.sql");
    expect(authority.sourceSha256).toBe(manifest.legacyAuthority.sourceSha256);
    expect(readFileSync("audit/legacy-schema-authority.sql", "utf8")).toContain(`-- Source SHA-256: ${authority.sourceSha256}`);
    expect(authority.tables).toHaveLength(201);
    expect(new Set(authority.tables.map((table) => table.table)).size).toBe(201);
    expect(readFileSync(manifest.legacyAuthority.path, "utf8")).not.toMatch(/INSERT INTO|VALUES\s*\(/i);
    for (const table of authority.tables) for (const index of table.indexes) {
      expect(index.sourceLine).toBeGreaterThan(table.sourceLine);
      expect(index.sourceSql.match(/^(?:UNIQUE\s+)?KEY\s+`([^`]+)`/)?.[1]).toBe(index.name);
      expect(index.unique).toBe(/^UNIQUE\s+KEY\b/.test(index.sourceSql));
      expect(index.columns.length).toBeGreaterThan(0);
      const keySql = index.sourceSql.slice(index.sourceSql.indexOf("("));
      expect([...keySql.matchAll(/`([^`]+)`(?:\((\d+)\))?/g)].map((match) => ({ name: match[1], prefix: match[2] ?? null })))
        .toEqual(index.columns);
    }
    for (const entry of entries) {
      expect(entry.legacyTable).toBe(entry.catalog.table === "express_company" ? "eb_express" : `eb_${entry.catalog.table}`);
      const table = authority.tables.find((row) => row.table === entry.legacyTable);
      expect(entry.legacyTableFound).toBe(!!table);
      const matching = table?.indexes.filter((index) => !index.unique
        && index.columns.every((column) => column.prefix === null)
        && JSON.stringify(index.columns.map((column) => column.name)) === JSON.stringify(entry.columns)) ?? [];
      expect(entry.legacyIndexes).toEqual(matching);
      expect(entry.decision).toBe(matching.length ? "restore-missing-legacy-query-index" : "review-orm-only");
    }
    expect(entries.filter((entry) => !entry.legacyTableFound).map((entry) => entry.key)).toEqual(["user_message.um_uid_msg"]);
  });

  it("registers only the 28 reviewed additions with an exact embedded mirror and fail-closed SQL", () => {
    const sql = LEGACY_QUERY_INDEX_ALIGNMENT_SQL;
    expect(readFileSync("migrations/0136_legacy_query_index_alignment.sql", "utf8").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', ARRAY\[/g)].map((match) => `${match[1]}.${match[2]}`))
      .toEqual(restore.map((entry) => entry.key));
    for (const entry of restore) expect(sql).toContain(`('${entry.catalog.table}', '${entry.catalog.name}', ARRAY[${entry.columns.map((column) => `'${column}'`).join(", ")}]::text[], false)`);
    expect(sql).not.toMatch(/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    for (const guard of ["current_schema()", "i.indisunique=item.is_unique", "i.indisvalid AND i.indisready", "i.indpred IS NULL",
      "i.indexprs IS NULL", "i.indnatts=i.indnkeyatts", "pg_get_indexdef(i.indexrelid)=expected_definition", "owner.conindid=i.indexrelid",
      "set_config('lock_timeout', '2s', true)", "0136 index definition drift"])
      expect(sql).toContain(guard);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service.match(/this\.migration_0142\(\)/g)).toHaveLength(1);
    expect(service).toContain("return LEGACY_QUERY_INDEX_ALIGNMENT_SQL");
  });

  it("retains all 107 exact contracts and rejects removal or definition mutation of every restored index", () => {
    const prior = ["orm-query-index-reconciliation.json", "orm-index-definition-reconciliation.json"]
      .flatMap((name) => JSON.parse(readFileSync(`audit/${name}`, "utf8")).entries.map((entry: Entry) => entry.catalog));
    const indexes = [...prior, ...restore.map((entry) => entry.catalog)];
    const keys = indexes.map((row) => row.key);
    expect(keys).toHaveLength(107);
    expect(new Set(keys).size).toBe(107);
    const catalog: Catalog = { tables: [], columns: [], constraints: [], sequences: [], indexes };
    expect(() => assertIndexContracts(catalog, catalog, keys)).not.toThrow();
    for (const entry of restore) {
      expect(() => assertIndexContracts(catalog, { ...catalog, indexes: indexes.filter((row) => row.key !== entry.key) }, keys)).toThrow(entry.key);
      expect(() => assertIndexContracts(catalog, { ...catalog, indexes: indexes.map((row) => row.key === entry.key ? { ...row, unique: true } : row) }, keys)).toThrow(entry.key);
    }
    const runner = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(runner).toContain('"orm-extra-index-reconciliation.json"');
    expect(runner).toContain("restoredLegacy.length !== 28");
    expect(runner).toContain("extra.length !== 50");
    for (const path of ["embedded", "orm", "orm_upgrade"]) expect(runner).toContain(`assertIndexContracts(catalogs.external, catalogs.${path}, requiredIndexKeys)`);
  });
});
