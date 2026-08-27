import { describe, expect, it } from "vitest";
import {
  allocateCents,
  applyBrokerageUplift,
  brokerageFromBasisPoints,
  calculateOrderBrokerage,
  calculateDivisionBrokerageRates,
  parsePercentBasisPoints,
  targetBrokerageReversal,
} from "../src/services/order/OrderBrokerageService";
import { normalizeConfigScalar, parseConfigInteger } from "../src/utils/config";

describe("订单返佣快照", () => {
  it("将两位小数百分比转换为 basis points 并拒绝越界配置", () => {
    expect(parseConfigInteger('"7"', 0)).toBe(7);
    expect(normalizeConfigScalar('"https:\/\/example.com"')).toBe("https://example.com");
    expect(normalizeConfigScalar('["a","b"]')).toBe('["a","b"]');
    expect(parsePercentBasisPoints("10.25", "一级返佣比例")).toBe(1025);
    expect(parsePercentBasisPoints('"10"', "一级返佣比例")).toBe(1000);
    expect(parsePercentBasisPoints("100", "一级返佣比例")).toBe(10_000);
    expect(() => parsePercentBasisPoints("100.01", "一级返佣比例")).toThrow("0 到 100");
    expect(() => parsePercentBasisPoints("1.234", "一级返佣比例")).toThrow("格式无效");
  });

  it("按 PHP 等级规则上浮，并保持整数运算", () => {
    expect(applyBrokerageUplift(1000, 10)).toBe(1100);
    expect(applyBrokerageUplift(525, 19)).toBe(624);
    expect(() => applyBrokerageUplift(1000, 1001)).toThrow("上浮无效");
  });

  it("对应 BCMath scale=2 向下截断到分", () => {
    expect(brokerageFromBasisPoints(12_345, 1000)).toBe(1234);
    expect(brokerageFromBasisPoints(12_345, 500)).toBe(617);
    expect(() => brokerageFromBasisPoints(Number.MAX_SAFE_INTEGER, 2)).toThrow("安全范围");
  });

  it("实付金额按权重分摊且不丢分", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(999, [600, 300, 100])).toEqual([600, 300, 99]);
    expect(allocateCents(100, [0, 0])).toEqual([0, 0]);
  });

  it("支持指定 SKU 佣金与比例佣金混合快照", () => {
    const result = calculateOrderBrokerage({
      items: [
        { grossCents: 10_000, costCents: 6_000, quantity: 2, specified: true, specifiedOneCents: 300, specifiedTwoCents: 100 },
        { grossCents: 5_000, costCents: 2_000, quantity: 1, specified: false, specifiedOneCents: 0, specifiedTwoCents: 0 },
      ],
      actualProductCents: 12_500,
      computeType: 2,
      oneBasisPoints: 1000,
      twoBasisPoints: 500,
      oneEligible: true,
      twoEligible: true,
    });
    expect(result).toEqual({
      oneCents: 1016,
      twoCents: 408,
      staffCents: 0,
      agentCents: 0,
      divisionCents: 0,
    });
  });

  it("利润返佣不允许负基数，非推广员不生成对应佣金", () => {
    const result = calculateOrderBrokerage({
      items: [
        { grossCents: 1000, costCents: 1200, quantity: 1, specified: false, specifiedOneCents: 0, specifiedTwoCents: 0 },
      ],
      actualProductCents: 900,
      computeType: 3,
      oneBasisPoints: 1000,
      twoBasisPoints: 500,
      oneEligible: true,
      twoEligible: false,
    });
    expect(result).toEqual({
      oneCents: 0,
      twoCents: 0,
      staffCents: 0,
      agentCents: 0,
      divisionCents: 0,
    });
  });

  it("按累计退款比例得出目标退佣，全额退款精确封顶", () => {
    const firstTarget = targetBrokerageReversal(1000, 3333, 10_000);
    const secondTarget = targetBrokerageReversal(1000, 6666, 10_000);
    expect(firstTarget).toBe(333);
    expect(secondTarget).toBe(666);
    expect(secondTarget - firstTarget).toBe(333);
    expect(targetBrokerageReversal(1000, 10_000, 10_000)).toBe(1000);
    expect(targetBrokerageReversal(1000, 12_000, 10_000)).toBe(1000);
  });

  it("员工直属买家按上级总比例做差额分佣", () => {
    const buyer = divisionAccount({ spreadUid: 10, staffId: 10, agentId: 20, divisionId: 30 });
    const staff = divisionAccount({ uid: 10, divisionType: 3, divisionPercent: 30 });
    const agent = divisionAccount({ uid: 20, divisionType: 2, divisionPercent: 50 });
    const division = divisionAccount({ uid: 30, divisionType: 1, divisionPercent: 70 });
    expect(calculateDivisionBrokerageRates({
      enabled: true,
      selfBrokerage: false,
      now: 100,
      baseOneBasisPoints: 1000,
      baseTwoBasisPoints: 500,
      buyer,
      firstSpreadParentUid: 0,
      staff,
      agent,
      division,
    })).toEqual({
      oneBasisPoints: 0,
      twoBasisPoints: 0,
      staffBasisPoints: 3000,
      agentBasisPoints: 2000,
      divisionBasisPoints: 2000,
    });
  });

  it("允许自购返佣时保留员工直属一级佣金并只结算差额", () => {
    const buyer = divisionAccount({ spreadUid: 10, staffId: 10, agentId: 20, divisionId: 30 });
    const rates = calculateDivisionBrokerageRates({
      enabled: true,
      selfBrokerage: true,
      now: 100,
      baseOneBasisPoints: 1000,
      baseTwoBasisPoints: 500,
      buyer,
      firstSpreadParentUid: 0,
      staff: divisionAccount({ uid: 10, divisionType: 3, divisionPercent: 30 }),
      agent: divisionAccount({ uid: 20, divisionType: 2, divisionPercent: 50 }),
      division: divisionAccount({ uid: 30, divisionType: 1, divisionPercent: 70 }),
    });
    expect(rates).toEqual({
      oneBasisPoints: 1000,
      twoBasisPoints: 0,
      staffBasisPoints: 2000,
      agentBasisPoints: 2000,
      divisionBasisPoints: 2000,
    });
    expect(calculateOrderBrokerage({
      items: [{ grossCents: 10_000, costCents: 5_000, quantity: 1, specified: false, specifiedOneCents: 0, specifiedTwoCents: 0 }],
      actualProductCents: 10_000,
      computeType: 1,
      ...rates,
      oneEligible: true,
      twoEligible: false,
    })).toEqual({
      oneCents: 1000,
      twoCents: 0,
      staffCents: 2000,
      agentCents: 2000,
      divisionCents: 2000,
    });
  });

  it("指定 SKU 佣金不参与事业部差额分佣", () => {
    expect(calculateOrderBrokerage({
      items: [{ grossCents: 10_000, costCents: 5_000, quantity: 2, specified: true, specifiedOneCents: 300, specifiedTwoCents: 100 }],
      actualProductCents: 10_000,
      computeType: 1,
      oneBasisPoints: 1000,
      twoBasisPoints: 500,
      staffBasisPoints: 2000,
      agentBasisPoints: 2000,
      divisionBasisPoints: 2000,
      oneEligible: true,
      twoEligible: true,
    })).toEqual({
      oneCents: 600,
      twoCents: 200,
      staffCents: 0,
      agentCents: 0,
      divisionCents: 0,
    });
  });

  it("事业部、代理商和员工本人下单按身份关闭普通两级佣金", () => {
    const common = {
      enabled: true,
      selfBrokerage: true,
      now: 100,
      baseOneBasisPoints: 1000,
      baseTwoBasisPoints: 500,
      firstSpreadParentUid: 0,
    };
    const division = divisionAccount({ uid: 30, divisionType: 1, divisionId: 30, divisionPercent: 70 });
    const agent = divisionAccount({ uid: 20, divisionType: 2, divisionId: 30, agentId: 20, divisionPercent: 50 });
    const staff = divisionAccount({ uid: 10, divisionType: 3, divisionId: 30, agentId: 20, staffId: 10, divisionPercent: 30 });
    expect(calculateDivisionBrokerageRates({
      ...common,
      buyer: division,
      staff: null,
      agent: null,
      division,
    })).toEqual({ oneBasisPoints: 0, twoBasisPoints: 0, staffBasisPoints: 0, agentBasisPoints: 0, divisionBasisPoints: 7000 });
    expect(calculateDivisionBrokerageRates({
      ...common,
      buyer: agent,
      staff: null,
      agent,
      division,
    })).toEqual({ oneBasisPoints: 0, twoBasisPoints: 0, staffBasisPoints: 0, agentBasisPoints: 5000, divisionBasisPoints: 2000 });
    expect(calculateDivisionBrokerageRates({
      ...common,
      buyer: staff,
      staff,
      agent,
      division,
    })).toEqual({ oneBasisPoints: 0, twoBasisPoints: 0, staffBasisPoints: 3000, agentBasisPoints: 2000, divisionBasisPoints: 2000 });
  });

  it("事业部分佣关闭时保留普通两级比例，并拒绝越界角色比例", () => {
    const buyer = divisionAccount({ staffId: 10, agentId: 20, divisionId: 30 });
    const input = {
      enabled: false,
      selfBrokerage: false,
      now: 100,
      baseOneBasisPoints: 1000,
      baseTwoBasisPoints: 500,
      buyer,
      firstSpreadParentUid: 0,
      staff: divisionAccount({ uid: 10, divisionType: 3, divisionPercent: 30 }),
      agent: divisionAccount({ uid: 20, divisionType: 2, divisionPercent: 50 }),
      division: divisionAccount({ uid: 30, divisionType: 1, divisionPercent: 70 }),
    };
    expect(calculateDivisionBrokerageRates(input)).toEqual({
      oneBasisPoints: 1000,
      twoBasisPoints: 500,
      staffBasisPoints: 0,
      agentBasisPoints: 0,
      divisionBasisPoints: 0,
    });
    expect(() => calculateDivisionBrokerageRates({
      ...input,
      enabled: true,
      staff: divisionAccount({ uid: 10, divisionType: 3, divisionPercent: 101 }),
    })).toThrow("分佣比例无效");
  });
});

function divisionAccount(overrides: Partial<{
  uid: number;
  spreadUid: number;
  divisionType: number;
  divisionStatus: number;
  divisionId: number;
  agentId: number;
  staffId: number;
  divisionPercent: number;
  divisionEndTime: number;
}> = {}) {
  return {
    uid: 1,
    spreadUid: 0,
    divisionType: 0,
    divisionStatus: 1,
    divisionId: 0,
    agentId: 0,
    staffId: 0,
    divisionPercent: 0,
    divisionEndTime: 1_000,
    ...overrides,
  };
}
