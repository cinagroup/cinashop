import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  buildIssuedCards,
  normalizeMembershipBatch,
  normalizeMembershipPlan,
  normalizeMembershipRight,
} from "../src/services/user/AdminPaidMembershipService";

describe("admin paid membership operations", () => {
  it("creates globally attributable card numbers and strong one-time passwords", () => {
    const cards = buildIssuedCards(321, 6_000);
    expect(cards).toHaveLength(6_000);
    expect(new Set(cards.map((card) => card.card_number)).size).toBe(6_000);
    expect(cards.every((card) => /^MC[A-Z0-9]{18}$/.test(card.card_number))).toBe(true);
    expect(cards.every((card) => /^[A-HJ-NP-Z2-9]{12}$/.test(card.card_password))).toBe(true);
    expect(cards[0].card_number.slice(2, 10)).toBe((321).toString(36).toUpperCase().padStart(8, "0"));
  });

  it("enforces the PHP batch ceiling and rejects unusable membership durations", () => {
    expect(normalizeMembershipBatch({
      title: "渠道体验卡",
      total_num: 6_000,
      use_day: 30,
      status: 1,
    })).toMatchObject({ totalNum: 6_000, useDay: 30, status: 1 });
    expect(() => normalizeMembershipBatch({ title: "超限", total_num: 6_001, use_day: 30 }))
      .toThrow("卡片数量格式错误");
    expect(() => normalizeMembershipBatch({ title: "无期限", total_num: 1, use_day: 0 }))
      .toThrow("会员有效天数格式错误");
  });

  it("normalizes free, timed, and permanent plans without client-authoritative prices", () => {
    expect(normalizeMembershipPlan({
      type: "free",
      title: "体验会员",
      vip_day: 7,
      price: "99.00",
      pre_price: "199.00",
    })).toMatchObject({ price: "0.00", prePrice: "0.00", vipDay: 7 });
    expect(normalizeMembershipPlan({
      type: "ever",
      title: "永久会员",
      price: "1298.00",
      pre_price: "998.00",
    })).toMatchObject({ vipDay: -1, price: "1298.00", prePrice: "998.00" });
    expect(() => normalizeMembershipPlan({
      type: "year",
      title: "年度会员",
      vip_day: 365,
      price: "0",
      pre_price: "199.00",
    })).toThrow("价格必须大于0");
    expect(() => normalizeMembershipPlan({
      type: "year",
      title: "倒挂套餐",
      vip_day: 365,
      price: "99.00",
      pre_price: "199.00",
    })).toThrow("优惠价不能高于划线原价");
    expect(() => normalizeMembershipPlan({ type: "custom", title: "未知", vip_day: 1 }))
      .toThrow("会员类型不支持");
  });

  it("validates member-right identifiers and non-negative runtime values", () => {
    expect(normalizeMembershipRight({
      right_type: "integral",
      title: "积分倍率",
      show_title: "双倍积分",
      number: 2,
      status: 1,
    })).toMatchObject({ rightType: "integral", showTitle: "双倍积分", number: 2 });
    expect(() => normalizeMembershipRight({
      right_type: "integral",
      title: "积分倍率",
      show_title: "双倍积分",
      number: -1,
    })).toThrow("权益数值格式错误");
  });

  it("registers view/manage ACL for every paid-membership route family", () => {
    expect(requiredAdminPermission("GET", "/adminapi/member_batch/index")).toBe("paid_membership.view");
    expect(requiredAdminPermission("POST", "/adminapi/member_batch/save/0")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("GET", "/adminapi/member_card/set_status")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("GET", "/adminapi/member_batch/set_value/7")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("GET", "/adminapi/member_ship/set_ship_status")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("POST", "/adminapi/member_right/save/1")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("POST", "/adminapi/member_agreement/save/1")).toBe("paid_membership.manage");
    expect(requiredAdminPermission("GET", "/adminapi/member_scan")).toBe("paid_membership.view");
  });

  it("restores the PHP route surface while keeping card secrets out of list responses", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminPaidMembershipController.ts", "utf8");
    const service = readFileSync("src/services/user/AdminPaidMembershipService.ts", "utf8");
    for (const route of [
      "/member_batch/index",
      "/member_batch/save/:id",
      "/member_card/index/:card_batch_id",
      "/member_card/set_status",
      "/member/ship",
      "/member_ship/save/:id",
      "/member/record",
      "/member/right",
      "/member_right/save/:id",
      "/member/agreement",
      "/member_agreement/save/:id",
      "/member_scan",
    ]) expect(routes).toContain(route);
    expect(controller).toContain("MAX_BODY_BYTES");
    expect(service).toContain("CARD_INSERT_CHUNK");
    expect(service).toContain('password_configured: true');
    expect(service).toContain('.for("update")');
    expect(service).not.toContain("Math.random");
    const listProjection = service.slice(service.indexOf("async cards("), service.indexOf("async setCardStatus("));
    expect(listProjection).not.toContain("cardPassword");
    expect(listProjection).not.toContain("card_password");
  });
});
