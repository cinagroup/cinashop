import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { is } from "drizzle-orm";
import { pgSequence, pgSchema, pgTable, integer, PgSequence } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { withSequenceState } from "../src/models/pgSequenceState";

const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, "..");
const kit = dirname(require.resolve("drizzle-kit"));
function environment(report: string) {
  const env = { ...process.env }, allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
  for (const key of Object.keys(env)) if (!allowed.has(key)) delete env[key];
  return { ...env, CI: "1", TSX_DISABLE_CACHE: "1", CINASHOP_DRIZZLE_AUDIT_REPORT: report };
}
function reportChecked(report: string) {
  const result = JSON.parse(readFileSync(report, "utf8"));
  expect(result.networkAttempts).toBe(0);
  expect(result.loaded.filter((p: string) => p.includes("/@esbuild-kit/"))).toEqual([]);
}
function cleanup(directory: string) {
  const path = resolve(directory);
  if (dirname(path) !== resolve(tmpdir()) || !/^cinashop-sequence-[A-Za-z0-9]+$/.test(basename(path)))
    throw new Error("Unsafe isolated sequence test cleanup");
  rmSync(path, { recursive: true, force: true });
}
describe("DB-009E5 typed sequence generator prerequisite", () => {
  it("decorates a local sequence only, resolves the owning column lazily and rejects foreign objects", () => {
    const plain = pgSequence("counter", { startWith: 100 });
    let evaluated = 0;
    const marked = withSequenceState(plain, { dataType: "integer", ownedBy: () => { evaluated++; return owner.uid; } });
    const owner = pgTable("owner", { uid: integer() });
    expect(evaluated).toBe(0);
    expect(is(marked, PgSequence)).toBe(true);
    expect(Object.getPrototypeOf(marked)).toBe(Object.getPrototypeOf(plain));
    expect(plain).not.toHaveProperty("cinashopSequence");
    expect(marked).toHaveProperty("cinashopSequence", { dataType: "integer", ownedBy: { schema: "public", table: "owner", column: "uid" } });
    expect(marked.seqOptions).toEqual(plain.seqOptions);
    const detached = withSequenceState(marked, { dataType: "smallint", ownedBy: null });
    expect(detached).toHaveProperty("cinashopSequence", { dataType: "smallint", ownedBy: null });
    expect(marked).toHaveProperty("cinashopSequence.dataType", "integer");
    // @ts-expect-error Only real PostgreSQL sequences are supported.
    expect(() => withSequenceState(owner, { dataType: "integer", ownedBy: null })).toThrow();
    // @ts-expect-error Types are deliberately restricted to PostgreSQL sequence types.
    expect(() => withSequenceState(plain, { dataType: "text", ownedBy: null })).toThrow();
    // @ts-expect-error Callbacks must resolve to an actual PostgreSQL column.
    const wrong = withSequenceState(plain, { dataType: "integer", ownedBy: () => owner });
    expect(() => Object.entries(wrong)).toThrow("PostgreSQL column");
    const tenant = pgSchema("tenant").table("owner", { uid: integer() });
    expect(() => Object.entries(withSequenceState(plain, { dataType: "integer", ownedBy: () => tenant.uid }))).toThrow("share a schema");
  });

  it.each(["bin.cjs", "api.js", "api.mjs"])("pins %s, preserves the previous patch as an upgrade input and refuses partial sequence edits", filename => {
    const patch = require("../scripts/patch-drizzle-pg-order.cjs");
    const old = require("../scripts/drizzle-pg-not-valid-patch.cjs");
    const { edits } = require("../scripts/drizzle-pg-sequence-patch.cjs");
      const source = readFileSync(join(kit, filename), "utf8");
      const original = patch.originalSource(filename, source);
      const previous = old.rewrite(original.replace(patch.before, patch.after), old.edits(filename));
      expect(patch.patchSource(filename, previous)).toBe(source);
      expect(patch.patchSource(filename, source)).toBe(source);
      // An unknown first input cannot seed the trusted-variant cache.
      const patchPath = require.resolve("../scripts/patch-drizzle-pg-order.cjs");
      delete require.cache[patchPath];
      const cold = require(patchPath);
      expect(() => cold.patchSource(filename, source + "\n// unknown first input")).toThrow("checksum/order drift");
      expect(cold.patchSource(filename, source)).toBe(source);
      for (const rule of edits(filename)) {
        expect(source).toContain(rule.after);
        expect(() => patch.patchSource(filename, source.replace(rule.after, rule.before))).toThrow("checksum/order drift");
      }
      for (const mutation of [source.replace('" NO CYCLE;"', '";"'), source.replace('" OWNED BY "', '" OWNER TO "'),
        source.replace("seqtypid::regtype", "seqstart::regtype")]) {
        expect(mutation).not.toBe(source);
        expect(() => patch.patchSource(filename, mutation)).toThrow("checksum/order drift");
      }
  });

  it.each(["cjs", "esm"])("executes the actual %s API with network denied", format => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-sequence-")), report = join(directory, "audit.json");
    try {
      const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"),
        join(root, "test/helpers/sequenceStateGeneratorLocal.cjs"), format], {
        cwd: root, env: environment(report), encoding: "utf8", timeout: 30_000, windowsHide: true,
      });
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("DB-009E5 " + format + ": sequence generation/state/ownership/rollback verified");
      reportChecked(report);
    } finally { cleanup(directory); }
  }, 45_000);

  it("round-trips actual CLI snapshots, ordered SQL, incremental ownership, exports and unchanged repeated generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cinashop-sequence-")), report = join(directory, "audit.json");
    const config = join(directory, "config.cjs"), schema = join(directory, "schema.ts"), output = join(directory, "out"), fresh = join(directory, "fresh");
    const db = new PGlite();
    try {
      writeFileSync(schema, "module.exports = require(" + JSON.stringify(join(root, "test/helpers/sequenceStateSchema.cjs")) + ")(process.env.SEQUENCE_TEST_MODE);");
      writeFileSync(config, "module.exports = { dialect: 'postgresql', schema: " + JSON.stringify(relative(root, schema).replaceAll("\\", "/")) + ", out: process.env.SEQUENCE_TEST_OUTPUT };");
      const run = (mode: string, destination = output, command = "generate") => {
        const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"),
          join(kit, "bin.cjs"), command, "--config=" + config, ...(command === "generate" ? ["--name=audit"] : [])], {
          cwd: root, env: { ...environment(report), SEQUENCE_TEST_MODE: mode, SEQUENCE_TEST_OUTPUT: relative(root, destination).replaceAll("\\", "/") },
          encoding: "utf8", timeout: 30_000, windowsHide: true,
        });
        expect(result.error, result.stdout + result.stderr).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stderr).not.toMatch(/DB-009E5:|Error:/);
        reportChecked(report); return result.stdout;
      };
      run("baseline"); await db.exec(readFileSync(join(output, "0000_audit.sql"), "utf8"));
      await db.exec("INSERT INTO seq_small_owner(memo) VALUES ('existing')");
      run("target");
      const delta = readFileSync(join(output, "0001_audit.sql"), "utf8");
      expect(delta.match(/ OWNED BY /g)).toHaveLength(4);
      expect(delta).not.toMatch(/DROP SEQUENCE|RESTART|setval/);
      await db.exec(delta);
      expect((await db.query("INSERT INTO seq_small_owner(memo) VALUES ('next') RETURNING uid")).rows).toEqual([{ uid: 11 }]);
      const snapshot = JSON.parse(readFileSync(join(output, "meta/0001_snapshot.json"), "utf8"));
      expect(snapshot.sequences["public.seq_small"].cinashopSequence).toEqual({ dataType: "smallint", ownedBy: { schema: "public", table: "seq_small_owner", column: "uid" } });
      expect(snapshot.sequences["public.seq_big"].startWith).toBe("9007199254740993");
      const contents = () => readdirSync(output, { recursive: true }).map(String).filter(p => /\.(sql|json)$/.test(p)).sort().map(p => [p, readFileSync(join(output, p), "utf8")]);
      const before = contents(); expect(run("target")).toContain("No schema changes"); expect(contents()).toEqual(before);
      run("target", fresh);
      const initial = readFileSync(join(fresh, "0000_audit.sql"), "utf8"), freshDb = new PGlite();
      try { await freshDb.exec(initial); } finally { await freshDb.close(); }
      const exported = run("target", output, "export");
      expect(exported.match(/ OWNED BY /g)).toHaveLength(4);
      expect(exported).toContain('CREATE SEQUENCE "public"."quoted""sequence;" AS integer');
      const exportDb = new PGlite();
      try { await exportDb.exec(exported); } finally { await exportDb.close(); }
      expect(contents()).toEqual(before);
    } finally { await db.close(); cleanup(directory); }
  }, 120_000);
});
