import assert from "node:assert/strict";
import type { sequenceRunnerDatabase } from "./kefuSequenceRunnerDatabase";

type Owned = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Node = Record<string, unknown> & { Plans?: Node[] };
type Plan = { "Query Text": string; Plan: Node };
interface ParentCase {
  name: string;
  key: number;
  referenced: boolean;
  deleteStatement: string;
  updateStatement: string;
}
function walk(node: Node): Node[] { return [node, ...(node.Plans ?? []).flatMap(walk)]; }

/** Real RI queries on an owned PG16 peer; never replace them with diagnostic SQL. */
export async function foreignKeyNestedPlans(owned: Owned, target: {
  table: string; constraint: string; columns: readonly string[]; cases: ParentCase[];
}) {
  assert.equal(owned.format, "pg16");
  const connect = owned.withPeer;
  assert(connect, "Actual PostgreSQL peers are required for nested plans");
  for (const name of [target.table, target.constraint, ...target.columns]) assert.match(name, /^[a-z][a-z0-9_]*$/);
  assert(target.cases.length > 1 && target.cases[0].referenced, "First case must supply a referenced warmup key");
  assert(target.cases.some(p => !p.referenced), "An actual unreferenced parent case is required");
  const records: Array<Record<string, unknown>> = [];
  for (const mode of ["auto", "force_custom_plan", "force_generic_plan"] as const) {
    const notices: string[] = [];
    await connect(async peer => {
      await peer.exec("LOAD 'auto_explain'; BEGIN");
      try {
        if (mode === "auto") assert.deepEqual(await peer.exec("SELECT current_setting('plan_cache_mode') AS mode"), [{ mode: "auto" }]);
        else await peer.exec(`SET LOCAL plan_cache_mode=${mode}`);
        await peer.exec(`SET LOCAL client_min_messages=notice; SET LOCAL auto_explain.log_level=notice;
          SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_analyze=on;
          SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off;
          SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_parameter_max_length=0;
          SET LOCAL auto_explain.log_min_duration=0`);
        for (const action of ["DELETE", "UPDATE"] as const) {
          // Each mode uses a fresh backend. DELETE then UPDATE intentionally
          // share that backend; UPDATE is not an independent cold-cache test.
          const cases = mode === "auto" ? [...Array<ParentCase>(5).fill(target.cases[0]), ...target.cases] : target.cases;
          for (const [offset, parent] of cases.entries()) {
            notices.length = 0;
            await peer.exec("SAVEPOINT ri_attempt");
            try {
              const operation = action === "DELETE" ? parent.deleteStatement : parent.updateStatement;
              if (parent.referenced) await assert.rejects(peer.exec(operation), { code: "23503", constraint_name: target.constraint });
              else await peer.exec(operation);
            } finally { await peer.exec("ROLLBACK TO SAVEPOINT ri_attempt; RELEASE SAVEPOINT ri_attempt"); }
            const plans = notices.flatMap(message => {
              const start = message.indexOf("{\n");
              if (start < 0) return [];
              const plan = JSON.parse(message.slice(start)) as Plan;
              const query = plan["Query Text"];
              return query?.includes(`FROM ONLY "public"."${target.table}"`)
                && target.columns.every(column => query.includes(`"${column}"`)) ? [plan] : [];
            });
            assert.equal(plans.length, 1, `Missing/ambiguous real RI plan for ${target.constraint}/${mode}/${action}/${parent.name}`);
            const plan = plans[0], nodes = walk(plan.Plan);
            assert.match(plan["Query Text"], /FOR KEY SHARE/);
            assert.equal(plan.Plan["Actual Rows"], parent.referenced ? 1 : 0);
            records.push({ mode, action, ordinal: offset + 1, case: parent.name, key: parent.key,
              referenced: parent.referenced, rows: plan.Plan["Actual Rows"],
              buffers: Number(plan.Plan["Shared Hit Blocks"] ?? 0) + Number(plan.Plan["Shared Read Blocks"] ?? 0),
              filtered: nodes.reduce((n, p) => n + Number(p["Rows Removed by Filter"] ?? 0) * Number(p["Actual Loops"] ?? 1), 0),
              parameterizedPlan: /\$[1-9]\b/.test(JSON.stringify(plan.Plan)),
              indexes: nodes.flatMap(p => typeof p["Index Name"] === "string" ? [p["Index Name"]] : []),
              nodes: nodes.map(p => ({ type: p["Node Type"], rows: p["Actual Rows"], loops: p["Actual Loops"] })),
              executedPlan: plan });
          }
        }
      } finally { await peer.exec("ROLLBACK"); }
    }, notice => { if (notice.message) notices.push(notice.message); });
  }
  assert.equal(records.length, target.cases.length * 6 + 10);
  return records;
}
