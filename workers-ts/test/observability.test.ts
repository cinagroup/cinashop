import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { observabilityMiddleware } from "@/middleware/observability";
import {
  classifyCriticalHttpOperation,
  emitOperationalEvent,
  operationalErrorCode,
} from "@/utils/observability";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("production observability contract", () => {
  it.each([
    ["POST", "/api/login", "login"],
    ["POST", "/adminapi/login", "login"],
    ["POST", "/api/pay/notify/alipay", "payment"],
    ["POST", "/api/order/pay", "payment"],
    ["POST", "/api/order/refund/apply/42", "refund"],
    ["POST", "/adminapi/print/jobs", "print"],
    ["POST", "/supplierapi/waybill/jobs", "waybill"],
    ["GET", "/api/assets/42", "r2"],
    ["GET", "/api/product/detail/42", null],
  ])("classifies %s %s without emitting a raw path", (method, path, expected) => {
    expect(classifyCriticalHttpOperation(method, path)).toBe(expected);
  });

  it("emits an indexable object with a stable schema", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    emitOperationalEvent("info", {
      event: "payment_callback_completed",
      component: "payment",
      operation: "wechat_callback",
      outcome: "success",
      durationMs: 12,
    });
    expect(log).toHaveBeenCalledWith({
      schema: "cinashop_operational_v1",
      event: "payment_callback_completed",
      component: "payment",
      operation: "wechat_callback",
      outcome: "success",
      durationMs: 12,
    });
    expect(typeof log.mock.calls[0][0]).toBe("object");
  });

  it("rejects sensitive, nested, invalid and non-finite fields", () => {
    const base = {
      event: "http_request_completed",
      component: "http" as const,
      operation: "request",
      outcome: "failure" as const,
    };
    expect(() => emitOperationalEvent("error", { ...base, payload: "secret" }))
      .toThrow("Operational field is forbidden: payload");
    expect(() => emitOperationalEvent("error", { ...base, outboxId: 42 }))
      .toThrow("Operational field is forbidden: outboxId");
    expect(() => emitOperationalEvent("error", { ...base, principalUid: 42 }))
      .toThrow("Operational field is forbidden: principalUid");
    expect(() => emitOperationalEvent("error", { ...base, schema: "overridden" }))
      .toThrow("Operational field is forbidden: schema");
    expect(() => emitOperationalEvent("error", { ...base, nested: {} as never }))
      .toThrow("Operational field must be scalar: nested");
    expect(() => emitOperationalEvent("error", { ...base, durationMs: Number.NaN }))
      .toThrow("Operational number is invalid: durationMs");
    expect(() => emitOperationalEvent("error", { ...base, errorCode: "raw provider message" }))
      .toThrow("Operational error code is invalid");
  });

  it("reduces exceptions to a class code without exposing the message", () => {
    const error = new TypeError("postgresql://user:password@example.invalid private payload");
    expect(operationalErrorCode(error)).toBe("type_error");
  });

  it("logs a critical HTTP flow after the final response status is known", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const app = new Hono();
    app.use("*", observabilityMiddleware as never);
    app.post("/api/order/pay", (c) => c.json({ ok: true }));

    const response = await app.request("/api/order/pay", { method: "POST" });
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "http_request_completed",
      component: "payment",
      operation: "payment",
      outcome: "success",
      statusCode: 200,
    }));
  });

  it("logs an HTTP 5xx without a raw path or exception message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono();
    app.use("*", observabilityMiddleware as never);
    app.get("/internal/failure", () => {
      throw new Error("secret response body");
    });
    app.onError((_error, c) => c.text("failed", 500));

    const response = await app.request("/internal/failure");
    expect(response.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: "http_request_completed",
      component: "http",
      operation: "request",
      outcome: "failure",
      statusCode: 500,
    }));
    const event = error.mock.calls[0][0] as Record<string, unknown>;
    expect(event).not.toHaveProperty("path");
    expect(event).not.toHaveProperty("message");
  });
});
