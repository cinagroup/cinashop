import { describe, expect, it } from "vitest";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { LegacyOrderCompatibilityService } from "@/services/order/LegacyOrderCompatibilityService";

describe("Alipay redirect compatibility after an assisted provider claim", () => {
  it("serves the original signed gateway URL from the opaque key without another initiation", async () => {
    const values = new Map<string, string>();
    const env = { CONFIG_KV: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value); },
      delete: async (key: string) => { values.delete(key); },
    } } as unknown as Env;
    const service = new LegacyOrderCompatibilityService({} as Container, env);
    const signed = "https://openapi.alipay.com/gateway.do?app_id=local_app&method=alipay.trade.wap.pay"
      + "&biz_content=%7B%22out_trade_no%22%3A%22local_order%22%2C%22total_amount%22%3A%221.00%22%7D&sign=local_signature";
    const key = await service.createAlipayKey(11, "local_order", signed);
    expect(await service.consumeAlipayKey(key)).toEqual({ uid: 11, orderId: "local_order", payUrl: signed });
    await expect(service.consumeAlipayKey(key)).rejects.toThrow("该订单无法支付");
    await expect(service.createAlipayKey(11, "local_order", "javascript:alert(1)"))
      .rejects.toThrow("支付宝支付地址无效");
  });
});
