import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  ENTERPRISE_WECHAT_JS_API_LIST,
  EnterpriseWechatJsSdkService,
  normalizeEnterpriseWechatSignedUrl,
} from "@/services/work/EnterpriseWechatJsSdkService";
import { ForbiddenException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { jsSdkSignature } from "@/utils/wechat-crypto";

interface MemoryKv {
  binding: KVNamespace;
  values: Map<string, string>;
  writes: Array<{ key: string; expirationTtl?: number }>;
}

function memoryKv(): MemoryKv {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; expirationTtl?: number }> = [];
  const binding = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      if (value === null || type !== "json") return value;
      return JSON.parse(value) as unknown;
    },
    async put(key: string, value: string, options?: KVNamespacePutOptions) {
      values.set(key, value);
      writes.push({ key, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      values.delete(key);
    },
  } as unknown as KVNamespace;
  return { binding, values, writes };
}

function fixture(overrides: Partial<Env> = {}) {
  const kv = memoryKv();
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
    CONFIG_KV: kv.binding,
    WORK_WECHAT_ALLOWED_ORIGINS: "https://work.example.com,https://work-alt.example.com:8443",
    WECHAT_WORK_CORP_SECRET: "company-worker-secret",
    WECHAT_WORK_AGENT_SECRET: "agent-worker-secret",
    ...overrides,
  } as Env;
  return { kv, config, container, env };
}

function jsonResponse(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  const json = JSON.stringify(body);
  return new Response(json, {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function queuedFetcher(responses: Response[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(_input)), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected provider request");
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Enterprise WeChat JS-SDK migration", () => {
  it("normalizes only allowlisted HTTPS origins and removes the fragment before signing", () => {
    expect(normalizeEnterpriseWechatSignedUrl(
      " https://work.example.com/a/../page?x=1#client-route ",
      "https://work.example.com",
    )).toBe("https://work.example.com/page?x=1");
    expect(normalizeEnterpriseWechatSignedUrl(
      "https://work-alt.example.com:8443/path",
      "https://work.example.com, https://work-alt.example.com:8443/",
    )).toBe("https://work-alt.example.com:8443/path");

    expect(() => normalizeEnterpriseWechatSignedUrl(
      "http://work.example.com/page",
      "https://work.example.com",
    )).toThrow(ForbiddenException);
    expect(() => normalizeEnterpriseWechatSignedUrl(
      "https://user:pass@work.example.com/page",
      "https://work.example.com",
    )).toThrow(ForbiddenException);
    expect(() => normalizeEnterpriseWechatSignedUrl(
      "https://evil.example.com/page",
      "https://work.example.com",
    )).toThrow(ForbiddenException);
    expect(() => normalizeEnterpriseWechatSignedUrl("not-a-url", "https://work.example.com"))
      .toThrow(ValidateException);
    expect(() => normalizeEnterpriseWechatSignedUrl(
      `https://work.example.com/${"x".repeat(2_100)}`,
      "https://work.example.com",
    )).toThrow(ValidateException);
    expect(() => normalizeEnterpriseWechatSignedUrl(
      "https://work.example.com/page",
      undefined,
    )).toThrow(ServiceUnavailableException);
    expect(() => normalizeEnterpriseWechatSignedUrl(
      "https://work.example.com/page",
      "https://work.example.com/path",
    )).toThrow(ServiceUnavailableException);
  });

  it("builds and caches the company config without persisting the Worker secret", async () => {
    const { kv, container, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "company-access", expires_in: 7200 }),
      jsonResponse({ errcode: 0, ticket: "company-ticket", expires_in: 7200 }),
    ]);
    const service = new EnterpriseWechatJsSdkService(container, env, fetcher);

    const first = await service.companyConfig("https://work.example.com/customer?id=9#ignored");
    const second = await service.companyConfig("https://work.example.com/customer?id=9#ignored");

    expect(first).toMatchObject({
      appId: "ww0123456789abcdef",
      url: "https://work.example.com/customer?id=9",
      debug: false,
      beta: true,
      openTagList: [],
      jsApiList: [...ENTERPRISE_WECHAT_JS_API_LIST],
    });
    expect(first.nonceStr).toMatch(/^[a-z0-9]{32}$/);
    expect(first.signature).toBe(await jsSdkSignature(
      "company-ticket",
      first.nonceStr,
      first.timestamp,
      first.url,
    ));
    expect(second.nonceStr).not.toBe(first.nonceStr);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    );
    expect(calls[0].url.searchParams.get("corpid")).toBe("ww0123456789abcdef");
    expect(calls[0].url.searchParams.get("corpsecret")).toBe("company-worker-secret");
    expect(calls[1].url.pathname).toBe("/cgi-bin/get_jsapi_ticket");
    expect(calls[1].url.searchParams.get("access_token")).toBe("company-access");
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
    expect(kv.writes.filter((write) => write.key.startsWith("work_jssdk:")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ expirationTtl: 6900 }),
        expect.objectContaining({ expirationTtl: 6900 }),
      ]));
    expect([...kv.values.keys()].join("\n")).not.toContain("company-worker-secret");
    expect([...kv.values.values()].join("\n")).not.toContain("company-worker-secret");
  });

  it("uses a distinct application credential and agent_config ticket", async () => {
    const { container, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "agent-access", expires_in: 7200 }),
      jsonResponse({ errcode: 0, ticket: "agent-ticket", expires_in: 7200 }),
    ]);
    const service = new EnterpriseWechatJsSdkService(container, env, fetcher);
    const result = await service.agentConfig("https://work-alt.example.com:8443/chat");

    expect(result).toMatchObject({
      corpid: "ww0123456789abcdef",
      agentid: 1000002,
      url: "https://work-alt.example.com:8443/chat",
      debug: false,
      jsApiList: [...ENTERPRISE_WECHAT_JS_API_LIST],
    });
    expect(result.signature).toBe(await jsSdkSignature(
      "agent-ticket",
      result.nonceStr,
      result.timestamp,
      result.url,
    ));
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("corpsecret")).toBe("agent-worker-secret");
    expect(calls[1].url.pathname).toBe("/cgi-bin/ticket/get");
    expect(calls[1].url.searchParams.get("type")).toBe("agent_config");
    expect(calls[1].url.searchParams.get("access_token")).toBe("agent-access");
  });

  it("exchanges OAuth code only for an internal employee and binds the configured CorpID", async () => {
    const { container, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "agent-access", expires_in: 7200 }),
      jsonResponse({
        errcode: 0,
        CorpId: "ww0123456789abcdef",
        UserId: "employee-7",
      }),
    ]);
    await expect(new EnterpriseWechatJsSdkService(container, env, fetcher)
      .employeeIdentity("oauth_code_7")).resolves.toEqual({
        corpId: "ww0123456789abcdef",
        agentId: 1000002,
        userid: "employee-7",
      });
    expect(calls).toHaveLength(2);
    expect(calls[1].url.pathname).toBe("/cgi-bin/auth/getuserinfo");
    expect(calls[1].url.searchParams.get("access_token")).toBe("agent-access");
    expect(calls[1].url.searchParams.get("code")).toBe("oauth_code_7");

    const external = fixture();
    const externalFetcher = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "agent-access", expires_in: 7200 }),
      jsonResponse({ errcode: 0, OpenId: "external-open-id" }),
    ]).fetcher;
    await expect(new EnterpriseWechatJsSdkService(
      external.container,
      external.env,
      externalFetcher,
    ).employeeIdentity("external_code")).rejects.toThrow(ForbiddenException);
  });

  it("refreshes an access token once when the ticket endpoint reports early expiry", async () => {
    const { container, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "old-access", expires_in: 7200 }),
      jsonResponse({ errcode: 42001, errmsg: "expired" }),
      jsonResponse({ errcode: 0, access_token: "fresh-access", expires_in: 7200 }),
      jsonResponse({ errcode: 0, ticket: "fresh-ticket", expires_in: 7200 }),
    ]);
    await expect(new EnterpriseWechatJsSdkService(container, env, fetcher)
      .companyConfig("https://work.example.com/page")).resolves.toMatchObject({
        appId: "ww0123456789abcdef",
      });
    expect(calls).toHaveLength(4);
    expect(calls[3].url.searchParams.get("access_token")).toBe("fresh-access");
  });

  it("fails closed before provider I/O when allowlist, IDs, or secrets are absent", async () => {
    const missingCompanySecret = fixture({ WECHAT_WORK_CORP_SECRET: undefined });
    const companyFetch = vi.fn() as unknown as typeof fetch;
    await expect(new EnterpriseWechatJsSdkService(
      missingCompanySecret.container,
      missingCompanySecret.env,
      companyFetch,
    ).companyConfig("https://work.example.com/page")).rejects.toThrow(
      "企业微信企业凭据尚未配置",
    );
    expect(companyFetch).not.toHaveBeenCalled();

    const missingAgentSecret = fixture({ WECHAT_WORK_AGENT_SECRET: undefined });
    const agentFetch = vi.fn() as unknown as typeof fetch;
    await expect(new EnterpriseWechatJsSdkService(
      missingAgentSecret.container,
      missingAgentSecret.env,
      agentFetch,
    ).agentConfig("https://work.example.com/page")).rejects.toThrow(
      "企业微信应用凭据尚未配置",
    );
    expect(agentFetch).not.toHaveBeenCalled();

    const missingAllowlist = fixture({ WORK_WECHAT_ALLOWED_ORIGINS: undefined });
    await expect(new EnterpriseWechatJsSdkService(
      missingAllowlist.container,
      missingAllowlist.env,
      vi.fn() as unknown as typeof fetch,
    ).companyConfig("https://work.example.com/page")).rejects.toThrow(
      "企业微信签名来源尚未配置",
    );
  });

  it("bounds, times out, and redacts failed provider responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const oversizedFixture = fixture();
    const oversized = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(16 * 1024 + 1) },
    })) as unknown as typeof fetch;
    await expect(new EnterpriseWechatJsSdkService(
      oversizedFixture.container,
      oversizedFixture.env,
      oversized,
    ).companyConfig("https://work.example.com/page")).rejects.toThrow(
      "企业微信签名服务暂时不可用",
    );

    const rejectedFixture = fixture();
    const rejected = vi.fn(async () => jsonResponse({
      errcode: 40013,
      errmsg: "provider echoed company-worker-secret",
    })) as unknown as typeof fetch;
    await expect(new EnterpriseWechatJsSdkService(
      rejectedFixture.container,
      rejectedFixture.env,
      rejected,
    ).companyConfig("https://work.example.com/page")).rejects.not.toThrow(
      "company-worker-secret",
    );
    expect(log.mock.calls.flat().join("\n")).not.toContain("company-worker-secret");

    vi.useFakeTimers();
    const hangingBodyFixture = fixture();
    const hangingBodyMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    });
    const hangingBody = hangingBodyMock as typeof fetch;
    const bodyResult = new EnterpriseWechatJsSdkService(
      hangingBodyFixture.container,
      hangingBodyFixture.env,
      hangingBody,
    ).companyConfig("https://work.example.com/page").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(hangingBodyMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(bodyResult).resolves.toMatchObject({
      message: "企业微信签名服务暂时不可用，请稍后重试",
    });
  });

  it("keeps the two exact public routes no-store and secrets out of versioned vars", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/EnterpriseWechatController.ts", "utf8");
    const service = readFileSync("src/services/work/EnterpriseWechatJsSdkService.ts", "utf8");
    const wrangler = readFileSync("wrangler.toml", "utf8");
    const auditWorker = readFileSync(
      "test/integration/EnterpriseWechatJsSdkAuditWorker.ts",
      "utf8",
    );
    const auditConfig = readFileSync(
      "test/integration/enterprise-wechat-jssdk-audit.wrangler.jsonc",
      "utf8",
    );
    expect(routes).toContain('v1Routes.get("/work/config", EnterpriseWechatController.config)');
    expect(routes).toContain('v1Routes.get("/work/agentConfig", EnterpriseWechatController.agentConfig)');
    expect(controller).toContain('"private, no-store, max-age=0"');
    expect(controller).toContain('c.header("Pragma", "no-cache")');
    expect(service).toContain("WECHAT_WORK_CORP_SECRET");
    expect(service).toContain("WECHAT_WORK_AGENT_SECRET");
    expect(service).not.toContain('getMany([\n      "wechat_work_corpid",\n      "wechat_work_build_agent_id",\n      "wechat_work_build_secret"');
    expect(wrangler).not.toMatch(/^WECHAT_WORK_(?:CORP|AGENT)_SECRET\s*=/m);
    expect(auditWorker).toContain("REPEATABLE READ, READ ONLY");
    expect(auditWorker).toContain("public_system_config_unchanged: true");
    expect(auditWorker).toContain("checks_passed: checks");
    expect(auditWorker).not.toContain("configuration_values_returned: true");
    expect(auditConfig).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
  });
});
