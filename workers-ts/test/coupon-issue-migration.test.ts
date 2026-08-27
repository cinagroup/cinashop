import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeCouponIssue } from "../src/models/schema";

describe("coupon issue migration parity", () => {
  it("keeps PHP scope and discount-mode columns in their correct Worker roles", () => {
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "store_coupon_issue")?.columnMappings,
    ).toEqual({
      type: "coupon_type",
      coupon_type: "type",
      coupon_time: "day",
      product_id: "legacy_product_ids",
      category_id: "legacy_category_id",
      brand_id: "legacy_brand_id",
      start_use_time: "use_start_time",
      end_use_time: "use_end_time",
    });
  });

  it("preserves issuance, stock, reward, validity, and soft-delete metadata", () => {
    const columns = getTableColumns(storeCouponIssue);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "cid",
        "category",
        "isPermanent",
        "isGiveSubscribe",
        "isFullGive",
        "fullReduction",
        "isDel",
        "title",
        "integral",
        "useStartTime",
        "useEndTime",
        "rule",
        "legacyProductIds",
        "legacyCategoryId",
        "legacyBrandId",
      ]),
    );
    expect(columns.couponTitle.getSQLType()).toBe("varchar(255)");
  });

  it("separates the claim window from the coupon use window at runtime", () => {
    const service = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    const dao = readFileSync("src/dao/activity/ActivityDaos.ts", "utf8");
    expect(service).toContain("issue.status !== 1 || issue.isDel !== 0");
    expect(service).toContain("if (issue.day > 0)");
    expect(service).toContain("startTime = issue.useStartTime ?? now");
    expect(service).toContain("endTime = issue.useEndTime");
    expect(service).toContain("if (!issue.isPermanent)");
    expect(dao).toContain("storeCouponIssue.receiveType} = 1");
  });
});
