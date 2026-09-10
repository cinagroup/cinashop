import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow=readFileSync(resolve(import.meta.dirname,"../../.github/workflows/workers-runtime-linux.yml"),"utf8").replace(/\r\n/g,"\n");
const job=(name:string)=>{
  const blocks=[...workflow.matchAll(/^  ([a-z-]+):\n([\s\S]*?)(?=^  [a-z-]+:\n|(?![\s\S]))/gm)];
  const selected=blocks.filter(m=>m[1]===name);
  expect(selected).toHaveLength(1);
  return selected[0][2];
};
const names=(source:string)=>[...source.matchAll(/^      - name: (.+)$/gm)].map(m=>m[1]);
const setup=["Check out repository","Set up Node.js","Verify pinned Node and npm","Install locked dependencies"];

describe("TEST-006 preserve required migration gate while separating catalog capacity",()=>{
  it("keeps the exact previous required-check name and rejects skipped, failed or cancelled dependencies",()=>{
    const aggregate=job("worker-static");
    expect(workflow.match(/name: Worker type, unit, schema and route gates$/gm)).toHaveLength(1);
    expect(aggregate).toContain("if: ${{ always() }}");
    expect(aggregate).toContain("needs: [worker-unit, worker-catalog]");
    expect(aggregate).toContain("timeout-minutes: 2");
    expect(names(aggregate)).toEqual(["Require both unchanged gate groups to succeed"]);
    expect(aggregate).toContain("UNIT_RESULT: ${{ needs.worker-unit.result }}");
    expect(aggregate).toContain("CATALOG_RESULT: ${{ needs.worker-catalog.result }}");
    expect(aggregate).toContain('run: |\n          test "$UNIT_RESULT" = "success"\n          test "$CATALOG_RESULT" = "success"');
    expect(aggregate).not.toMatch(/continue-on-error|if:.*success\(\)|\|\| true/);
  });
  it("retains every gate, pins the measured unit job budget and preserves catalog and child limits",()=>{
    const unit=job("worker-unit"),catalog=job("worker-catalog");
    expect(names(unit)).toEqual([...setup,"Audit production dependencies","Run both TypeScript configurations","Run Worker unit tests",
      "Verify exact executed unit shard coverage",
      "Audit production observability contract","Audit legacy-to-PostgreSQL schema drift","Audit legacy-to-Worker route parity"]);
    expect(names(catalog)).toEqual([...setup,"Execute isolated PostgreSQL 16 ORM and migration catalog audit",
      "Verify NOT VALID generator semantics on isolated PostgreSQL 16", "Verify sequence generator semantics on isolated PostgreSQL 16"]);
    // Run 34460778121 exceeded the old whole-job budget while tests continued.
    // Only unit-job capacity changed; no per-test deadline or gate is relaxed.
    expect(unit.match(/^    timeout-minutes: (\d+)$/gm)).toEqual(["    timeout-minutes: 40"]);
    expect(catalog.match(/^    timeout-minutes: (\d+)$/gm)).toEqual(["    timeout-minutes: 20"]);
    for(const block of [unit,catalog]) {
      expect(block).toContain("image: postgres:16.14-alpine");
      expect(block).toContain("TEST_FINANCE_POSTGRES_URL: postgresql://finance_test:finance_test@127.0.0.1:5432/cinashop_finance_test");
      expect(block).toContain('node-version: "24.14.1"');
      expect(block).toContain('test "$(npm --version)" = "11.11.0"');
      expect(block).toContain("run: npm ci");
      expect(block).not.toMatch(/needs:|continue-on-error|--maxWorkers|--testTimeout|--no-isolate|--retry|--passWithNoTests/);
    }
    for(const command of ["npm run audit:prod","npm run typecheck","npm run test:unit","npm run audit:observability"])
      expect(unit).toContain("run: "+command);
    expect(catalog).toContain("run: npm run audit:orm\n");
    expect(catalog).toContain("run: npm run audit:orm:not-valid\n");
    expect(catalog).toContain("run: npm run audit:orm:sequences\n");
    expect(unit).not.toContain("run: npm run audit:orm");
    expect(unit).toContain("strategy:\n      fail-fast: false\n      matrix:\n        shard: [1, 2]");
    expect(unit.match(/--shard=/g)).toHaveLength(1);
    expect(unit).toContain("run: npm run test:unit -- --shard=${{ matrix.shard }}/2 --reporter=default --reporter=json --outputFile.json=unit-shard-results.json");
    expect(unit).toContain("run: node scripts/audit-unit-shards.mjs ${{ matrix.shard }} unit-shard-results.json");
    expect(unit.match(/if: matrix.shard == 1/g)).toHaveLength(5);
    for(const name of ["Audit production dependencies", "Run both TypeScript configurations", "Audit production observability contract",
      "Audit legacy-to-PostgreSQL schema drift", "Audit legacy-to-Worker route parity"])
      expect(unit).toContain("- name: "+name+"\n        if: matrix.shard == 1\n");
    expect(catalog).not.toContain("--shard");
    expect(workflow).not.toContain("secrets.");
  });
  it("uses the real native partition and refuses omitted, duplicate, skipped or failed executed results",()=>{
    const environment={...process.env};
    const allowed=new Set(["PATH","Path","SystemRoot","WINDIR","COMSPEC","PATHEXT","TEMP","TMP","LOCALAPPDATA"]);
    for(const key of Object.keys(environment))if(!allowed.has(key))delete environment[key];
    environment.CI="1";
    const result=spawnSync(process.execPath,[resolve(import.meta.dirname,"helpers/unitShardPartitionAudit.mjs")],{
      cwd:resolve(import.meta.dirname,".."),env:environment,encoding:"utf8",timeout:10_000,windowsHide:true,
    });
    expect(result.error,result.stdout+result.stderr).toBeUndefined();
    expect(result.status,result.stdout+result.stderr).toBe(0);
    expect(result.stdout).toContain("nativePartitionCompleteAndDisjoint");
    expect(result.stdout).toContain('"invalidResultRefusals":14');
  },15_000);
});
