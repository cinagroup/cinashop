import { describe, expect, it } from "vitest";
import { createDbFromConnectionString } from "../src/lib/di";

describe("PostgreSQL connection options", () => {
  it("rejects a search path that can escape the isolated schema", () => {
    expect(() => createDbFromConnectionString(
      "postgres://example.invalid/database",
      1,
      { searchPath: "audit_schema,public" },
    )).toThrow("one safe schema identifier or public,pg_temp");
  });

  it("accepts only the explicit production path with pg_temp last", async () => {
    const db = createDbFromConnectionString(
      "postgres://example.invalid/database",
      1,
      { searchPath: "public,pg_temp" },
    );
    expect(db).toBeDefined();
    await db.$client.end({ timeout: 0 });
  });

  it("rejects unsafe application names", () => {
    expect(() => createDbFromConnectionString(
      "postgres://example.invalid/database",
      1,
      { applicationName: "audit worker; reset all" },
    )).toThrow("unsupported characters");
  });
});
