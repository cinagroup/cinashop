import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/models/schema";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const modelExports: Record<string, unknown> = schema;
const tables = Object.values(modelExports).filter((value): value is PgTable => is(value, PgTable));
const tableNames = tables.map((table) => getTableConfig(table).name).sort();

function outputDigest(directory: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory, { recursive: true }).map(String).sort()) {
    if (!/\.(?:sql|json)$/.test(name)) continue;
    hash.update(name).update(readFileSync(join(directory, name)));
  }
  return hash.digest("hex");
}

describe("DB-008 real Drizzle generation", () => {
  it("keeps schema-wide index names unique and restores existing migration names without changing keys", () => {
    const names = new Set<string>();
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const index of config.indexes) {
        const key = `${config.schema ?? "public"}.${index.config.name}`;
        expect(names.has(key), `${key} on ${config.name}`).toBe(false);
        names.add(key);
      }
    }
    const renamed: Array<{ table: PgTable; expected: Record<string, string>; migration: string }> = [
      { table: schema.storeProduct, expected: { sp_is_show_idx: "is_show", sp_sort_idx: "sort", sp_add_time_idx: "add_time" }, migration: "0001_product.sql" },
      { table: schema.userBill, expected: { ub_uid_idx: "uid" }, migration: "0002_order.sql" },
    ];
    for (const { table, expected, migration } of renamed) {
      const config = getTableConfig(table);
      for (const [name, column] of Object.entries(expected)) {
        const index = config.indexes.find((entry) => entry.config.name === name)!;
        expect(index.config.unique).toBe(false);
        expect(index.config.columns).toHaveLength(1);
        expect(index.config.columns[0]).toMatchObject({ name: column });
        expect(readFileSync(join(root, "migrations", migration), "utf8"))
          .toContain(`CREATE INDEX IF NOT EXISTS "${name}" ON "${config.name}" ("${column}");`);
      }
    }
  });

  it("preserves deployed standalone unique indexes and tenant columns without adding constraint entries", () => {
    const keys: Array<{ table: PgTable; name: string; columns: string[] }> = [
      { table: schema.workMemberCurrent, name: "wmc_corp_id_uq", columns: ["corp_id", "id"] },
      { table: schema.workClientCurrent, name: "wcc_corp_external_userid_uq", columns: ["corp_id", "external_userid"] },
      { table: schema.workGroupChatCurrent, name: "wgcc_corp_chat_id_uq", columns: ["corp_id", "chat_id"] },
    ];
    for (const { table, name, columns } of keys) {
      const config = getTableConfig(table);
      expect(config.uniqueConstraints.some((entry) => entry.name === name)).toBe(false);
      const index = config.indexes.find((entry) => entry.config.name === name)!;
      expect(index.config.unique).toBe(true);
      expect(index.config.where).toBeUndefined();
      expect(index.config.columns.map((column) => "name" in column ? column.name : "<expression>")).toEqual(columns);
    }
  });

  it("generates from the real config/schema, executes all generated SQL in memory and is stable on rerun", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cinashop-drizzle-generation-"));
    const output = join(temporary, "generated");
    const config = join(temporary, "audit.config.cjs");
    const report = join(temporary, "audit.json");
    const db = new PGlite();
    try {
      // Load the actual TS/default-export config through Drizzle's own loader;
      // redirect only output, retaining the real cwd-relative schema glob.
      // Never write repository migrations.
      writeFileSync(config, `const source = require(${JSON.stringify(join(root, "drizzle.config.ts"))});
const base = source.default ?? source;
if (base.dialect !== 'postgresql' || base.schema !== './src/models/schema/index.ts' || base.out !== './migrations') throw new Error('Re-audit changed Drizzle configuration');
module.exports = { ...base, out: ${JSON.stringify(relative(root, output).replaceAll("\\", "/"))} };
`);
      const environment = { ...process.env };
      const allowed = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA"]);
      for (const key of Object.keys(environment)) if (!allowed.has(key)) delete environment[key];
      Object.assign(environment, { CI: "1", TSX_DISABLE_CACHE: "1", DATABASE_URL: "postgresql://audit:audit@127.0.0.1:9/audit", CINASHOP_DRIZZLE_AUDIT_REPORT: report });
      const cli = join(dirname(require.resolve("drizzle-kit")), "bin.cjs");
      const run = (command: "generate" | "export" = "generate") => {
        const result = spawnSync(process.execPath, ["--require", join(root, "test/helpers/drizzleCliAudit.cjs"), cli, command, "--config", config, ...(command === "generate" ? ["--name", "audit"] : [])], {
          cwd: root, env: environment, encoding: "utf8", timeout: 45_000, windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const audit = JSON.parse(readFileSync(report, "utf8")) as { loaded: string[]; esbuild: [string, string][]; networkAttempts: number; blockedSockets: string[] };
        if (audit.networkAttempts) console.log(JSON.stringify({ blockedDrizzleSockets: audit.blockedSockets }));
        expect(audit.networkAttempts).toBe(0);
        expect(audit.loaded).toContain("drizzle.config.ts");
        expect(audit.loaded).toContain("src/models/schema/index.ts");
        expect(audit.loaded.filter((path) => path.includes("/@esbuild-kit/"))).toEqual([]);
        expect(audit.esbuild.length).toBeGreaterThan(0);
        for (const [, version] of audit.esbuild) {
          const [major, minor] = version.split(".").map(Number);
          expect(major > 0 || minor >= 25, version).toBe(true);
        }
        return result.stdout;
      };
      run();
      expect(readdirSync(output).filter((name) => name.endsWith(".sql"))).toEqual(["0000_audit.sql"]);
      const snapshot = JSON.parse(readFileSync(join(output, "meta/0000_snapshot.json"), "utf8"));
      expect(Object.values(snapshot.tables).map((table) => (table as { name: string }).name).sort()).toEqual(tableNames);
      await db.exec(readFileSync(join(output, "0000_audit.sql"), "utf8"));
      // Exact deployed closed-surface guards must still accept generated keys.
      for (const [migration, tag] of [
        ["0115_work_client_current_projection.sql", "work_client_closed_surface_verification"],
        ["0116_work_group_chat_current_projection.sql", "work_group_chat_closed_surface_verification"],
      ]) {
        const sql = readFileSync(join(root, "migrations", migration), "utf8");
        const start = sql.indexOf(`DO $${tag}$`);
        const end = sql.indexOf(`$${tag}$;`, start) + tag.length + 3;
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        await db.exec(sql.slice(start, end));
      }
      const actual = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      expect(actual.rows.map((row) => row.tablename)).toEqual(tableNames);
      const sequence = await db.query<{ uid: number }>("SELECT nextval('kefu_visitor_uid_seq')::int AS uid");
      expect(sequence.rows).toEqual([{ uid: 1_000_000_000 }]);
      const bounds = await db.query("SELECT start_value, min_value, max_value, increment_by, cycle FROM pg_sequences WHERE schemaname='public' AND sequencename='kefu_visitor_uid_seq'");
      expect(bounds.rows).toEqual([{ start_value: 1_000_000_000, min_value: 1, max_value: 2_147_483_647, increment_by: 1, cycle: false }]);
      const guest = await db.query<{ visitor_uid: number }>(`INSERT INTO kefu_visitor_session
        (session_id, service_id, kefu_uid, token_hash, created_at, expires_at, last_seen_at)
        VALUES ('drizzle-audit-only', 1, 2, $1, 1, 10, 1) RETURNING visitor_uid`, ["a".repeat(64)]);
      expect(guest.rows).toEqual([{ visitor_uid: 1_000_000_001 }]);
      const member = await db.query<{ id: number }>("INSERT INTO work_member_current (corp_id, userid, canonical_userid) VALUES ('corp_a','alice','alice') RETURNING id");
      await db.query("INSERT INTO work_member_relation_current (corp_id, member_id, department_id) VALUES ('corp_a',$1,1)", [member.rows[0].id]);
      await expect(db.query("INSERT INTO work_member_relation_current (corp_id, member_id, department_id) VALUES ('corp_b',$1,1)", [member.rows[0].id]))
        .rejects.toMatchObject({ code: "23503" });
      await db.query("DELETE FROM work_member_current WHERE id=$1", [member.rows[0].id]);
      expect((await db.query("SELECT * FROM work_member_relation_current")).rows).toEqual([]);
      const before = outputDigest(output);
      expect(run()).toContain("No schema changes");
      expect(outputDigest(output)).toBe(before);
      const exported = run("export");
      expect(exported.match(/CREATE TABLE /g)).toHaveLength(tableNames.length);
      expect(exported.match(/CREATE SEQUENCE /g)).toHaveLength(1);
      expect(outputDigest(output)).toBe(before);
      console.log(JSON.stringify({ drizzleGeneration: { tables: tableNames.length, explicitIndexes: tables.reduce((sum, table) => sum + getTableConfig(table).indexes.length, 0), rerunUnchanged: true, networkAttempts: 0 } }));
    } finally {
      await db.close();
      rmSync(temporary, { recursive: true, force: true }); // Only our fresh fixture.
    }
  }, 120_000);
});
