import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import {
  EnterpriseWechatProviderClient,
  EnterpriseWechatProviderError,
  isEnterpriseWechatCorpId,
} from "@/services/work/EnterpriseWechatProviderClient";

interface MemoryKv {
  binding: KVNamespace;
  values: Map<string, string>;
  writes: Array<{ key: string; expirationTtl?: number }>;
  deletes: string[];
}

function memoryKv(): MemoryKv {
  const values = new Map<string, string>();
  const writes: MemoryKv["writes"] = [];
  const deletes: string[] = [];
  const binding = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value !== null && type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options?: KVNamespacePutOptions) {
      values.set(key, value);
      writes.push({ key, expirationTtl: options?.expirationTtl });
    },
    async delete(key: string) {
      values.delete(key);
      deletes.push(key);
    },
  } as unknown as KVNamespace;
  return { binding, values, writes, deletes };
}

function fixture(overrides: Partial<Env> = {}) {
  const kv = memoryKv();
  const env = {
    CONFIG_KV: kv.binding,
    WECHAT_WORK_CORP_SECRET: "company-secret",
    WECHAT_WORK_AGENT_SECRET: "agent-secret",
    WECHAT_WORK_DIRECTORY_SECRET: "directory-secret",
    WECHAT_WORK_EXTERNAL_CONTACT_SECRET: "external-secret",
    ...overrides,
  } as Env;
  return { kv, env };
}

function jsonResponse(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function queuedFetcher(responses: Array<Response | Error>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected provider request");
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

function client(env: Env, fetcher: typeof fetch) {
  return new EnterpriseWechatProviderClient(env, {
    corpId: "ww0123456789abcdef",
    agentId: 1_000_002,
  }, fetcher);
}

async function providerFailure(promise: Promise<unknown>): Promise<EnterpriseWechatProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnterpriseWechatProviderError);
    return error as EnterpriseWechatProviderError;
  }
  throw new Error("expected EnterpriseWechatProviderError");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Enterprise WeChat provider client", () => {
  it("isolates four least-privilege scopes and supports bounded GET/POST reads", async () => {
    const { kv, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "company-token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, ticket: "company-ticket", expires_in: 7200 }),
      jsonResponse({ errcode: 0, access_token: "agent-token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, ticket: "agent-ticket", expires_in: 7200 }),
      jsonResponse({ errcode: 0, access_token: "directory-token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, userid: "member-7" }),
      jsonResponse({ errcode: 0, access_token: "external-token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, group_chat: { chat_id: "wr-chat-1" } }),
      jsonResponse({ errcode: 0, userid: "member-8" }),
    ]);
    const provider = client(env, fetcher);

    await expect(provider.companyJsApiTicket()).resolves.toBe("company-ticket");
    await expect(provider.agentJsApiTicket()).resolves.toBe("agent-ticket");
    await expect(provider.directoryMember("member-7")).resolves.toMatchObject({ userid: "member-7" });
    await expect(provider.externalGroupChat("wr-chat-1")).resolves.toHaveProperty("group_chat");
    await expect(provider.directoryMember("member-8")).resolves.toMatchObject({ userid: "member-8" });

    const tokenCalls = calls.filter((call) => call.url.pathname === "/cgi-bin/gettoken");
    expect(tokenCalls.map((call) => call.url.searchParams.get("corpsecret")))
      .toEqual(["company-secret", "agent-secret", "directory-secret", "external-secret"]);
    expect(calls.at(-2)?.init?.method).toBe("POST");
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(JSON.parse(String(calls.at(-2)?.init?.body))).toEqual({
      chat_id: "wr-chat-1",
      need_name: 0,
    });
    expect(calls.at(-1)?.url.searchParams.get("access_token")).toBe("directory-token");
    expect(kv.writes.filter((write) => write.key.includes(":access:"))).toHaveLength(4);
    expect(kv.writes.every((write) => write.expirationTtl === 6900)).toBe(true);
    const persisted = `${[...kv.values.keys()].join("\n")}\n${[...kv.values.values()].join("\n")}`;
    for (const secret of ["company-secret", "agent-secret", "directory-secret", "external-secret"]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it("coalesces concurrent access-token cache misses within one client", async () => {
    const { env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "shared-token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, userid: "member-a" }),
      jsonResponse({ errcode: 0, userid: "member-b" }),
    ]);
    const provider = client(env, fetcher);
    const [first, second] = await Promise.all([
      provider.directoryMember("member-a"),
      provider.directoryMember("member-b"),
    ]);
    expect([first.userid, second.userid].sort()).toEqual(["member-a", "member-b"]);
    expect(calls.filter((call) => call.url.pathname === "/cgi-bin/gettoken")).toHaveLength(1);
  });

  it("broadcasts metadata-only token failures to followers across client instances", async () => {
    const { env } = fixture();
    let cacheReads = 0;
    let releaseCacheMisses!: () => void;
    const cacheMissGate = new Promise<void>((resolve) => {
      releaseCacheMisses = resolve;
    });
    const originalKv = env.CONFIG_KV;
    env.CONFIG_KV = {
      ...originalKv,
      async get() {
        cacheReads += 1;
        if (cacheReads === 2) releaseCacheMisses();
        await cacheMissGate;
        return null;
      },
    } as unknown as KVNamespace;
    let tokenRequests = 0;
    let markTokenRequestStarted!: () => void;
    const tokenRequestStarted = new Promise<void>((resolve) => {
      markTokenRequestStarted = resolve;
    });
    let releaseTokenRequest!: () => void;
    const tokenRequestGate = new Promise<void>((resolve) => {
      releaseTokenRequest = resolve;
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname !== "/cgi-bin/gettoken") throw new Error("unexpected provider request");
      tokenRequests += 1;
      markTokenRequestStarted();
      await tokenRequestGate;
      return jsonResponse({ errcode: -1 }, {
        status: 503,
        headers: { "Retry-After": "17" },
      });
    }) as typeof fetch;

    const firstFailure = providerFailure(client(env, fetcher).directoryMember("member-a"));
    const secondFailure = providerFailure(client(env, fetcher).directoryMember("member-b"));
    await tokenRequestStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseTokenRequest();
    const [first, second] = await Promise.all([firstFailure, secondFailure]);

    expect(cacheReads).toBe(2);
    expect(tokenRequests).toBe(1);
    const expected = {
      kind: "retryable",
      operation: "directory_access_token",
      providerCode: -1,
      httpStatus: 503,
      retryAfterSeconds: 17,
    };
    expect(first).toMatchObject(expected);
    expect(second).toMatchObject(expected);
    expect(second).not.toBe(first);
  });

  it("coalesces concurrent invalid-token refreshes across client instances", async () => {
    const { kv, env } = fixture();
    let warming = true;
    let tokenRequests = 0;
    let invalidResponses = 0;
    let releaseInvalidResponses!: () => void;
    const invalidResponseGate = new Promise<void>((resolve) => {
      releaseInvalidResponses = resolve;
    });
    let synchronizeRefreshReads = false;
    let refreshReads = 0;
    let markRefreshReadStarted!: () => void;
    const refreshReadStarted = new Promise<void>((resolve) => {
      markRefreshReadStarted = resolve;
    });
    let releaseRefreshReads!: () => void;
    const refreshReadGate = new Promise<void>((resolve) => {
      releaseRefreshReads = resolve;
    });
    const originalKv = env.CONFIG_KV;
    env.CONFIG_KV = {
      ...originalKv,
      async get(key: string, type?: string) {
        const captured = kv.values.get(key) ?? null;
        if (synchronizeRefreshReads && captured?.includes("old-token")) {
          refreshReads += 1;
          markRefreshReadStarted();
          await refreshReadGate;
        }
        return captured !== null && type === "json" ? JSON.parse(captured) : captured;
      },
    } as unknown as KVNamespace;
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/cgi-bin/gettoken") {
        tokenRequests += 1;
        return jsonResponse({
          errcode: 0,
          access_token: warming ? "old-token" : "new-token",
          expires_in: 7200,
        });
      }
      if (url.searchParams.get("access_token") === "old-token") {
        if (warming) {
          return jsonResponse({ errcode: 0, userid: url.searchParams.get("userid") });
        }
        invalidResponses += 1;
        if (invalidResponses === 2) {
          synchronizeRefreshReads = true;
          releaseInvalidResponses();
        }
        await invalidResponseGate;
        return jsonResponse({ errcode: 40014 });
      }
      return jsonResponse({ errcode: 0, userid: url.searchParams.get("userid") });
    }) as typeof fetch;
    await expect(client(env, fetcher).directoryMember("warm-member"))
      .resolves.toMatchObject({ userid: "warm-member" });
    warming = false;
    tokenRequests = 0;
    kv.deletes.length = 0;
    calls.length = 0;
    const firstProvider = client(env, fetcher);
    const secondProvider = client(env, fetcher);

    const results = Promise.all([
      firstProvider.directoryMember("member-a"),
      secondProvider.directoryMember("member-b"),
    ]);
    await refreshReadStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshReads).toBe(1);
    releaseRefreshReads();
    const [first, second] = await results;

    expect([first.userid, second.userid].sort()).toEqual(["member-a", "member-b"]);
    expect(tokenRequests).toBe(1);
    expect(kv.deletes).toHaveLength(1);
    expect(refreshReads).toBe(1);
    expect(calls.filter((url) => url.pathname === "/cgi-bin/user/get")).toHaveLength(4);
  });

  it("treats malformed successful credential and ticket envelopes as retryable", async () => {
    const tokenFixture = fixture();
    const tokenFetch = queuedFetcher([
      jsonResponse({ errcode: 0, expires_in: 7200 }),
    ]).fetcher;
    expect(await providerFailure(client(tokenFixture.env, tokenFetch).directoryMember("member-7")))
      .toMatchObject({ kind: "retryable", providerCode: -2, httpStatus: 200 });

    const ticketFixture = fixture();
    const ticketFetch = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      jsonResponse({ errcode: 0, expires_in: 7200 }),
    ]).fetcher;
    expect(await providerFailure(client(ticketFixture.env, ticketFetch).companyJsApiTicket()))
      .toMatchObject({ kind: "retryable", providerCode: -2, httpStatus: 200 });
  });

  it("refreshes an invalid token exactly once and then classifies it as configuration", async () => {
    const { kv, env } = fixture();
    const { calls, fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "old-token", expires_in: 7200 }),
      jsonResponse({ errcode: 40014, errmsg: "old-token echoed here" }),
      jsonResponse({ errcode: 0, access_token: "fresh-token", expires_in: 7200 }),
      jsonResponse({ errcode: 42001, errmsg: "fresh-token echoed here" }),
    ]);
    const error = await providerFailure(client(env, fetcher).directoryMember("sensitive-member"));
    expect(error).toMatchObject({
      kind: "configuration",
      operation: "directory_member_get",
      providerCode: 42001,
      httpStatus: 200,
    });
    expect(calls).toHaveLength(4);
    expect(kv.deletes).toHaveLength(1);
    expect(JSON.stringify(error)).not.toMatch(/old-token|fresh-token|sensitive-member|echoed/);
  });

  it("keeps bare 404 terminal and classifies rate/server/provider-busy failures as retryable", async () => {
    const cases: Array<{
      response: Response;
      expected: Partial<EnterpriseWechatProviderError>;
    }> = [
      {
        response: new Response("", { status: 404 }),
        expected: { kind: "terminal", httpStatus: 404 },
      },
      {
        response: jsonResponse({ errcode: 45009 }, {
          status: 429,
          headers: { "Retry-After": "99999" },
        }),
        expected: { kind: "retryable", httpStatus: 429, retryAfterSeconds: 900 },
      },
      {
        response: new Response("upstream unavailable", { status: 503 }),
        expected: { kind: "retryable", httpStatus: 503 },
      },
      {
        response: jsonResponse({ errcode: -1 }),
        expected: { kind: "retryable", providerCode: -1 },
      },
    ];
    for (const current of cases) {
      const { env } = fixture();
      const { fetcher } = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
        current.response,
      ]);
      const error = await providerFailure(client(env, fetcher).directoryMember("member-7"));
      expect(error).toMatchObject(current.expected);
    }
  });

  it("maps HTTP 200 provider not-found codes only for their read operation", async () => {
    const cases: Array<{
      code: number;
      call(provider: EnterpriseWechatProviderClient): Promise<unknown>;
    }> = [
      { code: 60_111, call: (provider) => provider.directoryMember("member-7") },
      { code: 60_003, call: (provider) => provider.directoryDepartment(7) },
      { code: 60_123, call: (provider) => provider.directoryDepartments(7) },
      { code: 84_061, call: (provider) => provider.externalContact("wo-contact-7") },
      { code: 40_096, call: (provider) => provider.externalContact("wo-contact-8") },
      { code: 40_050, call: (provider) => provider.externalGroupChat("wr-chat-7") },
      { code: 86_003, call: (provider) => provider.externalGroupChat("wr-chat-8") },
      { code: 40_068, call: (provider) => provider.corpTagList(["et-tag-7"]) },
    ];
    for (const current of cases) {
      const { env } = fixture();
      const { fetcher } = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
        jsonResponse({ errcode: current.code }),
      ]);
      const error = await providerFailure(current.call(client(env, fetcher)));
      expect(error).toMatchObject({
        kind: "not_found",
        httpStatus: 200,
        providerCode: current.code,
      });
    }

    const { env } = fixture();
    const { fetcher } = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      jsonResponse({ errcode: 60_111 }),
    ]);
    expect((await providerFailure(client(env, fetcher).externalContact("wo-contact-9"))).kind)
      .toBe("terminal");

    const unfilteredFixture = fixture();
    const unfilteredFetch = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      jsonResponse({ errcode: 40_068 }),
    ]).fetcher;
    expect((await providerFailure(
      client(unfilteredFixture.env, unfilteredFetch).corpTagList(),
    )).kind).toBe("terminal");
  });

  it("does not refresh a token when an HTTP failure body contains an invalid-token code", async () => {
    const cases = [
      {
        response: jsonResponse({ errcode: 40014 }, {
          status: 429,
          headers: { "Retry-After": "17" },
        }),
        expected: { kind: "retryable", httpStatus: 429, retryAfterSeconds: 17 },
      },
      {
        response: jsonResponse({ errcode: 42001 }, { status: 404 }),
        expected: { kind: "configuration", httpStatus: 404 },
      },
    ] as const;
    for (const current of cases) {
      const { kv, env } = fixture();
      const { calls, fetcher } = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
        current.response,
      ]);
      const error = await providerFailure(client(env, fetcher).directoryMember("member-7"));
      expect(error).toMatchObject(current.expected);
      expect(calls).toHaveLength(2);
      expect(kv.deletes).toHaveLength(0);
    }
  });

  it("does not let provider not-found codes override retryable HTTP statuses", async () => {
    const cases: Array<{
      response: Response;
      call(provider: EnterpriseWechatProviderClient): Promise<unknown>;
      expected: Partial<EnterpriseWechatProviderError>;
    }> = [
      {
        response: jsonResponse({ errcode: 60_111 }, {
          status: 429,
          headers: { "Retry-After": "23" },
        }),
        call: (provider) => provider.directoryMember("member-7"),
        expected: {
          kind: "retryable",
          providerCode: 60_111,
          httpStatus: 429,
          retryAfterSeconds: 23,
        },
      },
      {
        response: jsonResponse({ errcode: 84_061 }, { status: 500 }),
        call: (provider) => provider.externalContact("wo-contact-7"),
        expected: { kind: "retryable", providerCode: 84_061, httpStatus: 500 },
      },
    ];
    for (const current of cases) {
      const { kv, env } = fixture();
      const { calls, fetcher } = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
        current.response,
      ]);
      expect(await providerFailure(current.call(client(env, fetcher))))
        .toMatchObject(current.expected);
      expect(calls).toHaveLength(2);
      expect(kv.deletes).toHaveLength(0);
    }
  });

  it("keeps ordinary 4xx and unknown provider codes terminal", async () => {
    for (const response of [
      new Response("", { status: 400 }),
      jsonResponse({ errcode: 60123, errmsg: "business id member-secret" }),
    ]) {
      const { env } = fixture();
      const { fetcher } = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token-secret", expires_in: 7200 }),
        response,
      ]);
      const error = await providerFailure(client(env, fetcher).directoryMember("member-secret"));
      expect(error.kind).toBe("terminal");
      expect(JSON.stringify(error)).not.toMatch(/token-secret|member-secret|business id/);
    }
  });

  it("treats network errors, timeouts, malformed UTF-8 and oversized 2xx as retryable", async () => {
    for (const malformedSuccess of [{}, { errcode: null }, { errcode: "0" }]) {
      const missingCodeFixture = fixture();
      const missingCodeFetch = queuedFetcher([
        jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
        jsonResponse(malformedSuccess),
      ]).fetcher;
      const error = await providerFailure(
        client(missingCodeFixture.env, missingCodeFetch).directoryMember("member-7"),
      );
      expect(error).toMatchObject({
        kind: "retryable",
        httpStatus: 200,
        providerCode: -2,
      });
    }

    const networkFixture = fixture();
    const networkFetch = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      new Error("network included a secret"),
    ]).fetcher;
    expect((await providerFailure(
      client(networkFixture.env, networkFetch).directoryMember("member-7"),
    )).kind).toBe("retryable");

    const invalidFixture = fixture();
    const invalidFetch = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125])),
    ]).fetcher;
    expect((await providerFailure(
      client(invalidFixture.env, invalidFetch).directoryMember("member-7"),
    )).kind).toBe("retryable");

    const oversizedFixture = fixture();
    const oversizedFetch = queuedFetcher([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      new Response("{}", { headers: { "Content-Length": String(256 * 1024 + 1) } }),
    ]).fetcher;
    expect((await providerFailure(
      client(oversizedFixture.env, oversizedFetch).directoryMember("member-7"),
    )).kind).toBe("retryable");

    vi.useFakeTimers();
    const timeoutFixture = fixture();
    let requestCount = 0;
    const hangingFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
            once: true,
          });
        },
      }));
    }) as typeof fetch;
    const result = providerFailure(
      client(timeoutFixture.env, hangingFetch).directoryMember("member-7"),
    );
    await vi.waitFor(() => expect(hangingFetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).kind).toBe("retryable");
  });

  it("fails closed before I/O for missing scoped secrets and enforces the 18-byte CorpID contract", async () => {
    expect(isEnterpriseWechatCorpId("ww0123456789abcdef")).toBe(true);
    expect(isEnterpriseWechatCorpId("x".repeat(19))).toBe(false);
    const { env } = fixture({ WECHAT_WORK_DIRECTORY_SECRET: undefined });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const error = await providerFailure(client(env, fetcher).directoryMember("member-7"));
    expect(error.kind).toBe("configuration");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => new EnterpriseWechatProviderClient(env, {
      corpId: "x".repeat(19),
      agentId: 1,
    }, fetcher)).toThrow(EnterpriseWechatProviderError);
  });

  it("keeps credentials absent from versioned Wrangler vars and exposes no arbitrary URL request API", () => {
    const source = readFileSync("src/services/work/EnterpriseWechatProviderClient.ts", "utf8");
    const wrangler = readFileSync("wrangler.toml", "utf8");
    expect(source).toContain('const PROVIDER_ORIGIN = "https://qyapi.weixin.qq.com"');
    expect(source).not.toMatch(/console\.(?:log|error|warn)/);
    expect(source).not.toContain("errmsg");
    expect(wrangler).not.toMatch(/^WECHAT_WORK_(?:CORP|AGENT|DIRECTORY|EXTERNAL_CONTACT)_SECRET\s*=/m);
    expect(wrangler).toMatch(/\[observability\.traces\]\s+enabled\s*=\s*false/m);
  });
});
