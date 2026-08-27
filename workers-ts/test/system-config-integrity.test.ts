import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SystemConfigDao } from "../src/dao/system/SystemConfigDao";

describe("system configuration migration integrity", () => {
  it("seeds only missing global keys in both migration representations", () => {
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8");
    const firstMigration = embedded.slice(
      embedded.indexOf("private migration_0000"),
      embedded.indexOf("private migration_0001"),
    );

    expect(firstMigration).toContain("WHERE NOT EXISTS");
    expect(firstMigration).toContain('existing."menu_name" = seed.menu_name');
    expect(firstMigration).toContain('existing."is_store" = 0');
    expect(firstMigration).not.toContain("ON CONFLICT DO NOTHING");

    for (const file of [
      "migrations/0000_init.sql",
      "migrations/0011_order_brokerage_settlement.sql",
      "migrations/0012_order_rewards.sql",
      "migrations/0013_division_brokerage.sql",
    ]) {
      const migration = readFileSync(file, "utf8");
      expect(migration).toContain("WHERE NOT EXISTS");
      expect(migration).toMatch(/"is_store"\s*=\s*0/);
    }
  });

  it("uses deterministic priority when historical duplicate keys exist", async () => {
    const singleBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
    singleBuilder.select = vi.fn(() => singleBuilder);
    singleBuilder.from = vi.fn(() => singleBuilder);
    singleBuilder.where = vi.fn(() => singleBuilder);
    singleBuilder.orderBy = vi.fn(() => singleBuilder);
    singleBuilder.limit = vi.fn(async () => [{ value: "https://cinashop-pc.pages.dev" }]);

    const singleDao = new SystemConfigDao(singleBuilder as never);
    await expect(singleDao.getValue("site_url")).resolves.toBe(
      "https://cinashop-pc.pages.dev",
    );
    expect(singleBuilder.orderBy).toHaveBeenCalledOnce();

    const batchBuilder: Record<string, ReturnType<typeof vi.fn>> = {};
    batchBuilder.select = vi.fn(() => batchBuilder);
    batchBuilder.from = vi.fn(() => batchBuilder);
    batchBuilder.where = vi.fn(() => batchBuilder);
    batchBuilder.orderBy = vi.fn(async () => [
      { menuName: "site_url", value: "https://cinashop.example.com" },
      { menuName: "site_url", value: "https://cinashop-pc.pages.dev" },
    ]);

    const batchDao = new SystemConfigDao(batchBuilder as never);
    await expect(batchDao.getValues(["site_url"])).resolves.toEqual({
      site_url: "https://cinashop-pc.pages.dev",
    });
    expect(batchBuilder.orderBy).toHaveBeenCalledOnce();
  });
});
