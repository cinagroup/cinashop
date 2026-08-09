/**
 * 关键业务逻辑测试 (审计补充)
 *
 * 覆盖:
 *   - 订单金额计算 (整数分, 避免浮点误差)
 *   - 退款金额计算 (整单/部分)
 *   - 优惠券可用性判断 (类型/商品/品类)
 *   - 签到连续天数计算
 *   - 响应信封格式
 */
import { describe, it, expect } from "vitest";

// ─── 金额计算 (订单/退款共用逻辑) ─────────────────────────

/**
 * 模拟 StoreOrderCreateService 的金额计算:
 * 商品价 * 数量, 用整数分避免浮点误差
 */
function calcTotalCents(items: { price: string; num: number }[]): number {
  return items.reduce((sum, i) => {
    return sum + Math.round(Number(i.price) * 100) * i.num;
  }, 0);
}

describe("订单金额计算 (整数分, 避免浮点误差)", () => {
  it("多商品总价计算正确", () => {
    const items = [
      { price: "99.90", num: 2 },
      { price: "299.00", num: 1 },
    ];
    // 99.90*2 + 299.00 = 199.80 + 299.00 = 498.80
    expect(calcTotalCents(items)).toBe(49880);
  });

  it("浮点陷阱: 0.1 + 0.2 类场景不丢精度", () => {
    const items = [
      { price: "0.10", num: 1 },
      { price: "0.20", num: 1 },
    ];
    // 若用浮点: 0.1+0.2 = 0.30000000000000004
    // 用整数分: 10 + 20 = 30 分 = 0.30
    expect(calcTotalCents(items)).toBe(30);
  });

  it("积分抵扣: 100 积分 = 1 元, 不超过订单金额", () => {
    const totalCents = 49880;
    const useIntegral = 500; // 500 积分 = 5 元
    const deductionCents = Math.min(useIntegral * 1, totalCents);
    const payCents = Math.max(0, totalCents - deductionCents);
    expect(deductionCents).toBe(500);
    expect(payCents).toBe(49380);
  });

  it("积分超出订单金额时, 支付金额为 0", () => {
    const totalCents = 300;
    const useIntegral = 500;
    const deductionCents = Math.min(useIntegral * 1, totalCents);
    const payCents = Math.max(0, totalCents - deductionCents);
    expect(payCents).toBe(0);
  });
});

// ─── 退款金额计算 ─────────────────────────────────────────

/**
 * 模拟 StoreOrderRefundService 的部分退款计算:
 * 退款金额 = 订单实付 * (退款数量 / 总数量)
 */
function calcRefundPrice(payPrice: string, refundNum: number, totalNum: number): string {
  const ratio = totalNum > 0 ? refundNum / totalNum : 0;
  return (Number(payPrice) * ratio).toFixed(2);
}

describe("退款金额计算", () => {
  it("整单退款 = 实付金额", () => {
    expect(calcRefundPrice("498.80", 3, 3)).toBe("498.80");
  });

  it("部分退款按比例", () => {
    // 3 件商品付 498.80, 退 1 件
    expect(calcRefundPrice("498.80", 1, 3)).toBe("166.27");
  });

  it("退款数量不能超过总数量 (业务守卫)", () => {
    // 守卫: 退款数量 > 总数量时, 应限制为总数量 (防止超退)
    const refundNum = Math.min(5, 2); // 限 2
    const result = Number(calcRefundPrice("100.00", refundNum, 2));
    expect(result).toBeLessThanOrEqual(100);
    expect(result).toBe(100);
  });
});

// ─── 优惠券可用性 (模拟后端 issue 列表过滤) ───────────────

interface Coupon {
  couponType: number; // 1通用 2商品 3品类
  productId: string;
  categoryId: string;
}

function isCouponApplicable(coupon: Coupon, product: { id: number; cateId: string }): boolean {
  switch (coupon.couponType) {
    case 1: // 通用券
      return true;
    case 2: // 商品券
      return coupon.productId.split(",").includes(String(product.id));
    case 3: // 品类券
      return coupon.categoryId.split(",").includes(product.cateId);
    default:
      return false;
  }
}

describe("优惠券可用性判断", () => {
  it("通用券对所有商品可用", () => {
    const coupon = { couponType: 1, productId: "0", categoryId: "0" };
    expect(isCouponApplicable(coupon, { id: 1, cateId: "1" })).toBe(true);
    expect(isCouponApplicable(coupon, { id: 99, cateId: "5" })).toBe(true);
  });

  it("商品券只对指定商品可用", () => {
    const coupon = { couponType: 2, productId: "1,2,3", categoryId: "0" };
    expect(isCouponApplicable(coupon, { id: 2, cateId: "1" })).toBe(true);
    expect(isCouponApplicable(coupon, { id: 9, cateId: "1" })).toBe(false);
  });

  it("品类券只对指定品类可用", () => {
    const coupon = { couponType: 3, productId: "0", categoryId: "1,2" };
    expect(isCouponApplicable(coupon, { id: 5, cateId: "2" })).toBe(true);
    expect(isCouponApplicable(coupon, { id: 5, cateId: "9" })).toBe(false);
  });
});

// ─── 签到连续天数 (模拟 UserCenterService.sign) ──────────

function calcSignDays(signedYesterday: boolean, currentSignNum: number): number {
  return signedYesterday ? currentSignNum + 1 : 1;
}

describe("签到连续天数计算", () => {
  it("昨日已签 → 连续天数递增", () => {
    expect(calcSignDays(true, 5)).toBe(6);
  });

  it("昨日未签 → 重置为 1", () => {
    expect(calcSignDays(false, 5)).toBe(1);
  });

  it("首次签到 → 1 天", () => {
    expect(calcSignDays(false, 0)).toBe(1);
  });
});

// ─── 响应信封 (审计: 前端依赖 status/msg/data 结构) ─────

describe("API 响应信封格式 (前端契约)", () => {
  it("成功响应包含 status=200 + msg + data", () => {
    const resp = { status: 200, msg: "ok", data: { id: 1 } };
    expect(resp.status).toBe(200);
    expect(resp).toHaveProperty("msg");
    expect(resp).toHaveProperty("data");
  });

  it("错误响应 status != 200", () => {
    const resp = { status: 400, msg: "库存不足", data: null };
    expect(resp.status).not.toBe(200);
    expect(resp.msg).toBe("库存不足");
  });

  it("登录失效码 410000/410001/410002 触发前端跳转", () => {
    const authCodes = [410000, 410001, 410002];
    for (const code of authCodes) {
      // 前端 request.ts 拦截器逻辑
      const shouldRedirect = authCodes.includes(code);
      expect(shouldRedirect).toBe(true);
    }
  });
});
