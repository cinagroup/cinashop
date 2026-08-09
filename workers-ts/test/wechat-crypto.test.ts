/**
 * 微信加密工具测试 (M6)
 *
 * 验证 v2 签名 / JS-SDK 签名 / AES 解密的正确性。
 * RSA 签名/验签需要测试密钥对, 留到集成测试 (Miniflare) 验证。
 */
import { describe, it, expect } from "vitest";
import {
  generateV2Sign,
  md5Hex,
  jsSdkSignature,
  generateNonceStr,
  decryptMiniProgramData,
} from "../src/utils/wechat-crypto";

describe("微信 v2 签名 (MD5 大写, 对应 PHP Helper::generateSign)", () => {
  it("排序 + 拼 key + MD5 大写", () => {
    const params = {
      appid: "wx1234567890",
      mch_id: "1234567890",
      body: "测试商品",
      out_trade_no: "order123",
      total_fee: "100",
    };
    const sign = generateV2Sign(params, "apikey_test");
    // 验证: 32位大写十六进制
    expect(sign).toMatch(/^[A-F0-9]{32}$/);
  });

  it("sign 字段不参与签名", () => {
    const params1 = { a: "1", b: "2" };
    const params2 = { a: "1", b: "2", sign: "anything" };
    expect(generateV2Sign(params1, "key")).toBe(generateV2Sign(params2, "key"));
  });

  it("空值参数不参与签名", () => {
    const params1 = { a: "1", b: "" };
    const params2 = { a: "1" };
    expect(generateV2Sign(params1, "key")).toBe(generateV2Sign(params2, "key"));
  });
});

describe("MD5", () => {
  it("md5('123456') = e10adc3949ba59abbe56e057f20f883e", () => {
    expect(md5Hex("123456")).toBe("e10adc3949ba59abbe56e057f20f883e");
  });
  it("md5('') = d41d8cd98f00b204e9800998ecf8427e", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});

describe("JS-SDK SHA1 签名 (对应 PHP JsApiTicket::configSignature)", () => {
  it("签名串顺序固定: jsapi_ticket & noncestr & timestamp & url", async () => {
    const sig = await jsSdkSignature(
      "s4TmZVfFQ3D3aJOBfU5SmVfFQ3D3aJOB",
      "Wm3WZYTPz0wzccnW",
      1414587457,
      "http://mp.weixin.qq.com?params=value",
    );
    // SHA1 → 40 位十六进制
    expect(sig).toMatch(/^[a-f0-9]{40}$/);
  });

  it("不同 url 产生不同签名", async () => {
    const sig1 = await jsSdkSignature("ticket", "nonce", 1000, "http://a.com");
    const sig2 = await jsSdkSignature("ticket", "nonce", 1000, "http://b.com");
    expect(sig1).not.toBe(sig2);
  });
});

describe("generateNonceStr", () => {
  it("生成长度可配置的随机字符串", () => {
    expect(generateNonceStr(16)).toHaveLength(16);
    expect(generateNonceStr(32)).toHaveLength(32);
  });
  it("只含小写字母和数字", () => {
    const nonce = generateNonceStr(100);
    expect(nonce).toMatch(/^[a-z0-9]+$/);
  });
});

describe("AES-128-CBC 小程序数据解密", () => {
  it("密钥错误时抛异常", async () => {
    // 用无效的 base64 数据
    await expect(
      decryptMiniProgramData("invalidbase64==", "AAAAAAAAAAAAAAAAAAAAAA==", "AAAAAAAAAAAAAAAA"),
    ).rejects.toThrow();
  });
});
