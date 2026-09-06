/** TEST-006: verify the native partition and actual JSON result, not `list --filesOnly` (which ignores --shard). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BaseSequencer, createVitest } from "vitest/node";

const root = resolve(import.meta.dirname, "..");
const id = path => relative(root, path).replaceAll("\\", "/");
const digest = files => createHash("sha256").update(files.join("\n")).digest("hex");

export async function inspectUnitPartition() {
  const shards = [], universes = [];
  for (const index of [1, 2]) {
    const ctx = await createVitest("test", { root, config: resolve(root, "vitest.config.ts"), watch: false, shard: `${index}/2` });
    try {
      assert.equal(ctx.config.sequence.sequencer, BaseSequencer, "Review a custom sequencer before accepting its partition");
      assert.deepEqual(ctx.config.shard, { index, count: 2 });
      const specs = await ctx.globTestSpecifications();
      const all = specs.map(s => id(s.moduleId)).sort();
      assert.ok(all.length > 1);
      assert.equal(new Set(all).size, all.length, "Duplicate module/project identities require explicit review");
      const selected = (await new BaseSequencer(ctx).shard(specs)).map(s => id(s.moduleId)).sort();
      assert.ok(selected.length > 0);
      universes.push(all); shards.push(selected);
    } finally { await ctx.close(); }
  }
  assert.deepEqual(universes[0], universes[1], "Test inventory changed while collecting partitions");
  assert.deepEqual(shards.flat().sort(), universes[0], "Shards must cover every configured file exactly once");
  assert.equal(new Set(shards.flat()).size, universes[0].length, "Shards must not overlap");
  return { files: universes[0], shards, digest: digest(universes[0]) };
}

export function verifyExecutedShard(partition, index, result) {
  assert.ok(index === 1 || index === 2, "Invalid shard index");
  assert.equal(result.success, true, "A failed run cannot satisfy coverage");
  assert.equal(result.numFailedTests, 0);
  assert.equal(result.numPendingTests, 0, "Dedicated CI PostgreSQL tests must run, not skip");
  assert.equal(result.numTodoTests, 0);
  assert.ok(Array.isArray(result.testResults));
  const expected = partition.shards[index - 1];
  assert.deepEqual(result.testResults.map(r => id(r.name)).sort(), expected, "Actual executed files differ from the native shard");
  const cases = result.testResults.flatMap(r => {
    assert.equal(r.status, "passed", "Every selected module must pass");
    assert.ok(Array.isArray(r.assertionResults) && r.assertionResults.length > 0, "Selected modules must execute assertions");
    return r.assertionResults;
  });
  for (const test of cases) assert.equal(test.status, "passed", "Skipped, pending, failed and todo assertions are not acceptance");
  assert.equal(cases.length, result.numTotalTests);
  assert.equal(cases.length, result.numPassedTests);
  return { shard: index, shardCount: 2, inventoryFiles: partition.files.length, inventorySha256: partition.digest,
    executedFiles: expected.length, executedFileSha256: digest(expected), passedTests: cases.length,
    skippedTests: 0, nativePartitionCompleteAndDisjoint: true, executedFilesMatchNativePartition: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [index, report] = process.argv.slice(2);
    assert.match(index ?? "", /^[12]$/);
    assert.equal(report, "unit-shard-results.json", "Only the CI-generated result in the Worker root is accepted");
    const partition = await inspectUnitPartition();
    const result = JSON.parse(await readFile(resolve(root, report), "utf8"));
    console.log(`UNIT_SHARD_AUDIT ${JSON.stringify(verifyExecutedShard(partition, Number(index), result))}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unit shard verification failed");
    process.exitCode = 1;
  }
}
