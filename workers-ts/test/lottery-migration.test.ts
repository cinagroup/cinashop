import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  luckLottery,
  luckLotteryEntitlement,
  luckLotteryRecord,
  luckPrize,
} from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { normalizeLotteryInput } from "@/services/activity/LotteryAdminService";
import {
  selectWeightedPrize,
  shouldGrantReferralChance,
} from "@/services/activity/LotteryService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

function prize(id: number, chance: number, type = 1): typeof luckPrize.$inferSelect {
  return {
    id,
    type,
    lotteryId: 9,
    name: `奖品${id}`,
    prompt: "",
    image: `/prize-${id}.png`,
    chance,
    total: 10,
    couponId: 0,
    productId: 0,
    unique: "",
    num: "1.00",
    sort: id,
    status: 1,
    isDel: 0,
    addTime: 1,
  };
}

function validInput() {
  return {
    type: 1,
    name: "积分抽奖",
    image: "/lottery.png",
    factor: 1,
    factor_num: 10,
    attends_user: 1,
    period: [1_800_000_000, 1_800_086_400],
    lottery_num: 2,
    total_lottery_num: 10,
    content: "活动规则",
    prize: Array.from({ length: 8 }, (_, index) => ({
      type: 1,
      name: `谢谢参与${index + 1}`,
      image: `/lose-${index + 1}.png`,
      chance: index === 0 ? 10 : 0,
      total: -1,
      num: 0,
      sort: index,
    })),
  };
}

describe("lottery domain migration", () => {
  it("preserves all three source tables and isolates the Worker entitlement table", () => {
    expect(getTableName(luckLottery)).toBe("luck_lottery");
    expect(getTableName(luckPrize)).toBe("luck_prize");
    expect(getTableName(luckLotteryRecord)).toBe("luck_lottery_record");
    expect(getTableName(luckLotteryEntitlement)).toBe("luck_lottery_entitlement");
    expect(Object.keys(getTableColumns(luckLottery))).toHaveLength(26);
    expect(Object.keys(getTableColumns(luckPrize))).toHaveLength(16);
    expect(Object.keys(getTableColumns(luckLotteryRecord))).toHaveLength(14);
    expect(Object.keys(getTableColumns(luckLotteryEntitlement))).toEqual([
      "id", "uid", "factor", "sourceType", "sourceId", "sourceKey", "amount",
      "remaining", "expiresAt", "addTime", "updateTime",
    ]);
    for (const table of ["luck_lottery", "luck_prize", "luck_lottery_record"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_TABLES.some((entry) => entry.table === "luck_lottery_entitlement")).toBe(false);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0070 and embedded 0077 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0070_lottery_domain.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0077\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    const sourceSql = migration.split("-- Worker-only reliability table.")[0];
    expect(sourceSql).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "luck_lottery_entitlement_source_uq"');
    expect(migration).toContain('WHERE "remaining" > 0');
    expect(migration).toContain('"remaining" >= 0 AND "remaining" <= "amount"');
  });

  it("uses bounded Web-Crypto-compatible weighted selection boundaries", () => {
    const prizes = [prize(1, 2), prize(2, 3), prize(3, 5)];
    expect(selectWeightedPrize(prizes, 0)?.id).toBe(1);
    expect(selectWeightedPrize(prizes, 1)?.id).toBe(1);
    expect(selectWeightedPrize(prizes, 2)?.id).toBe(2);
    expect(selectWeightedPrize(prizes, 4)?.id).toBe(2);
    expect(selectWeightedPrize(prizes, 5)?.id).toBe(3);
    expect(selectWeightedPrize(prizes, 9)?.id).toBe(3);
    expect(() => selectWeightedPrize(prizes, 10)).toThrow("测试抽奖值超出权重范围");
  });

  it("requires eight prizes and rejects unsafe external or ambiguous award types", () => {
    expect(normalizeLotteryInput(validInput()).prizes).toHaveLength(8);
    expect(() => normalizeLotteryInput({ ...validInput(), prize: [] })).toThrow("请配置8个抽奖奖品");
    const redPacket = validInput();
    redPacket.prize[1].type = 4;
    redPacket.prize[1].chance = 1;
    expect(() => normalizeLotteryInput(redPacket)).toThrow("微信红包奖品尚未接入可靠付款通道");
    const level = validInput();
    level.prize[1].type = 8;
    level.prize[1].chance = 1;
    expect(() => normalizeLotteryInput(level)).toThrow("用户等级奖品缺少明确等级配置");
  });

  it("grants the final capped referral increment without the PHP off-by-one", () => {
    expect(shouldGrantReferralChance(1, 3, 10)).toBe(true);
    expect(shouldGrantReferralChance(3, 3, 10)).toBe(true);
    expect(shouldGrantReferralChance(4, 3, 10)).toBe(true);
    expect(shouldGrantReferralChance(5, 3, 10)).toBe(false);
    expect(shouldGrantReferralChance(10, 1, 10)).toBe(true);
    expect(shouldGrantReferralChance(11, 1, 10)).toBe(false);
  });

  it("restores source routes, permissions, and durable event hooks", () => {
    const publicRoutes = readFileSync("src/routes/v2/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(publicRoutes).toContain('v2Routes.get("/lottery/info/:factor?"');
    expect(publicRoutes).toContain('v2Routes.post("/lottery"');
    expect(publicRoutes).toContain('v2Routes.post("/lottery/receive"');
    expect(publicRoutes).toContain('v2Routes.get("/lottery/record"');
    expect(adminRoutes).toContain('adminapiRoutes.get("/lottery/list"');
    expect(adminRoutes).toContain('adminapiRoutes.post("/lottery/record/deliver"');
    expect(requiredAdminPermission("GET", "/adminapi/lottery/list")).toBe("lottery.view");
    expect(requiredAdminPermission("POST", "/adminapi/lottery/add")).toBe("lottery.manage");
    expect(requiredAdminPermission("POST", "/adminapi/lottery/record/deliver")).toBe("lottery.manage");

    const paid = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const reply = readFileSync("src/services/product/ReplyService.ts", "utf8");
    const spread = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    expect(paid).toContain("grantLotteryEntitlement(tx");
    expect(reply).toContain('sourceType: "comment"');
    expect(spread).toContain("grantReferralLotteryChance(tx");
  });

  it("scopes claims to the authenticated owner and keeps request bodies bounded", () => {
    const runtime = readFileSync("src/services/activity/LotteryService.ts", "utf8");
    const userController = readFileSync("src/controllers/api/v1/LotteryController.ts", "utf8");
    const adminController = readFileSync("src/controllers/api/v1/AdminLotteryController.ts", "utf8");
    const adminRuntime = readFileSync("src/services/activity/LotteryAdminService.ts", "utf8");
    expect(runtime).toContain("eq(luckLotteryRecord.uid, uid)");
    expect(runtime).toContain("crypto.getRandomValues");
    expect(runtime).toContain('.for("update")');
    expect(userController).toContain("const MAX_BODY_BYTES = 8 * 1024");
    expect(adminController).toContain("const MAX_BODY_BYTES = 256 * 1024");
    expect(adminRuntime).not.toContain("user: userTable");
    expect(adminRuntime).toContain("userPhone: userTable.phone");
    expect(adminRuntime).toContain("pg_advisory_xact_lock");
  });
});
