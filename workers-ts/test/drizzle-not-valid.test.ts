import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { check, foreignKey, getTableConfig, integer, pgTable, unique } from "drizzle-orm/pg-core";
import { check as mysqlCheck } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { notValid } from "../src/models/pgNotValid";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const kit = dirname(require.resolve("drizzle-kit"));
function environment(report: string) {
  const result = { ...process.env };
  const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) delete result[key];
  return { ...result, CI: "1", TSX_DISABLE_CACHE: "1", CINASHOP_DRIZZLE_AUDIT_REPORT: report };
}
function assertReport(report: string) {
  const result = JSON.parse(readFileSync(report, "utf8"));
  expect(result.networkAttempts).toBe(0);
  expect(result.loaded.filter((path: string) => path.includes("/@esbuild-kit/"))).toEqual([]);
}

describe("DB-009E2A explicit PostgreSQL NOT VALID generator prerequisite", () => {
  it("decorates only local CHECK/FK builders, without changing originals, prototypes or fluent actions", () => {
    const original = check("amount_ck", sql`amount >= 0`);
    const prototypeBuild = Object.getPrototypeOf(original).build;
    const marked = notValid(notValid(original));
    const plainTable = pgTable("plain", { amount: integer() }, () => [original]);
    const table = pgTable("marked", { amount: integer() }, () => [marked]);
    expect(getTableConfig(plainTable).checks[0]).not.toHaveProperty("notValid");
    expect(getTableConfig(table).checks[0]).toHaveProperty("notValid", true);
    expect(Object.getPrototypeOf(original).build).toBe(prototypeBuild);
    const parent = pgTable("parent", { id: integer().primaryKey() });
    const child = pgTable("child", { id: integer() }, t => {
      const fk = foreignKey({ name: "child_fk", columns: [t.id], foreignColumns: [parent.id] });
      const nv = notValid(fk).onDelete("cascade").onUpdate("restrict");
      expect(fk).not.toHaveProperty("_onDelete", "cascade");
      return [nv];
    });
    expect(getTableConfig(child).foreignKeys[0]).toMatchObject({ notValid: true, onDelete: "cascade", onUpdate: "restrict" });
    // @ts-expect-error Unique constraints do not support NOT VALID.
    expect(() => notValid(unique("wrong"))).toThrow("only supports PostgreSQL");
    // @ts-expect-error The marker is PostgreSQL-specific, not a dialect-wide flag.
    expect(() => notValid(mysqlCheck("wrong", sql`1=1`))).toThrow("only supports PostgreSQL");
  });

  it("rejects partial or forged new patches, including altered metadata, SQL suffixes and introspection guards", () => {
    const patch = require("../scripts/patch-drizzle-pg-order.cjs");
    const { edits } = require("../scripts/drizzle-pg-not-valid-patch.cjs");
    for (const file of Object.keys(patch.hashes)) {
      const source = readFileSync(join(kit, file), "utf8");
      const original = patch.originalSource(file, source);
      expect(createHash("sha256").update(original).digest("hex")).toBe(patch.hashes[file]);
      for (const rule of edits(file)) {
        expect(source).toContain(rule.after);
        expect(() => patch.patchSource(file, source.replace(rule.after, rule.before))).toThrow("checksum/order drift");
      }
      for (const mutation of [source.replace('notValid: literalType(true)', 'notValid: booleanType()'),
        source.replace('" NOT VALID"', '""'), source.replace("AND NOT con.convalidated", "AND con.convalidated")]) {
        expect(mutation).not.toBe(source);
        expect(() => patch.patchSource(file, mutation)).toThrow("checksum/order drift");
      }
    }
  });

  it.each(["cjs", "esm"])("executes %s persisted/fresh/upgrade/invalid-row tests with sockets denied", format => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-not-valid-api-"));
    const report = join(directory, "audit.json");
    try {
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"),
        join(root, "test/helpers/notValidLocalAudit.cjs"), format], {
        cwd: root, env: environment(report), encoding: "utf8", timeout: 30_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`DB-009E2A ${format}: 5 NOT VALID constraints`);
      assertReport(report);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 45_000);

  it("executes actual CLI fresh/upgrade/export SQL and persisted snapshots with a byte-stable no-op", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-not-valid-cli-"));
    const report = join(directory, "audit.json");
    const schemaFile = join(directory, "schema.ts");
    const config = join(directory, "config.cjs");
    const output = join(directory, "generated");
    const freshOutput = join(directory, "fresh");
    const db = new PGlite();
    try {
      writeFileSync(schemaFile, `module.exports = require(${JSON.stringify(join(root, "test/helpers/notValidSchema.cjs"))})(process.env.CINASHOP_NOT_VALID_MODE);`);
      writeFileSync(config, `module.exports = { dialect: 'postgresql', schema: ${JSON.stringify(relative(root, schemaFile).replaceAll("\\", "/"))}, out: process.env.CINASHOP_NOT_VALID_OUT };`);
      const run = (mode: string, out = output, command = "generate") => {
        const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"),
          join(kit, "bin.cjs"), command, `--config=${config}`, ...(command === "generate" ? ["--name=audit"] : [])], {
          cwd: root, env: { ...environment(report), CINASHOP_NOT_VALID_MODE: mode,
            CINASHOP_NOT_VALID_OUT: relative(root, out).replaceAll("\\", "/") },
          encoding: "utf8", timeout: 30_000, windowsHide: true,
        });
        expect(result.error, result.stdout + result.stderr).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        assertReport(report);
        return result.stdout;
      };
      run("baseline");
      await db.exec(readFileSync(join(output, "0000_audit.sql"), "utf8"));
      await db.exec("INSERT INTO public.nv_child(id,corp,external,amount,message) VALUES(1,'old',9,-1,'forbidden;token')");
      run("not-valid");
      const delta = readFileSync(join(output, "0001_audit.sql"), "utf8");
      expect(delta.match(/ NOT VALID;/g)).toHaveLength(5);
      expect(delta).not.toMatch(/DROP|VALIDATE CONSTRAINT/);
      await db.exec(delta);
      const expected = ["nv_amount_ck", "nv_child_fk", "nv_message_ck", "nv_tenant_amount_ck", "nv_tenant_fk"].sort();
      const actual = await db.query<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE NOT convalidated ORDER BY conname");
      expect(actual.rows.map(c => c.name)).toEqual(expected);
      expect((await db.query("SELECT amount,message FROM public.nv_child WHERE id=1")).rows).toEqual([{ amount: -1, message: "forbidden;token" }]);
      await expect(db.exec("UPDATE public.nv_child SET memo='modified' WHERE id=1")).rejects.toMatchObject({ code: "23514" });
      const snap = JSON.parse(readFileSync(join(output, "meta/0001_snapshot.json"), "utf8"));
      const constraints = Object.values(snap.tables).flatMap((t: unknown) => {
        const table = t as { checkConstraints: Record<string, { name: string; notValid?: true }>; foreignKeys: Record<string, { name: string; notValid?: true }> };
        return [...Object.values(table.checkConstraints), ...Object.values(table.foreignKeys)];
      });
      expect(constraints.filter(c => c.notValid).map(c => c.name).sort()).toEqual(expected);
      const digest = () => readdirSync(output, { recursive: true }).map(String).filter(p => /\.(sql|json)$/.test(p)).sort()
        .map(p => [p, readFileSync(join(output, p), "utf8")]);
      const before = digest();
      expect(run("not-valid")).toContain("No schema changes");
      expect(digest()).toEqual(before);
      run("not-valid", freshOutput);
      const initial = readFileSync(join(freshOutput, "0000_audit.sql"), "utf8");
      expect(initial.match(/ NOT VALID;/g)).toHaveLength(5);
      const fresh = new PGlite();
      try { await fresh.exec(initial); } finally { await fresh.close(); }
      const exported = run("not-valid", output, "export");
      expect(exported.match(/ NOT VALID;/g)).toHaveLength(5);
      expect(exported).toContain("forbidden;token");
    } finally { await db.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);
});
