import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { financePostgres } from "./helpers/financePostgres";
import { paymentCallbackEvent } from "../src/models/schema/payment_callback";
import { paymentReconciliationCase } from "../src/models/schema/payment_reconciliation";
import { storeOrderCartInfo } from "../src/models/schema/order";
import { storeProductReply } from "../src/models/schema/reply";

type Plan = { "Node Type": string; "Index Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number;
  "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
type Explained = { Plan: Plan; Triggers?: Array<{ "Constraint Name"?: string; Calls?: number; Time?: number }> };
function explained(result: unknown): Explained {
  const rows = Array.isArray(result) ? result : result && typeof result === "object" && "rows" in result ? result.rows : null;
  if (!Array.isArray(rows) || !Array.isArray(rows[0]?.["QUERY PLAN"]) || !rows[0]["QUERY PLAN"][0]?.Plan)
    throw new Error("Missing executed JSON plan");
  return rows[0]["QUERY PLAN"][0] as Explained;
}
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
function summary({ Plan: plan, Triggers: triggers }: Explained) {
  return { rows: plan["Actual Rows"], hits: plan["Shared Hit Blocks"], reads: plan["Shared Read Blocks"],
    filtered: nodes(plan).reduce((n, p) => n + (p["Rows Removed by Filter"] ?? 0) * (p["Actual Loops"] ?? 1), 0),
    indexes: nodes(plan).flatMap(p => p["Index Name"] ? [p["Index Name"]] : []), triggers };
}

// The base fixture creates real model columns/defaults/PKs. Add the actual model
// secondary indexes, CHECKs and FKs too; do not replace them with a permissive schema.
async function installRelations(db: Awaited<ReturnType<typeof financePostgres>>["db"], tables: PgTable[]) {
  const allowed = new Set(tables.map(table => getTableConfig(table).name));
  for (const table of tables) {
    const definition = getTableConfig(table);
    for (const { config } of definition.indexes) {
      if (!config.name || config.method !== "btree" || config.with || config.concurrently || config.only)
        throw new Error("Review changed fixture index options");
      const columns = config.columns.map(column => {
        if (!("name" in column) || !column.name || !("indexConfig" in column) || column.indexConfig?.opClass)
          throw new Error("Review expression/opclass fixture index");
        return sql`${sql.identifier(column.name)} ${sql.raw(column.indexConfig?.order ?? "asc")} nulls ${sql.raw(column.indexConfig?.nulls ?? "last")}`;
      });
      await db.execute(sql`CREATE ${sql.raw(config.unique ? "UNIQUE " : "")}INDEX ${sql.identifier(config.name)}
        ON ${sql.identifier(definition.name)} (${sql.join(columns, sql`, `)}) ${config.where ? sql`WHERE ${config.where}` : sql``}`);
    }
    for (const check of definition.checks) {
      await db.execute(sql`ALTER TABLE ${sql.identifier(definition.name)} ADD CONSTRAINT ${sql.identifier(check.name)}
        CHECK (${check.value}) ${"notValid" in check && check.notValid === true ? sql`NOT VALID` : sql``}`);
    }
    for (const fk of definition.foreignKeys) {
      const reference = fk.reference(), parent = getTableConfig(reference.foreignTable).name;
      if (!allowed.has(parent)) throw new Error("Fixture is missing a referenced table");
      await db.execute(sql`ALTER TABLE ${sql.identifier(definition.name)} ADD CONSTRAINT ${sql.identifier(fk.getName())}
        FOREIGN KEY (${sql.join(reference.columns.map(c => sql.identifier(c.name)), sql`, `)})
        REFERENCES ${sql.identifier(parent)} (${sql.join(reference.foreignColumns.map(c => sql.identifier(c.name)), sql`, `)})
        ON DELETE ${sql.raw(fk.onDelete ?? "no action")} ON UPDATE ${sql.raw(fk.onUpdate ?? "no action")}
        ${"notValid" in fk && fk.notValid === true ? sql`NOT VALID` : sql``}`);
    }
  }
}

const cases = [
  { name: "payment reconciliation callback reference", parent: paymentCallbackEvent, child: paymentReconciliationCase,
    column: "callback_event_id", constraint: "prc_callback_event_fk", candidate: "audit_prc_callback_fk", type: "bigint", validated: true, deletion: "r" },
  { name: "reply snapshot reference including deleted replies", parent: storeOrderCartInfo, child: storeProductReply,
    column: "order_cart_info_id", constraint: "spr_order_cart_info_fk", candidate: "audit_spr_cart_fk", type: "integer", validated: false, deletion: "a" },
] as const;

describe("DB-009G child-index evidence for parent FK checks", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  it.each(cases)("executes probes and actual parent actions: $name", async target => {
    f = await financePostgres([target.parent, target.child]);
    const db = f.db;
    await installRelations(db, [target.parent, target.child]);
    const reference = getTableConfig(target.child).foreignKeys.find(fk => fk.getName() === target.constraint)?.reference();
    expect(reference?.columns.map(column => column.name)).toEqual([target.column]);
    expect(reference?.foreignTable).toBe(target.parent);
    expect(reference?.foreignColumns.map(column => column.name)).toEqual(["id"]);
    const parentName = getTableConfig(target.parent).name, childName = getTableConfig(target.child).name;
    if (target.child === paymentReconciliationCase) {
      await db.execute(sql`INSERT INTO payment_callback_event
        (id, provider, profile, provider_event_id, replay_key, payload_hash, order_no, transaction_id, trade_state, amount_cents, currency)
        SELECT n, 'alipay', 'alipay', 'event_' || n, '00000000-0000-4000-8000-' || lpad(n::text,12,'0'),
          repeat('a',64), 'order_' || n, 'transaction_' || n, 'TRADE_SUCCESS', 100, 'CNY' FROM generate_series(1,4) n`);
      await db.execute(sql`INSERT INTO payment_reconciliation_case
        (id,replay_key,provider,profile,order_no,expected_amount_cents,currency,status,callback_event_id)
        SELECT n, '00000000-0000-4000-8000-' || lpad(n::text,12,'0'), 'alipay', 'alipay', 'case_' || n, 100, 'CNY',
          CASE WHEN n=100001 THEN 'OPEN' ELSE 'CLOSED' END,
          CASE WHEN n=100001 THEN 2 WHEN n=100002 THEN 3 WHEN n%2=0 THEN 1 ELSE NULL END
        FROM generate_series(1,100003) n`);
    } else {
      await db.execute(sql`INSERT INTO store_order_cart_info(id, "unique") SELECT n, 'parent_' || n FROM generate_series(1,4) n`);
      await db.execute(sql`INSERT INTO store_product_reply(id,order_cart_info_id,is_del)
        SELECT n, CASE WHEN n=100001 THEN 2 WHEN n=100002 THEN 3 WHEN n%2=0 THEN 1 ELSE NULL END,
          CASE WHEN n=100001 THEN 0 ELSE 1 END FROM generate_series(1,100003) n`);
    }
    await db.execute(sql`ANALYZE ${sql.identifier(parentName)}`);
    await db.execute(sql`ANALYZE ${sql.identifier(childName)}`);
    const [identity] = await db.select({ version: sql<string>`current_setting('server_version_num')` }).from(sql`(values (1)) as probe(n)`);
    const major = Math.floor(Number(identity.version) / 10000);
    expect([16, 18]).toContain(major);
    // PG18 distinguishes RESTRICT; CI PG16 still reports FK violation. Do not
    // accept arbitrary errors or apply this distinction to NO ACTION updates.
    const deleteCode = major === 18 && target.deletion === "r" ? "23001" : "23503";
    const fkState = () => db.select({ name: sql<string>`c.conname`, validated: sql<boolean>`c.convalidated`,
      deletion: sql<string>`c.confdeltype`, update: sql<string>`c.confupdtype`, definition: sql<string>`pg_get_constraintdef(c.oid)` })
      .from(sql`pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace`)
      .where(sql`n.nspname=current_schema() AND c.conname=${target.constraint}`);
    const originalFk = await fkState();
    expect(originalFk).toMatchObject([{ name: target.constraint, validated: target.validated, deletion: target.deletion, update: "a" }]);
    const fingerprint = async (tableName: string) => {
      const [row] = await db.select({ count: sql<string>`count(*)::text`, digest: sql<string>`md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id))` })
        .from(sql`${sql.identifier(tableName)} x`);
      return row;
    };
    const beforeRows = await fingerprint(childName), beforeParents = await fingerprint(parentName);
    expect(beforeRows.count).toBe("100003");
    const [nulls] = await db.select({ count: sql<number>`count(*)::int` }).from(target.child)
      .where(sql`${sql.identifier(target.column)} IS NULL`);
    expect(nulls.count).toBe(50001);
    // Mirrors PG16 ri_restrict's SQL without adding LIMIT (which changes the
    // planner's row goal). SPI stops after one match; our selected keys have
    // at most one match anyway. This is NOT the captured nested trigger plan.
    const probe = (key: number) => sql`SELECT 1 FROM ONLY ${sql.identifier(childName)} x
      WHERE ${key}::${sql.raw(target.type)} OPERATOR(pg_catalog.=) x.${sql.identifier(target.column)} FOR KEY SHARE OF x`;
    const generic = async () => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL plan_cache_mode=force_generic_plan`);
      const prepared = new PgDialect().sqlToQuery(probe(4));
      expect(prepared.params).toEqual([4]);
      await tx.execute(sql.raw(`PREPARE audit_fk_child AS ${prepared.sql}`));
      try { return summary(explained(await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE audit_fk_child(4)`))); }
      finally { await tx.execute(sql`DEALLOCATE audit_fk_child`); }
    });
    const plans = async () => ({
      absent: summary(explained(await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe(4)}`))),
      active: summary(explained(await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe(2)}`))),
      deletedOrClosed: summary(explained(await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${probe(3)}`))),
      genericAbsent: await generic(),
    });
    const before = await plans();
    expect(before.absent.rows).toBe(0);
    expect(before.active.rows).toBe(1);
    expect(before.deletedOrClosed.rows).toBe(1);
    expect(before.absent.filtered).toBeGreaterThanOrEqual(100000);
    const parentActions = async () => {
      // Both referenced states must protect their parent before AND after the
      // candidate index. NOT VALID does not disable checks on subsequent writes.
      for (const key of [2, 3]) {
        await expect(db.execute(sql`DELETE FROM ${sql.identifier(parentName)} WHERE id=${key}`)).rejects.toMatchObject({ cause: { code: deleteCode } });
        await expect(db.execute(sql`UPDATE ${sql.identifier(parentName)} SET id=id+100 WHERE id=${key}`)).rejects.toMatchObject({ cause: { code: "23503" } });
      }
      const rollback = new Error("rollback isolated parent action");
      const actual: ReturnType<typeof summary>[] = [];
      for (const operation of [sql`DELETE FROM ${sql.identifier(parentName)} WHERE id=4`,
        sql`UPDATE ${sql.identifier(parentName)} SET id=104 WHERE id=4`]) {
        await expect(db.transaction(async tx => {
          actual.push(summary(explained(await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${operation}`))));
          throw rollback;
        })).rejects.toBe(rollback);
      }
      expect(actual.every(plan => plan.triggers?.some(trigger => trigger["Constraint Name"] === target.constraint && trigger.Calls === 1))).toBe(true);
      return actual;
    };
    const parentBefore = await parentActions();
    // Test-only candidate. Formal ORM/external/embedded DDL is NOT changed here.
    await db.execute(sql`CREATE INDEX ${sql.identifier(target.candidate)} ON ${sql.identifier(childName)} (${sql.identifier(target.column)})`);
    await db.execute(sql`ANALYZE ${sql.identifier(childName)}`);
    const after = await plans();
    expect(after.absent.rows).toBe(0);
    expect(after.active.rows).toBe(1);
    expect(after.deletedOrClosed.rows).toBe(1);
    // The hot-key fixture may make a forced generic plan choose differently;
    // report it explicitly rather than equating a custom plan with every plan.
    for (const plan of [after.absent, after.active, after.deletedOrClosed]) {
      expect(plan.indexes).toContain(target.candidate);
      expect(plan.filtered).toBe(0);
      expect((plan.hits ?? 0) + (plan.reads ?? 0)).toBeLessThan(50);
    }
    expect(after.genericAbsent.rows).toBe(0);
    const parentAfter = await parentActions();
    expect(await fingerprint(childName)).toEqual(beforeRows);
    expect(await fingerprint(parentName)).toEqual(beforeParents);
    expect(await fkState()).toEqual(originalFk);
    process.stdout.write("FK_CHILD_INDEX_AUDIT " + JSON.stringify({ target: target.constraint, version: identity.version, rows: 100003,
      before, after, parentBefore, parentAfter, nullableRows: nulls.count, referencedKeyDistribution: "one hot key plus two rare keys",
      existingForeignKeyUnchanged: true, childRowsUnchanged: true, parentRowsUnchanged: true,
      candidateMigrationApplied: false, nestedTriggerPlanCaptured: false, productionLatencyClaim: false }) + "\n");
  }, 120000);
});
