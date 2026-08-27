import { describe, expect, it } from "vitest";
import {
  calculateProductIntegralSnapshot,
  calculateReceiptRewards,
  decimalToWholePoints,
  parseRewardRate,
  targetProportionalPoints,
} from "../src/services/order/OrderRewardService";

describe("确认收货积分与经验", () => {
  it("兼容 PHP JSON 标量并转为固定万分单位", () => {
    expect(parseRewardRate('"1"', "积分比例")).toBe(10_000);
    expect(parseRewardRate("0.125", "积分比例")).toBe(1_250);
    expect(parseRewardRate("12.3456", "积分比例")).toBe(123_456);
    expect(() => parseRewardRate("1.23456", "积分比例")).toThrow("格式无效");
    expect(() => parseRewardRate("-1", "积分比例")).toThrow("格式无效");
  });

  it("按 PHP BCMath 精度计算普通会员积分与经验", () => {
    expect(calculateReceiptRewards({
      orderType: 0,
      payCents: 1234,
      gainIntegral: "7.90",
      orderIntegralRateUnits: 10_000,
      orderExpRateUnits: 10_000,
      paidMember: false,
      memberIntegralMultiplier: 2,
      memberFunctionEnabled: true,
      levelActive: true,
    })).toEqual({ productIntegral: 7, orderIntegral: 12, expHundredths: 1234 });
  });

  it("付费会员倍率只放大实付返积分，不放大商品积分或经验", () => {
    expect(calculateReceiptRewards({
      orderType: 0,
      payCents: 1234,
      gainIntegral: 7,
      orderIntegralRateUnits: 10_000,
      orderExpRateUnits: 20_000,
      paidMember: true,
      memberIntegralMultiplier: 2,
      memberFunctionEnabled: true,
      levelActive: true,
    })).toEqual({ productIntegral: 7, orderIntegral: 24, expHundredths: 2468 });
  });

  it("营销订单不赠积分，但旧版仍允许已激活用户获得经验", () => {
    expect(calculateReceiptRewards({
      orderType: 3,
      payCents: 5000,
      gainIntegral: 10,
      orderIntegralRateUnits: 10_000,
      orderExpRateUnits: 10_000,
      paidMember: true,
      memberIntegralMultiplier: 3,
      memberFunctionEnabled: true,
      levelActive: true,
    })).toEqual({ productIntegral: 0, orderIntegral: 0, expHundredths: 5000 });
  });

  it("商品积分先按商品乘数量再以 scale=0 截断", () => {
    expect(calculateProductIntegralSnapshot([
      { giveIntegral: "1.50", quantity: 3 },
      { giveIntegral: "0.75", quantity: 2 },
    ])).toBe(5);
    expect(decimalToWholePoints("99.99")).toBe(99);
  });

  it("按累计退款目标计算增量并在全额退款精确封顶", () => {
    const first = targetProportionalPoints(100, 3333, 10_000);
    const second = targetProportionalPoints(100, 6666, 10_000);
    expect(first).toBe(33);
    expect(second).toBe(66);
    expect(second - first).toBe(33);
    expect(targetProportionalPoints(100, 10_000, 10_000)).toBe(100);
    expect(targetProportionalPoints(100, 12_000, 10_000)).toBe(100);
  });
});
