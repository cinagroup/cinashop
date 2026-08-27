import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  memberCard,
  memberCardBatch,
  memberShip,
  otherOrder,
  otherOrderStatus,
} from "../src/models/schema";
import {
  calculateMembershipExpiry,
  normalizeMemberChannel,
  timingSafeSecretEqual,
} from "../src/services/user/PaidMembershipService";
import { createQrSvgDataUrl } from "../src/services/user/MembershipScanService";

describe("paid membership core migration", () => {
  it("preserves all five source tables and their deterministic migration keys", () => {
    expect(getTableName(memberCardBatch)).toBe("member_card_batch");
    expect(getTableName(memberCard)).toBe("member_card");
    expect(getTableName(memberShip)).toBe("member_ship");
    expect(getTableName(otherOrder)).toBe("other_order");
    expect(getTableName(otherOrderStatus)).toBe("other_order_status");

    expect(Object.keys(getTableColumns(memberCard))).toEqual([
      "id", "cardBatchId", "cardNumber", "cardPassword", "useUid", "useTime",
      "status", "addTime", "updateTime",
    ]);
    expect(Object.keys(getTableColumns(otherOrderStatus))).toEqual([
      "oid", "changeType", "changeMessage", "shopType", "changeTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "member_card")?.key)
      .toEqual(["id", "card_batch_id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "other_order_status")?.key)
      .toEqual([]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "other_order_status")?.copyStrategy)
      .toBe("append_multiset");
  });

  it("does not invent uniqueness for historical card numbers or membership order numbers", () => {
    const migration = readFileSync("migrations/0061_paid_membership_core.sql", "utf8");
    expect(migration).toContain('PRIMARY KEY ("id", "card_batch_id")');
    expect(migration).toContain('"member_card_number_lookup"');
    expect(migration).toContain('"other_order_order_id"');
    expect(migration).not.toMatch(/UNIQUE[^\n]+card_number/i);
    expect(migration).not.toMatch(/UNIQUE[^\n]+order_id/i);
    expect(migration).not.toMatch(/CREATE TABLE[^;]+other_order_status[^;]+PRIMARY KEY/is);
  });

  it("normalizes only the PHP-supported storefront channels", () => {
    expect(normalizeMemberChannel("WEIXIN")).toBe("wechat");
    expect(normalizeMemberChannel("wechat")).toBe("wechat");
    expect(normalizeMemberChannel("weixinh5")).toBe("weixinh5");
    expect(normalizeMemberChannel("routine")).toBe("routine");
    expect(normalizeMemberChannel("app")).toBeNull();
  });

  it("extends an active membership but starts expired membership from now", () => {
    const now = 1_700_000_000;
    expect(calculateMembershipExpiry(30, 0, 0, now)).toBe(now + 30 * 86_400);
    expect(calculateMembershipExpiry(30, 2, now + 100, now)).toBe(
      now + 100 + 30 * 86_400,
    );
    expect(calculateMembershipExpiry(30, 2, now - 100, now)).toBe(now + 30 * 86_400);
    expect(() => calculateMembershipExpiry(0, 0, 0, now)).toThrow("会员有效天数无效");
  });

  it("compares card secrets without direct string equality", async () => {
    await expect(timingSafeSecretEqual("123456", "123456")).resolves.toBe(true);
    await expect(timingSafeSecretEqual("123456", "654321")).resolves.toBe(false);
  });

  it("restores purchase, payment, projection, coupon, and atomic redemption routes", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/MemberCardController.ts", "utf8");
    const service = readFileSync("src/services/user/PaidMembershipService.ts", "utf8");
    for (const route of [
      "/user/member/card/index",
      "/user/member/card/draw",
      "/user/member/card/create",
      "/user/member/card/pay",
      "/user/member/coupons/list",
      "/user/member/overdue/time",
    ]) expect(routes).toContain(route);
    expect(service).toContain('limit(2)');
    expect(service).toContain('.for("update")');
    expect(service).toContain("timingSafeSecretEqual");
    expect(service).toContain("eq(memberCard.useUid, 0)");
    expect(service).toContain("eq(memberCard.useTime, 0)");
    expect(service).toContain('changeType: "card_redeem"');
    expect(service).toContain("parseConfigInteger(config.member_card_status, 1)");
    expect(service).toContain("parseConfigInteger(enabled, 1)");
    expect(controller).not.toContain("card_password");
    expect(service).toContain("createMembershipOrder");
    expect(service).toContain("applyMembershipPayment");
    expect(service).toContain("order.payPrice");
    expect(service).toContain('type: "pay_member"');
    expect(service).toContain('changeType: "pay_success"');
  });

  it("generates an embeddable H5 activation QR without an external image service", () => {
    const dataUrl = createQrSvgDataUrl(
      "https://cinashop.example.com/pages/annex/vip_active/index",
    );
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(dataUrl.length).toBeGreaterThan(500);
  });
});
