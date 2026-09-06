import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../src/lib/di";
import { MigrationService } from "../src/services/MigrationService";
import { KEFU_SEQUENCE_ALIGNMENT_SQL } from "../src/migrations/kefuSequenceAlignment";
import { runKefuSequenceAlignment } from "../src/migrations/runKefuSequenceAlignment";

// These tests cover orchestration only. The real unmocked runner and fresh
// MigrationService.runAll execute against dedicated PG16 databases in CI.
vi.mock("../src/migrations/runKefuSequenceAlignment", () => ({ runKefuSequenceAlignment: vi.fn() }));
const runner = vi.mocked(runKefuSequenceAlignment);
const dialect = new PgDialect();
const root = resolve(import.meta.dirname, "..");
const names = Array.from({ length: 152 }, (_, i) => String(i).padStart(4, "0"));

function harness(failure?: { index: number; error: unknown }, superseded = false) {
  let depth = 0, index = 0;
  const sqlCalls: Array<{ index: number; sql: string }> = [];
  const transaction = vi.fn(async (callback: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>) => {
    const current = index++;
    depth++;
    try {
      return await callback({ execute: async query => {
        const statement = dialect.sqlToQuery(query).sql;
        sqlCalls.push({ index: current, sql: statement });
        if (statement !== "SET LOCAL search_path TO public, pg_temp" && failure?.index === current) throw failure.error;
        return [{ applied: superseded }];
      } });
    } finally { depth--; }
  });
  // Deliberate orchestration-only double; no driver/client is created. Real
  // database shape and SQL semantics are tested in the existing PG16 paths.
  const container = { db: { transaction } } as unknown as Container;
  runner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0151 must receive the root DB outside an outer transaction").toBe(0);
  });
  return { service: new MigrationService(container), transaction, sqlCalls, db: container.db };
}

beforeEach(() => {
  runner.mockReset();
});

describe("embedded 0151 sequence registration", () => {
  it("appends the exact SQL guard once, after the unchanged numeric 0000–0150 registry", () => {
    const source = readFileSync(resolve(root, "src/services/MigrationService.ts"), "utf8");
    const file = ts.createSourceFile("MigrationService.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const service = file.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "MigrationService");
    expect(service && ts.isClassDeclaration(service)).toBe(true);
    if (!service || !ts.isClassDeclaration(service)) throw new Error("MigrationService class missing");
    const runAll = service.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(file) === "runAll");
    if (!runAll || !ts.isMethodDeclaration(runAll)) throw new Error("runAll missing");
    const declarations = runAll.body!.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations);
    const array = declarations.find(d => d.name.getText(file) === "migrations")?.initializer;
    if (!array || !ts.isArrayLiteralExpression(array)) throw new Error("Numbered registry missing");
    expect(array.elements.map(e => e.getText(file))).toEqual(names.map(n => `this.migration_${n}()`));
    const setup = harness();
    expect(setup.service.kefuSequenceAlignmentMigrationSqlForVerification()).toBe(KEFU_SEQUENCE_ALIGNMENT_SQL);
    expect(KEFU_SEQUENCE_ALIGNMENT_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0145_kefu_sequence_alignment.sql"), "utf8").trim());
    expect(setup.transaction).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("executes all 152 steps in order and dispatches only 0151 to the independent root transaction runner", async () => {
    const setup = harness();
    expect(await setup.service.runAll()).toEqual({ executed: names, errors: [] });
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.sqlCalls.filter(c => c.sql === "SET LOCAL search_path TO public, pg_temp")).toHaveLength(151);
    expect(setup.sqlCalls.some(c => c.sql === KEFU_SEQUENCE_ALIGNMENT_SQL)).toBe(false);
  });

  it.each([new Error("already exists"), new Error("sequence drift"), "raw rejection"])(
    "does not skip, retry or record success after the standalone runner fails (%s)", async error => {
      const setup = harness();
      runner.mockRejectedValue(error);
      const result = await setup.service.runAll();
      expect(result.executed).toEqual(names.slice(0, 151));
      expect(result.errors).toEqual([`0151: ${error instanceof Error ? error.message : error}`]);
      expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([115, 150])("never dispatches 0151 after modern step %i fails, including an already-exists error", async index => {
    const setup = harness({ index, error: new Error("already exists") });
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, index), errors: [`${names[index]}: already exists`] });
    expect(setup.transaction).toHaveBeenCalledTimes(index + 1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves the historical skip behavior without applying it to 0151", async () => {
    const setup = harness({ index: 10, error: new Error("already exists") });
    const expected = [...names]; expected[10] = "0010 (skipped)";
    expect(await setup.service.runAll()).toEqual({ executed: expected, errors: [] });
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
  });

  it("preserves the 0118→0119 supersession without shifting the 0151 execution identity", async () => {
    const setup = harness(undefined, true), expected = [...names];
    expected[118] = "0118 (superseded by 0119)";
    expect(await setup.service.runAll()).toEqual({ executed: expected, errors: [] });
    expect(setup.sqlCalls.filter(c => c.index === 118)).toHaveLength(2); // SET and marker SELECT; no old DDL.
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
  });
});
