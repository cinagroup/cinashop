import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  "test/integration/AdminUserWriteReplayProductionMigrationWorker.ts",
  "utf8",
);
const runner = readFileSync(
  "scripts/run-admin-user-write-replay-production-migration.ps1",
  "utf8",
);
const config = readFileSync(
  "test/integration/admin-user-write-replay-production-migration.wrangler.jsonc",
  "utf8",
);

describe("admin user replay production migration harness", () => {
  it("uses the canonical migration in a bounded transaction and verifies two passes", () => {
    expect(worker).toContain("ADMIN_MOBILE_USER_REPLAY_SQL");
    expect(worker).toContain("SET LOCAL lock_timeout = '2s'");
    expect(worker).toContain("SET LOCAL statement_timeout = '15s'");
    expect(worker.match(/tx\.unsafe\(ADMIN_MOBILE_USER_REPLAY_SQL\)/g)).toHaveLength(2);
    expect(worker).toContain("partial admin user replay object set detected");
    expect(worker).toContain("business_state_unchanged");
    expect(worker).toContain("expected_catalog_delta");
    expect(worker).toContain("idempotent");
  });

  it("keeps the temporary endpoint token-protected and cleans it up", () => {
    expect(worker).toContain('request.headers.get("X-Audit-Token")');
    expect(worker).toContain("crypto.subtle.timingSafeEqual");
    expect(worker).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(runner).toContain("no_token_status")
    expect(runner).toContain("wrong_method_status")
    expect(runner).toContain("url_returns_404")
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
  });

  it("returns only catalog shape, counts, booleans and digests", () => {
    expect(worker).not.toMatch(/SELECT\s+\*/i);
    expect(worker).not.toMatch(/account|real_name|nickname|phone|email|pwd|password/i);
    expect(worker).not.toContain("beforeBusiness,");
    expect(worker).not.toContain("afterBusiness,");
  });
});
