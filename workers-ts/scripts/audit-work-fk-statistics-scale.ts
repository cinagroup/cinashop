/** Explicit, bounded local PG16 experiment; never a production migration. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from "../test/helpers/kefuSequenceRunnerDatabase";
import { foreignKeyIndexInventory } from "./foreign-key-index-audit";

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
type CapturedPlan = { "Query Text": string; Plan: PlanNode };
function nodes(plan: PlanNode): PlanNode[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
function captured(notices: string[]): CapturedPlan {
  const plans = notices.flatMap(message => {
    const start = message.indexOf("{\n");
    if (start < 0) return [];
    const plan = JSON.parse(message.slice(start)) as CapturedPlan;
    return plan["Query Text"]?.includes('FROM ONLY "public"."work_contact_action_outbox"') ? [plan] : [];
  });
  assert.equal(plans.length, 1, "Exactly one actual wcao RI query must be captured");
  assert.match(plans[0]["Query Text"], /FOR KEY SHARE/);
  assert.match(plans[0]["Query Text"], /"corp_id"/);
  assert.match(plans[0]["Query Text"], /"client_id"/);
  return plans[0];
}

async function main() {
  assert.equal(process.argv.length, 2, "This audit accepts no scope/connection override arguments");
  validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? "");
  const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
  const generated = (await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join("\n");
  const expectedForeignKeys = foreignKeyIndexInventory(models).entries.map(entry => `${entry.table}.${entry.name}`).sort();
  const auditStarted = performance.now();
  const scales: unknown[] = [];
  for (const count of [100003, 1000003]) {
    const f = await sequenceRunnerDatabase();
    assert.equal(f.format, "pg16", "PGlite is not a valid capacity benchmark");
    if (!f.withPeer) throw new Error("Actual PG16 peer connections are required");
    try {
      const seedStarted = performance.now();
      await f.exec(generated);
      const constraints = () => f.query(`SELECT c.conrelid::text,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
        ORDER BY c.conrelid,c.conname`);
      const indexes = () => f.query(`SELECT c.oid::text,c.relname,to_jsonb(i) AS metadata,pg_get_indexdef(c.oid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' ORDER BY c.relname`);
      const stats = () => f.query(`SELECT a.attname,a.attstattarget,a.attoptions,to_jsonb(s) AS statistics
        FROM pg_attribute a LEFT JOIN pg_statistic s ON s.starelid=a.attrelid AND s.staattnum=a.attnum
        WHERE a.attrelid='public.work_contact_action_outbox'::regclass AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum,s.stainherit`);
      const fingerprint = (table: "work_callback_event" | "work_contact_action_outbox" | "work_client_current") =>
        f.query(`SELECT count(*)::text AS count,md5(string_agg(md5(to_jsonb(x)::text),'' ORDER BY x.id${table === "work_client_current" ? ",x.corp_id" : ""})) AS digest FROM public.${table} x`);
      const actual = await f.query("SELECT t.relname,c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='f'");
      assert.deepEqual(actual.rows.map(row => {
        assert(row && typeof row === "object" && "relname" in row && "conname" in row);
        return `${row.relname}.${row.conname}`;
      }).sort(), expectedForeignKeys);
      await f.exec(`INSERT INTO work_client_current(corp_id,external_userid)
        SELECT 'fixture','client_'||n FROM generate_series(1,4) n;
        INSERT INTO work_client_current(id,corp_id,external_userid) OVERRIDING SYSTEM VALUE VALUES (4,'other','client_other')`);
      // Each chunk keeps the existing 30-second statement deadline. No FK,
      // CHECK or unique index is disabled to make million-row seeding succeed.
      for (let start = 1; start <= count; start += 10000) {
        const end = Math.min(start + 9999, count);
        await f.exec(`INSERT INTO work_callback_event(id,event_key,payload_hash,subject_key_hash,corp_id,payload,event_time)
          SELECT n,lpad(to_hex(n),64,'0'),repeat('b',64),repeat('c',64),CASE WHEN n=${count} THEN 'other' ELSE 'fixture' END,'{}',1
          FROM generate_series(${start},${end}) n`);
        await f.exec(`INSERT INTO work_contact_action_outbox(id,event_id,event_key,action_key,action_type,corp_id,client_id,payload_hash,status)
          SELECT n,n,lpad(to_hex(n),64,'0'),lpad(to_hex(n),64,'0'),'AUTO_TAG',CASE WHEN n=${count} THEN 'other' ELSE 'fixture' END,
          CASE WHEN n=${count - 2} THEN 2 WHEN n=${count - 1} THEN 3 WHEN n=${count} THEN 4 ELSE 1 END,
          repeat('b',64),CASE WHEN n=${count - 2} THEN 'PENDING' ELSE 'CLOSED' END FROM generate_series(${start},${end}) n`);
        if (end % 100000 === 0 || end === count) process.stderr.write(`WORK_FK_SCALE_PROGRESS ${JSON.stringify({ count, seeded: end })}\n`);
      }
      await f.exec("ANALYZE public.work_contact_action_outbox; ANALYZE public.work_client_current");
      const baselineConstraints = await constraints(), baselineIndexes = await indexes(), baselineStats = await stats();
      const baselineRows = await Promise.all([fingerprint("work_callback_event"), fingerprint("work_contact_action_outbox"), fingerprint("work_client_current")]);
      assert.deepEqual(baselineRows[1].rows.map(row => (row as unknown as { count: string }).count), [String(count)]);
      const [identity] = (await f.query("SELECT current_setting('server_version_num') AS version,current_setting('default_statistics_target') AS default_target,current_setting('plan_cache_mode') AS mode")).rows;
      assert(identity && typeof identity === "object" && "mode" in identity && identity.mode === "auto");
      const sizes = await f.query("SELECT pg_relation_size('public.work_contact_action_outbox')::text AS heap_bytes,pg_indexes_size('public.work_contact_action_outbox')::text AS index_bytes");
      const seedMs = performance.now() - seedStarted;
      const trials: unknown[] = [];
      for (const target of [-1, 1000, 10000]) {
        for (let trial = 0; trial < 5; trial++) {
          const notices: string[] = [];
          await f.withPeer(async peer => {
            await peer.exec("LOAD 'auto_explain'; BEGIN");
            try {
              assert.deepEqual(await peer.exec("SELECT current_setting('plan_cache_mode') AS mode"), [{ mode: "auto" }]);
              // Default arm receives no ALTER. Candidate arms use only a local
              // rollback transaction, so their targets/statistics cannot leak.
              if (target !== -1) await peer.exec(`ALTER TABLE public.work_contact_action_outbox
                ALTER COLUMN corp_id SET STATISTICS ${target}, ALTER COLUMN client_id SET STATISTICS ${target}`);
              const analyzeStarted = performance.now();
              await peer.exec("ANALYZE VERBOSE public.work_contact_action_outbox");
              const analyzeMs = performance.now() - analyzeStarted;
              const analyzeMessages = notices.filter(message => /scanned|sample/.test(message));
              assert(analyzeMessages.length > 0, "Actual ANALYZE sample progress must be captured");
              const sampledStats = await peer.exec("SELECT attname,n_distinct,most_common_freqs FROM pg_stats WHERE schemaname='public' AND tablename='work_contact_action_outbox' AND attname IN ('corp_id','client_id') ORDER BY attname");
              await peer.exec(`SET LOCAL client_min_messages=notice; SET LOCAL auto_explain.log_level=notice;
                SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_analyze=on;
                SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off;
                SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_parameter_max_length=0;
                SET LOCAL auto_explain.log_min_duration=0`);
              const operations: unknown[] = [];
              for (const [offset, key] of [1, 1, 1, 1, 1, 1, 4, 2, 4].entries()) {
                notices.length = 0;
                await peer.exec("SAVEPOINT ri_attempt");
                try {
                  const operation = `DELETE FROM public.work_client_current WHERE corp_id='fixture' AND id=${key}`;
                  if (key === 4) await peer.exec(operation);
                  else await assert.rejects(peer.exec(operation), { code: "23503", constraint_name: "wcao_client_fk" });
                } finally { await peer.exec("ROLLBACK TO SAVEPOINT ri_attempt; RELEASE SAVEPOINT ri_attempt"); }
                const plan = captured(notices), flat = nodes(plan.Plan);
                assert.equal(plan.Plan["Actual Rows"], key === 4 ? 0 : 1);
                operations.push({ ordinal: offset + 1, key, parameterizedPlan: /\$[12]\b/.test(JSON.stringify(plan.Plan)),
                  rows: plan.Plan["Actual Rows"], hits: plan.Plan["Shared Hit Blocks"], reads: plan.Plan["Shared Read Blocks"],
                  filtered: flat.reduce((sum, node) => sum + Number(node["Rows Removed by Filter"] ?? 0) * Number(node["Actual Loops"] ?? 1), 0),
                  nodes: flat.map(node => ({ type: node["Node Type"], rows: node["Actual Rows"], loops: node["Actual Loops"], index: node["Index Name"] })),
                  ...(offset >= 5 ? { executedPlan: plan } : {}) });
              }
              assert.equal(operations.length, 9);
              trials.push({ target, trial, analyzeMs, analyzeMessages, sampledStats, operations });
            } finally { await peer.exec("ROLLBACK"); }
          }, notice => { if (notice.message) notices.push(notice.message); });
          assert.deepEqual(await stats(), baselineStats, "Every diagnostic target and statistic must roll back");
          process.stderr.write(`WORK_FK_SCALE_PROGRESS ${JSON.stringify({ count, target, trial, rolledBack: true })}\n`);
        }
      }
      assert.deepEqual(await constraints(), baselineConstraints);
      assert.deepEqual(await indexes(), baselineIndexes);
      assert.deepEqual(await Promise.all([fingerprint("work_callback_event"), fingerprint("work_contact_action_outbox"), fingerprint("work_client_current")]), baselineRows);
      scales.push({ count, identity, sizes: sizes.rows, seedMs, fullOrmForeignKeys: expectedForeignKeys.length, trials,
        allRowsUnchanged: true, allConstraintsAndIndexesUnchanged: true, statisticsRestoredAfterEveryTrial: true });
    } finally { await f.close(); }
  }
  assert.equal(scales.length, 2);
  process.stdout.write("WORK_FK_STATISTICS_SCALE_AUDIT " + JSON.stringify({ scales, elapsedMs: performance.now() - auditStarted,
    ownedDatabasesCleaned: true, productionConnected: false, migrationRecommendation: false }) + "\n");
}

main().catch(error => {
  // Avoid dumping connection-bearing driver diagnostics. Fixture constraint
  // assertions remain visible; no URL or password is an output field.
  process.stderr.write(`WORK_FK_STATISTICS_SCALE_FAILED ${error instanceof Error ? error.name : "UnknownError"}\n`);
  process.exitCode = 1;
});
