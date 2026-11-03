import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main as migrationMain } from "../scripts/mysql-to-postgres";
import { parseCreateTables } from "../scripts/data-migration/schema-audit";
import { extractStaticMigrationSql } from "../scripts/data-migration/schema-source-extraction";

describe("static TypeScript migration SQL declaration supplements", () => {
  it("decodes escaped quotes and newlines as literal SQL with exact source provenance", () => {
    const sql = '-- reviewed SQL\nCREATE TABLE "quoted_ledger" ("id" integer PRIMARY KEY, "memo" text DEFAULT \'a\\b\');\n';
    const encoded = JSON.stringify(sql);
    const source = `// declaration owner\nexport const ESCAPED_SQL = ${encoded};\n`;
    const result = extractStaticMigrationSql(source, "src/migrations/escaped.ts");
    expect(result.unresolved).toEqual([]);
    expect(result.staticSqlLiterals).toHaveLength(1);
    const literal = result.staticSqlLiterals[0];
    expect(literal).toMatchObject({ sourceName: "src/migrations/escaped.ts", symbol: "ESCAPED_SQL",
      line: 2, representation: "string-literal", sql });
    expect(source.slice(literal.start, literal.end)).toBe(encoded);
    expect([...parseCreateTables(literal.sql, "postgres").get("quoted_ledger")!.columns.keys()]).toEqual(["id", "memo"]);
  });

  it("retains complete no-substitution templates without evaluating TypeScript", () => {
    const source = 'export const STATIC_SQL = `/* owner */\nCREATE TABLE public.static_ledger (id integer PRIMARY KEY);`;';
    const result = extractStaticMigrationSql(source, "static.ts");
    expect(result.unresolved).toEqual([]);
    expect(result.staticSqlLiterals).toHaveLength(1);
    expect(result.staticSqlLiterals[0]).toMatchObject({ representation: "no-substitution-template",
      sql: "/* owner */\nCREATE TABLE public.static_ledger (id integer PRIMARY KEY);" });
    expect([...parseCreateTables(result.staticSqlLiterals[0].sql, "postgres").keys()]).toEqual(["static_ledger"]);
  });

  it("does not promote comments, messages, SQL values or ordinary strings into literal declarations", () => {
    const source = [
      '// export const COMMENT_SQL = `CREATE TABLE "comment" ("id" int);`;',
      'const ordinary = \'CREATE TABLE "ordinary" ("id" int);\';',
      'export const message = \'CREATE TABLE "message" ("id" int);\';',
      'export const MESSAGE_SQL = \'Error: CREATE TABLE "message" was refused\';',
      'export const COMMENT_ONLY_SQL = \'/* outer /* CREATE TABLE "fake" ("id" int); */ inner */ SELECT 1\';',
      'export const VALUE_SQL = "SELECT \'CREATE TABLE fake (id int)\'";',
      'export const QUOTED_VALUE_SQL = "COMMENT ON TABLE x IS \'CREATE TABLE fake (id int)\'";',
    ].join("\n");
    const result = extractStaticMigrationSql(source, "messages.ts");
    expect(result.staticSqlLiterals).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports interpolation positions instead of calling expressions or inventing their values", () => {
    const source = 'export const DYNAMIC_SQL = `CREATE TABLE public.${(() => { throw Error("must not execute"); })()} (id integer);`;';
    const result = extractStaticMigrationSql(source, "dynamic.ts");
    expect(result.staticSqlLiterals).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    const unknown = result.unresolved[0];
    expect(unknown).toMatchObject({ sourceName: "dynamic.ts", symbol: "DYNAMIC_SQL", line: 1,
      reason: "interpolated-template" });
    expect(unknown.expressionRanges).toHaveLength(1);
    const range = unknown.expressionRanges[0];
    expect(range).toMatchObject({ sourceName: "dynamic.ts", line: 1, syntaxKind: "CallExpression" });
    expect(source.slice(range.start, range.end)).toContain('throw Error("must not execute")');
  });

  it.each([
    ['export const CONCAT_SQL = "CREATE TABLE " + name;', "non-literal-sql-expression"],
    ['export const CALL_SQL = buildSql();', "non-literal-sql-expression"],
    ['export const REFERENCE_SQL = importedSql;', "non-literal-sql-expression"],
    ['export let MUTABLE_SQL = `CREATE TABLE public.mutable (id integer);`;', "mutable-sql-declaration"],
    ['export declare const AMBIENT_SQL: string;', "non-literal-sql-expression"],
  ])("leaves non-literal or mutable SQL unproved: %s", (source, reason) => {
    const result = extractStaticMigrationSql(source, "unknown.ts");
    expect(result.staticSqlLiterals).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ sourceName: "unknown.ts", reason });
    expect(result.unresolved[0].expressionRanges).not.toHaveLength(0);
  });

  it("discloses dynamic migration-method SQL even without an exported SQL constant", () => {
    const source = 'class M { migration_0000() { return `CREATE ${kind} public.name (id integer);`; } }';
    const result = extractStaticMigrationSql(source, "method.ts");
    expect(result.staticSqlLiterals).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ sourceName: "method.ts", reason: "interpolated-template" });
    expect(result.unresolved[0].expressionRanges[0].syntaxKind).toBe("Identifier");
  });

  it("keeps DO/EXECUTE-format interpolation unresolved even when table DDL is inside a SQL value", () => {
    const source = "class M { migration_0001() { return `DO $owner$ BEGIN EXECUTE format('CREATE TABLE %I.ledger (id integer)', schema_name); ${guard} END $owner$;`; } }";
    const result = extractStaticMigrationSql(source, "format-method.ts");
    expect(result.staticSqlLiterals).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({ sourceName: "format-method.ts", reason: "interpolated-template" });
    expect(source.slice(result.unresolved[0].expressionRanges[0].start,
      result.unresolved[0].expressionRanges[0].end)).toBe("guard");
  });

  it("rejects syntax recovery and identifies the actual supplied source", () => {
    expect(() => extractStaticMigrationSql('export const BROKEN_SQL = "CREATE TABLE x (', "src/migrations/broken.ts"))
      .toThrow(/Invalid TypeScript migration declaration source src\/migrations\/broken.ts:1:/);
    expect(() => extractStaticMigrationSql("export const X_SQL = 'x';", " "))
      .toThrow("requires a source name");
  });

  it("reads the real city literal as the exact independently authored external SQL and columns", () => {
    const sourceName = "src/migrations/customerCityDelivery.ts";
    const source = readFileSync(resolve(import.meta.dirname, "../", sourceName), "utf8");
    const external = readFileSync(resolve(import.meta.dirname, "../migrations/0173_customer_city_delivery.sql"));
    const result = extractStaticMigrationSql(source, sourceName);
    const literal = result.staticSqlLiterals.find(item => item.symbol === "CUSTOMER_CITY_DELIVERY_SQL");
    expect(literal).toBeDefined();
    expect(Buffer.from(literal!.sql, "utf8").equals(external)).toBe(true);
    expect(literal).toMatchObject({ sourceName, representation: "string-literal", line: 7 });
    const actual = parseCreateTables(literal!.sql, "postgres");
    const expected = parseCreateTables(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(external), "postgres");
    expect([...actual.keys()].sort()).toEqual([
      "customer_city_delivery_attempt", "customer_city_delivery_binding", "customer_city_delivery_job",
    ]);
    for (const [name, table] of actual) {
      expect([...table.columns]).toEqual([...expected.get(name)!.columns]);
      expect(table.primaryKey).toEqual(expected.get(name)!.primaryKey);
      expect(parseCreateTables(source, "postgres").has(name)).toBe(false);
    }
  });

  it("preserves the existing self-contained raw SQL override without parsing it as TypeScript", async () => {
    const directory = mkdtempSync(join(tmpdir(), "schema-source-override-"));
    const source = join(directory, "source.sql");
    const target = join(directory, "migrations");
    const embedded = join(directory, "worker.sql");
    const sql = 'CREATE TABLE "user" ("uid" integer PRIMARY KEY);';
    mkdirSync(target);
    writeFileSync(source, 'CREATE TABLE `eb_user` (`uid` int NOT NULL PRIMARY KEY);');
    writeFileSync(join(target, "0000.sql"), sql);
    writeFileSync(embedded, sql);
    const writes: string[] = [];
    const output: Pick<typeof process.stdout, "write"> = process.stdout;
    const stdout = vi.spyOn(output, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    vi.stubEnv("SOURCE_SCHEMA_SQL", source);
    vi.stubEnv("TARGET_MIGRATIONS_DIR", target);
    vi.stubEnv("TARGET_EMBEDDED_MIGRATION_SOURCE", embedded);
    try {
      await expect(migrationMain(["schema-audit", "--json"])).resolves.toBeUndefined();
      const report = JSON.parse(writes.join(""));
      expect(report.definitionDrift).toMatchObject({ externalTableCount: 1, workerTableCount: 1,
        externalOnlyTables: [], workerOnlyTables: [], columnDrift: [] });
      expect(report.declarationScan).toMatchObject({ mode: "explicit-source-override",
        interpretation: "declared-source-not-installed-catalog", installationEquivalenceProven: false,
        staticLiteralSupplement: [], unresolved: [], completeStaticSqlExtraction: false,
        unresolvedListExhaustive: false,
        staticLiteralExtractionScope: "explicit-self-contained-source-override-not-typescript-parsed" });
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
