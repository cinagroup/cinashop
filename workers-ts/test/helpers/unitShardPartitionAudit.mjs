import assert from "node:assert/strict";
import { resolve } from "node:path";
import { inspectUnitPartition, verifyExecutedShard } from "../../scripts/audit-unit-shards.mjs";

const partition=await inspectUnitPartition();
let invalidResultRefusals=0;
for(const index of [1,2]) {
  // Synthetic reporter objects test refusal logic only; actual CI reports are separately verified after execution.
  const selected=partition.shards[index-1];
  const good={success:true,numFailedTests:0,numPendingTests:0,numTodoTests:0,numPassedTests:selected.length,numTotalTests:selected.length,
    testResults:selected.map(file=>({name:resolve(file),status:"passed",assertionResults:[{status:"passed"}]}))};
  assert.equal(verifyExecutedShard(partition,index,good).executedFiles,selected.length);
  const bads=[
    {...good,testResults:good.testResults.slice(1)},
    {...good,testResults:[...good.testResults,good.testResults[0]]},
    {...good,success:false},
    {...good,numPendingTests:1},
    {...good,numTodoTests:1},
    {...good,numPassedTests:good.numPassedTests-1},
    {...good,testResults:good.testResults.map((r,i)=>i?r:{...r,assertionResults:[{status:"skipped"}]})},
  ];
  for(const bad of bads) {assert.throws(()=>verifyExecutedShard(partition,index,bad));invalidResultRefusals++;}
}
console.log(JSON.stringify({inventoryFiles:partition.files.length,shards:partition.shards.map(s=>s.length),
  nativePartitionCompleteAndDisjoint:true,invalidResultRefusals}));
