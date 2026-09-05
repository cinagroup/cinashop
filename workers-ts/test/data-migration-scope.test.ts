import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DataMigrationScope {
  deploymentMode: string;
  legacyPhpHistoryRequired: boolean;
  sourceMysqlReconciliation: string;
  notApplicableChecklistItems: string[];
  productionBaseline: {
    tables: number;
    missingCandidateTables: string[];
    extraTables: string[];
  };
}

const scope = JSON.parse(
  readFileSync("audit/data-migration-scope.json", "utf8"),
) as DataMigrationScope;
const checklist = readFileSync("../MIGRATION_CHECKLIST.md", "utf8");

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

  it("records the exact current repository-to-production table parity", () => {
    expect(scope.productionBaseline).toEqual(expect.objectContaining({
      tables: 263,
      missingCandidateTables: [],
      extraTables: [],
    }));
  });

  it("keeps every retired source-data checklist item explicitly closed as not applicable", () => {
    for (const id of scope.notApplicableChecklistItems) {
      expect(checklist).toMatch(new RegExp(`- \\[x\\] \\*\\*${id}[^\\n]*不适用`));
    }
    const openItems = checklist.split("\n").filter((line) => /^\s*- \[ \]/.test(line));
    expect(openItems.join("\n")).not.toMatch(/SOURCE_MYSQL_URL|从源 MySQL|源PHP[^\n]*复制/);
  });
});
