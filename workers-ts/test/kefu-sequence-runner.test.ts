import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as api from "drizzle-kit/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as models from "../src/models/schema";
import type { DbClient } from "../src/lib/di";
import { KEFU_SEQUENCE_ALIGNMENT_SQL } from "../src/migrations/kefuSequenceAlignment";
import { runKefuSequenceAlignment } from "../src/migrations/runKefuSequenceAlignment";
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from "./helpers/kefuSequenceRunnerDatabase";

const require = createRequire(import.meta.url);
const auditKefuSequence = require("./helpers/kefuSequenceAudit.cjs");
const dialect = new PgDialect();
type Root = Parameters<typeof runKefuSequenceAlignment>[0];
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Hook = (tx: Tx, statement: string, position: number) => Promise<void>;
// Instrumentation delegates every statement/transaction to the actual driver.
// It exists only here to inspect settings before dispatch and inject SQL errors.
function observed(db: Root, before?: Hook, after?: Hook): Root {
  return { $client: db.$client, transaction: (callback, config) => db.transaction(async tx => {
    let position = 0;
    const proxy = new Proxy(tx, { get(target, key, receiver) {
      if (key === "execute") return async (query: SQL) => {
        const statement = dialect.sqlToQuery(query).sql, index = position++;
        await before?.(tx, statement, index);
        const result = await tx.execute(query);
        await after?.(tx, statement, index);
        return result;
      };
      return Reflect.get(target, key, receiver);
    } });
    return callback(proxy);
  }, config) };
}

const settingsSql = `SELECT name,setting FROM pg_catalog.pg_settings
  WHERE name IN ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
    'search_path','transaction_isolation','default_transaction_isolation') ORDER BY name`;

describe("standalone sequence transaction execution boundary", () => {
  let fixture: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let fullPath: Record<string, unknown>;
  const query = async (statement: string) => (await fixture.query(statement)).rows;
  const settings = () => query(settingsSql);
  const capture = async () => ({
    identity: await query(`SELECT c.oid,to_jsonb(c) AS metadata,to_jsonb(s) AS options
      FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid WHERE c.oid='public.kefu_visitor_uid_seq'::regclass`),
    counter: await query("SELECT last_value::text,is_called,log_cnt::text FROM public.kefu_visitor_uid_seq"),
    dependencies: await query(`SELECT * FROM pg_depend WHERE classid='pg_class'::regclass
      AND objid='public.kefu_visitor_uid_seq'::regclass ORDER BY refclassid,refobjid,refobjsubid,deptype`),
    rows: await query("SELECT to_jsonb(s) AS row FROM public.kefu_visitor_session s ORDER BY session_id"),
  });

  beforeAll(async () => {
    fixture = await sequenceRunnerDatabase();
    fullPath = await auditKefuSequence({ api, models, format: `runner-${fixture.format}`, database: fixture,
      runAlignment: () => runKefuSequenceAlignment(fixture.db) });
  }, 180_000);
  afterAll(async () => {
    if (fixture) {
      await fixture.close();
      process.stdout.write("KEFU_SEQUENCE_RUNNER_AUDIT " + JSON.stringify({ format: fixture.format, fullOldModelPath: fullPath,
        databaseRemovedAndAbsenceVerified: fixture.format === "pg16", localMemoryClosed: fixture.format === "pglite" }) + "\n");
    }
  });
  beforeEach(async () => {
    await fixture.exec(`RESET ALL;
      SET statement_timeout='30s'; SET lock_timeout='3s';
      SET search_path TO pg_catalog;
      ALTER SEQUENCE public.kefu_visitor_uid_seq OWNED BY NONE;
      ALTER SEQUENCE public.kefu_visitor_uid_seq AS bigint MINVALUE 1 MAXVALUE 2147483647 CACHE 1;`);
  });

  it("runs the full actual old ORM model, thirty refusals and committed upgrade through the standalone function", () => {
    // The current ORM also includes the independent 0146 recovery scan index.
    expect(fullPath.initialStatements).toBe(1077);
    expect(fullPath.committedUpgradeExecution).toBe("standalone-drizzle-transaction");
    expect(fullPath.driftRefusals).toHaveLength(30);
    expect(fullPath.originalOidsRowsAclRolesCommentsAndNonTargetObjectsPreserved).toBe(true);
    expect(fullPath.noOpStorageAndCounterConfirmed).toBe(true);
    expect(fullPath.syntheticRowsCleanupConfirmed).toBe(true);
    if (fixture.format === "pg16") expect(fullPath.lockVerification).toMatchObject({
      waitRefused: true, directNextvalSetvalAndTableWriterBlocked: true, concurrentDistinctNumbers: 16,
    });
    else expect(fullPath.lockVerification).toBeNull();
  });

  it.each([[0, 0, 30000, 5000], [120000, 12000, 30000, 5000], [15000, 3000, 15000, 3000]])(
    "bounds session timeouts %i/%i before the DO, retains stricter values, restores all settings", async (statement, idle, expectedStatement, expectedIdle) => {
      await fixture.exec(`SET statement_timeout='${statement}ms'; SET idle_in_transaction_session_timeout='${idle}ms';
        SET default_transaction_isolation='serializable'`);
      const original = await settings(), before = await capture();
      const calls: string[] = [];
      await runKefuSequenceAlignment(observed(fixture.db, async (tx, statement) => {
        calls.push(statement);
        if (statement === KEFU_SEQUENCE_ALIGNMENT_SQL) {
          const result = await tx.execute(sql.raw(settingsSql));
          // PGlite returns {rows}; postgres-js returns an array. Only test code adapts it.
          const rows = Array.isArray(result) ? result : (result as unknown as { rows: Array<{ name: string; setting: string }> }).rows;
          const values = Object.fromEntries(rows.map(r => [r.name, r.setting]));
          expect(values).toMatchObject({ statement_timeout: String(expectedStatement),
            idle_in_transaction_session_timeout: String(expectedIdle), search_path: "public, pg_temp",
            transaction_isolation: "read committed", default_transaction_isolation: "serializable" });
        }
      }));
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe("SET LOCAL search_path TO public, pg_temp");
      expect(calls[1]).toContain("set_config('statement_timeout'");
      expect(calls[2]).toBe(KEFU_SEQUENCE_ALIGNMENT_SQL);
      expect(await settings()).toEqual(original);
      const after = await capture();
      expect(after.counter).toEqual(before.counter);
      expect(after.rows).toEqual(before.rows);
      await runKefuSequenceAlignment(fixture.db);
      expect(await capture()).toEqual(after);
      expect(await settings()).toEqual(original);
    }, 20_000);

  it("propagates failure after the real ALTER and rolls back storage, ownership and all LOCAL settings", async () => {
    const before = await capture(), original = await settings();
    await expect(runKefuSequenceAlignment(observed(fixture.db, undefined, async (tx, statement) => {
      if (statement === KEFU_SEQUENCE_ALIGNMENT_SQL) await tx.execute(sql.raw("SELECT 1/0"));
    }))).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(await capture()).toEqual(before);
    expect(await settings()).toEqual(original);
  });

  it("rolls back a setup failure without dispatching the migration or swallowing the original error", async () => {
    const original = await settings(), before = await capture(), failure = new Error("isolated setup probe");
    let calls = 0;
    await expect(runKefuSequenceAlignment(observed(fixture.db, undefined, async (_tx, _sql, index) => {
      calls++;
      if (index === 1) throw failure;
    }))).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(await capture()).toEqual(before);
    expect(await settings()).toEqual(original);
  });

  it("fails closed on actual definition drift and restores the connection for the next request", async () => {
    await fixture.exec("ALTER SEQUENCE public.kefu_visitor_uid_seq CACHE 2");
    const before = await capture(), original = await settings();
    await expect(runKefuSequenceAlignment(fixture.db)).rejects.toMatchObject({ cause: { code: "P0001" } });
    expect(await capture()).toEqual(before);
    expect(await settings()).toEqual(original);
  });

  it("rejects a real nested Drizzle transaction before using a savepoint or acquiring migration locks", async () => {
    const before = await capture();
    await fixture.db.transaction(async tx => {
      await expect(runKefuSequenceAlignment(tx as unknown as Root)).rejects.toThrow("root database");
    });
    expect(await capture()).toEqual(before);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("PostgreSQL 16: an existing 500ms deadline actually cancels the blocked DO and rolls back", async () => {
    expect(fixture.format).toBe("pg16");
    await fixture.exec("SET statement_timeout='500ms'");
    const before = await capture(), original = await settings();
    await fixture.withPeer!(async peer => {
      await peer.exec("BEGIN; LOCK TABLE public.kefu_visitor_session IN ACCESS EXCLUSIVE MODE");
      try {
        await expect(runKefuSequenceAlignment(fixture.db)).rejects.toMatchObject({ cause: { code: "57014" } });
      } finally { await peer.exec("ROLLBACK"); }
    });
    expect(await capture()).toEqual(before);
    expect(await settings()).toEqual(original);
  }, 10_000);

  it("has fixed SQL with no migration replay, connection creation, retry loop or arbitrary schema/SQL argument", () => {
    const source = readFileSync(new URL("../src/migrations/runKefuSequenceAlignment.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(fetch|process|postgres|createDb|setTimeout)\s*[.(]|\b(for|while)\s*\(/);
    expect(source.match(/await tx\.execute\(/g)).toHaveLength(3);
    expect(source).toContain('{ isolationLevel: "read committed" }');
    expect(source).toContain('import type { DbClient }');
  });

  it("rejects remote, production-named, wrong-role and option-injected test URLs before creating clients", () => {
    const valid = "postgresql://finance_test:fixture@127.0.0.1:5432/cinashop_finance_test";
    expect(validateSequenceRunnerTestUrl(valid).hostname).toBe("127.0.0.1");
    for (const value of ["not-a-url", valid.replace("127.0.0.1", "db.example.com"),
      valid.replace("cinashop_finance_test", "production"), valid.replace("finance_test:", "admin:"),
      valid.replace("postgresql:", "https:"), `${valid}?options=-c%20search_path%3Dpublic`, `${valid}#fragment`])
      expect(() => validateSequenceRunnerTestUrl(value)).toThrow();
  });
});
