/**
 * getMinPrice 单元测试
 *
 * 对应 PHP app/services/product/StoreProductServices.php::getMinPrice
 * 验证 4 种价格场景的逻辑分支, 必须与 PHP 完全一致。
 */
import { describe, it, expect } from "vitest";
import { StoreProductService } from "../src/services/product/StoreProductService";

// 构造一个不依赖 container/env 的 service 实例 (只用 getMinPrice 纯函数)
const svc = new StoreProductService(
  null as never,
  null as never,
);

describe("getMinPrice (对应 PHP getMinPrice 会员价计算)", () => {
  it("discount=100 且非 svip → 无折扣, vip_price=0", () => {
    const r = svc.getMinPrice("100.00", 0, "0", 100, "");
    expect(r.price_type).toBe("");
    expect(r.vip_price).toBe("0");
    expect(r.level_name).toBe("");
  });

  it("discount=90 (9折) 且非 svip → level 价生效", () => {
    const r = svc.getMinPrice("100.00", 0, "0", 90, "白银会员");
    expect(r.price_type).toBe("level");
    expect(r.vip_price).toBe("90.00");
    expect(r.level_name).toBe("白银会员");
    expect(r.level_price).toBe("90.00");
  });

  it("svip 商品 + discount=100 → member 价生效", () => {
    const r = svc.getMinPrice("100.00", 1, "80.00", 100, "");
    expect(r.price_type).toBe("member");
    expect(r.vip_price).toBe("80.00");
  });

  it("svip 商品 + discount=85 且 level 价 < svip 价 → 取 level 价", () => {
    // price=100, discount=85 → level_price=85; vip=80 → level(85) > vip(80)
    // 应取低的 vip=80, price_type=member
    const r = svc.getMinPrice("100.00", 1, "80.00", 85, "黄金");
    expect(r.price_type).toBe("member");
    expect(r.vip_price).toBe("80.00");
  });

  it("svip 商品 + discount=70 且 level 价 < svip 价 → 取 level 价", () => {
    // price=100, discount=70 → level_price=70; vip=80 → level(70) < vip(80)
    // 应取低的 level=70, price_type=level
    const r = svc.getMinPrice("100.00", 1, "80.00", 70, "钻石");
    expect(r.price_type).toBe("level");
    expect(r.vip_price).toBe("70.00");
  });

  it("discount=0 (免费) → level_price=0", () => {
    const r = svc.getMinPrice("100.00", 0, "0", 0, "测试");
    expect(r.price_type).toBe("level");
    expect(r.vip_price).toBe("0.00");
  });

  it("精度: price=99.99, discount=88 → 87.99", () => {
    const r = svc.getMinPrice("99.99", 0, "0", 88, "");
    expect(r.level_price).toBe("87.99");
  });
});
