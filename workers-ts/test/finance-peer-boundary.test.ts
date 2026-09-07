import { describe, expect, it } from "vitest";
import { validateFinancePeerUrl, waitForFinanceBlock, waitForFinanceClock } from "./helpers/financePeers";
import { financePostgres } from "./helpers/financePostgres";

describe("independent finance peer safety boundary", () => {
  const valid = "postgresql://finance_test:fixture@127.0.0.1:5432/cinashop_finance_test";
  it("accepts only the dedicated loopback test target without injected options", () => {
    expect(validateFinancePeerUrl(valid)).toBe(valid);
    expect(validateFinancePeerUrl(valid.replace("127.0.0.1", "localhost"))).toContain("localhost");
    for (const value of ["", "not a URL", valid.replace("postgresql:", "https:"), valid.replace("127.0.0.1", "db.example.com"),
      valid.replace("cinashop_finance_test", "production"), valid.replace("finance_test:", "admin:"),
      `${valid}?options=-c%20search_path%3Dpublic`, `${valid}#fragment`]) expect(() => validateFinancePeerUrl(value)).toThrow();
  });
  it("rejects invalid and same-session blocker pairs without executing SQL", async () => {
    const f = await financePostgres([]);
    try {
      for (const [waiter, blocker] of [[1, 1], [0, 2], [1, -2], [NaN, 2], [1, 2.5]]) {
        await expect(waitForFinanceBlock(f.db, waiter, blocker)).rejects.toThrow("Invalid finance backend pair");
      }
    } finally { await f.close(); }
  });
  it("executes the actual database-clock probe and rejects invalid deadlines", async () => {
    const f = await financePostgres([]);
    try {
      for (const value of [0, -1, NaN, Infinity, 1.5]) {
        await expect(waitForFinanceClock(f.db, value)).rejects.toThrow("Invalid finance deadline");
      }
      await expect(waitForFinanceClock(f.db, Date.now() - 60_000)).resolves.toBeUndefined();
    } finally { await f.close(); }
  });
});
