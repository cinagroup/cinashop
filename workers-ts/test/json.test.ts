import { describe, it, expect } from "vitest";
import { jsonOk, jsonFail, jsonRaw, type ApiResponse } from "../src/utils/json";
import { Hono } from "hono";

function mockContext() {
  return new Hono();
}

describe("json 封装 (对应 PHP app('json')->success/fail)", () => {
  it("jsonOk: status=200, msg 默认 'ok'", async () => {
    const app = mockContext();
    app.get("/t", (c) => jsonOk(c, { a: 1 }));
    const res = await app.request("/t");
    const body = (await res.json()) as ApiResponse<{ a: number }>;
    expect(res.status).toBe(200);
    expect(body.status).toBe(200);
    expect(body.msg).toBe("ok");
    expect(body.data).toEqual({ a: 1 });
  });

  it("jsonOk: 自定义 msg", async () => {
    const app = mockContext();
    app.get("/t", (c) => jsonOk(c, null, "登录成功"));
    const res = await app.request("/t");
    const body = (await res.json()) as ApiResponse<null>;
    expect(body.msg).toBe("登录成功");
    expect(body.data).toBeNull();
  });

  it("jsonFail: status=400 但 HTTP 仍 200", async () => {
    const app = mockContext();
    app.get("/t", (c) => jsonFail(c, "账号或密码错误"));
    const res = await app.request("/t");
    const body = (await res.json()) as ApiResponse<null>;
    expect(res.status).toBe(200); // ← 关键: HTTP 200, 业务 status 400
    expect(body.status).toBe(400);
    expect(body.msg).toBe("账号或密码错误");
  });

  it("jsonRaw: 自定义 status code", async () => {
    const app = mockContext();
    app.get("/t", (c) => jsonRaw(c, 410000, "请登录", null));
    const res = await app.request("/t");
    const body = (await res.json()) as ApiResponse<null>;
    expect(body.status).toBe(410000);
    expect(body.msg).toBe("请登录");
  });
});
