import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseAdminStatisticChannel,
  parseUserRegionSort,
} from "@/services/admin/AdminExtendedStatisticService";

describe("Admin 用户/交易/余额统计迁移", () => {
  it("严格白名单化用户渠道与地域排序", () => {
    expect(parseAdminStatisticChannel()).toBe("");
    expect(parseAdminStatisticChannel("all")).toBe("");
    expect(parseAdminStatisticChannel("WECHAT")).toBe("wechat");
    expect(parseAdminStatisticChannel("routine")).toBe("routine");
    expect(() => parseAdminStatisticChannel("wechat' OR 1=1 --")).toThrow("渠道无效");
    expect(parseUserRegionSort()).toBe("allNum");
    expect(parseUserRegionSort("payPrice")).toBe("payPrice");
    expect(() => parseUserRegionSort("payPrice DESC")).toThrow("排序字段无效");
  });

  it("在两个 Admin 路由面注册剩余十四个 PHP 合同", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const paths = [
      "statistic/product/get_excel",
      "statistic/user/get_basic",
      "statistic/user/get_trend",
      "statistic/user/get_wechat",
      "statistic/user/get_wechat_trend",
      "statistic/user/get_region",
      "statistic/user/get_sex",
      "statistic/user/get_excel",
      "statistic/trade/top_trade",
      "statistic/trade/bottom_trade",
      "statistic/balance/get_basic",
      "statistic/balance/get_trend",
      "statistic/balance/get_channel",
      "statistic/balance/get_type",
    ];
    for (const path of paths) {
      expect(adminRoutes).toContain(`/${path}`);
      expect(v1Routes).toContain(`/admin/${path}`);
    }
  });

  it("固定修正 PHP 的重复订单、软删除、三日桶和无效流水问题", () => {
    const service = readFileSync("src/services/admin/AdminExtendedStatisticService.ts", "utf8");
    expect(service).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(service).toContain("pid = 0");
    expect(service).toContain("is_del = 0 AND is_system_del = 0");
    expect(service).toContain("status = 1 AND pm IN (0, 1)");
    expect(service).toContain("refund_status IN (0, 3)");
    expect(service).toContain("COALESCE(NULLIF(refunded_time, 0), add_time)");
    expect(service).toContain("Array.from({ length: 24 }");
    expect(service).not.toContain("length: 25");
    expect(service).not.toContain("outYeOrderChain");
  });

  it("保持用户与商品导出字段顺序", () => {
    const service = readFileSync("src/services/admin/AdminExtendedStatisticService.ts", "utf8");
    expect(service).toContain('["time", "user", "browse", "new", "paid", "changes", "vip", "recharge", "payPrice"]');
    expect(service).toContain('["time", "browse", "user", "cart", "order", "payNum", "pay", "cost", "refund", "refundNum", "changes"]');
    expect(service).toContain("data:text/csv;charset=utf-8");
  });
});
