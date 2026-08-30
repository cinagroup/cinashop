import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  EnterpriseWechatContextService,
  requireEnterpriseWechatOrigin,
  type WorkContextStateStore,
} from "@/services/work/EnterpriseWechatContextService";
import { ForbiddenException } from "@/utils/errors";

function memoryStateStore() {
  const values = new Map<string, unknown>();
  const store: WorkContextStateStore = {
    async putOnce(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async take<T>(key: string) {
      const value = values.get(key) as T | undefined;
      values.delete(key);
      return value ?? null;
    },
  };
  return { store, values };
}

function fixture() {
  const config = {
    wechat_work_corpid: "ww0123456789abcdef",
    wechat_work_build_agent_id: "1000002",
  };
  const container = {
    systemConfigDao: {
      getValues: vi.fn(async (names: string[]) => Object.fromEntries(
        names.flatMap((name) => name in config
          ? [[name, config[name as keyof typeof config]]]
          : []),
      )),
    },
  } as unknown as Container;
  const env = {
    APP_KEY: "unit-only-work-context-signing-key-32-bytes-minimum",
    WORK_WECHAT_ALLOWED_ORIGINS: "https://work.example.com,https://alternate.example.com",
    CONFIG_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
  } as Env;
  return { container, env };
}

describe("Enterprise WeChat trusted context", () => {
  it("creates an exact-origin OAuth challenge while storing only the verifier hash", async () => {
    const { container, env } = fixture();
    const memory = memoryStateStore();
    const service = new EnterpriseWechatContextService(container, env, {
      stateStore: memory.store,
      now: () => 1_788_000_000,
    });
    const result = await service.challenge(
      "https://work.example.com",
      "https://work.example.com/pages/work/user?tab=info#client-fragment",
    );
    const authorization = new URL(result.authorization_url);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://open.weixin.qq.com/connect/oauth2/authorize",
    );
    expect(authorization.searchParams.get("appid")).toBe("ww0123456789abcdef");
    expect(authorization.searchParams.get("agentid")).toBe("1000002");
    expect(authorization.searchParams.get("scope")).toBe("snsapi_base");
    expect(authorization.searchParams.get("state")).toBe(result.state);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://work.example.com/pages/work/user?tab=info",
    );
    expect(authorization.hash).toBe("#wechat_redirect");
    expect(result.state).toMatch(/^[a-f0-9]{64}$/);
    expect(result.cookie_value).toMatch(new RegExp(`^${result.state}\\.[a-f0-9]{64}$`));
    const verifier = result.cookie_value.split(".")[1];
    expect(JSON.stringify([...memory.values.entries()])).not.toContain(verifier);
    expect([...memory.values.keys()]).toEqual([`work_context:state:${result.state}`]);
  });

  it("rejects non-exact or cross-origin Enterprise WeChat browser origins", async () => {
    const { container, env } = fixture();
    expect(requireEnterpriseWechatOrigin(
      "https://work.example.com",
      env.WORK_WECHAT_ALLOWED_ORIGINS,
    )).toBe("https://work.example.com");
    expect(() => requireEnterpriseWechatOrigin(
      "https://work.example.com/path",
      env.WORK_WECHAT_ALLOWED_ORIGINS,
    )).toThrow(ForbiddenException);
    expect(() => requireEnterpriseWechatOrigin(
      "https://evil.example.com",
      env.WORK_WECHAT_ALLOWED_ORIGINS,
    )).toThrow(ForbiddenException);
    await expect(new EnterpriseWechatContextService(container, env, {
      stateStore: memoryStateStore().store,
    }).challenge(
      "https://work.example.com",
      "https://alternate.example.com/callback",
    )).rejects.toThrow("OAuth 回调地址与请求来源不一致");
  });

  it("registers the seven legacy reads behind bearer context plus protected challenge routes", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/EnterpriseWechatController.ts", "utf8");
    const service = readFileSync("src/services/work/EnterpriseWechatContextService.ts", "utf8");
    const cors = readFileSync("src/services/auth/TrustedAuthClient.ts", "utf8");
    const corsMiddleware = readFileSync("src/middleware/cors.ts", "utf8");
    const frontend = readFileSync("../view/uniapp-ts/src/api/work.ts", "utf8");
    const request = readFileSync("../view/uniapp-ts/src/utils/request.ts", "utf8");
    const audit = readFileSync("test/integration/EnterpriseWechatContextAuditWorker.ts", "utf8");
    for (const route of [
      '/work/groupInfo',
      '/work/groupMember/:id',
      '/work/client/info',
      '/work/order/list',
      '/work/order/info/:id',
      '/work/product/cart_list',
      '/work/product/visit_list',
    ]) expect(routes).toContain(`"${route}"`);
    for (const route of [
      '/work/groupInfo',
      '/work/groupMember/',
      '/work/client/info',
      '/work/order/list',
      '/work/order/info/',
      '/work/product/cart_list',
      '/work/product/visit_list',
    ]) expect(frontend).toContain(route);
    expect(routes).toContain('"/work/context/challenge"');
    expect(routes).toContain('"/work/context/exchange"');
    expect(controller).toContain('"__Host-cinashop-work-context-state"');
    expect(controller).toContain('httpOnly: true');
    expect(controller).toContain('sameSite: "Lax"');
    expect(controller).toContain('secure: true');
    expect(controller).toContain("c.req.raw.body?.getReader()");
    expect(controller).toContain("reader.cancel()");
    expect(controller).toContain('match(/^Bearer ([^\\s]+)$/i)');
    expect(service).toContain('issuer: TOKEN_ISSUER');
    expect(service).toContain('audience,');
    expect(service).toContain('eq(storeOrder.uid, scope.client.uid)');
    expect(cors).toContain('WORK_WECHAT_ALLOWED_ORIGINS');
    expect(cors).toContain('path.startsWith("/api/work/")');
    expect(corsMiddleware).toContain("isAllowedCorsOriginForPath");
    expect(frontend).toContain('headers: { Authorization: `Bearer ${token}` }');
    expect(frontend).toContain("withCredentials: true");
    expect(frontend).toContain("noAuth: true");
    expect(request).toContain("withCredentials: options.withCredentials");
    expect(audit).toContain('REPEATABLE READ, READ ONLY');
    expect(audit).toContain('row_level_values_returned: false');
  });
});
