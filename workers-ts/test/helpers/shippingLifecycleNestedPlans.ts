import assert from 'node:assert/strict';
import type { sequenceRunnerDatabase } from './kefuSequenceRunnerDatabase';

type Node = Record<string, unknown> & { Plans?: Node[] };
type Plan = { 'Query Text': string; Plan: Node };
const walk = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(walk)];

// Observe actual trigger SPI execution on one stable backend, including after
// hot-key warmup. No forced planner mode, replacement function or business commit.
export async function shippingLifecycleNestedPlans(f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>) {
  assert.equal(f.format, 'pg16'); assert.ok(f.withPeer);
  const notices: string[] = [], records: Array<Record<string, unknown>> = [];
  await f.withPeer(async peer => {
    await peer.exec("LOAD 'auto_explain'; BEGIN");
    try {
      assert.deepEqual(await peer.exec("SELECT current_setting('plan_cache_mode') AS mode"), [{ mode: 'auto' }]);
      await peer.exec(`SET LOCAL client_min_messages=notice; SET LOCAL auto_explain.log_level=notice;
        SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_analyze=on;
        SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_timing=off;
        SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_parameter_max_length=0;
        SET LOCAL auto_explain.log_min_duration=0`);
      for (const action of ['UPDATE', 'DELETE']) {
        for (const [ordinal, id] of [10,10,10,10,10,10,12,11].entries()) {
          notices.length = 0;
          await peer.exec('SAVEPOINT shipping_attempt');
          try {
            const statement = action === 'UPDATE' ? `UPDATE public.shipping_templates SET is_del=1 WHERE id=${id}`
              : `DELETE FROM public.shipping_templates WHERE id=${id}`;
            if (id === 11) await peer.exec(statement);
            else await assert.rejects(peer.exec(statement), { code: '23503' });
          } finally { await peer.exec('ROLLBACK TO SAVEPOINT shipping_attempt; RELEASE SAVEPOINT shipping_attempt'); }
          const plans = notices.flatMap(message => {
            const start = message.indexOf('{\n'); if (start < 0) return [];
            const plan = JSON.parse(message.slice(start)) as Plan;
            return plan['Query Text']?.includes('FROM public.store_product') && plan['Query Text'].includes('CASE WHEN temp_id') ? [plan] : [];
          });
          assert.equal(plans.length, 1, `Missing/ambiguous real shipping parent plan: ${action}/${ordinal}/${id}`);
          const plan = plans[0], nodes = walk(plan.Plan);
          records.push({ action, ordinal: ordinal + 1, id, mode: 'auto', referenced: id !== 11,
            buffers: Number(plan.Plan['Shared Hit Blocks'] ?? 0) + Number(plan.Plan['Shared Read Blocks'] ?? 0),
            filtered: nodes.reduce((n,p) => n + Number(p['Rows Removed by Filter'] ?? 0) * Number(p['Actual Loops'] ?? 0), 0),
            parameterizedPlan: /\$[1-9]\b/.test(JSON.stringify(plan.Plan)),
            scans: nodes.filter(p => p['Relation Name']).map(p => ({ type: p['Node Type'], table: p['Relation Name'], index: p['Index Name'], loops: p['Actual Loops'] })),
            executedPlan: plan });
        }
      }
    } finally { await peer.exec('ROLLBACK'); }
  }, notice => { if (notice.message) notices.push(notice.message); });
  assert.equal(records.length, 16);
  return records;
}
