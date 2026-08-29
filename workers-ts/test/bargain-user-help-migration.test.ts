import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeBargainUserHelp } from "../src/models/schema";
import { calculateBargainHelpCutCents } from "../src/services/activity/ActivityJoinService";

describe("bargain user help migration", () => {
  it("preserves the exact seven-column source contract", () => {
    expect(getTableName(storeBargainUserHelp)).toBe("store_bargain_user_help");
    expect(Object.keys(getTableColumns(storeBargainUserHelp))).toEqual([
      "id",
      "uid",
      "bargainId",
      "bargainUserId",
      "price",
      "addTime",
      "type",
    ]);
    const spec = MIGRATION_TABLES.find((entry) => entry.table === "store_bargain_user_help");
    expect(spec?.key).toEqual(["id"]);
    expect(spec?.note).toContain("Historical duplicate");
  });

  it("does not invent a historical uniqueness constraint", () => {
    const migration = readFileSync("migrations/0053_bargain_user_help.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('("bargain_user_id", "id")');
    expect(migration).toContain('("uid", "bargain_id", "type")');
  });

  it("reserves at least one cent for each remaining helper and closes on the last helper", () => {
    expect(calculateBargainHelpCutCents({
      remainingCents: 1_000,
      remainingPeople: 5,
      percent: 10,
    })).toBe(99);
    expect(calculateBargainHelpCutCents({
      remainingCents: 5,
      remainingPeople: 5,
      percent: 30,
    })).toBe(1);
    expect(calculateBargainHelpCutCents({
      remainingCents: 37,
      remainingPeople: 1,
      percent: 10,
    })).toBe(37);
  });

  it("serializes helpers, blocks repeat help, and records source-compatible price semantics", () => {
    const service = readFileSync("src/services/activity/ActivityJoinService.ts", "utf8");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain("priorHelp");
    expect(service).toContain("completedPeople >= peopleLimit");
    expect(service).toContain("tx.insert(storeBargainUserHelp)");
    expect(service).toContain("bargainPrice: centsToDecimal(originalCents)");
    expect(service).toContain("price: centsToDecimal(newAlreadyCutCents)");
  });

  it("charges current bargain price and restores the PHP help companion routes", () => {
    const order = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(order).toContain("bargainOriginalCents - decimalToCents(participant.price)");
    expect(order).not.toContain("unitPriceCents = Math.round(Number(bu[0].bargainPrice) * 100)");
    expect(routes).toContain('/bargain/help/price"');
    expect(routes).toContain('/bargain/help/count"');
    expect(routes).toContain('/bargain/help/list"');
  });
});
