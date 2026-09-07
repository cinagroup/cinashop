import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAllColumnsAligned, assertColumnDefaultContracts } from "../scripts/data-migration/column-default-contracts";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { COLUMN_DEFAULT_ALIGNMENT_SQL as sql } from "../src/migrations/columnDefaultAlignment";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
type Entry = { key: string; catalog: CatalogRow; previousCatalog: CatalogRow;
  model: { file: string; line: number; declaration: string; previousDeclaration: string };
  sources: Array<{ file: string; line: number; sql: string }> };
const manifest = JSON.parse(read("audit/orm-column-default-reconciliation.json")) as { entries: Entry[] };
const catalog: Catalog = { tables: [], columns: manifest.entries.map(e => e.catalog), constraints: [], indexes: [], sequences: [] };

describe("DB-009E1 exact column default reconciliation", () => {
  it("binds four default-only changes to immutable catalog rows, original SQL and exact model declarations", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison: string; category: string; change: string; value: { key: string; fields: string[]; reference: CatalogRow; candidate: CatalogRow } }> };
    expect(manifest.entries).toHaveLength(4);
    for (const e of manifest.entries) {
      const original = baseline.records.find(r => r.comparison === "externalVsOrm" && r.category === "columns" && r.change === "changed" && r.value.key === e.key)!.value;
      expect(original.fields).toEqual(["default"]);
      expect(original.reference).toEqual(e.catalog);
      expect(original.candidate).toEqual(e.previousCatalog);
      expect({ ...e.previousCatalog, default: e.catalog.default }).toEqual(e.catalog);
      assertModelDeclaration(read(e.model.file), String(e.catalog.table), e.model.declaration);
      for (const source of e.sources) expect(read(source.file).split("\n")[source.line - 1]).toBe(source.sql);
    }
  });

  it("registers an exact guarded SET DEFAULT mirror, without type/nullability changes or business DML", () => {
    expect(read("migrations/0141_column_default_alignment.sql").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/^\s{4}\('([a-z0-9_]+)', '([a-z0-9_]+)', '([^']+)',/gm)].map(m => [m[1] + "." + m[2], m[3]]))
      .toEqual(manifest.entries.map(e => [e.key, e.catalog.type]));
    const literal = (value: unknown) => value === null ? "NULL::text" : `$value$${String(value)}$value$`;
    for (const e of manifest.entries) expect(sql).toContain(`('${e.catalog.table}', '${e.catalog.name}', '${e.catalog.type}', ${literal(e.previousCatalog.default)}, ${literal(e.catalog.default)})`);
    expect([...sql.matchAll(/EXECUTE format\('([^']+)'/g)].map(m => m[1])).toEqual([
      "LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE", "ALTER TABLE ONLY %I.%I ALTER COLUMN %I SET DEFAULT %s",
    ]);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|CASCADE|REINDEX)\b/);
    for (const guard of ["current_schema()", "set_config('lock_timeout', '2s', true)", "FROM pg_inherits", "a.attnotnull",
      "a.attidentity=''", "a.attgenerated=''", "a.attcollation=", "previous_default IS DISTINCT FROM item.old_default",
      "previous_default IS DISTINCT FROM item.target_default", "resulting_default IS DISTINCT FROM item.target_default"])
      expect(sql).toContain(guard);
    const service = read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0147\(\)/g)).toHaveLength(1);
    expect(service).toContain("return COLUMN_DEFAULT_ALIGNMENT_SQL");
  });

  it("gates all column fields and additions/omissions without canonicalizing expressions", () => {
    expect(() => assertColumnDefaultContracts(catalog, manifest)).not.toThrow();
    expect(() => assertAllColumnsAligned(catalog, catalog)).not.toThrow();
    for (const e of manifest.entries) {
      const wrong = { ...catalog, columns: catalog.columns.map(row => row.key === e.key ? e.previousCatalog : row) };
      expect(() => assertColumnDefaultContracts(wrong, manifest)).toThrow(e.key);
      expect(() => assertAllColumnsAligned(catalog, wrong)).toThrow();
    }
    for (const columns of [catalog.columns.slice(1), [...catalog.columns, catalog.columns[0]],
      [...catalog.columns, { ...catalog.columns[0], key: "other.extra", name: "extra", table: "other" }],
      catalog.columns.map((row, i) => i ? row : { ...row, notNull: false }),
      catalog.columns.map((row, i) => i ? row : { ...row, generated: "s" }),
      catalog.columns.map((row, i) => i ? row : { ...row, type: "text" })]) {
      expect(() => assertAllColumnsAligned(catalog, { ...catalog, columns })).toThrow();
    }
    expect(() => assertColumnDefaultContracts(catalog, { entries: manifest.entries.slice(1) })).toThrow();
    const mutation = structuredClone(manifest); mutation.entries[0].catalog.notNull = false;
    expect(() => assertColumnDefaultContracts(catalog, mutation)).toThrow();
    const runner = read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain('"orm_default_upgrade"');
    expect(runner).toContain("assertAllColumnsAligned(catalogs.external, catalog)");
    expect(runner).toContain("assertColumnDefaultContracts(catalog, defaultManifest)");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_default_upgrade)");
    expect(runner).toContain("columnWriteVerification[path] = await auditDefaults.verifyDefaultWrites");
  });

  it("checks real PostgreSQL and PGlite NOT NULL error column names strictly", () => {
    const { matchesNullViolation } = createRequire(import.meta.url)("./helpers/columnDefaultAudit.cjs") as {
      matchesNullViolation(error: Record<string, unknown>, column: string): boolean;
    };
    for (const fields of [{ column: "payload" }, { column_name: "payload" }, { column: "payload", column_name: "payload" }]) {
      expect(matchesNullViolation({ code: "23502", ...fields }, "payload")).toBe(true);
    }
    for (const error of [{ code: "23502" }, { code: "23503", column: "payload" }, { code: "23502", column_name: "other" },
      { code: "23502", column: "payload", column_name: "other" }]) expect(() => matchesNullViolation(error, "payload")).toThrow();
  });

  it("keeps application writers explicit: defaults do not replace event payloads or sanitization", () => {
    expect(read("src/services/order/OrderOutboxService.ts")).toContain("payload: { orderId: order.id, orderNo: order.orderId }");
    const deadLetter = read("src/services/order/OrderQueueDeadLetterService.ts");
    for (const source of ["prepareOrderQueueDeadLetter(message.body)", "sha256(prepared.body)", "body: prepared.body", "bodySha256: bodyHash"])
      expect(deadLetter).toContain(source);
    expect(read("src/dao/activity/ActivityDaos.ts")).toContain(".where(seckillCatalogSchedulePredicate(timeId, now))");
    expect(read("src/services/activity/SeckillScheduleQuery.ts")).toContain("ids(storeSeckill.timeId)");
    expect(read("src/services/activity/SeckillScheduleQuery.ts")).toContain("string_to_array(CASE");
    expect(read("src/models/schema/brokerage.ts")).toContain("Active commission code uses user_brokerage.frozen_time instead.");
  });

  it.each(["cjs", "esm"])("executes %s full-schema old/default upgrade and write contracts with sockets denied", format => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-column-default-"));
    const report = join(directory, "audit.json");
    try {
      const environment = { ...process.env };
      const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", DATABASE_URL: "postgresql://audit:audit@127.0.0.1:9/audit", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"), join(root, "test/helpers/columnDefaultLocalAudit.cjs"), format], {
        cwd: root, env: environment, encoding: "utf8", timeout: 90_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`DB-009E1 ${format}: 4 default-only alignments, 14 drift refusals`);
      const audit = JSON.parse(readFileSync(report, "utf8"));
      expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);
});
