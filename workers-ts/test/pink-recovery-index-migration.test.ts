import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { storeOrderRefund } from "../src/models/schema/order_refund";
import { PINK_RECOVERY_INDEX_SQL } from "../src/migrations/pinkRecoveryIndex";
import { runPinkRecoveryIndex } from "../src/migrations/runPinkRecoveryIndex";
import { financePostgres } from "./helpers/financePostgres";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

const external = readFileSync("migrations/0146_pink_recovery_index.sql", "utf8");
const indexName = "sor_pink_recovery_scan";
const predicate = `is_cancel = 0 AND is_del = 0 AND apply_type = 1 AND refund_type IN (0, 1, 2, 4, 5)
  AND refund_reason = '用户手动取消拼团' AND refund_explain = '用户手动取消未成团的拼团订单'
  AND left(order_id, 12) = 'pink_cancel_'`;
function messages(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message + (error.cause ? " " + messages(error.cause) : "");
}

describe("B1 formal recovery index upgrade", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture() {
    f = await financePostgres([storeOrderRefund]);
    await f.db.insert(storeOrderRefund).values([
      { orderId: "ordinary", refundReason: "unchanged fixture", refundPrice: "6.25" },
      { orderId: "pink_cancel_fixture", applyType: 1, refundReason: "用户手动取消拼团",
        refundExplain: "用户手动取消未成团的拼团订单", refundPrice: "8.75" },
    ]);
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    return { ...f, schema: identity.schema };
  }
  async function catalog() {
    if (!f) throw new Error("Missing fixture");
    return f.db.select({ oid: sql<string>`c.oid::text`, name: sql<string>`c.relname`,
      file: sql<string>`c.relfilenode::text`, kind: sql<string>`c.relkind`,
      definition: sql<string | null>`CASE WHEN c.relkind='i' THEN pg_get_indexdef(c.oid) END` })
      .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
      .where(sql`n.nspname=current_schema()`).orderBy(sql`c.relname`);
  }
  it("keeps byte-equivalent external/embedded DDL, one appended registration and nine positive catalog gates", () => {
    expect(external.trim()).toBe(PINK_RECOVERY_INDEX_SQL.trim());
    expect(external).not.toMatch(/\b(?:DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|nextval|setval)\b/i);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service.match(/this\.migration_0152\(\)/g)).toHaveLength(1);
    expect(service).toContain("return PINK_RECOVERY_INDEX_SQL;");
    expect(service).toContain("if (i === 152)");
    expect(service).toContain("await runPinkRecoveryIndex(this.container.db)");
    expect(service).toContain("if (i >= 115) break");
    const audit = readFileSync("scripts/orm-ddl-audit.ts", "utf8");
    expect(audit).toContain('[...duplicateContracts.keys, "store_order_refund.sor_pink_recovery_scan"]');
    for (const path of ["embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names", "orm_checks", "orm_sequences"]) {
      expect(audit).toContain(`assertIndexContracts(catalogs.external, catalogs.${path}, requiredIndexKeys)`);
    }
  });
  it("upgrades existing rows additively, repeats without replacing any OID/file, and leaves sequence state intact", async () => {
    const { db, schema } = await fixture();
    const rows = await db.select().from(storeOrderRefund);
    const before = await catalog();
    const sequence = () => db.select({ value: sql<string>`last_value::text`, called: sql<boolean>`is_called` })
      .from(sql`store_order_refund_id_seq`);
    const initialSequence = await sequence();
    await db.transaction(tx => tx.execute(sql.raw(external)));
    const installed = await catalog();
    expect(installed.filter(row => row.name !== indexName)).toEqual(before);
    expect(installed.filter(row => row.name === indexName)).toHaveLength(1);
    await runPinkRecoveryIndex(db, schema);
    await runPinkRecoveryIndex(db, schema);
    expect(await catalog()).toEqual(installed);
    expect(await db.select().from(storeOrderRefund)).toEqual(rows);
    expect(await sequence()).toEqual(initialSequence);
  });
  it("accepts the actual ORM predicate and preserves its pre-existing index identity", async () => {
    const { db, schema } = await fixture();
    const matches = getTableConfig(storeOrderRefund).indexes.filter(index => index.config.name === indexName);
    expect(matches).toHaveLength(1);
    const { config } = matches[0];
    expect(config.unique).toBe(false);
    expect(config.columns.map(column => "name" in column ? column.name : null)).toEqual(["id", "add_time"]);
    expect(config.where).toBeDefined();
    await db.execute(sql`CREATE INDEX sor_pink_recovery_scan ON store_order_refund (id, add_time) WHERE ${config.where!}`);
    const before = await catalog();
    await runPinkRecoveryIndex(db, schema);
    expect(await catalog()).toEqual(before);
  });
  it("creates the index on an empty fresh table without creating a business row", async () => {
    f = await financePostgres([storeOrderRefund]);
    await f.db.transaction(tx => tx.execute(sql.raw(external)));
    expect((await catalog()).filter(row => row.name === indexName)).toHaveLength(1);
    expect(await f.db.select().from(storeOrderRefund)).toEqual([]);
  });
  it("ignores same-named temporary objects and restores the caller search path", async () => {
    const { db, schema } = await fixture();
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql`CREATE TEMP TABLE store_order_refund(id integer) ON COMMIT DROP`);
      await tx.execute(sql`CREATE TEMP TABLE sor_pink_recovery_scan(id integer) ON COMMIT DROP`);
      const probe = () => tx.select({ schema: sql<string>`current_schema()`, path: sql<string>`current_setting('search_path')` })
        .from(sql`(values (1)) as probe(n)`);
      const before = await probe();
      await tx.execute(sql.raw(external));
      expect(await probe()).toEqual(before);
      const tempRows = await tx.select({ name: sql<string>`c.relname`, kind: sql<string>`c.relkind` })
        .from(sql`pg_class c`).where(sql`c.relnamespace=pg_my_temp_schema()`).orderBy(sql`c.relname`);
      expect(tempRows).toEqual([{ name: indexName, kind: "r" }, { name: "store_order_refund", kind: "r" }]);
    });
    expect((await catalog()).filter(row => row.name === indexName)).toHaveLength(1);
  });
  it("applies only to the explicit current schema and leaves the original schema unchanged", async () => {
    const { db, schema } = await fixture();
    const before = await catalog();
    const isolated = `pink_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    await expect(db.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(isolated)}`);
      await tx.execute(sql`CREATE TABLE ${sql.identifier(isolated)}.store_order_refund
        (LIKE ${sql.identifier(schema)}.store_order_refund INCLUDING DEFAULTS)`);
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(isolated)}, ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql.raw(external));
      const indexes = await tx.select({ schema: sql<string>`n.nspname` })
        .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
        .where(sql`c.relname=${indexName} AND n.nspname IN (${isolated}, ${schema})`);
      expect(indexes).toEqual([{ schema: isolated }]);
      // The transaction owns this newly created schema; rollback cleans it up on any outcome.
      throw new Error("scope fixture rollback");
    })).rejects.toThrow("scope fixture rollback");
    expect(await catalog()).toEqual(before);
  });
  it.each([
    ["missing predicate", "CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time)"],
    ["wrong key order", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(add_time, id) WHERE ${predicate}`],
    ["descending key", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id DESC, add_time) WHERE ${predicate}`],
    ["null order", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id NULLS FIRST, add_time) WHERE ${predicate}`],
    ["unique index", `CREATE UNIQUE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time) WHERE ${predicate}`],
    ["included column", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time) INCLUDE(uid) WHERE ${predicate}`],
    ["expression key", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund((id + 0), add_time) WHERE ${predicate}`],
    ["wrong eligibility", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time) WHERE ${predicate.replace("0, 1, 2, 4, 5", "0, 1, 2, 3, 4, 5")}`],
    ["prefix case", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time) WHERE ${predicate.replace("pink_cancel_", "PINK_CANCEL_")}`],
    ["storage parameters", `CREATE INDEX sor_pink_recovery_scan ON store_order_refund(id, add_time) WITH (fillfactor=70) WHERE ${predicate}`],
    ["same named table", "CREATE TABLE sor_pink_recovery_scan(id integer)"],
    ["other table index", "CREATE TABLE other_refunds(id integer, add_time integer); CREATE INDEX sor_pink_recovery_scan ON other_refunds(id, add_time)"],
    ["constraint-owned index", "ALTER TABLE store_order_refund ADD CONSTRAINT sor_pink_recovery_scan UNIQUE(id, add_time)"],
  ])("rejects %s without replacing the conflicting object or changing rows", async (_label, ddl) => {
    const { db, exec, schema } = await fixture();
    await exec(ddl);
    const before = await catalog(), rows = await db.select().from(storeOrderRefund);
    await runPinkRecoveryIndex(db, schema).then(() => { throw new Error("Drift was accepted"); }, error => {
      expect(messages(error)).toContain("0146 index definition drift");
    });
    expect(await catalog()).toEqual(before);
    expect(await db.select().from(storeOrderRefund)).toEqual(rows);
  });
  it("rolls the newly created index back with the caller transaction", async () => {
    const { db } = await fixture();
    const before = await catalog();
    await expect(db.transaction(async tx => {
      await tx.execute(sql.raw(external));
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    expect(await catalog()).toEqual(before);
  });
  it("rejects an incompatible operand type before building an index", async () => {
    const { db, schema } = await fixture();
    await db.execute(sql`ALTER TABLE store_order_refund ALTER COLUMN add_time TYPE bigint`);
    const before = await catalog();
    await runPinkRecoveryIndex(db, schema).then(() => { throw new Error("Drift was accepted"); }, error => {
      expect(messages(error)).toContain("0146 recovery operand column drift");
    });
    expect(await catalog()).toEqual(before);
  });
  it("rejects a missing explicit schema/table without falling back to public", async () => {
    const { db } = await fixture();
    const before = await catalog();
    await expect(runPinkRecoveryIndex(db, "missing_pink_recovery_schema")).rejects.toThrow();
    expect(await catalog()).toEqual(before);
  });
  it("refuses nested transactions and invalid/system schemas before issuing maintenance SQL", async () => {
    const { db } = await fixture();
    for (const schema of ["", "pg_catalog", "pg_temp", "information_schema", "public,pg_temp", 'public"', "x".repeat(64)]) {
      await expect(runPinkRecoveryIndex(db, schema)).rejects.toThrow("Invalid recovery index schema");
    }
    await db.transaction(async tx => {
      // Drizzle transactions have no root $client, which the executor requires.
      await expect(runPinkRecoveryIndex({ transaction: tx.transaction.bind(tx) }))
        .rejects.toThrow("root database");
    });
  });
  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)("PG16 bounds a real writer lock wait, rolls back, and succeeds after the blocker exits", async () => {
    const { db, schema } = await fixture();
    await withFinancePeers(db, async ([writer, upgrader, observer]) => {
      const before = await catalog();
      await writer.exec("BEGIN");
      try {
        await writer.exec("LOCK TABLE store_order_refund IN ROW EXCLUSIVE MODE");
        const upgrading = outcome(runPinkRecoveryIndex(upgrader.db, schema));
        await waitForFinanceBlock(observer.db, upgrader.pid, writer.pid);
        const result = await upgrading;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(messages(result.error)).toContain("lock timeout");
        expect(await catalog()).toEqual(before);
        const [settings] = await upgrader.db.select({ lock: sql<string>`current_setting('lock_timeout')`,
          statement: sql<string>`current_setting('statement_timeout')`, idle: sql<string>`current_setting('idle_in_transaction_session_timeout')` })
          .from(sql`(values (1)) as probe(n)`);
        expect(settings).toEqual({ lock: "8s", statement: "10s", idle: "15s" });
      } finally { await writer.exec("ROLLBACK"); }
      await runPinkRecoveryIndex(upgrader.db, schema);
      expect((await catalog()).filter(row => row.name === indexName)).toHaveLength(1);
    });
  }, 20_000);
});
