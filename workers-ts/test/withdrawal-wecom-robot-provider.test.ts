import { describe, expect, it, vi } from "vitest";
import { WechatProviderConfigurationError, WechatProviderRejectedError } from "@/services/wechat/WechatNotificationProvider";
import { sendWithdrawalWecomRobot, validWithdrawalWecomWebhook } from "@/services/wechat/WithdrawalWecomRobotProvider";

const secret = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${"a".repeat(32)}`;
const payload = { kind: "wecom_robot" as const, withdrawalId: 41 };

describe("withdrawal WeCom robot provider", () => {
  it("allows only the fixed HTTPS host/path and one hex webhook key", async () => {
    expect(validWithdrawalWecomWebhook(secret)).toBe(true);
    const invalid = [undefined, "", "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + "a".repeat(32),
      "https://qyapi.weixin.qq.com.evil.invalid/cgi-bin/webhook/send?key=" + "a".repeat(32),
      "https://qyapi.weixin.qq.com:443/cgi-bin/webhook/send?key=" + "a".repeat(32),
      secret + "&extra=1", secret + "#fragment", secret.replace("a".repeat(32), "not-a-key")];
    const fetcher = vi.fn() as unknown as typeof fetch;
    for (const value of invalid) {
      expect(validWithdrawalWecomWebhook(value)).toBe(false);
      await expect(sendWithdrawalWecomRobot(value, payload, fetcher)).rejects.toBeInstanceOf(WechatProviderConfigurationError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the minimal text once with no nickname, amount, template or credential in the body", async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json({ errcode: 0, errmsg: "ok" })) as unknown as typeof fetch;
    await expect(sendWithdrawalWecomRobot(secret, payload, fetcher)).resolves.toEqual({
      providerReference: "", requestId: "", responseCode: "0" });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe(secret);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    expect(JSON.parse(String(init?.body))).toEqual({ msgtype: "text",
      text: { content: "收到一笔提现申请，请在后台查看。申请编号：41" } });
    expect(String(init?.body)).not.toContain("key=");
  });

  it("classifies explicit provider rejection while masking transport and response ambiguity", async () => {
    const denied = vi.fn(async () => Response.json({ errcode: 93000, errmsg: secret })) as unknown as typeof fetch;
    await expect(sendWithdrawalWecomRobot(secret, payload, denied)).rejects.toMatchObject({
      code: 93000, retryable: false });
    const throttled = vi.fn(async () => Response.json({ errcode: 45009 })) as unknown as typeof fetch;
    await expect(sendWithdrawalWecomRobot(secret, payload, throttled)).rejects.toMatchObject({
      code: 45009, retryable: true });
    const ambiguous = [
      vi.fn(async () => { throw new Error(secret); }),
      vi.fn(async () => new Response("x".repeat(2049), { status: 200 })),
      vi.fn(async () => new Response("redirect", { status: 302, headers: { location: secret } })),
      vi.fn(async () => new Response("not-json", { status: 200 })),
    ];
    for (const fetcher of ambiguous) {
      await expect(sendWithdrawalWecomRobot(secret, payload, fetcher as unknown as typeof fetch))
        .rejects.toThrow("企业微信机器人投递结果未知");
      try { await sendWithdrawalWecomRobot(secret, payload, fetcher as unknown as typeof fetch); }
      catch (error) { expect(String(error)).not.toContain(secret); expect(error).not.toBeInstanceOf(WechatProviderRejectedError); }
    }
  });

  it("cancels unconsumed bodies for oversized declared length and non-2xx responses", async () => {
    for (const responseInit of [
      { status: 200, headers: { "content-length": "2049" } },
      { status: 503 },
    ]) {
      const canceled = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel: canceled }), responseInit);
      const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
      await expect(sendWithdrawalWecomRobot(secret, payload, fetcher))
        .rejects.toThrow("企业微信机器人投递结果未知");
      expect(canceled).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds a stalled response body even if its stream ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const stalled = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} })));
      const pending = sendWithdrawalWecomRobot(secret, payload, stalled as unknown as typeof fetch);
      const assertion = expect(pending).rejects.toThrow("企业微信机器人投递结果未知");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(stalled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
