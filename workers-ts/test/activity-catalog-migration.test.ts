import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeBargain,
  storeCombination,
  storeIntegral,
  storeSeckill,
} from "../src/models/schema";

describe("activity catalog migration parity", () => {
  it("maps renamed PHP fields and explicitly converts varchar numeric epochs", () => {
    const byTable = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));

    expect(byTable.get("store_seckill")?.columnMappings).toEqual({ title: "store_name" });
    expect(byTable.get("store_seckill")?.columnConversions).toEqual({
      start_time: "epoch_string_to_timestamp",
      stop_time: "epoch_string_to_timestamp",
      add_time: "numeric_string_to_integer",
    });
    expect(byTable.get("store_combination")?.columnMappings).toEqual({ title: "store_name" });
    expect(byTable.get("store_combination")?.columnConversions).toEqual({
      add_time: "numeric_string_to_integer",
    });
    expect(byTable.get("store_bargain")?.columnMappings).toEqual({ people_num: "people" });
    expect(byTable.get("store_integral")?.columnMappings).toEqual({ title: "store_name" });
    expect(byTable.get("store_integral")?.columnConversions).toEqual({
      add_time: "numeric_string_to_integer",
    });
  });

  it("preserves fulfillment, shipping, form, label, and refund snapshots", () => {
    const bargain = getTableColumns(storeBargain);
    const combination = getTableColumns(storeCombination);
    const integral = getTableColumns(storeIntegral);
    const seckill = getTableColumns(storeSeckill);

    expect(Object.keys(bargain)).toEqual(
      expect.arrayContaining([
        "productType", "relationId", "title", "images", "bargainMaxPrice",
        "bargainMinPrice", "giveIntegral", "tempId", "deliveryType",
        "customForm", "storeLabelId", "ensureId", "specs", "isDel",
      ]),
    );
    expect(Object.keys(combination)).toEqual(
      expect.arrayContaining([
        "productType", "relationId", "images", "attr", "isShow", "isDel",
        "effectiveTime", "tempId", "deliveryType", "customForm", "specs",
      ]),
    );
    expect(Object.keys(integral)).toEqual(
      expect.arrayContaining([
        "productType", "relationId", "images", "isShow", "isDel", "onceNum",
        "tempId", "deliveryType", "customForm", "specs",
      ]),
    );
    expect(Object.keys(seckill)).toEqual(
      expect.arrayContaining([
        "activityId", "productType", "relationId", "images", "giveIntegral",
        "description", "isShow", "isDel", "tempId", "deliveryType",
        "customForm", "specs",
      ]),
    );
    expect(seckill.timeId.getSQLType()).toBe("text");
  });

  it("keeps deleted, hidden, future, and expired activities out of reads and checkout", () => {
    const dao = readFileSync("src/dao/activity/ActivityDaos.ts", "utf8");
    const order = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const join = readFileSync("src/services/activity/ActivityJoinService.ts", "utf8");

    for (const source of [dao, order, join]) {
      expect(source).toContain("storeCombination.isShow");
      expect(source).toContain("storeCombination.isDel");
      expect(source).toContain("storeCombination.startTime");
      expect(source).toContain("storeCombination.stopTime");
    }
    expect(dao).toContain("storeSeckill.isShow");
    expect(dao).toContain("storeIntegral.isDel");
    expect(order).toContain("storeBargain.isDel");
    expect(join).toContain("storeBargain.startTime");
  });
});
