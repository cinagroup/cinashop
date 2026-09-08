import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { financePostgres } from "./helpers/financePostgres";
import { storeOrder, storeOrderRefund } from "../src/models/schema";
import { pinkCancellationRecoveryScan } from "../src/services/activity/PinkCancellationRecoveryService";

// This is an index design experiment, not a production migration or a claim
// that the current query's scan cost is acceptable. CI repeats it on PG16.
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

describe("original cancellation scan: isolated 100k-row index design evidence", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  it("executes the same service query before/after a candidate index and exposes generic-plan eligibility", async () => {
    f = await financePostgres([storeOrder, storeOrderRefund]);
    const db = f.db;
    // financePostgres creates columns/PKs only. Install EVERY current model
    // secondary index here so the baseline cannot pretend existing indexes are absent.
    for (const table of [storeOrder, storeOrderRefund] as PgTable[]) {
      const definition = getTableConfig(table);
      for (const { config } of definition.indexes) {
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

    // Fixed literal predicate only in this disposable design experiment.
    // Time is an index key, NOT a volatile now()-based partial predicate.
    await db.execute(sql`CREATE INDEX audit_pink_recovery_candidate ON store_order_refund (id, add_time)
      WHERE is_cancel = 0 AND is_del = 0 AND apply_type = 1 AND refund_type IN (0, 1, 2, 4, 5)
      AND refund_reason = '用户手动取消拼团' AND refund_explain = '用户手动取消未成团的拼团订单'
      AND left(order_id, 12) = 'pink_cancel_'`);
    await db.execute(sql`ANALYZE store_order_refund`);
    const after = summary(await explain());
    expect(await scan()).toEqual(beforeRows);
    expect(after.indexes).toContain("audit_pink_recovery_candidate");
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
    expect(generic.indexes).toContain("audit_pink_recovery_candidate");
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
      candidateMigrationApplied: false, genericUsesCandidate: generic.indexes.includes("audit_pink_recovery_candidate") }));
  }, 60_000);
});
