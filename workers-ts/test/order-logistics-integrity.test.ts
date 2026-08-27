import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAliyunTrackingUrl,
  normalizeExpressCode,
  parseAliyunTrackingPayload,
  readBoundedJson,
} from "@/services/order/ExpressService";

describe("订单物流查询完整性", () => {
  it("固定阿里云物流主机并安全编码运单参数", () => {
    const url = new URL(buildAliyunTrackingUrl("SF 123:456", "zhongtong"));
    expect(url.origin).toBe("https://wuliu.market.alicloudapi.com");
    expect(url.pathname).toBe("/kdi");
    expect(url.searchParams.get("no")).toBe("SF 123:456");
    expect(url.searchParams.get("type")).toBe("ZTO");
    expect(normalizeExpressCode(" EMS ")).toBe("EMS");
  });

  it("只保留承运商真实轨迹并识别签收状态", () => {
    const parsed = parseAliyunTrackingPayload({
      status: "0",
      result: {
        deliverystatus: 3,
        issign: 1,
        list: [
          { time: "2026-08-09 11:20:00", status: "快件已由本人签收" },
          { time: "2026-08-09 09:10:00", status: "快件正在派送" },
        ],
      },
    });
    expect(parsed).toEqual({
      accepted: true,
      delivered: true,
      state: "delivered",
      statusText: "已签收",
      traces: [
        {
          time: "2026-08-09 11:20:00",
          content: "快件已由本人签收",
          status: "已签收",
        },
        {
          time: "2026-08-09 09:10:00",
          content: "快件正在派送",
          status: "派送中",
        },
      ],
    });
  });

  it("未知或错误响应明确降级，不生成轨迹", () => {
    expect(parseAliyunTrackingPayload({ status: "203", msg: "no result" })).toEqual({
      accepted: false,
      delivered: false,
      state: "temporarily_unavailable",
      statusText: "物流服务暂不可用",
      traces: [],
    });
  });

  it("对第三方响应执行流式大小上限", async () => {
    const response = new Response(JSON.stringify({ result: { list: [] } }), {
      headers: { "content-type": "application/json" },
    });
    await expect(readBoundedJson(response, 128)).resolves.toEqual({ result: { list: [] } });

    const oversized = new Response(JSON.stringify({ value: "x".repeat(200) }));
    await expect(readBoundedJson(oversized, 64)).rejects.toThrow("大小限制");
  });

  it("按 uid 查订单/退款单，直接使用包裹运单并缓存真实结果", () => {
    const source = readFileSync("src/services/order/ExpressService.ts", "utf8");
    expect(source).toContain("eq(storeOrder.uid, uid)");
    expect(source).toContain("eq(storeOrderRefund.uid, uid)");
    expect(source).toContain("expressNo: order.deliveryId");
    expect(source).toContain("ACTIVE_CACHE_TTL_SECONDS = 30 * 60");
    expect(source).toContain("ALIYUN_EXPRESS_APP_CODE");
    expect(source).not.toContain("generateMockTraces");
    expect(source).not.toContain("深圳转运中心");
    expect(source).not.toContain("目的地营业点");
  });

  it("保留 PHP 退款物流路由并把 Worker env 传入服务", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/OrderController.ts", "utf8");
    expect(routes).toContain('"/order/express/:orderId/:type"');
    expect(controller).toContain('c.req.param("type")');
    expect(controller).toContain('new ExpressService(c.get("container"), c.env)');
  });

  it("PC 与 UniApp 展示真实降级消息和拆分包裹选择", () => {
    for (const file of [
      "../view/pc-ts/src/pages/order/OrderExpress.vue",
      "../view/uniapp-ts/src/pages/order/express.vue",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("displayResult.message");
      expect(source).toContain("result.packages.length > 1");
      expect(source).toContain("selectedPackageId");
    }
  });
});
