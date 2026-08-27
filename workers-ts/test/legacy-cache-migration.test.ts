import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { legacyCache } from "../src/models/schema";

describe("legacy database cache migration", () => {
  it("preserves the varchar primary key and all source columns", () => {
    expect(getTableName(legacyCache)).toBe("cache");
    expect(Object.keys(getTableColumns(legacyCache))).toEqual([
      "key", "result", "expireTime", "addTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "cache")?.key)
      .toEqual(["key"]);
  });

  it("keeps nullable JSON text, enforces expiry on reads, and uses explicit bounded writes", () => {
    const migration = readFileSync("migrations/0060_legacy_db_cache.sql", "utf8");
    const service = readFileSync("src/services/system/DatabaseCacheService.ts", "utf8");
    expect(migration).toContain('"result" TEXT');
    expect(migration).toContain('"cache_expire_time"');
    expect(service).toContain("gte(legacyCache.expireTime, now)");
    expect(service).toContain("MAX_CACHE_DOCUMENT_BYTES");
    expect(service).toContain("onConflictDoUpdate");
    expect(service).toContain("async remove(key: string)");
  });

  it("restores newcomer agreement from the real source-backed cache table", () => {
    const newcomer = readFileSync("src/services/activity/StoreNewcomerService.ts", "utf8");
    expect(newcomer).toContain("new DatabaseCacheService(this.container)");
    expect(newcomer).toContain('.get("newcomer_agreement", "")');
  });
});
