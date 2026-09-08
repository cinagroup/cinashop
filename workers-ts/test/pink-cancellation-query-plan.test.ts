import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { financePostgres } from "./helpers/financePostgres";
import { storeOrder, storeOrderRefund } from "../src/models/schema";
import { pinkCancellationRecoveryScan } from "../src/services/activity/PinkCancellationRecoveryService";
import { runPinkRecoveryIndex } from "../src/migrations/runPinkRecoveryIndex";

// Execute the formal single-purpose migration in an isolated fixture. This is
// selected-distribution evidence, not a production latency/capacity guarantee.
type Plan = { "Node Type": string; "Index Name"?: string; "Relation Name"?: string;
  "Actual Rows"?: number; "Actual Loops"?: number; "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; Plans?: Plan[] };
function queryPlan(result: unknown): Plan {
  const rows = Array.isArray(result) ? result : result && typeof result === "object" && "rows" in result ? result.rows : null;
  if (!Array.isArray(rows) || !rows[0] || !Array.isArray(rows[0]["QUERY PLAN"]) || !rows[0]["QUERY PLAN"][0]?.Plan) {
    throw new Error("Missing executed PostgreSQL JSON plan");
  }
  return rows[0]["QUERY PLAN"][0].Plan as Plan;
}
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
function summary(plan: Plan) {
  return { rows: plan["Actual Rows"], hits: plan["Shared Hit Blocks"], reads: plan["Shared Read Blocks"],
    filtered: nodes(plan).reduce((sum, node) => sum + (node["Rows Removed by Filter"] ?? 0) * (node["Actual Loops"] ?? 1), 0),
    indexes: nodes(plan).flatMap(node => node["Index Name"] ? [node["Index Name"]] : []) };
}

async function installModelIndexes(db: Awaited<ReturnType<typeof financePostgres>>["db"], omitRecovery = false) {
  for (const table of [storeOrder, storeOrderRefund] as PgTable[]) {
    const definition = getTableConfig(table);
    for (const { config } of definition.indexes) {
      if (omitRecovery && definition.name === "store_order_refund" && config.name === "sor_pink_recovery_scan") continue;
      if (!config.name || config.method !== "btree" || config.with || config.concurrently || config.only) {
        throw new Error("Review changed fixture index options");
      }
      const columns = config.columns.map(column => {
        if (!("name" in column) || !column.name || !("indexConfig" in column) || column.indexConfig?.opClass) {
          throw new Error("Review expression/opclass fixture index");
        }
        return sql`${sql.identifier(column.name)} ${sql.raw(column.indexConfig?.order ?? "asc")} nulls ${sql.raw(column.indexConfig?.nulls ?? "last")}`;
      });
      await db.execute(sql`CREATE ${sql.raw(config.unique ? "UNIQUE " : "")}INDEX ${sql.identifier(config.name)}
        ON ${sql.identifier(definition.name)} (${sql.join(columns, sql`, `)}) ${config.where ? sql`WHERE ${config.where}` : sql``}`);
    }
  }
}

describe("original cancellation scan: isolated 100k-row index design evidence", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  it("executes the same service query before/after the formal index migration, including generic plans", async () => {
    f = await financePostgres([storeOrder, storeOrderRefund]);
    const db = f.db;
    // Install all PRE-0146 secondary indexes; omit ONLY this newly added index
    // to reproduce the existing-database upgrade baseline.
    await installModelIndexes(db, true);
    await db.insert(storeOrder).values({ id: 1, orderId: "query-fixture", pinkId: 400, activityId: 30 });
    await db.execute(sql`INSERT INTO store_order_refund
      (id, store_order_id, order_id, refund_type, is_cancel, is_del, apply_type, refund_reason, refund_explain)
      SELECT n, 1, 'pink_cancel_' || n,
        CASE WHEN n % 5 = 0 THEN 6 ELSE 0 END,
        CASE WHEN n % 5 = 1 THEN 1 ELSE 0 END,
        CASE WHEN n % 5 = 2 THEN 1 ELSE 0 END, 1,
        CASE WHEN n % 5 = 3 THEN 'ordinary aftersales' ELSE '用户手动取消拼团' END,
        CASE WHEN n % 5 = 4 THEN 'ordinary explanation' ELSE '用户手动取消未成团的拼团订单' END
      FROM generate_series(1, 100000) n`);
    await db.execute(sql`INSERT INTO store_order_refund
      (id, store_order_id, order_id, apply_type, refund_reason, refund_explain, add_time)
      SELECT n, 1, 'pink_cancel_' || n, 1, '用户手动取消拼团', '用户手动取消未成团的拼团订单',
        CASE WHEN n <= 100005 THEN 2000 ELSE 0 END FROM generate_series(100001, 100030) n`);
    await db.execute(sql`ANALYZE store_order_refund`); await db.execute(sql`ANALYZE store_order`);
    const scan = (cursor = 0, ceiling = 100030) => pinkCancellationRecoveryScan(db, cursor, ceiling, 1060000);
    const explain = async (cursor = 0, ceiling = 100030) => queryPlan(await db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scan(cursor, ceiling).getSQL()}`));
    const beforeRows = await scan();
    expect(beforeRows.map(row => row.id)).toEqual([100006, 100007, 100008, 100009, 100010]);
    const before = summary(await explain());

    const [identity] = await db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    await runPinkRecoveryIndex(db, identity.schema);
    await db.execute(sql`ANALYZE store_order_refund`);
    const after = summary(await explain());
    expect(await scan()).toEqual(beforeRows);
    expect(after.indexes).toContain("sor_pink_recovery_scan");
    expect(after.filtered).toBeLessThan(100);
    expect((await scan(100025)).map(row => row.id)).toEqual([100026, 100027, 100028, 100029, 100030]);
    expect(await scan(100030)).toEqual([]);
    expect((await scan(100018, 100020)).map(row => row.id)).toEqual([100019, 100020]);
    const tail = summary(await explain(100030));
    const dialect = new PgDialect();
    const query = scan().toSQL();
    expect(query.params).toEqual([0, 100030, 1000, 5]);
    const parameters = query.params.map(value => {
      if (typeof value !== "string" && typeof value !== "number") throw new Error("Unexpected audit parameter");
      return dialect.sqlToQuery(sql`${value}`.inlineParams()).sql;
    }).join(", ");
    const generic = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`PREPARE audit_pink_scan AS ${query.sql}`));
      try { return summary(queryPlan(await tx.execute(sql.raw(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE audit_pink_scan(${parameters})`)))); }
      finally { await tx.execute(sql`DEALLOCATE audit_pink_scan`); }
    });
    expect(generic.rows).toBe(5);
    expect(generic.indexes).toContain("sor_pink_recovery_scan");
    expect(generic.filtered).toBeLessThan(100);
    // Index membership must track mutable terminal/withdrawal/business flags;
    // the candidate cannot merely return the right initial five rows.
    await db.execute(sql`UPDATE store_order_refund SET refund_type = 6 WHERE id = 100006`);
    await db.execute(sql`UPDATE store_order_refund SET is_cancel = 1 WHERE id = 100007`);
    await db.execute(sql`UPDATE store_order_refund SET is_del = 1 WHERE id = 100008`);
    await db.execute(sql`UPDATE store_order_refund SET refund_reason = 'ordinary aftersales' WHERE id = 100009`);
    await db.execute(sql`UPDATE store_order_refund SET apply_type = 2 WHERE id = 100010`);
    expect((await scan()).map(row => row.id)).toEqual([100011, 100012, 100013, 100014, 100015]);
    await db.execute(sql`UPDATE store_order_refund SET refund_type = 0 WHERE id = 100006`);
    expect((await scan()).map(row => row.id)).toEqual([100006, 100011, 100012, 100013, 100014]);
    // Report, do not turn a fast custom plan into a generic/production guarantee.
    console.log("PINK_RECOVERY_QUERY_AUDIT " + JSON.stringify({ rows: 100030, before, candidate: after, tail, generic,
      migrationApplied: "0146", genericUsesCandidate: generic.indexes.includes("sor_pink_recovery_scan") }));
  }, 60_000);

  it("measures recent-prefix growth, empty scans, dense backlog and interleaved ages with distinct orders", async () => {
    f = await financePostgres([storeOrder, storeOrderRefund]);
    const db = f.db;
    await installModelIndexes(db);
    const [identity] = await db.select({ schema: sql<string>`current_schema()`, version: sql<string>`current_setting('server_version_num')` })
      .from(sql`(values (1)) as probe(n)`);
    // Validate the actual model-created index with the formal migration guard.
    await runPinkRecoveryIndex(db, identity.schema);
    await db.execute(sql`INSERT INTO store_order(id, order_id, "unique", pink_id, activity_id, uid)
      SELECT n, 'capacity_order_' || n, 'capacity_unique_' || n, n + 500000, 30, n % 1000 + 1 FROM generate_series(1, 100005) n`);
    const addRefunds = (first: number, last: number, time: number) => db.execute(sql`INSERT INTO store_order_refund
      (id, store_order_id, order_id, uid, apply_type, refund_reason, refund_explain, refund_price, refund_num, add_time)
      SELECT n, n, 'pink_cancel_' || (n + 500000) || '_' || n, n % 1000 + 1, 1,
        '用户手动取消拼团', '用户手动取消未成团的拼团订单', 6.25, 1, ${time}
      FROM generate_series(${first}::int, ${last}::int) n`);
    await addRefunds(1, 10000, 2000);
    await addRefunds(100001, 100005, 0);
    await db.execute(sql`ANALYZE store_order`);
    const scan = (cursor = 0, ceiling = 100005) => pinkCancellationRecoveryScan(db, cursor, ceiling, 1060000);
    const measure = async (ids: number[], cursor = 0, ceiling = 100005) => {
      const actual = await scan(cursor, ceiling);
      expect(actual.map(row => row.id)).toEqual(ids);
      for (const row of actual) {
        expect(row.storeOrderId).toBe(row.id);
        expect(row.uid).toBe(row.id % 1000 + 1);
        expect(row.pinkId).toBe(row.id + 500000);
        expect(row.orderId).toBe(`pink_cancel_${row.id + 500000}_${row.id}`);
      }
      const plan = queryPlan(await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scan(cursor, ceiling).getSQL()}`));
      expect(plan["Actual Rows"]).toBe(ids.length);
      return summary(plan);
    };
    const dueTail = [100001, 100002, 100003, 100004, 100005];
    await db.execute(sql`ANALYZE store_order_refund`);
    const recent10k = await measure(dueTail);
    await addRefunds(10001, 100000, 2000);
    await db.execute(sql`ANALYZE store_order_refund`);
    const recent100k = await measure(dueTail);
    const frozenCeiling = await measure([], 0, 100000);
    const lateCursor = await measure(dueTail, 100000);
    const query = scan().toSQL();
    expect(query.params).toEqual([0, 100005, 1000, 5]);
    const generic = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL plan_cache_mode = force_generic_plan`);
      await tx.execute(sql.raw(`PREPARE audit_pink_capacity AS ${query.sql}`));
      try {
        return summary(queryPlan(await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          EXECUTE audit_pink_capacity(0, 100005, 1000, 5)`)));
      } finally { await tx.execute(sql`DEALLOCATE audit_pink_capacity`); }
    });
    expect(generic.rows).toBe(5);
    await db.execute(sql`UPDATE store_order_refund SET add_time=2000 WHERE id > 100000`);
    await db.execute(sql`ANALYZE store_order_refund`);
    const allRecentEmpty = await measure([]);
    await db.execute(sql`UPDATE store_order_refund SET add_time=0`);
    await db.execute(sql`ANALYZE store_order_refund`);
    const backlogHead = await measure([1, 2, 3, 4, 5]);
    const backlogMiddle = await measure([50001, 50002, 50003, 50004, 50005], 50000);
    const backlogTail = await measure(dueTail, 100000);
    await db.execute(sql`UPDATE store_order_refund SET add_time=CASE WHEN id % 10000=0 THEN 0 ELSE 2000 END`);
    await db.execute(sql`ANALYZE store_order_refund`);
    const interleaved = await measure([10000, 20000, 30000, 40000, 50000]);
    const interleavedNext = await measure([60000, 70000, 80000, 90000, 100000], 50000);
    const interleavedTail = await measure([], 100000);
    // Keep churn visible, then distinguish it from the maintained live-row
    // distribution. VACUUM touches only this disposable fixture table.
    await f.exec("VACUUM (ANALYZE) store_order_refund");
    const maintainedInterleaved = await measure([10000, 20000, 30000, 40000, 50000]);
    // Measurements are not universal budget gates: later index keys may reject
    // heap visits without reducing index pages traversed. No provider I/O here.
    console.log("PINK_RECOVERY_CAPACITY_AUDIT " + JSON.stringify({ version: identity.version, orders: 100005, refunds: 100005, syntheticOwners: 1000,
      recent10k, recent100k, frozenCeiling, lateCursor, generic, allRecentEmpty,
      backlogHead, backlogMiddle, backlogTail, interleaved, interleavedNext, interleavedTail, maintainedInterleaved,
      productionLatencyClaim: false, universalScanBoundProven: false }));
  }, 120_000);
});
