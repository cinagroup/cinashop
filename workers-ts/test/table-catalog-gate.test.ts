import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { assertAllTablesAligned, TABLE_CATALOG_COUNT, TABLE_CATALOG_FIELDS } from "../scripts/data-migration/table-catalog-contracts";
import { verifyTableCatalogGate } from "./helpers/tableCatalogGateAudit";

const table = (key: string): CatalogRow => ({
  key, name: key, kind: "r", persistence: "p", rowSecurity: false,
  forceRowSecurity: false, partition: false, partitionKey: null,
});
const synthetic: Catalog = {
  tables: Array.from({ length: 263 }, (_, i) => table(`comparator_only_${i}`)),
  columns: [], constraints: [], indexes: [], sequences: [],
};
const withRow = (row: CatalogRow): Catalog => ({ ...synthetic, tables: [row, ...synthetic.tables.slice(1)] });
const changes: Record<typeof TABLE_CATALOG_FIELDS[number], unknown> = {
  key: "renamed", name: "renamed", kind: "p", persistence: "u", rowSecurity: true,
  forceRowSecurity: true, partition: true, partitionKey: "RANGE (id)",
};

describe("DB-009F complete table catalog hard gate", () => {
  it.each(TABLE_CATALOG_FIELDS)("refuses raw %s drift in either direction", field => {
    const changed = withRow({ ...synthetic.tables[0], [field]: changes[field] });
    expect(() => assertAllTablesAligned(synthetic, changed)).toThrow();
    expect(() => assertAllTablesAligned(changed, synthetic)).toThrow();
  });

  it("refuses empty/contracted/expanded/duplicate cohorts, including identical defects on both sides", () => {
    expect(TABLE_CATALOG_COUNT).toBe(263);
    for (const rows of [[], synthetic.tables.slice(1), [...synthetic.tables, table("extra")],
      [synthetic.tables[1], ...synthetic.tables.slice(1)]]) {
      const changed = { ...synthetic, tables: rows };
      expect(() => assertAllTablesAligned(synthetic, changed)).toThrow();
      expect(() => assertAllTablesAligned(changed, synthetic)).toThrow();
      expect(() => assertAllTablesAligned(changed, changed)).toThrow();
    }
  });

  it("refuses dropped/extra fields and implicit type coercion even when the reader is wrong on both sides", () => {
    for (const field of TABLE_CATALOG_FIELDS) {
      const row = { ...synthetic.tables[0] }; delete row[field];
      const changed = withRow(row);
      expect(() => assertAllTablesAligned(changed, changed)).toThrow("row shape");
    }
    for (const row of [
      { ...synthetic.tables[0], extra: null }, { ...synthetic.tables[0], rowSecurity: "false" },
      { ...synthetic.tables[0], forceRowSecurity: 0 }, { ...synthetic.tables[0], partition: null },
      { ...synthetic.tables[0], partitionKey: false }, { ...synthetic.tables[0], partitionKey: "" },
      { ...synthetic.tables[0], kind: "v" }, { ...synthetic.tables[0], persistence: "unknown" },
      { ...synthetic.tables[0], key: "", name: "" },
    ]) {
      const changed = withRow(row);
      expect(() => assertAllTablesAligned(changed, changed)).toThrow("row shape");
    }
  });

  it("ignores row/property order but never normalizes partition expressions or table names", () => {
    const reordered = { ...synthetic, tables: [...synthetic.tables].reverse().map(row => Object.fromEntries(Object.entries(row).reverse()) as CatalogRow) };
    expect(() => assertAllTablesAligned(synthetic, reordered)).not.toThrow();
    const original = withRow({ ...synthetic.tables[0], kind: "p", partitionKey: "RANGE (id)" });
    const changed = withRow({ ...synthetic.tables[0], kind: "p", partitionKey: "RANGE ((id + 0))" });
    expect(() => assertAllTablesAligned(original, changed)).toThrow("Full table catalog differs");
    const renamed = withRow({ ...synthetic.tables[0], key: "renamed", name: "renamed" });
    expect(() => assertAllTablesAligned(synthetic, renamed)).toThrow("Full table catalog differs");
  });

  it("executes all nine real metadata refusals and rollbacks locally; the same helper runs on isolated PG16 in CI", async () => {
    const db = await PGlite.create();
    try {
      const report = await verifyTableCatalogGate({
        exec: statement => db.exec(statement),
        query: async statement => (await db.query<CatalogRow>(statement)).rows,
      });
      expect(report).toEqual({
        fixtureTables: 263,
        engineDriftRefusals: ["rls-enabled", "rls-forced", "persistence", "kind", "partition-key", "partition-member", "renamed", "missing", "extra"],
        bothComparisonDirectionsRefused: true, tableOnlyChangesInvisibleToOtherCategories: 6,
        allFiveCategoriesRestoredAfterEachRollback: true, temporaryShadowIgnored: true,
        scope: "Self-created fixture metadata only; no policy authorization or production equivalence claim",
      });
      await expect(verifyTableCatalogGate({ exec: statement => db.exec(statement),
        query: async statement => (await db.query<CatalogRow>(statement)).rows })).rejects.toThrow("empty public catalog");
    } finally { await db.close(); }
  }, 60_000);

  it("wires the hard gate to every collected catalog, retains the nine project paths, and keeps CLI failures nonzero", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../scripts/orm-ddl-audit.ts"), "utf8");
    const file = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const loops: ts.ForOfStatement[] = [];
    const visit = (node: ts.Node) => { if (ts.isForOfStatement(node)) loops.push(node); ts.forEachChild(node, visit); }; visit(file);
    const allCatalogLoops = loops.filter(loop => loop.expression.getText(file) === "Object.values(catalogs)");
    const calls = allCatalogLoops.filter(loop => ts.isBlock(loop.statement))
      .flatMap(loop => ts.isBlock(loop.statement) ? loop.statement.statements.map(statement => statement.getText(file)) : []);
    expect(calls.filter(call => call.startsWith("assertAllTablesAligned("))).toEqual(["assertAllTablesAligned(catalogs.external, catalog);"]);
    const pathLoop = loops.find(loop => loop.initializer.getText(file) === "const path")!;
    expect(pathLoop.expression.getText(file)).toBe('["external", "embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names", "orm_checks", "orm_sequences", "table_gate"] as const');
    expect(source).toContain('if (!tableCatalogGateVerification) throw new Error("Table catalog engine gate verification is missing")');
    expect(source).toContain("tableCatalogGateVerification = await verifyTableCatalogGate(");
    expect(source).toContain('process.exitCode = 1;');
    expect(source).toContain('await control.unsafe(`DROP DATABASE "${name}"`)');
    expect(source).toContain('if (remains.length) throw new Error("Isolated database cleanup was not confirmed")');
  });
});
