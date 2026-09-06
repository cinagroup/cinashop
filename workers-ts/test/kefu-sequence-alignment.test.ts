import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { assertAllSequencesAligned, assertKefuSequenceAligned } from "../scripts/data-migration/kefu-sequence-contracts";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";
import { KEFU_SEQUENCE_ALIGNMENT_SQL } from "../src/migrations/kefuSequenceAlignment";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
type Entry = { key: string; catalog: CatalogRow; previousCatalog: CatalogRow;
  snapshot: { cinashopSequence: { dataType: string; ownedBy: { schema: string; table: string; column: string } } };
  previousSnapshot: object; model: { file: string; exportName: string; declaration: string; previousDeclaration: string };
  fieldDeclaration: string; sources: Array<{ file: string; clauses: Array<{ line: number; sql: string; sha256: string }> }> };
const manifest = JSON.parse(read("audit/orm-kefu-sequence-reconciliation.json")) as { entries: Entry[] };
const entry = manifest.entries[0];
const catalog: Catalog = { tables: [], columns: [], constraints: [], indexes: [], sequences: [entry.catalog] };
const sql = read("migrations/0145_kefu_sequence_alignment.sql");

describe("DB-009E5B guarded business sequence alignment", () => {
  it("binds the immutable raw difference, exact external/embedded source and actual typed model AST", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison: string; category: string; change: string; value: { key: string; reference: CatalogRow; candidate: CatalogRow } }> };
    const changed = baseline.records.filter(r => r.comparison === "externalVsOrm" && r.category === "sequences" && r.change === "changed");
    expect(manifest.entries.map(e => [e.key, e.catalog, e.previousCatalog]))
      .toEqual(changed.map(r => [r.value.key, r.value.reference, r.value.candidate]));
    expect(manifest.entries).toHaveLength(1);
    expect(entry.snapshot).toEqual({ ...entry.previousSnapshot, cinashopSequence: {
      dataType: "integer", ownedBy: { schema: "public", table: "kefu_visitor_session", column: "visitor_uid" },
    } });
    const source = read(entry.model.file);
    const file = ts.createSourceFile("model.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = file.statements.filter(ts.isVariableStatement)
      .filter(s => s.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === entry.model.exportName));
    expect(declarations).toHaveLength(1);
    expect(declarations[0].getText(file)).toBe(entry.model.declaration);
    expect(source).not.toContain(entry.model.previousDeclaration);
    assertModelDeclaration(source, "kefu_visitor_session", entry.fieldDeclaration);
    expect(entry.sources.map(s => s.file)).toEqual(["migrations/0104_kefu_visitor_session.sql", "src/services/MigrationService.ts"]);
    for (const source of entry.sources) {
      expect(source.clauses).toHaveLength(2);
      for (const clause of source.clauses) {
        expect(read(source.file).split(clause.sql)).toHaveLength(2);
        expect(createHash("sha256").update(clause.sql).digest("hex")).toBe(clause.sha256);
        if (source.file.startsWith("migrations/")) expect(read(source.file).split("\n").slice(clause.line - 1).join("\n").startsWith(clause.sql)).toBe(true);
      }
    }
  });

  it("has only supported lock operations and the exact type/owner mutation, with no counter reset", () => {
    expect(KEFU_SEQUENCE_ALIGNMENT_SQL.trim()).toBe(sql.trim());
    const commands = [...sql.matchAll(/EXECUTE pg_catalog\.format\('([^']+)'/g)].map(m => m[1]);
    expect(commands.filter(s => /^(ALTER|LOCK)/.test(s))).toEqual([
      "LOCK TABLE ONLY %I.kefu_visitor_session IN ACCESS EXCLUSIVE MODE",
      "ALTER TABLE %I.kefu_visitor_session SET SCHEMA %I",
      "ALTER SEQUENCE %I.kefu_visitor_uid_seq SET SCHEMA %I",
      "ALTER SEQUENCE %I.kefu_visitor_uid_seq AS INTEGER OWNED BY %I.kefu_visitor_session.visitor_uid",
    ]);
    expect(commands.join("\n")).not.toMatch(/\b(DROP|RESTART|setval|nextval|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    for (const fragment of ["FOR phase IN 1..2", "set_config('lock_timeout','2s',true)", "pg_catalog,%I,pg_temp",
      "pg_catalog.pg_locks", "before_log_count", "IS DISTINCT FROM before_number", "IS DISTINCT FROM before_called",
      "pg_catalog.pg_depend", "pg_catalog.pg_shdepend", "pg_catalog.pg_seclabel", "pg_catalog.pg_event_trigger"])
      expect(sql).toContain(fragment);
    const runner = read("scripts/orm-ddl-audit.ts");
    for (const fragment of ['"orm_sequences"', "Sequence lock peer identity mismatch", "concurrentDistinctNumbers !== 16",
      "assertAllSequencesAligned(catalogs.external, catalog)", "assertKefuSequenceAligned(catalog, kefuSequenceManifest)",
      "compareCatalogs(catalogs.orm, catalogs.orm_sequences)", "assertIndexContracts(catalogs.external, catalogs.orm_sequences, requiredIndexKeys)"])
      expect(runner).toContain(fragment);
  });

  it("rejects every field, missing/duplicate identities, aliases and contraction of the complete 227-sequence gate", () => {
    expect(() => assertKefuSequenceAligned(catalog, manifest)).not.toThrow();
    for (const [key, value] of Object.entries(entry.catalog)) {
      const row = { ...entry.catalog, [key]: typeof value === "boolean" ? !value : String(value) + "_drift" };
      expect(() => assertKefuSequenceAligned({ ...catalog, sequences: [row] }, manifest)).toThrow();
    }
    for (const rows of [[], [entry.catalog, entry.catalog], [entry.catalog, { ...entry.catalog, key: "alias", name: "alias" }]])
      expect(() => assertKefuSequenceAligned({ ...catalog, sequences: rows }, manifest)).toThrow();
    for (const entries of [[], [entry, entry], [{ ...entry, previousCatalog: entry.catalog }],
      [{ ...entry, catalog: { ...entry.catalog, type: "bigint" } }]]) expect(() => assertKefuSequenceAligned(catalog, { entries })).toThrow();
    // Synthetic rows only exercise the comparison guard. Actual all-227 catalog proof is the PG16 nine-path runner.
    const all = { ...catalog, sequences: [entry.catalog, ...Array.from({ length: 226 }, (_, i) => ({
      ...entry.catalog, key: `contract_only_${i}`, name: `contract_only_${i}`, ownedBy: null,
    }))] };
    expect(() => assertAllSequencesAligned(all, { ...all, sequences: [...all.sequences].reverse() })).not.toThrow();
    for (const sequences of [all.sequences.slice(1), [...all.sequences, all.sequences[0]],
      [...all.sequences.slice(1), all.sequences[1]], all.sequences.map((s, i) => i === 80 ? { ...s, cache: "2" } : s)])
      expect(() => assertAllSequencesAligned(all, { ...all, sequences })).toThrow();
    expect(() => assertAllSequencesAligned(catalog, catalog)).toThrow();
  });

  it.each(["cjs", "esm"])("executes the actual %s full old-model upgrade with network denied", format => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-kefu-sequence-")), report = join(directory, "audit.json");
    try {
      const environment = { ...process.env }, allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"),
        join(root, "test/helpers/kefuSequenceLocalAudit.cjs"), format], {
        cwd: root, env: environment, encoding: "utf8", timeout: 150_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("KEFU_SEQUENCE_AUDIT "));
      expect(line).toBeDefined();
      const proof = JSON.parse(line!.slice("KEFU_SEQUENCE_AUDIT ".length));
      expect(proof.modelAligned).toBe(true);
      expect(proof.driftRefusals).toHaveLength(30);
      expect(proof.newDefaultWriteConfirmed).toBe(true);
      expect(proof.syntheticRowsCleanupConfirmed).toBe(true);
      expect(proof.lockVerification).toBeNull(); // Local single-connection WASM is not real PG16 lock evidence.
      const audit = JSON.parse(readFileSync(report, "utf8"));
      expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally {
      const exact = resolve(directory);
      if (dirname(exact) !== resolve(tmpdir()) || !/^cinashop-kefu-sequence-[A-Za-z0-9]+$/.test(basename(exact)))
        throw new Error("Unsafe isolated kefu sequence cleanup");
      rmSync(exact, { recursive: true, force: true });
    }
  }, 180_000);
});
