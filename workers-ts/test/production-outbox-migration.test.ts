import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production outbox migration guard", () => {
  const worker = readFileSync("test/integration/ProductionOutboxMigrationWorker.ts", "utf8");

  it("exposes only fixed print and waybill migrations behind an audit token", () => {
    expect(worker).toContain('path === "/apply-print"');
    expect(worker).toContain('path === "/apply-waybill"');
    expect(worker).not.toContain("request.json");
    expect(worker).not.toContain("request.text");
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
  });

  it("pins and bounds the production DDL transaction", () => {
    expect(worker).toContain("SET LOCAL search_path TO public");
    expect(worker).toContain("SET LOCAL lock_timeout = '3s'");
    expect(worker).toContain("SET LOCAL statement_timeout = '30s'");
    expect(worker).toContain("pg_advisory_xact_lock");
    expect(worker).toContain("business fingerprint changed inside DDL transaction");
  });

  it("uses the same embedded DDL that is already checked against the external files", () => {
    expect(worker).toContain("receiptPrintJobMigrationSqlForVerification");
    expect(worker).toContain("waybillJobMigrationSqlForVerification");
  });
});
