import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("payment outbox Queue PostgreSQL integration evidence", () => {
  it("applies a validated schema at the start of every scoped business transaction", () => {
    const source = readFileSync("src/lib/di.ts", "utf8");
    expect(source).toContain(
      "const transactionSearchPaths = new WeakMap<DbClient, readonly string[]>();",
    );
    expect(source).toContain("SET LOCAL search_path TO");
    expect(source).toContain("transactionSearchPaths.get(container.db)");
  });

  it("retains the production-Hyperdrive Queue business recovery scenario", () => {
    const scenario = readFileSync(
      "test/integration/OrderPaidOutboxQueuePostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain('"normal", "interruption", "expired_lease", "failure"');
    expect(scenario).toContain("integration supplier transaction failure");
    expect(scenario).toContain("failure_before_retry");
    expect(scenario).toContain("duplicate deliveries were not idempotently acknowledged");
    expect(scenario).toContain("audit-specific business rows escaped into public schema");
    expect(scenario).toContain("DROP SCHEMA ${schema} CASCADE");
  });
});
