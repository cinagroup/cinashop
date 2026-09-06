import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertMissingConstraintContracts } from "../scripts/data-migration/missing-constraint-contracts";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { MISSING_CONSTRAINT_ALIGNMENT_SQL as sql } from "../src/migrations/missingConstraintAlignment";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
type Entry = { key: string; catalog: CatalogRow; model: { file: string; declaration: string };
  sources: Array<{ file: string; line: number; sql: string; declarationStart: string }>;
  columns: CatalogRow[]; snapshot: { notValid?: true }; reference?: { columnCatalog: CatalogRow[] } };
const manifest = JSON.parse(read("audit/orm-missing-constraint-reconciliation.json")) as { entries: Entry[] };
const catalog: Catalog = { tables: [], columns: [], indexes: [], sequences: [], constraints: manifest.entries.map(e => e.catalog) };

describe("DB-009E2B exact missing CHECK/FK reconciliation", () => {
  it("binds all 41 non-alias rows to immutable engine evidence and typed model/source declarations", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison: string; category: string; change: string; value: CatalogRow & { reference: string } }> };
    const records = baseline.records.filter(r => r.comparison === "externalVsOrm" && r.category === "constraints");
    const aliases = new Set(records.filter(r => r.change === "possibleRenames").map(r => r.value.reference));
    expect(manifest.entries.map(e => e.catalog)).toEqual(records.filter(r => r.change === "referenceOnly" && !aliases.has(r.value.key)).map(r => r.value));
    expect(manifest.entries).toHaveLength(41);
    expect(manifest.entries.filter(e => e.catalog.type === "c")).toHaveLength(39);
    expect(manifest.entries.filter(e => !e.catalog.validated)).toHaveLength(8);
    for (const e of manifest.entries) {
      assertModelDeclaration(read(e.model.file), String(e.catalog.table), e.model.declaration);
      expect(e.snapshot.notValid === true).toBe(!e.catalog.validated);
      expect(e.sources.some(s => s.file.startsWith("migrations/"))).toBe(true);
      expect(e.sources.some(s => s.file.startsWith("src/"))).toBe(true);
      for (const source of e.sources) {
        expect(read(source.file)).toContain(source.sql);
        // External historical files are untouched; embedded imports may move lines.
        if (source.file.startsWith("migrations/")) expect(read(source.file).split("\n")[source.line - 1]).toBe(source.declarationStart);
      }
    }
  });

  it("registers an exact add-only guard with the original SQL, not a reparsed deparser expression", () => {
    expect(read("migrations/0142_missing_constraint_alignment.sql").trim()).toBe(sql.trim());
    const data = JSON.parse(sql.split("$constraint_data$")[1]) as {
      columns: Array<Record<string, unknown>>;
      constraints: Array<{ table: string; name: string; definition: string; ddl?: string; validated: boolean; columns: string[] }> };
    expect(data.constraints.map(e => e.table + "." + e.name)).toEqual(manifest.entries.map(e => e.key));
    expect(data.columns).toHaveLength(96);
    expect(new Set(data.columns.map(e => e.table)).size).toBe(17);
    for (const [i, e] of manifest.entries.entries()) {
      expect(data.constraints[i].definition).toBe(e.catalog.definition);
      expect(data.constraints[i].validated).toBe(e.catalog.validated);
      expect(data.constraints[i].columns).toEqual(e.columns.map(c => c.name));
      if (e.catalog.type === "c") {
        const latest = e.sources.filter(s => s.file.startsWith("migrations/")).at(-1)!;
        expect(data.constraints[i].ddl).toBe(latest.sql.replace(/^CONSTRAINT\s+"?\w+"?\s+/, ""));
      }
    }
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|INSERT|VALIDATE CONSTRAINT)\b/);
    for (const guard of ["current_schema()", "set_config('lock_timeout', '2s', true)", "pg_catalog,%I,pg_temp",
      "FOR phase IN 1..2", "actual.convalidated IS DISTINCT FROM target.validated",
      "pg_catalog.pg_get_constraintdef(actual.oid,false) IS DISTINCT FROM target.definition",
      "pg_catalog.unnest(actual.conkey)", "actual.conindid IS DISTINCT FROM ref_key.conindid",
      "t.tgenabled='O'", "equivalent constraint has an unreviewed name"]) expect(sql).toContain(guard);
    const service = read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0148\(\)/g)).toHaveLength(1);
    expect(service).toContain("return MISSING_CONSTRAINT_ALIGNMENT_SQL");
  });

  it("rejects omissions, duplicate identities and any catalog field drift without SQL normalization", () => {
    expect(() => assertMissingConstraintContracts(catalog, manifest)).not.toThrow();
    for (const e of manifest.entries) {
      expect(() => assertMissingConstraintContracts({ ...catalog, constraints: catalog.constraints.filter(c => c.key !== e.key) }, manifest)).toThrow(e.key);
      for (const patch of [{ definition: String(e.catalog.definition) + " " }, { validated: !e.catalog.validated },
        { deferrable: true }, { inheritCount: 1 }, { type: "u" }, { noInherit: !e.catalog.noInherit }]) {
        expect(() => assertMissingConstraintContracts({ ...catalog, constraints: catalog.constraints.map(c => c.key === e.key ? { ...c, ...patch } : c) }, manifest)).toThrow(e.key);
      }
    }
    expect(() => assertMissingConstraintContracts({ ...catalog, constraints: [...catalog.constraints, catalog.constraints[0]] }, manifest)).toThrow();
    for (const entries of [manifest.entries.slice(1), [...manifest.entries.slice(1), manifest.entries[1]], [...manifest.entries].reverse()]) {
      expect(() => assertMissingConstraintContracts(catalog, { entries })).toThrow();
    }
    const runner = read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain('"orm_constraints"');
    expect(runner).toContain("assertMissingConstraintContracts(catalog, missingConstraintManifest)");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_constraints)");
  });

  it.each(["cjs", "esm"])("executes %s full-schema old/guarded upgrade with all network sockets denied", format => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-missing-constraints-"));
    const report = join(directory, "audit.json");
    try {
      const environment = { ...process.env };
      const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", DATABASE_URL: "postgresql://audit:audit@127.0.0.1:9/audit", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"), join(root, "test/helpers/missingConstraintLocalAudit.cjs"), format], {
        cwd: root, env: environment, encoding: "utf8", timeout: 180_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`DB-009E2B ${format}: 41 constraints, 33 invalid-old-row refusals, 8 NOT VALID contracts`);
      expect(result.stdout).toContain("8 committed old rows / new references / unchanged orphan distinction");
      const audit = JSON.parse(readFileSync(report, "utf8"));
      expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 210_000);
});
