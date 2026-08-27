import { describe, expect, it } from "vitest";
import {
  buildAlipaySignContent,
  extractAlipayResponseContent,
  parseAndVerifyAlipayApiResponse,
  signAlipayContent,
  signAlipayParams,
  verifyAlipayNotification,
  type AlipayParams,
} from "@/utils/alipay";

function toPem(value: ArrayBuffer, label: "PUBLIC KEY" | "PRIVATE KEY"): string {
  const base64 = Buffer.from(value).toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function createKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicDer = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
  const privateDer = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return {
    publicKey: toPem(publicDer, "PUBLIC KEY"),
    privateKey: toPem(privateDer, "PRIVATE KEY"),
  };
}

describe("支付宝 RSA2", () => {
  it("按键名排序并排除 sign", () => {
    expect(
      buildAlipaySignContent({ z: "3", sign: "ignored", a: "1", sign_type: "RSA2" }),
    ).toBe("a=1&sign_type=RSA2&z=3");
  });

  it("验证合法通知并拒绝篡改金额", async () => {
    const keys = await createKeyPair();
    const params: AlipayParams = {
      app_id: "2026000000000000",
      out_trade_no: "wx123",
      total_amount: "12.34",
      trade_status: "TRADE_SUCCESS",
      sign_type: "RSA2",
    };
    params.sign = await signAlipayParams(params, keys.privateKey);

    await expect(verifyAlipayNotification(params, keys.publicKey)).resolves.toBe(true);
    await expect(
      verifyAlipayNotification({ ...params, total_amount: "0.01" }, keys.publicKey),
    ).resolves.toBe(false);
  });

  it("按支付宝原始 response 节点验签，保留嵌套 JSON 与转义", async () => {
    const keys = await createKeyPair();
    const content =
      '{"code":"10000","fund_change":"Y","refund_fee":"12.34","detail":{"text":"a}b\\\"c"}}';
    const sign = await signAlipayContent(content, keys.privateKey);
    const raw = `{"alipay_trade_refund_response":${content},"sign":"${sign}"}`;

    expect(extractAlipayResponseContent(raw, "alipay_trade_refund_response")).toBe(content);
    await expect(
      parseAndVerifyAlipayApiResponse<{ refund_fee: string }>(
        raw,
        "alipay_trade_refund_response",
        keys.publicKey,
      ),
    ).resolves.toMatchObject({ refund_fee: "12.34" });

    const tampered = raw.replace('"refund_fee":"12.34"', '"refund_fee":"0.01"');
    await expect(
      parseAndVerifyAlipayApiResponse(
        tampered,
        "alipay_trade_refund_response",
        keys.publicKey,
      ),
    ).rejects.toThrow("验签失败");
  });
});
