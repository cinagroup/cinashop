import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env, WorkContactActionMessage } from "@/env";
import { MigrationService } from "@/services/MigrationService";
import {
  consumeWorkContactActionMessage,
  isWorkContactActionDispatchMessage,
  isWorkContactActionMessage,
} from "@/services/work/EnterpriseWechatContactActionService";
import {
  EnterpriseWechatProviderClient,
  EnterpriseWechatProviderError,
} from "@/services/work/EnterpriseWechatProviderClient";

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value !== null && type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}

function jsonResponse(body: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function provider(responses: Array<Response | Error>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected_provider_call");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const env = {
    CONFIG_KV: memoryKv(),
    WECHAT_WORK_EXTERNAL_CONTACT_SECRET: "external-secret",
  } as Env;
  return {
    calls,
    client: new EnterpriseWechatProviderClient(env, {
      corpId: "ww-contact-action",
    }, fetcher),
  };
}

async function failure(promise: Promise<unknown>): Promise<EnterpriseWechatProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnterpriseWechatProviderError);
    return error as EnterpriseWechatProviderError;
  }
  throw new Error("expected_provider_failure");
}

describe("Enterprise WeChat contact action outbox", () => {
  it("keeps external and embedded 0118 DDL byte equivalent", () => {
    const external = readFileSync("migrations/0118_work_contact_action_outbox.sql", "utf8");
    expect(new MigrationService({} as never).workContactActionOutboxMigrationSqlForVerification())
      .toBe(external);
    expect(external).toContain("work_contact_action_outbox");
    expect(external).toContain("work_contact_action_audit");
    expect(external).toContain("'UNKNOWN'");
    expect(external).toContain("wcao_guard_immutable_0118");
    expect(external).toContain("wcaa_guard_immutable_0118");
    expect(external).toContain("payload_redacted_time");
  });

  it("accepts only reference-only action and dispatch Queue messages", () => {
    expect(isWorkContactActionMessage({
      action: "processWorkContactAction",
      actionId: 7,
      actionKey: "a".repeat(64),
    })).toBe(true);
    expect(isWorkContactActionMessage({
      action: "processWorkContactAction",
      actionId: 7,
      actionKey: "a".repeat(64),
      welcomeCode: "must-not-leave-postgresql",
    })).toBe(false);
    expect(isWorkContactActionDispatchMessage({
      action: "dispatchWorkContactActions",
      scheduledAt: 1_788_048_000,
    })).toBe(true);
    expect(isWorkContactActionDispatchMessage({
      action: "dispatchWorkContactActions",
      scheduledAt: 0,
    })).toBe(false);
  });

  it("sends welcome and tag requests with exact provider payloads", async () => {
    const welcome = provider([
      jsonResponse({ errcode: 0, access_token: "token", expires_in: 7200 }),
      jsonResponse({ errcode: 0 }),
      jsonResponse({ errcode: 0 }),
    ]);
    await expect(welcome.client.sendWelcome("welcome-code-1", {
      text: { content: "hello" },
      attachments: [],
    })).resolves.toBeUndefined();
    await expect(welcome.client.markExternalContactTags(
      "employee-1",
      "external-1",
      ["tag-1", "tag-2"],
    )).resolves.toBeUndefined();
    const actionCalls = welcome.calls.filter((call) =>
      call.url.pathname !== "/cgi-bin/gettoken");
    expect(actionCalls.map((call) => call.url.pathname)).toEqual([
      "/cgi-bin/externalcontact/send_welcome_msg",
      "/cgi-bin/externalcontact/mark_tag",
    ]);
    expect(JSON.parse(String(actionCalls[0].init?.body))).toEqual({
      welcome_code: "welcome-code-1",
      text: { content: "hello" },
      attachments: [],
    });
    expect(JSON.parse(String(actionCalls[1].init?.body))).toEqual({
      userid: "employee-1",
      external_userid: "external-1",
      add_tag: ["tag-1", "tag-2"],
      remove_tag: [],
    });
  });

  it("classifies write transport ambiguity, used welcome codes, and explicit 429", async () => {
    const transport = provider([
      jsonResponse({ errcode: 0, access_token: "token-a", expires_in: 7200 }),
      new Error("network_lost_after_send"),
    ]);
    expect(await failure(transport.client.sendWelcome("welcome-code-2", {
      text: { content: "hello" },
    }))).toMatchObject({ kind: "unknown", operation: "external_contact_send_welcome" });

    const used = provider([
      jsonResponse({ errcode: 0, access_token: "token-b", expires_in: 7200 }),
      jsonResponse({ errcode: 41_051 }),
    ]);
    expect(await failure(used.client.sendWelcome("welcome-code-3", {
      text: { content: "hello" },
    }))).toMatchObject({ kind: "unknown", providerCode: 41_051 });

    const rateLimited = provider([
      jsonResponse({ errcode: 0, access_token: "token-c", expires_in: 7200 }),
      jsonResponse({ errcode: 45_009 }, {
        status: 429,
        headers: { "Retry-After": "17" },
      }),
    ]);
    expect(await failure(rateLimited.client.markExternalContactTags(
      "employee-1",
      "external-1",
      ["tag-1"],
    ))).toMatchObject({ kind: "retryable", providerCode: 45_009, retryAfterSeconds: 17 });
  });

  it("couples Queue acknowledgement to terminal/deferred outcomes", async () => {
    const body: WorkContactActionMessage = {
      action: "processWorkContactAction",
      actionId: 9,
      actionKey: "b".repeat(64),
    };
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeWorkContactActionMessage({ body, attempts: 1, ack, retry }, {
      processMessage: vi.fn().mockResolvedValue("succeeded"),
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    ack.mockClear();
    await consumeWorkContactActionMessage({ body, attempts: 2, ack, retry }, {
      processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 47 }),
    });
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenLastCalledWith({ delaySeconds: 47 });
  });

  it("keeps C8 side effects behind a dedicated release gate", () => {
    const callback = readFileSync(
      "src/services/work/EnterpriseWechatCallbackService.ts",
      "utf8",
    );
    const action = readFileSync(
      "src/services/work/EnterpriseWechatContactActionService.ts",
      "utf8",
    );
    expect(callback).toContain("CONTACT_ACTION_DISABLED");
    expect(callback).toContain("enqueueProjectedClientActions");
    expect(action).toContain("WECHAT_WORK_CONTACT_ACTION_AUTHORITY");
    expect(action).toContain("welcome_code_expired_before_enqueue");
    expect(action).toContain("contact_action_provider_lease_expired");
    expect(action).toContain("client_unionid_ambiguous");
    expect(action).toContain("欢迎码为单次凭据，UNKNOWN/DEAD 不允许重发");
  });
});
