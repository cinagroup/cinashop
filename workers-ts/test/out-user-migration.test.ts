import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outUserWriteReplay } from "@/models/schema";
import {
  normalizeOutUserCreateInput,
  normalizeOutUserGiveInput,
  normalizeOutUserUpdateInput,
} from "@/services/out/OutUserService";

describe("Out API user write migration", () => {
  it("normalizes the PHP create contract without accepting silent fields", () => {
    const normalized = normalizeOutUserCreateInput({
      phone: "13800138000",
      real_name: " 测试用户 ",
      birthday: "2000-02-29",
      label_id: [3, "2", 3],
      group_id: 1,
      level: 2,
      pwd: "strong-pass",
      true_pwd: "strong-pass",
      extend_info: { source: "out" },
    });
    expect(normalized.values).toMatchObject({
      phone: "13800138000",
      realName: "测试用户",
      groupId: 1,
      birthday: 951_753_600,
      status: 0,
      spreadOpen: 1,
    });
    expect(normalized.labels).toEqual([2, 3]);
    expect(normalized.level).toBe(2);
    expect(normalized.values.extendInfo).toBe('{"source":"out"}');
    expect(() => normalizeOutUserCreateInput({ phone: "13800138000", adminId: 99 }))
      .toThrow("不能静默丢弃");
    expect(() => normalizeOutUserCreateInput({ phone: "13800138000", pwd: "123456" }))
      .toThrow("太过简单");
    expect(() => normalizeOutUserCreateInput({ phone: "not-phone" }))
      .toThrow("格式不正确");
  });

  it("uses safe partial profile updates and validates finance pairs", () => {
    const normalized = normalizeOutUserUpdateInput({ real_name: "只改姓名" });
    expect(normalized.profile.values).toEqual({ realName: "只改姓名" });
    expect(normalized.profile.labels).toBeUndefined();
    expect(normalized.profile.level).toBeUndefined();
    expect(normalized.finance).toEqual({
      moneyStatus: 0,
      moneyCents: 0,
      integralStatus: 0,
      integral: 0,
    });
    expect(() => normalizeOutUserUpdateInput({ money_status: 1 }))
      .toThrow("必须同时提交");
    expect(() => normalizeOutUserUpdateInput({ money_status: 0, money: "1.00" }))
      .toThrow("非0时修改类型");
  });

  it("requires the four published give fields and exact decimal/integer values", () => {
    expect(normalizeOutUserGiveInput({
      money_status: 2,
      money: "9.02",
      integration_status: 1,
      integration: 50,
    })).toEqual({
      moneyStatus: 2,
      moneyCents: 902,
      integralStatus: 1,
      integral: 50,
    });
    expect(() => normalizeOutUserGiveInput({
      money_status: 1,
      money: "1.001",
      integration_status: 0,
      integration: 0,
    })).toThrow("余额格式错误");
    expect(() => normalizeOutUserGiveInput({
      money_status: 0,
      money: 0,
      integration_status: 0,
      integration: 0,
    })).toThrow("至少修改一项");
  });

  it("keeps external and embedded DDL exact and replay rows content-free", () => {
    expect(getTableName(outUserWriteReplay)).toBe("out_user_write_replay");
    expect(Object.keys(getTableColumns(outUserWriteReplay))).toEqual([
      "id",
      "outAccountId",
      "operation",
      "requestKey",
      "requestHash",
      "userId",
      "moneyLedgerId",
      "integralLedgerId",
      "addTime",
    ]);
    const migration = readFileSync("migrations/0099_out_user_write_replay.sql", "utf8").trim();
    const migrationService = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = migrationService
      .match(/private migration_0106\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    const replayDefinition = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS "out_user_write_replay"'),
      migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "ouwr_account_operation_key_uq"'),
    );
    expect(replayDefinition).not.toMatch(/phone|real_name|card_id|birthday|request_body|response_body/i);
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "user_active_phone_uq"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "um_out_request_uq"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "ub_out_request_uq"');
  });

  it("publishes all three PHP routes with ACL and UUID replay wiring", () => {
    const routes = readFileSync("src/routes/outapi.ts", "utf8");
    const api = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const service = readFileSync("src/services/out/OutUserService.ts", "utf8");
    expect(routes).toContain('"/user/give/:uid"');
    expect(routes).toContain('"/user/:uid"');
    expect(api).toContain('"post /user"');
    expect(api).toContain('"put /user/{uid}"');
    expect(api).toContain('"put /user/give/{uid}"');
    expect(service).toContain("normalizeOutRequestKey");
    expect(service).toContain("for(\"update\")");
    expect(service).toContain("Math.min(finance.integral, currentIntegral)");
    expect(service).toContain("applyRegistrationGifts");
    const scenario = readFileSync("test/integration/OutApiUserPostgresScenario.ts", "utf8");
    const runScenario = scenario.slice(
      scenario.indexOf("async function runScenario"),
      scenario.indexOf("export async function runOutApiUserPostgresScenario"),
    );
    expect(runScenario).not.toContain("container.db");
    expect(runScenario).toContain("const scopedDb");
  });
});
