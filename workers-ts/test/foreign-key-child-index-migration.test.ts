import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { paymentReconciliationCase } from "../src/models/schema/payment_reconciliation";
import { storeProductReply } from "../src/models/schema/reply";
import { FOREIGN_KEY_CHILD_INDEX_SQL } from "../src/migrations/foreignKeyChildIndexes";
import { runForeignKeyChildIndexes } from "../src/migrations/runForeignKeyChildIndexes";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";

const external = readFileSync("migrations/0147_foreign_key_child_indexes.sql", "utf8");
const names = ["prc_callback_event", "spr_order_cart_info"];
const dialect = new PgDialect();
type Root = Parameters<typeof runForeignKeyChildIndexes>[0];
function messages(error: unknown): string {
  return error instanceof Error ? error.message + (error.cause ? " " + messages(error.cause) : "") : String(error);
}

describe("DB-009G guarded child-index upgrade", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture() {
    f = await financePostgres([paymentReconciliationCase, storeProductReply]);
    await f.db.insert(paymentReconciliationCase).values({ replayKey: "00000000-0000-4000-8000-000000000001",
      provider: "alipay", profile: "alipay", orderNo: "fixture_order", expectedAmountCents: 100, currency: "CNY" });
    await f.db.insert(storeProductReply).values([{ isDel: 0 }, { isDel: 1 }]);
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as p(n)`);
    return { ...f, schema: identity.schema };
  }
  async function catalog(db = f?.db) {
    if (!db) throw new Error("Missing fixture");
    return db.select({ oid: sql<string>`c.oid::text`, name: sql<string>`c.relname`, file: sql<string>`c.relfilenode::text`,
      kind: sql<string>`c.relkind`, definition: sql<string | null>`CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END` })
      .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`).where(sql`n.nspname=current_schema()`).orderBy(sql`c.relname`);
  }
  async function rowsAndSequences() {
    if (!f) throw new Error("Missing fixture");
    return { cases: await f.db.select().from(paymentReconciliationCase).orderBy(paymentReconciliationCase.id),
      replies: await f.db.select().from(storeProductReply).orderBy(storeProductReply.id),
      sequences: await f.db.select({ case: sql<string>`(SELECT last_value::text || ':' || is_called::text FROM payment_reconciliation_case_id_seq)`,
        reply: sql<string>`(SELECT last_value::text || ':' || is_called::text FROM store_product_reply_id_seq)` }).from(sql`(values (1)) as p(n)`) };
  }
  it("keeps exact external/embedded SQL, additive-only DDL and both positive nine-path gates", () => {
    expect(external.trim()).toBe(FOREIGN_KEY_CHILD_INDEX_SQL.trim());
    expect(external).not.toMatch(/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|nextval|setval)\b/i);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service.match(/this\.migration_0153\(\)/g)).toHaveLength(1);
    expect(service).toContain("return FOREIGN_KEY_CHILD_INDEX_SQL;");
    expect(service).toContain("await runForeignKeyChildIndexes(this.container.db)");
    const audit = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(audit).toContain('requiredIndexKeys.push("payment_reconciliation_case.prc_callback_event", "store_product_reply.spr_order_cart_info")');
    for (const path of ["embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names", "orm_checks", "orm_sequences"])
      expect(audit).toContain(`assertIndexContracts(catalogs.external, catalogs.${path}, requiredIndexKeys)`);
  });
  it("upgrades existing rows and repeats without replacing any index/file or advancing sequences", async () => {
    const { db, schema } = await fixture();
    const before = await catalog(), data = await rowsAndSequences();
    await db.transaction(tx => tx.execute(sql.raw(external)));
    const installed = await catalog();
    expect(installed.filter(row => !names.includes(row.name))).toEqual(before);
    expect(installed.filter(row => names.includes(row.name)).map(row => row.name)).toEqual(names);
    await runForeignKeyChildIndexes(db, schema);
    await runForeignKeyChildIndexes(db, schema);
    expect(await catalog()).toEqual(installed);
    expect(await rowsAndSequences()).toEqual(data);
  });
  it("accepts indexes emitted by the real complete ORM generator without replacing them", async () => {
    const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
    const generated = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models));
    // Drizzle emits public-qualified references. Use a whole disposable DB,
    // not public in the shared CI service or a textual schema rewrite.
    const orm = await sequenceRunnerDatabase();
    try {
      await orm.exec(generated.join("\n"));
      const before = await catalog(orm.db);
      expect(before.filter(row => names.includes(row.name)).map(row => row.name)).toEqual(names);
      await runForeignKeyChildIndexes(orm.db);
      await runForeignKeyChildIndexes(orm.db);
      expect(await catalog(orm.db)).toEqual(before);
    } finally { await orm.close(); }
  }, 120000);
  it("creates both indexes on empty tables without manufacturing business rows", async () => {
    f = await financePostgres([paymentReconciliationCase, storeProductReply]);
    await f.db.transaction(tx => tx.execute(sql.raw(external)));
    expect((await catalog()).filter(row => names.includes(row.name))).toHaveLength(2);
    expect(await f.db.select().from(paymentReconciliationCase)).toEqual([]);
    expect(await f.db.select().from(storeProductReply)).toEqual([]);
  });
  it.each([
    ["partial", "CREATE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id) WHERE is_del=0"],
    ["unique", "CREATE UNIQUE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id)"],
    ["descending", "CREATE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id DESC)"],
    ["nulls first", "CREATE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id NULLS FIRST)"],
    ["wrong column", "CREATE INDEX spr_order_cart_info ON store_product_reply(id)"],
    ["included", "CREATE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id) INCLUDE(id)"],
    ["expression", "CREATE INDEX spr_order_cart_info ON store_product_reply((order_cart_info_id+0))"],
    ["hash", "CREATE INDEX spr_order_cart_info ON store_product_reply USING hash(order_cart_info_id)"],
    ["storage", "CREATE INDEX spr_order_cart_info ON store_product_reply(order_cart_info_id) WITH(fillfactor=70)"],
    ["table collision", "CREATE TABLE spr_order_cart_info(id integer)"],
    ["other table", "CREATE INDEX spr_order_cart_info ON payment_reconciliation_case(callback_event_id)"],
    ["constraint owned", "ALTER TABLE store_product_reply ADD CONSTRAINT spr_order_cart_info UNIQUE(order_cart_info_id)"],
    ["first-table partial", "CREATE INDEX prc_callback_event ON payment_reconciliation_case(callback_event_id) WHERE status='OPEN'"],
  ])("rejects %s and rolls back earlier additions without replacing the conflicting object", async (_label, ddl) => {
    const { db, exec, schema } = await fixture();
    await exec(ddl);
    const before = await catalog(), data = await rowsAndSequences();
    const result = await outcome(runForeignKeyChildIndexes(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0147 index definition drift");
    expect(await catalog()).toEqual(before);
    expect(await rowsAndSequences()).toEqual(data);
  });
  it.each([
    "ALTER TABLE store_product_reply ALTER COLUMN order_cart_info_id TYPE bigint",
    "ALTER TABLE payment_reconciliation_case ALTER COLUMN callback_event_id TYPE integer",
    "ALTER TABLE store_product_reply ALTER COLUMN order_cart_info_id SET DEFAULT 0; UPDATE store_product_reply SET order_cart_info_id=0; ALTER TABLE store_product_reply ALTER COLUMN order_cart_info_id SET NOT NULL",
    "ALTER TABLE store_product_reply RENAME COLUMN order_cart_info_id TO old_reference",
  ])("refuses incompatible reference columns: %s", async ddl => {
    const { db, exec, schema } = await fixture();
    await exec(ddl);
    const before = await catalog();
    const result = await outcome(runForeignKeyChildIndexes(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0147 reference column drift");
    expect(await catalog()).toEqual(before);
  });
  it("rolls both indexes back on caller failure", async () => {
    const { db } = await fixture();
    const before = await catalog(), rollback = new Error("isolated rollback");
    await expect(db.transaction(async tx => { await tx.execute(sql.raw(external)); throw rollback; })).rejects.toBe(rollback);
    expect(await catalog()).toEqual(before);
  });
  it("ignores temporary shadows and restores the original caller search path", async () => {
    const { db, schema } = await fixture();
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
      for (const name of ["payment_reconciliation_case", "store_product_reply", ...names])
        await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(name)}(id integer) ON COMMIT DROP`);
      const getPath = () => tx.select({ path: sql<string>`current_setting('search_path')` }).from(sql`(values (1)) as p(n)`);
      const before = await getPath();
      await tx.execute(sql.raw(external));
      expect(await getPath()).toEqual(before);
      const temporary = await tx.select({ count: sql<number>`count(*)::int` }).from(sql`pg_class`)
        .where(sql`relnamespace=pg_my_temp_schema() AND relkind='r'`);
      expect(temporary).toEqual([{ count: 4 }]);
    });
    expect((await catalog()).filter(row => names.includes(row.name))).toHaveLength(2);
  });
  it("rejects missing and invalid schemas and a nested transaction without falling back to public", async () => {
    const { db } = await fixture();
    const before = await catalog();
    for (const schema of ["", "pg_catalog", "pg_temp", "information_schema", "public,pg_temp", 'public"', "x".repeat(64)])
      await expect(runForeignKeyChildIndexes(db, schema)).rejects.toThrow("Invalid foreign key index schema");
    await expect(runForeignKeyChildIndexes(db, "missing_foreign_key_index_schema")).rejects.toThrow();
    await db.transaction(async tx => {
      await expect(runForeignKeyChildIndexes({ transaction: tx.transaction.bind(tx) })).rejects.toThrow("root database");
    });
    expect(await catalog()).toEqual(before);
  });
  it("targets only the explicitly selected schema, leaving the original tables untouched", async () => {
    const { db, schema } = await fixture();
    const before = await catalog(), isolated = `fk_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("owned scope rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(isolated)}`);
      for (const table of ["payment_reconciliation_case", "store_product_reply"])
        await tx.execute(sql`CREATE TABLE ${sql.identifier(isolated)}.${sql.identifier(table)}
          (LIKE ${sql.identifier(schema)}.${sql.identifier(table)} INCLUDING DEFAULTS)`);
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(isolated)}, ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql.raw(external));
      const scopes = await tx.select({ schema: sql<string>`n.nspname`, name: sql<string>`c.relname` })
        .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
        .where(sql`c.relname IN ('prc_callback_event','spr_order_cart_info') AND n.nspname IN (${isolated},${schema})`)
        .orderBy(sql`c.relname`);
      expect(scopes).toEqual(names.map(name => ({ schema: isolated, name })));
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await catalog()).toEqual(before);
  });
  it.each([
    ["inheritance", "CREATE TABLE inherited_reply() INHERITS (store_product_reply)", "inherited tables"],
    ["unlogged", "ALTER TABLE store_product_reply SET UNLOGGED", "expected permanent table"],
    ["missing second table", "ALTER TABLE store_product_reply RENAME TO old_replies", "expected permanent table"],
  ])("refuses %s and leaves the first addition rolled back", async (_name, ddl, expected) => {
    const { db, exec, schema } = await fixture();
    await exec(ddl);
    const before = await catalog();
    const result = await outcome(runForeignKeyChildIndexes(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain(expected);
    expect(await catalog()).toEqual(before);
  });
  it.each([[0, 0, "30000", "5000"], [120000, 12000, "30000", "5000"], [15000, 3000, "15000", "3000"]])(
    "arms bounded deadlines before DDL and restores caller settings %i/%i", async (statement, idle, expectedStatement, expectedIdle) => {
      const { db, exec, schema } = await fixture();
      await exec(`SET statement_timeout='${statement}ms'; SET idle_in_transaction_session_timeout='${idle}ms'`);
      let observed = false;
      const wrapped: Root = { $client: db.$client, transaction: (callback, config) => db.transaction(async tx => {
        const proxy = new Proxy(tx, { get(target, key, receiver) {
          if (key === "execute") return async (query: SQL) => {
            if (dialect.sqlToQuery(query).sql === FOREIGN_KEY_CHILD_INDEX_SQL) {
              const [settings] = await tx.select({ statement: sql<string>`(SELECT setting FROM pg_settings WHERE name='statement_timeout')`,
                idle: sql<string>`(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')`,
                isolation: sql<string>`current_setting('transaction_isolation')` }).from(sql`(values (1)) as p(n)`);
              expect(settings).toEqual({ statement: expectedStatement, idle: expectedIdle, isolation: "read committed" });
              observed = true;
            }
            return tx.execute(query);
          };
          return Reflect.get(target, key, receiver);
        } });
        return callback(proxy);
      }, config) };
      await runForeignKeyChildIndexes(wrapped, schema);
      expect(observed).toBe(true);
      const [after] = await db.select({ statement: sql<string>`(SELECT setting FROM pg_settings WHERE name='statement_timeout')`,
        idle: sql<string>`(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')` }).from(sql`(values (1)) as p(n)`);
      expect(after).toEqual({ statement: String(statement), idle: String(idle) });
    });
  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).each(["payment_reconciliation_case", "store_product_reply"])(
    "PG16 refuses a real writer lock on %s, restores budgets and succeeds after release", async table => {
      const { db, schema } = await fixture();
      await withFinancePeers(db, async ([writer, upgrader, observer]) => {
        const before = await catalog(), data = await rowsAndSequences();
        await writer.exec("BEGIN");
        try {
          await writer.db.execute(sql`LOCK TABLE ${sql.identifier(table)} IN ROW EXCLUSIVE MODE`);
          const pending = outcome(runForeignKeyChildIndexes(upgrader.db, schema));
          await waitForFinanceBlock(observer.db, upgrader.pid, writer.pid);
          const result = await pending;
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toMatchObject({ cause: { code: "55P03" } });
          expect(await catalog()).toEqual(before);
          expect(await rowsAndSequences()).toEqual(data);
          const [settings] = await upgrader.db.select({ lock: sql<string>`current_setting('lock_timeout')`,
            statement: sql<string>`current_setting('statement_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` }).from(sql`(values (1)) as p(n)`);
          expect(settings).toEqual({ lock: "8s", statement: "10s", idle: "15s" });
        } finally { await writer.exec("ROLLBACK"); }
        await runForeignKeyChildIndexes(upgrader.db, schema);
        expect((await catalog()).filter(row => names.includes(row.name))).toHaveLength(2);
      });
    }, 20000);
});
