import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { corsMiddleware } from "../src/middleware/cors";
import { allowlistedAuthRequest, isAllowedAuthOrigin } from "../src/services/auth/TrustedAuthClient";

// Exercise the checked-in deployment values, not a separately maintained fixture.
const config = readFileSync("wrangler.toml", "utf8");
const vars = config.match(/^\[vars\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
if (!vars) throw new Error("Missing Wrangler vars section");
function deploymentVar(key: string): string {
  const matches = [...vars!.matchAll(new RegExp(`^${key} = "([^"\\r\\n]*)"\\s*$`, "gm"))];
  if (matches.length !== 1) throw new Error(`Expected exactly one deployment variable: ${key}`);
  return matches[0]![1]!;
}
function productionEnvironment(): "production" {
  const value = deploymentVar("NODE_ENV");
  if (value !== "production") throw new Error("Deployment must use production origin policy");
  return value;
}
const env = {
  NODE_ENV: productionEnvironment(),
  ALLOWED_ORIGINS: deploymentVar("ALLOWED_ORIGINS"),
  PC_AUTH_ALLOWED_ORIGINS: deploymentVar("PC_AUTH_ALLOWED_ORIGINS"),
};
const shop = "https://shop.cinaseek.ai";
const app = new Hono<{ Bindings: typeof env }>();
app.use("*", corsMiddleware);
// This route only checks request metadata; no sessions, database or provider calls.
app.post("/api/pc/key", (c) => {
  try {
    return c.json(allowlistedAuthRequest(c.req.raw, c.env, "pc_user"));
  } catch {
    return c.json({ denied: true }, 403);
  }
});

describe("shop custom-domain deployment origins", () => {
  it("adds only shop while retaining existing storefront origins", () => {
    expect(env.NODE_ENV).toBe("production");
    expect(env.ALLOWED_ORIGINS.split(",").sort()).toEqual([
      "https://cinashop-h5.pages.dev", "https://cinashop-pc.pages.dev", shop,
    ].sort());
    expect(env.PC_AUTH_ALLOWED_ORIGINS.split(",").sort()).toEqual([
      "https://cinashop-pc.pages.dev", shop,
    ].sort());
  });

  it.each([shop, "https://cinashop-pc.pages.dev"])("admits PC bootstrap from %s", async (origin) => {
    const result = await app.request("/api/pc/key", { method: "POST", headers: { Origin: origin } }, env);
    expect(result.status).toBe(200);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect((await result.json() as { origin: string }).origin).toBe(origin);
    expect(isAllowedAuthOrigin(origin, env, "kefu_agent")).toBe(false);
  });

  it("handles shop browser preflight with the real CORS middleware", async () => {
    const result = await app.request("/api/pc/key", {
      method: "OPTIONS",
      headers: { Origin: shop, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type,Form-type,Authori-zation" },
    }, env);
    expect(result.status).toBe(204);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(shop);
    expect(result.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(result.headers.get("Access-Control-Allow-Headers")).toContain("Authori-zation");
  });

  it.each([
    "https://cinaseek.ai", "https://admin.cinaseek.ai", "https://api.cinaseek.ai",
    "https://www.cinaseek.ai", "https://shop.cinaseek.ai.evil.example",
    "http://shop.cinaseek.ai", "https://shop.cinaseek.ai:8443", "null",
    "https://157b8f1c.cinashop-pc.pages.dev", "https://codex-shop-validation.cinashop-pc.pages.dev",
  ])("does not extend trust to %s", async (origin) => {
    const result = await app.request("/api/pc/key", { method: "POST", headers: { Origin: origin } }, env);
    expect(result.status).toBe(403);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps H5 CORS separate from PC login admission", async () => {
    const origin = "https://cinashop-h5.pages.dev";
    const result = await app.request("/api/pc/key", { method: "POST", headers: { Origin: origin } }, env);
    expect(result.status).toBe(403);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  it("allows legacy GET Referer fallback without weakening POST Origin checks", () => {
    const url = "https://shop.cinaseek.ai/api/pc/key";
    const headers = { Referer: `${shop}/login` };
    expect(allowlistedAuthRequest(new Request(url, { headers }), env, "pc_user").origin).toBe(shop);
    expect(() => allowlistedAuthRequest(new Request(url, { method: "POST", headers }), env, "pc_user"))
      .toThrow("请求来源未进入登录白名单");
  });
});
