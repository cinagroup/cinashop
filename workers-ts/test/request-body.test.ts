import { describe, expect, it } from "vitest";
import { readBoundedJsonObject } from "@/utils/request-body";

function request(body: BodyInit, headers?: HeadersInit): Request {
  return new Request("https://example.test/api", { method: "POST", body, headers });
}

describe("bounded JSON request bodies", () => {
  it("parses a JSON object inside the limit", async () => {
    await expect(readBoundedJsonObject(request('{"phone":"13800138000"}'), 1024))
      .resolves.toEqual({ phone: "13800138000" });
  });

  it("rejects malformed JSON and non-object roots", async () => {
    await expect(readBoundedJsonObject(request("{"), 1024))
      .rejects.toThrow("请求数据格式错误");
    await expect(readBoundedJsonObject(request("[]"), 1024))
      .rejects.toThrow("请求数据格式错误");
  });

  it("rejects a declared body above the limit before reading", async () => {
    await expect(readBoundedJsonObject(
      request("{}", { "content-length": "2048" }),
      1024,
    )).rejects.toThrow("请求数据不能超过1 KiB");
  });

  it("rejects an actual body above the limit without trusting headers", async () => {
    await expect(readBoundedJsonObject(request(JSON.stringify({ value: "x".repeat(2048) })), 1024))
      .rejects.toThrow("请求数据不能超过1 KiB");
  });

  it("rejects an invalid parser limit", async () => {
    await expect(readBoundedJsonObject(request("{}"), 0))
      .rejects.toThrow("maxBytes must be a positive safe integer");
  });
});
