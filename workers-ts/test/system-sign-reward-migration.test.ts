import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { systemSignReward } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { calculateSignReward } from "../src/services/system/SystemSignRewardService";
import { nextContinuousSignDays, signDayWindow } from "../src/utils/sign";

describe("system sign reward migration", () => {
  it("preserves the exact five-column source contract", () => {
    expect(getTableName(systemSignReward)).toBe("system_sign_reward");
    expect(Object.keys(getTableColumns(systemSignReward))).toEqual([
      "id",
      "type",
      "days",
      "point",
      "exp",
    ]);
  });

  it("registers a stable migration key without rejecting historical duplicates", () => {
    const spec = MIGRATION_TABLES.find((entry) => entry.table === "system_sign_reward");
    expect(spec?.key).toEqual(["id"]);
    expect(spec?.note).toContain("historical duplicate");
    const migration = readFileSync("migrations/0050_system_sign_rewards.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('ON "system_sign_reward" ("type", "days", "id")');
  });

  it("replaces the base reward at milestones and adds simultaneous milestones", () => {
    const rules = [
      { id: 1, type: 0, days: 7, point: 8, exp: 3 },
      { id: 2, type: 1, days: 30, point: 20, exp: 5 },
    ];
    expect(calculateSignReward({
      basePoint: 2,
      baseExp: 1,
      continuousDays: 2,
      cumulativeDays: 2,
      rules,
      memberFunctionEnabled: true,
      levelActive: true,
      pointMultiplier: 1,
    })).toMatchObject({ point: 2, exp: 1, matchedContinuous: false, matchedCumulative: false });
    expect(calculateSignReward({
      basePoint: 2,
      baseExp: 1,
      continuousDays: 7,
      cumulativeDays: 10,
      rules,
      memberFunctionEnabled: true,
      levelActive: true,
      pointMultiplier: 1,
    })).toMatchObject({ point: 8, exp: 3, matchedContinuous: true, matchedCumulative: false });
    expect(calculateSignReward({
      basePoint: 2,
      baseExp: 1,
      continuousDays: 7,
      cumulativeDays: 30,
      rules,
      memberFunctionEnabled: true,
      levelActive: true,
      pointMultiplier: 2,
    })).toMatchObject({ point: 56, exp: 8, matchedContinuous: true, matchedCumulative: true });
  });

  it("does not record experience when the member function or user level is inactive", () => {
    const input = {
      basePoint: 1,
      baseExp: 10,
      continuousDays: 1,
      cumulativeDays: 1,
      rules: [],
      pointMultiplier: 1,
    };
    expect(calculateSignReward({
      ...input,
      memberFunctionEnabled: false,
      levelActive: true,
    }).exp).toBe(0);
    expect(calculateSignReward({
      ...input,
      memberFunctionEnabled: true,
      levelActive: false,
    }).exp).toBe(0);
  });

  it("uses deterministic Asia/Shanghai day and cycle boundaries", () => {
    const midnight = Math.floor(Date.parse("2026-08-09T16:00:00.000Z") / 1000);
    expect(signDayWindow(midnight)).toEqual({
      yesterdayStart: midnight - 86_400,
      todayStart: midnight,
      tomorrowStart: midnight + 86_400,
      weekday: 1,
      dayOfMonth: 10,
    });
    expect(nextContinuousSignDays({
      currentDays: 9,
      signedYesterday: true,
      signMode: 1,
      weekday: 1,
      dayOfMonth: 10,
    })).toBe(1);
    expect(nextContinuousSignDays({
      currentDays: 9,
      signedYesterday: true,
      signMode: -1,
      weekday: 1,
      dayOfMonth: 10,
    })).toBe(10);
  });

  it("restores both admin surfaces and transactionally closes double-award gaps", () => {
    const service = readFileSync("src/services/user/UserCenterService.ts", "utf8");
    const rewardService = readFileSync(
      "src/services/system/SystemSignRewardService.ts",
      "utf8",
    );
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain("stats.cumulativeDays + 1");
    expect(service).toContain("tx.insert(userSign)");
    expect(service).toContain("tx.insert(userBill)");
    expect(service).toContain("detectUserLevel");
    expect(service).not.toContain("signNum % 7");
    expect(rewardService).toContain("pg_advisory_xact_lock");
    expect(rewardService).toContain("签到奖励已存在");
    for (const routes of [adminRoutes, v1Routes]) {
      expect(routes).toContain("/setting/sign/rewards");
      expect(routes).toContain("/setting/sign/add_rewards");
      expect(routes).toContain("/setting/sign/edit_rewards/:id");
      expect(routes).toContain("/setting/sign/save_rewards/:id");
      expect(routes).toContain("/setting/sign/del_rewards/:id");
    }
    expect(requiredAdminPermission("GET", "/adminapi/setting/sign/rewards"))
      .toBe("config.view");
    expect(requiredAdminPermission("POST", "/api/admin/setting/sign/save_rewards/:id"))
      .toBe("config.manage");
  });
});
