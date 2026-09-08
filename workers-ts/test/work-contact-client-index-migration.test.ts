import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { workContactActionOutbox } from "../src/models/schema/work_contact_action";
import { WORK_CONTACT_CLIENT_INDEX_SQL } from "../src/migrations/workContactClientIndex";
import { runWorkContactClientIndex } from "../src/migrations/runWorkContactClientIndex";
import { financePostgres } from "./helpers/financePostgres";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

const external = readFileSync("migrations/0148_work_contact_client_index.sql", "utf8");
const dialect = new PgDialect(), indexName = "wcao_client_ref";
type Root = Parameters<typeof runWorkContactClientIndex>[0];
function messages(error: unknown): string {
  return error instanceof Error ? error.message + (error.cause ? " " + messages(error.cause) : "") : String(error);
}

describe("0148 all-state customer reference index upgrade", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture() {
    // Shape/refusal unit fixture uses actual model columns/defaults/PK. Full
    // unmodified ORM constraints and actual parent actions are checked separately.
    f = await financePostgres([workContactActionOutbox]);
    await f.db.insert(workContactActionOutbox).values([1, 2].map(n => ({ eventId: n, eventKey: "a".repeat(64),
      actionKey: n.toString(16).padStart(64, "0"), actionType: "AUTO_TAG" as const,
      corpId: "fixture", clientId: n, payloadHash: "b".repeat(64), status: n === 1 ? "PENDING" as const : "CLOSED" as const })));
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) p(n)`);
    return { ...f, schema: identity.schema };
  }
  async function catalog(db = f?.db) {
    if (!db) throw new Error("Missing fixture");
    return db.select({ oid: sql<string>`c.oid::text`, name: sql<string>`c.relname`, file: sql<string>`c.relfilenode::text`,
      kind: sql<string>`c.relkind`, definition: sql<string | null>`CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END` })
      .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
      .where(sql`n.nspname=current_schema()`).orderBy(sql`c.relname`);
  }
  async function data() {
    if (!f) throw new Error("Missing fixture");
    return { rows: await f.db.select().from(workContactActionOutbox).orderBy(workContactActionOutbox.id),
      sequence: await f.db.select({ value: sql<string>`last_value::text`, called: sql<boolean>`is_called` })
        .from(sql`work_contact_action_outbox_id_seq`),
      statistics: await f.db.select({ name: sql<string>`attname`, target: sql<number>`attstattarget`, options: sql<unknown>`attoptions` })
        .from(sql`pg_attribute`).where(sql`attrelid='work_contact_action_outbox'::regclass AND attnum>0`).orderBy(sql`attnum`) };
  }
  it("keeps exact additive external/embedded SQL, independent registration and nine-path positive gates", () => {
    expect(external.trim()).toBe(WORK_CONTACT_CLIENT_INDEX_SQL.trim());
    expect(external).not.toMatch(/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|ANALYZE|nextval|setval)\b/i);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service.match(/this\.migration_0154\(\)/g)).toHaveLength(1);
    expect(service).toContain("return WORK_CONTACT_CLIENT_INDEX_SQL;");
    expect(service).toContain("await runWorkContactClientIndex(this.container.db)");
    const audit = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(audit).toContain('requiredIndexKeys.push("work_contact_action_outbox.wcao_client_ref")');
    for (const path of ["embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names", "orm_checks", "orm_sequences"])
      expect(audit).toContain(`assertIndexContracts(catalogs.external, catalogs.${path}, requiredIndexKeys)`);
  });
  it("adds only the missing index and is repeatable without changing rows, sequences or column statistics", async () => {
    const { db, schema } = await fixture();
    const before = await catalog(), original = await data();
    await db.transaction(tx => tx.execute(sql.raw(external)));
    const installed = await catalog();
    expect(installed.filter(row => row.name !== indexName)).toEqual(before);
    expect(installed.filter(row => row.name === indexName)).toHaveLength(1);
    await runWorkContactClientIndex(db, schema);
    await runWorkContactClientIndex(db, schema);
    expect(await catalog()).toEqual(installed);
    expect(await data()).toEqual(original);
  });
  it("accepts the complete real ORM-generated index without replacing any object", async () => {
    const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
    const orm = await sequenceRunnerDatabase();
    try {
      const statements = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models));
      await orm.exec(statements.join("\n"));
      const before = await catalog(orm.db);
      expect(before.filter(row => row.name === indexName)).toHaveLength(1);
      await runWorkContactClientIndex(orm.db);
      await runWorkContactClientIndex(orm.db);
      expect(await catalog(orm.db)).toEqual(before);
    } finally { await orm.close(); }
  }, 120000);
  it("creates the index on an empty table without creating business rows", async () => {
    f = await financePostgres([workContactActionOutbox]);
    const before = await data();
    await f.db.transaction(tx => tx.execute(sql.raw(external)));
    expect((await catalog()).filter(row => row.name === indexName)).toHaveLength(1);
    expect(await data()).toEqual(before);
  });
  it.each([
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(client_id,corp_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id,client_id) WHERE status='PENDING'",
    "CREATE UNIQUE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id,client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id DESC,client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id NULLS FIRST,client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id,client_id) INCLUDE(id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id,(client_id+0))",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox USING hash(client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id,client_id) WITH(fillfactor=70)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id COLLATE \"C\",client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(corp_id varchar_pattern_ops,client_id)",
    "CREATE INDEX wcao_client_ref ON work_contact_action_outbox(client_id)",
    "CREATE TABLE wcao_client_ref(id integer)",
    "CREATE TABLE other_actions(id integer); CREATE INDEX wcao_client_ref ON other_actions(id)",
    "ALTER TABLE work_contact_action_outbox ADD CONSTRAINT wcao_client_ref UNIQUE(corp_id,client_id)",
  ])("refuses an incompatible same-name object without replacing it: %s", async ddl => {
    const { db, schema, exec } = await fixture();
    await exec(ddl);
    const before = await catalog(), original = await data();
    const result = await outcome(runWorkContactClientIndex(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0148 customer reference index definition drift");
    expect(await catalog()).toEqual(before);
    expect(await data()).toEqual(original);
  });
  it.each([
    "ALTER TABLE work_contact_action_outbox ALTER COLUMN corp_id TYPE varchar(64)",
    "ALTER TABLE work_contact_action_outbox ALTER COLUMN corp_id TYPE varchar(18) COLLATE \"C\"",
    "ALTER TABLE work_contact_action_outbox ALTER COLUMN client_id TYPE bigint",
    "ALTER TABLE work_contact_action_outbox ALTER COLUMN client_id DROP NOT NULL",
    "ALTER TABLE work_contact_action_outbox ALTER COLUMN corp_id DROP NOT NULL",
    "ALTER TABLE work_contact_action_outbox RENAME COLUMN client_id TO old_client_id",
  ])("refuses reference-column drift: %s", async ddl => {
    const { db, schema, exec } = await fixture();
    await exec(ddl);
    const before = await catalog();
    const result = await outcome(runWorkContactClientIndex(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0148 customer reference column drift");
    expect(await catalog()).toEqual(before);
  });
  it("rolls back the addition on caller failure and ignores temporary name shadows", async () => {
    const { db, schema } = await fixture();
    const before = await catalog(), original = await data(), rollback = new Error("fixture rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql`CREATE TEMP TABLE work_contact_action_outbox(id integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE wcao_client_ref(id integer) ON COMMIT DROP`);
      await tx.execute(sql.raw(external));
      const rows = await tx.select({ definition: sql<string>`pg_get_indexdef(c.oid)` })
        .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
        .where(sql`n.nspname=${schema} AND c.relname='wcao_client_ref'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].definition).toContain("(corp_id, client_id)");
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await catalog()).toEqual(before);
    expect(await data()).toEqual(original);
  });
  it.each([
    ["CREATE TABLE inherited_actions() INHERITS(work_contact_action_outbox)", "inherited tables"],
    ["ALTER TABLE work_contact_action_outbox SET UNLOGGED", "expected permanent"],
    ["ALTER TABLE work_contact_action_outbox RENAME TO original_actions", "expected permanent"],
  ])("refuses unsupported table shape: %s", async (ddl, expected) => {
    const { db, schema, exec } = await fixture();
    await exec(ddl);
    const before = await catalog(), result = await outcome(runWorkContactClientIndex(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain(expected);
    expect(await catalog()).toEqual(before);
  });
  it("rejects missing/unsafe schemas and non-root transactions", async () => {
    const { db } = await fixture();
    for (const schema of ["", "pg_catalog", "information_schema", "pg_temp", "public,pg_temp", 'public"', "x".repeat(64)])
      await expect(runWorkContactClientIndex(db, schema)).rejects.toThrow("Invalid customer reference index schema");
    await expect(runWorkContactClientIndex(db, "missing_customer_ref_schema")).rejects.toThrow();
    await db.transaction(async tx => {
      await expect(runWorkContactClientIndex({ transaction: tx.transaction.bind(tx) })).rejects.toThrow("root database");
    });
    expect((await catalog()).some(row => row.name === indexName)).toBe(false);
  });
  it("keeps an explicit second schema isolated from the original tables", async () => {
    const { db, schema } = await fixture();
    const isolated = `client_scope_${crypto.randomUUID().replaceAll("-", "")}`, before = await catalog();
    const rollback = new Error("owned schema rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(isolated)}`);
      await tx.execute(sql`CREATE TABLE ${sql.identifier(isolated)}.work_contact_action_outbox
        (LIKE ${sql.identifier(schema)}.work_contact_action_outbox INCLUDING DEFAULTS)`);
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(isolated)}, ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql.raw(external));
      const scopes = await tx.select({ schema: sql<string>`n.nspname` }).from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
        .where(sql`c.relname='wcao_client_ref' AND n.nspname IN (${schema},${isolated})`);
      expect(scopes).toEqual([{ schema: isolated }]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await catalog()).toEqual(before);
  });
  it("refuses an enabled DDL hook in a whole owned database, including an otherwise valid no-op", async () => {
    // Event triggers are database-wide: never create them in the shared CI DB.
    const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
    const orm = await sequenceRunnerDatabase();
    try {
      const statements = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models));
      await orm.exec(statements.join("\n"));
      await orm.exec(`CREATE FUNCTION public.audit_client_ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$;
        CREATE EVENT TRIGGER audit_client_ddl_hook ON ddl_command_end EXECUTE FUNCTION public.audit_client_ddl_hook()`);
      const before = await catalog(orm.db), result = await outcome(runWorkContactClientIndex(orm.db));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(messages(result.error)).toContain("0148 enabled DDL event triggers");
      expect(await catalog(orm.db)).toEqual(before);
    } finally { await orm.close(); }
  }, 120000);
  it.each([[0,0,"30000","5000"],[120000,12000,"30000","5000"],[15000,3000,"15000","3000"]])(
    "arms bounded deadlines before DO and restores settings %i/%i", async (statement, idle, expectedStatement, expectedIdle) => {
      const { db, schema, exec } = await fixture();
      await exec(`SET statement_timeout='${statement}ms'; SET idle_in_transaction_session_timeout='${idle}ms'`);
      let observed = false;
      const wrapped: Root = { $client: db.$client, transaction: (callback, config) => db.transaction(async tx => {
        const proxy = new Proxy(tx, { get(target, key, receiver) {
          if (key === "execute") return async (query: SQL) => {
            if (dialect.sqlToQuery(query).sql === WORK_CONTACT_CLIENT_INDEX_SQL) {
              const [settings] = await tx.select({ statement: sql<string>`(SELECT setting FROM pg_settings WHERE name='statement_timeout')`,
                idle: sql<string>`(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')`,
                isolation: sql<string>`current_setting('transaction_isolation')` }).from(sql`(values (1)) p(n)`);
              expect(settings).toEqual({ statement: expectedStatement, idle: expectedIdle, isolation: "read committed" });
              observed = true;
            }
            return tx.execute(query);
          };
          return Reflect.get(target, key, receiver);
        } });
        return callback(proxy);
      }, config) };
      await runWorkContactClientIndex(wrapped, schema);
      expect(observed).toBe(true);
      const [after] = await db.select({ statement: sql<string>`(SELECT setting FROM pg_settings WHERE name='statement_timeout')`,
        idle: sql<string>`(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')` }).from(sql`(values (1)) p(n)`);
      expect(after).toEqual({ statement: String(statement), idle: String(idle) });
    });
  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).each([
    { statement: "10s", code: "55P03" }, { statement: "500ms", code: "57014" },
  ])("PG16 rejects a verified writer under $statement and succeeds after release", async ({ statement, code }) => {
    const { db, schema } = await fixture();
    await withFinancePeers(db, async ([writer, upgrader, observer]) => {
      const before = await catalog(), original = await data();
      await upgrader.exec(`SET statement_timeout='${statement}'`);
      await writer.exec("BEGIN");
      try {
        await writer.exec("LOCK TABLE work_contact_action_outbox IN ROW EXCLUSIVE MODE");
        const pending = outcome(runWorkContactClientIndex(upgrader.db, schema));
        await waitForFinanceBlock(observer.db, upgrader.pid, writer.pid);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ cause: { code } });
        expect(await catalog()).toEqual(before);
        expect(await data()).toEqual(original);
        const [settings] = await upgrader.db.select({ lock: sql<string>`current_setting('lock_timeout')`,
          statement: sql<string>`current_setting('statement_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` }).from(sql`(values (1)) p(n)`);
        expect(settings).toEqual({ lock: "8s", statement, idle: "15s" });
      } finally { await writer.exec("ROLLBACK"); }
      await runWorkContactClientIndex(upgrader.db, schema);
      expect((await catalog()).some(row => row.name === indexName)).toBe(true);
    });
  }, 20000);
});
