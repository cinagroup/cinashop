import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatLegacyShanghaiUnix,
  legacyBrokerageProjection,
  legacyExtractProjection,
  legacyMoneyProjection,
  normalizeRoutineProfile,
  normalizeVerifiedOfficialProfile,
  parseLegacyUserLedgerQuery,
} from "@/services/user/V2UserCompatibilityService";
import { userBrokerage, userMoney } from "@/models/schema";

type Money = typeof userMoney.$inferSelect;
type Brokerage = typeof userBrokerage.$inferSelect;

function money(overrides: Partial<Money> = {}): Money {
  return {
    id: 11,
    uid: 7,
    linkId: "99",
    type: "pay_product",
    title: "商城购物",
    number: "20.00",
    balance: "80.00",
    pm: 0,
    mark: "订单消费",
    status: 1,
    addTime: 1_777_603_500,
    ...overrides,
  };
}

function brokerage(overrides: Partial<Brokerage> = {}): Brokerage {
  return {
    id: 12,
    uid: 7,
    linkId: "101",
    pm: 0,
    title: "佣金提现",
    category: "extract",
    type: "extract",
    sourceType: "",
    number: "12.50",
    balance: "40.00",
    mark: "提现申请",
    status: 1,
    take: 0,
    frozenTime: 0,
    addTime: 1_777_603_500,
    ...overrides,
  };
}

describe("API-004 user and referral compatibility migration", () => {
  it("mounts all five PHP routes with forced authentication", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    expect(routes).toContain(
      'v2Routes.post("/user/user_update", authMiddleware({ force: true }), V2UserCompatibilityController.updateRoutineProfile)',
    );
    expect(routes).toContain(
      'v2Routes.get("/user/wechat", authMiddleware({ force: true }), V2UserCompatibilityController.refreshWechatProfile)',
    );
    expect(routes).toContain(
      'v2Routes.get("/user/money_list/:type", authMiddleware({ force: true }), V2UserCompatibilityController.moneyList)',
    );
    expect(routes).toContain(
      'v2Routes.get("/agent/agent_user_list/:type", authMiddleware({ force: true }), V2UserCompatibilityController.agentUserList)',
    );
    expect(routes).toContain(
      'v2Routes.get("/agent/agent_info", authMiddleware({ force: true }), V2UserCompatibilityController.agentInfo)',
    );
  });

  it("bounds legacy pagination and preserves integer-prefix coercion", () => {
    expect(parseLegacyUserLedgerQuery({
      page: "99999tail",
      limit: "500",
      start: "1770000000x",
      stop: "1771000000",
      keyword: `  ${"a".repeat(100)}  `,
    })).toEqual({
      page: 1_000,
      limit: 100,
      start: 1_770_000_000,
      stop: 1_771_000_000,
      keyword: "a".repeat(64),
    });
  });

  it("normalizes only bounded Mini Program profile fields", () => {
    const result = normalizeRoutineProfile({
      nickName: "迁移用户\u0000",
      avatarUrl: "https://img.example/avatar.png",
      gender: "2legacy",
      language: "zh_CN",
      city: "深圳",
      province: "广东",
      country: "中国",
      uid: 999,
      openid: "attacker-controlled",
    });
    expect(result).toEqual({
      nickname: "迁移用户",
      avatar: "https://img.example/avatar.png",
      sex: 2,
      language: "zh_CN",
      city: "深圳",
      province: "广东",
      country: "中国",
    });
    expect(result).not.toHaveProperty("uid");
    expect(result).not.toHaveProperty("openid");
  });

  it("requires the provider-verified official openid", () => {
    expect(() => normalizeVerifiedOfficialProfile({ nickname: "无身份" }))
      .toThrow("没有获取到openid");
    expect(normalizeVerifiedOfficialProfile({
      openid: "wx-openid",
      nickname: "公众号用户",
      headimgurl: "/avatar.jpg",
      sex: 1,
    })).toEqual(expect.objectContaining({
      openid: "wx-openid",
      nickname: "公众号用户",
      avatar: "/avatar.jpg",
      sex: 1,
    }));
  });

  it("returns PHP snake_case money fields and refund labels", () => {
    expect(legacyMoneyProjection(money(), "退款中")).toEqual(expect.objectContaining({
      link_id: "99",
      type_name: "商城购物",
      refund_status: "退款中",
      time_key: "2026-05",
      time: "2026-05",
      day: "2026-05-01",
      add_time: "2026/05/01 10:45",
    }));
  });

  it("returns extraction status/message without exposing camelCase fields", () => {
    const projected = legacyBrokerageProjection(brokerage(), {
      status: -1,
      failMsg: "资料不完整",
    });
    expect(projected).toEqual(expect.objectContaining({
      link_id: "101",
      source_type: "",
      extract_status: -1,
      extract_msg: "资料不完整",
      time_key: "2026-05",
    }));
    expect(projected).not.toHaveProperty("linkId");
    expect(legacyExtractProjection(brokerage({ type: "extract_fail" })))
      .not.toHaveProperty("extract_status");
  });

  it("fixes the PHP minute formatter and uses the path referral type", () => {
    expect(formatLegacyShanghaiUnix(1_777_603_500, "agent")).toBe("2026.05.01 10:45");
    const controller = readFileSync("src/controllers/api/v1/V2UserCompatibilityController.ts", "utf8");
    expect(controller).toContain('c.req.param("type")');
    const service = readFileSync("src/services/user/V2UserCompatibilityService.ts", "utf8");
    expect(service).toContain("gt(userTable.payCount, 0)");
  });

  it("batches linked refund/recharge/extraction lookups and never interpolates raw SQL", () => {
    const source = readFileSync("src/services/user/V2UserCompatibilityService.ts", "utf8");
    expect(source).toContain("Promise.all([");
    expect(source).toContain("inArray(storeOrderRefund.storeOrderId, orderIds)");
    expect(source).toContain("inArray(userRecharge.id, rechargeIds)");
    expect(source).toContain("inArray(userExtract.id, extractIds)");
    expect(source).toContain(".innerJoin(userTable");
    expect(source).toContain("eq(userTable.status, 1)");
    expect(source).not.toContain("sql.raw(");
  });
});
