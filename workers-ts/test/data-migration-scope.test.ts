import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DataMigrationScope {
  deploymentMode: string;
  legacyPhpHistoryRequired: boolean;
  sourceMysqlReconciliation: string;
  notApplicableChecklistItems: string[];
  candidateSchemaWork: {
    candidateTables: number;
    addedSinceHistoricalBaseline: string[];
    deploymentStatus: string;
  };
  productionBaseline: {
    capturedAt: string;
    tables: number;
    missingCandidateTables: string[];
    extraTables: string[];
  };
}

const scope = JSON.parse(
  readFileSync("audit/data-migration-scope.json", "utf8"),
) as DataMigrationScope;
const checklist = readFileSync("../MIGRATION_CHECKLIST.md", "utf8");
const readme = readFileSync("README.md", "utf8");

function openChecklistItems(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => /^\s*- \[ \]/.test(line))
    .join("\n");
}

describe("fresh-system data migration scope", () => {
  it("does not require legacy PHP history or source MySQL reconciliation", () => {
    expect(scope).toMatchObject({
      deploymentMode: "fresh_system",
      legacyPhpHistoryRequired: false,
      sourceMysqlReconciliation: "not_applicable",
    });
    expect(scope.notApplicableChecklistItems).toEqual([
      "DATA-001",
      "DATA-002",
      "DATA-003",
      "DATA-004",
      "DATA-005",
    ]);
  });

  it("preserves the historical production snapshot and identifies the undeployed candidate addition", () => {
    expect(scope.productionBaseline).toEqual(expect.objectContaining({
      capturedAt: "2026-09-04T14:55:00Z",
      tables: 263,
      missingCandidateTables: [],
      extraTables: [],
    }));
    expect(scope.candidateSchemaWork).toEqual(expect.objectContaining({
      candidateTables: 277,
      addedSinceHistoricalBaseline: ["shipping_template_create_replay", "admin_refund_operation", "admin_refund_creation", "store_order_invoice_evidence", "store_order_invoice_allocation", "store_order_refund_split", "store_order_fulfillment_branch", "offline_order_admission", "offline_order_payment_selection", "offline_order_balance", "offline_order_query_evidence", "offline_order_callback_binding", "offline_order_external_payment", "offline_order_payment_dispatch"],
      deploymentStatus: "not_deployed",
    }));
    expect(scope.candidateSchemaWork.candidateTables).toBe(
      scope.productionBaseline.tables + scope.candidateSchemaWork.addedSinceHistoricalBaseline.length,
    );
  });

  it("keeps every retired source-data checklist item explicitly closed as not applicable", () => {
    for (const id of scope.notApplicableChecklistItems) {
      expect(checklist).toMatch(new RegExp(`- \\[x\\] \\*\\*${id}[^\\n]*不适用`));
    }
    expect(openChecklistItems(checklist)).not.toMatch(
      /SOURCE_MYSQL_URL|从源 MySQL|源PHP[^\n]*复制/,
    );
    expect(openChecklistItems(readme)).not.toMatch(
      /SOURCE_MYSQL_URL|从源 MySQL|源PHP[^\n]*复制|旧 MySQL[^\n]*(迁移|复制|对账)|复制旧[^\n]*(数据|库存|会员|订单)/,
    );
  });
});
