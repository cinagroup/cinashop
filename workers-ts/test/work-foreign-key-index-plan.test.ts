import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";
import { foreignKeyIndexInventory } from "../scripts/foreign-key-index-audit";
import { runWorkContactClientIndex } from "../src/migrations/runWorkContactClientIndex";

type Node = { "Node Type": string; "Index Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number;
  "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; "Rows Removed by Filter"?: number; Plans?: Node[] };
type Explained = { Plan: Node; Triggers?: Array<{ "Constraint Name"?: string; Calls?: number }> };
function explainResult(result: unknown): Explained {
  const rows = Array.isArray(result) ? result : result && typeof result === "object" && "rows" in result ? result.rows : null;
  if (!Array.isArray(rows) || !Array.isArray(rows[0]?.["QUERY PLAN"]) || !rows[0]["QUERY PLAN"][0]?.Plan)
    throw new Error("Missing executed plan");
  return rows[0]["QUERY PLAN"][0];
}
function walk(node: Node): Node[] { return [node, ...(node.Plans ?? []).flatMap(walk)]; }
function summary(plan: Explained) {
  return { rows: plan.Plan["Actual Rows"], hits: plan.Plan["Shared Hit Blocks"] ?? 0, reads: plan.Plan["Shared Read Blocks"] ?? 0,
    filtered: walk(plan.Plan).reduce((sum, node) => sum + (node["Rows Removed by Filter"] ?? 0) * (node["Actual Loops"] ?? 1), 0),
    indexes: walk(plan.Plan).flatMap(node => node["Index Name"] ? [node["Index Name"]] : []), triggers: plan.Triggers };
}
function messages(error: unknown): string {
  return error instanceof Error ? error.message + (error.cause ? " " + messages(error.cause) : "") : String(error);
}
const targets = [
  { fk: "wmc_last_event_fk", table: "work_member_current", column: "last_event_id", index: "wmc_last_event_idx", parent: "work_callback_event", existing: true },
  { fk: "wmia_last_event_fk", table: "work_member_identity_alias", column: "last_event_id", index: "wmia_last_event_idx", parent: "work_callback_event", existing: true },
  { fk: "wmia_link_event_fk", table: "work_member_identity_alias", column: "link_event_id", index: "wmia_link_event_idx", parent: "work_callback_event", existing: true },
  { fk: "wcao_client_fk", table: "work_contact_action_outbox", column: "client_id", index: "wcao_client_ref", parent: "work_client_current", existing: false },
] as const;

describe("DB-009G2 Enterprise WeChat FK index decisions", () => {
  let generated: string;
  let expectedForeignKeys: string[];
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>> | undefined;
  beforeAll(async () => {
    const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
    const statements = await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models));
    const baseline = statements.filter(statement => !statement.startsWith('CREATE INDEX "wcao_client_ref"'));
    expect(statements.length - baseline.length).toBe(1);
    generated = baseline.join("\n");
    expectedForeignKeys = foreignKeyIndexInventory(models).entries.map(entry => `${entry.table}.${entry.name}`).sort();
  }, 120000);
  afterEach(async () => { await f?.close(); f = undefined; });
  it.each(targets)("uses real model constraints and parent actions for $fk", async target => {
    f = await sequenceRunnerDatabase();
    const { db, exec, query } = f;
    // Full ORM SQL except the single new index, providing its pre-0148 baseline.
    // The public schema belongs to this isolated database, never the shared CI service.
    await exec(generated);
    const actualForeignKeys = await query("SELECT t.relname,c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f'");
    expect(actualForeignKeys.rows.map(row => {
      if (!row || typeof row !== "object" || !("relname" in row) || !("conname" in row)
        || typeof row.relname !== "string" || typeof row.conname !== "string") {
        throw new Error("Unexpected foreign key catalog row");
      }
      return `${row.relname}.${row.conname}`;
    }).sort()).toEqual(expectedForeignKeys);
    await exec(`INSERT INTO work_callback_event
      (id,event_key,payload_hash,subject_key_hash,corp_id,payload,event_time)
      SELECT n,lpad(to_hex(n),64,'0'),repeat('b',64),repeat('c',64),
        CASE WHEN n=100003 AND ${!target.existing} THEN 'other' ELSE 'fixture' END,'{}',1
      FROM generate_series(1,${target.existing ? 5 : 100005}) n`);
    if (target.table === "work_member_current") {
      await exec(`WITH fixture AS (
        SELECT n,CASE WHEN n=100001 THEN 2 WHEN n=100002 THEN 3 WHEN n%2=0 THEN 1 ELSE NULL END AS event
        FROM generate_series(1,100003) n)
        INSERT INTO work_member_current
          (corp_id,userid,canonical_userid,lifecycle_state,status,enable,deleted_time,
           last_event_id,last_event_key,last_event_subject_key_hash,last_event_time)
        SELECT 'fixture','user_'||n,'user_'||n,CASE WHEN n=100002 THEN 'DELETED' ELSE 'ACTIVE' END,
          CASE WHEN n=100002 THEN 5 ELSE 1 END,CASE WHEN n=100002 THEN 0 ELSE 1 END,
          CASE WHEN n=100002 THEN 1 ELSE NULL END,event,
          CASE WHEN event IS NOT NULL THEN lpad(to_hex(event),64,'0') END,
          CASE WHEN event IS NOT NULL THEN repeat('c',64) END,CASE WHEN event IS NOT NULL THEN 1 ELSE 0 END FROM fixture`);
    } else if (target.table === "work_member_identity_alias") {
      await exec("INSERT INTO work_member_current(corp_id,userid,canonical_userid) VALUES ('fixture','member','member')");
      const link = target.column === "link_event_id";
      await exec(`WITH fixture AS (
        SELECT n,CASE WHEN n=100001 THEN 2 WHEN n=100002 THEN 3 WHEN n%2=0 THEN 1 ELSE NULL END AS event
        FROM generate_series(1,100003) n), values_to_insert AS (
        SELECT *,CASE WHEN event IS NULL THEN NULL WHEN ${link} THEN 5 ELSE event END AS last_event FROM fixture)
        INSERT INTO work_member_identity_alias
          (corp_id,userid,canonical_userid,member_id,lifecycle_state,last_event_id,last_event_key,
           last_event_subject_key_hash,last_event_time,link_event_id,link_event_time)
        SELECT 'fixture','alias_'||n,
          CASE WHEN ${link} AND event IS NOT NULL THEN 'member' ELSE 'alias_'||n END,
          CASE WHEN ${link} AND event IS NOT NULL AND n<>100002 THEN 1 ELSE NULL END,
          CASE WHEN n=100002 THEN 'UNRESOLVED' WHEN ${link} AND event IS NOT NULL THEN 'RENAMED' ELSE 'DELETED' END,
          last_event,CASE WHEN last_event IS NOT NULL THEN lpad(to_hex(last_event),64,'0') END,
          CASE WHEN last_event IS NOT NULL THEN repeat('c',64) END,CASE WHEN last_event IS NOT NULL THEN 1 ELSE 0 END,
          CASE WHEN ${link} THEN event ELSE NULL END,CASE WHEN ${link} AND event IS NOT NULL THEN 1 ELSE 0 END
        FROM values_to_insert`);
    } else {
      await exec(`INSERT INTO work_client_current(corp_id,external_userid)
        SELECT 'fixture','client_'||n FROM generate_series(1,4) n;
        INSERT INTO work_client_current(id,corp_id,external_userid) OVERRIDING SYSTEM VALUE VALUES (4,'other','client_other');
        INSERT INTO work_contact_action_outbox(id,event_id,event_key,action_key,action_type,corp_id,client_id,payload_hash,status)
        SELECT n,n,lpad(to_hex(n),64,'0'),lpad(to_hex(n),64,'0'),'AUTO_TAG',
          CASE WHEN n=100003 THEN 'other' ELSE 'fixture' END,
          CASE WHEN n=100001 THEN 2 WHEN n=100002 THEN 3 WHEN n=100003 THEN 4 ELSE 1 END,
          repeat('b',64),CASE WHEN n=100001 THEN 'PENDING' ELSE 'CLOSED' END
        FROM generate_series(1,100003) n`);
    }
    await exec(`ANALYZE public.${target.table}; ANALYZE public.${target.parent}`);
    const [identity] = await db.select({ version: sql<string>`current_setting('server_version_num')` }).from(sql`(values (1)) as p(n)`);
    const major = Math.floor(Number(identity.version) / 10000);
    expect([16, 18]).toContain(major);
    const fkState = () => query(`SELECT conname,confdeltype,confupdtype,convalidated,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='public.${target.table}'::regclass AND conname='${target.fk}'`);
    const beforeFk = await fkState();
    expect(beforeFk.rows).toMatchObject([{ conname: target.fk, confdeltype: "r", confupdtype: "a", convalidated: true }]);
    const fingerprint = (table: string) => query(`SELECT count(*)::text AS count,
      md5(string_agg(to_jsonb(x)::text,'' ORDER BY ${table === "work_member_identity_alias" ? "x.corp_id,x.userid" : table === "work_client_current" ? "x.corp_id,x.id" : "x.id"})) AS digest
      FROM public.${table} x`);
    const beforeRows = await fingerprint(target.table), beforeParents = await fingerprint(target.parent);
    expect(beforeRows.rows).toMatchObject([{ count: "100003" }]);
    const indexState = () => query(`SELECT c.oid::text,c.relname,pg_get_indexdef(c.oid) AS definition,pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='public.${target.table}'::regclass ORDER BY c.relname`);
    const originalIndexes = await indexState();
    if (target.existing) expect(originalIndexes.rows).toContainEqual(expect.objectContaining({ relname: target.index,
      predicate: `(${target.column} IS NOT NULL)` }));
    const probe = (key: number) => sql`SELECT 1 FROM ONLY public.${sql.identifier(target.table)} x WHERE
      ${target.existing ? sql`` : sql`${"fixture"}::varchar OPERATOR(pg_catalog.=) x.corp_id AND`}
      ${key}::integer OPERATOR(pg_catalog.=) x.${sql.identifier(target.column)} FOR KEY SHARE OF x`;
    const genericOn = async (tx: Pick<typeof db, "execute">) => {
      await tx.execute(sql`SET LOCAL plan_cache_mode=force_generic_plan`);
      const built = new PgDialect().sqlToQuery(probe(4));
      expect(built.params).toEqual(target.existing ? [4] : ["fixture", 4]);
      await tx.execute(sql.raw(`PREPARE audit_work_fk AS ${built.sql}`));
      try {
        return summary(explainResult(await tx.execute(target.existing
          ? sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE audit_work_fk(4)`
          : sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE audit_work_fk('fixture',4)`)));
      } finally { await tx.execute(sql`DEALLOCATE audit_work_fk`); }
    };
    const generic = () => db.transaction(genericOn);
    const plans = async (executor: Pick<typeof db, "execute"> = db, genericProbe = generic) => ({
      absent: summary(explainResult(await executor.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(4)}`))),
      firstState: summary(explainResult(await executor.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(2)}`))),
      secondState: summary(explainResult(await executor.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(3)}`))),
      genericAbsent: await genericProbe(),
    });
    const existingPlans = await plans();
    let indexed = existingPlans, withoutIndex = existingPlans;
    const defaultStatisticsTrials: unknown[] = [];
    let fullSampleDiagnostic: Awaited<ReturnType<typeof plans>> | undefined;
    let diagnosticStatisticsRestored = false;
    if (target.existing) {
      const rollback = new Error("restore fixture index");
      await expect(db.transaction(async tx => {
        await tx.execute(sql`DROP INDEX public.${sql.identifier(target.index)}`);
        // Use this same transaction/connection; root queries would wait on our DDL lock.
        withoutIndex = { ...existingPlans, absent: summary(explainResult(await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(4)}`))) };
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await indexState()).toEqual(originalIndexes);
    } else {
      await runWorkContactClientIndex(db);
      await exec("ANALYZE public.work_contact_action_outbox");
      indexed = await plans();
      // Default ANALYZE can miss three rare client keys in this deliberately
      // extreme hot-key fixture. Keep that evidence; do not force planner flags
      // or mistake one lucky sample for universal generic-plan performance.
      for (let trial = 0; trial < 5; trial++) {
        const sample = trial === 0 ? indexed : await plans();
        expect(sample.absent.rows).toBe(0);
        expect(sample.firstState.rows).toBe(1);
        expect(sample.secondState.rows).toBe(1);
        expect(sample.genericAbsent.rows).toBe(0);
        const stats = await query("SELECT attname,n_distinct,most_common_freqs FROM pg_stats WHERE schemaname='public' AND tablename='work_contact_action_outbox' AND attname IN ('corp_id','client_id') ORDER BY attname");
        defaultStatisticsTrials.push({ trial, stats: stats.rows, absent: sample.absent, genericAbsent: sample.genericAbsent });
        if (trial < 4) await exec("ANALYZE public.work_contact_action_outbox");
      }
      const statisticsState = () => query(`SELECT a.attname,a.attstattarget,to_jsonb(s) AS statistics
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_statistic s
          ON s.starelid=a.attrelid AND s.staattnum=a.attnum
        WHERE a.attrelid='public.work_contact_action_outbox'::regclass
          AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum,s.stainherit`);
      const beforeDiagnostic = await statisticsState();
      // Separate diagnostic only: target 1000 samples this entire 100003-row
      // fixture. This is NOT a migration or a recommendation to change production
      // statistics. Default-plan variability remains an open acceptance item.
      const rollbackDiagnostic = new Error("restore fixture statistics before parent actions");
      await expect(db.transaction(async tx => {
        await tx.execute(sql`ALTER TABLE public.work_contact_action_outbox ALTER COLUMN corp_id SET STATISTICS 1000`);
        await tx.execute(sql`ALTER TABLE public.work_contact_action_outbox ALTER COLUMN client_id SET STATISTICS 1000`);
        await tx.execute(sql`ANALYZE public.work_contact_action_outbox`);
        // Use the same transaction for every plan; root queries would wait on
        // our DDL locks. Rollback restores both targets and pg_statistic rows.
        fullSampleDiagnostic = await plans(tx, () => genericOn(tx));
        throw rollbackDiagnostic;
      })).rejects.toBe(rollbackDiagnostic);
      expect(await statisticsState()).toEqual(beforeDiagnostic);
      diagnosticStatisticsRestored = true;
    }
    expect(withoutIndex.absent.filtered).toBeGreaterThanOrEqual(100000);
    expect(indexed.absent.rows).toBe(0);
    expect(indexed.firstState.rows).toBe(1);
    expect(indexed.secondState.rows).toBe(1);
    expect(indexed.genericAbsent.rows).toBe(0);
    for (const [name, plan] of Object.entries(fullSampleDiagnostic ?? indexed)) {
      expect(plan.indexes, JSON.stringify({ target: target.fk, name, plan })).toContain(target.index);
      expect(plan.filtered).toBe(0);
      expect(plan.hits + plan.reads).toBeLessThan(50);
    }
    const parentWhere = (key: number) => target.existing ? sql`id=${key}` : sql`corp_id=${"fixture"} AND id=${key}`;
    // Client id is GENERATED ALWAYS; change the other referenced key component
    // instead of disabling identity protection to manufacture an UPDATE test.
    const parentUpdate = (key: number) => target.existing
      ? sql`UPDATE public.${sql.identifier(target.parent)} SET id=id+200000 WHERE ${parentWhere(key)}`
      : sql`UPDATE public.work_client_current SET corp_id='moved' WHERE ${parentWhere(key)}`;
    for (const key of [2, 3]) {
      for (const operation of [sql`DELETE FROM public.${sql.identifier(target.parent)} WHERE ${parentWhere(key)}`,
        parentUpdate(key)]) {
        const result = await db.execute(operation).then(() => ({ error: undefined }), error => ({ error }));
        expect(result.error).toBeDefined();
        expect(messages(result.error)).toContain(target.fk);
        const deletion = new PgDialect().sqlToQuery(operation).sql.startsWith("DELETE");
        expect(result.error).toMatchObject({ cause: { code: deletion && major === 18 ? "23001" : "23503" } });
      }
    }
    for (const operation of [sql`DELETE FROM public.${sql.identifier(target.parent)} WHERE ${parentWhere(4)}`,
      parentUpdate(4)]) {
      const rollback = new Error("restore fixture parent");
      await expect(db.transaction(async tx => {
        const plan = explainResult(await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${operation}`));
        expect(plan.Triggers).toContainEqual(expect.objectContaining({ "Constraint Name": target.fk, Calls: 1 }));
        throw rollback;
      })).rejects.toBe(rollback);
    }
    expect(await fingerprint(target.table)).toEqual(beforeRows);
    expect(await fingerprint(target.parent)).toEqual(beforeParents);
    expect(await fkState()).toEqual(beforeFk);
    const nullable = await query(`SELECT count(*)::int AS count FROM public.${target.table} WHERE ${target.column} IS NULL`);
    expect(nullable.rows).toEqual([{ count: target.existing ? 50001 : 0 }]);
    process.stdout.write("WORK_FK_INDEX_AUDIT " + JSON.stringify({ target: target.fk, version: identity.version,
      rows: 100003, existingPartialIndex: target.existing, existingPlans, withoutIndexAbsent: withoutIndex.absent, indexed,
      completeModelForeignKeys: expectedForeignKeys.length,
      defaultStatisticsTrials, fullSampleDiagnostic, diagnosticStatisticsTarget: target.existing ? null : 1000,
      diagnosticStatisticsRestored: target.existing ? null : diagnosticStatisticsRestored,
      parentActionsUseDefaultStatistics: true,
      defaultStatisticsUniversalIndexUseProven: false,
      nullRows: target.existing ? 50001 : 0, formalMigrationApplied: target.existing ? false : "0148", existingIndexPreserved: target.existing,
      parentAndChildRowsUnchanged: true, foreignKeyUnchanged: true, nestedTriggerPlanCaptured: false, productionLatencyClaim: false }) + "\n");
  }, 180000);
});
