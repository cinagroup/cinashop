import { readFileSync } from "node:fs";
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
  it("retains every existing gate exactly once and does not increase execution or child time limits",()=>{
    const unit=job("worker-unit"),catalog=job("worker-catalog");
    expect(names(unit)).toEqual([...setup,"Audit production dependencies","Run both TypeScript configurations","Run Worker unit tests",
      "Audit production observability contract","Audit legacy-to-PostgreSQL schema drift","Audit legacy-to-Worker route parity"]);
    expect(names(catalog)).toEqual([...setup,"Execute isolated PostgreSQL 16 ORM and migration catalog audit",
      "Verify NOT VALID generator semantics on isolated PostgreSQL 16"]);
    for(const block of [unit,catalog]) {
      expect(block).toContain("timeout-minutes: 20");
      expect(block).toContain("image: postgres:16.14-alpine");
      expect(block).toContain("TEST_FINANCE_POSTGRES_URL: postgresql://finance_test:finance_test@127.0.0.1:5432/cinashop_finance_test");
      expect(block).toContain('node-version: "24.14.1"');
      expect(block).toContain('test "$(npm --version)" = "11.11.0"');
      expect(block).toContain("run: npm ci");
      expect(block).not.toMatch(/needs:|continue-on-error|--shard|--maxWorkers|--testTimeout/);
    }
    for(const command of ["npm run audit:prod","npm run typecheck","npm run test:unit","npm run audit:observability"])
      expect(unit).toContain("run: "+command);
    expect(catalog).toContain("run: npm run audit:orm\n");
    expect(catalog).toContain("run: npm run audit:orm:not-valid\n");
    expect(unit).not.toContain("run: npm run audit:orm");
    expect(workflow).not.toContain("secrets.");
  });
});
