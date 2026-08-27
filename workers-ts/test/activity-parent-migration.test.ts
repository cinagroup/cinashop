import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeActivity, storeActivityRelation } from "../src/models/schema";

describe("parent activity migration", () => {
  it("preserves nullable legacy schedule and limit fields", () => {
    const activity = getTableColumns(storeActivity);
    const relation = getTableColumns(storeActivityRelation);

    expect(Object.keys(activity)).toEqual([
      "id",
      "type",
      "name",
      "image",
      "startDay",
      "endDay",
      "startTime",
      "endTime",
      "timeId",
      "onceNum",
      "num",
      "discount",
      "status",
      "isRecommend",
      "linkId",
      "applicableType",
      "applicableStoreId",
      "isDel",
      "addTime",
    ]);
    for (const column of [
      activity.image,
      activity.timeId,
      activity.onceNum,
      activity.num,
      activity.status,
      activity.isRecommend,
      activity.linkId,
      activity.applicableStoreId,
    ]) {
      expect(column.notNull).toBe(false);
    }
    expect(Object.keys(relation)).toEqual(["id", "activityId", "productId"]);
    expect(relation.activityId.notNull).toBe(true);
    expect(relation.productId.notNull).toBe(true);
  });

  it("orders parent activities before seckill goods in the activity phase", () => {
    const names = MIGRATION_TABLES.map((entry) => entry.table);
    for (const table of ["store_activity", "store_activity_relation"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)).toMatchObject({
        key: ["id"],
        phase: "activity",
      });
    }
    expect(names.indexOf("store_activity")).toBeLessThan(names.indexOf("store_seckill"));
  });

  it("returns the parent schedule with seckill detail without changing list eligibility", () => {
    const source = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    expect(source).toContain(".from(storeActivity)");
    expect(source).toContain("eq(storeActivity.id, item.activityId)");
    expect(source).toContain("return { ...item, activity, percent }");
  });
});
