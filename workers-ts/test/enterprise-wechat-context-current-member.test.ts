import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { EnterpriseWechatContextService } from "@/services/work/EnterpriseWechatContextService";
import { ForbiddenException, ServiceUnavailableException } from "@/utils/errors";

type QueryRows = ReadonlyArray<Record<string, unknown>>;

function databaseFixture(...results: QueryRows[]) {
  const pending = [...results];
  const select = vi.fn(() => {
    const rows = pending.shift();
    if (!rows) throw new Error("Unexpected SELECT");
    const builder = {
      from: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => rows),
    };
    builder.from.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    return builder;
  });
  const db = {
    select,
    execute: vi.fn(async () => []),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  const container = { db } as unknown as Container;
  const service = new EnterpriseWechatContextService(container, {
    WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
  } as Env, {
    stateStore: {
      putOnce: vi.fn(async () => true),
      take: vi.fn(async () => null),
    },
    identityProvider: {
      employeeIdentity: vi.fn(async () => ({
        corpId: "ww0123456789abcdef",
        agentId: 1,
        userid: "alice",
      })),
    },
  });
  return { service, select, pending };
}

function activeAlias(overrides: Record<string, unknown> = {}) {
  return {
    aliasUserid: "alice",
    aliasMemberId: 41,
    aliasCanonicalUserid: "alice",
    aliasLifecycleState: "ACTIVE",
    aliasLastEventId: 9,
    aliasLastEventKey: "a".repeat(64),
    aliasLastEventSubjectKeyHash: "b".repeat(64),
    aliasLastEventTime: 1_700_000_000,
    aliasLastSequenceRank: 20,
    currentId: 41,
    currentUserid: "alice",
    currentCanonicalUserid: "alice",
    currentLifecycleState: "ACTIVE",
    currentStatus: 1,
    currentEnable: 1,
    currentLastEventId: 9,
    currentLastEventKey: "a".repeat(64),
    currentLastEventSubjectKeyHash: "b".repeat(64),
    currentLastEventTime: 1_700_000_000,
    currentLastSequenceRank: 20,
    ...overrides,
  };
}

async function requireActor(
  service: EnterpriseWechatContextService,
  userid = "Alice",
): Promise<void> {
  return (service as unknown as {
    requireActor(corpId: string, actorUserid: string): Promise<void>;
  }).requireActor("ww0123456789abcdef", userid);
}

describe("Enterprise WeChat current-member context authorization", () => {
  it("authorizes a case-normalized ACTIVE alias and ACTIVE current member", async () => {
    const fixture = databaseFixture([activeAlias()], [{ id: 41 }]);

    await expect(requireActor(fixture.service, "  ALICE  ")).resolves.toBeUndefined();

    expect(fixture.select).toHaveBeenCalledTimes(2);
    expect(fixture.pending).toHaveLength(0);
  });

  it.each([
    ["DELETED alias", activeAlias({
      aliasLifecycleState: "DELETED",
      currentLifecycleState: "DELETED",
      currentStatus: 5,
      currentEnable: 0,
    }), [{ id: 41 }]],
    ["RENAMED alias", activeAlias({
      aliasCanonicalUserid: "bob",
      aliasLifecycleState: "RENAMED",
      currentUserid: "bob",
      currentCanonicalUserid: "bob",
    }), []],
    ["UNRESOLVED alias", activeAlias({
      aliasMemberId: null,
      aliasLifecycleState: "UNRESOLVED",
      currentId: null,
      currentUserid: null,
      currentCanonicalUserid: null,
      currentLifecycleState: null,
      currentStatus: null,
      currentEnable: null,
    }), []],
    ["disabled current member", activeAlias({ currentStatus: 2, currentEnable: 0 }), [{ id: 41 }]],
    ["latest-seen event not yet applied", activeAlias({
      aliasLastEventId: 10,
      aliasLastEventTime: 1_700_000_001,
    }), [{ id: 41 }]],
  ])("blocks %s without consulting stale legacy membership", async (_label, alias, current) => {
    const fixture = databaseFixture([alias], current);

    await expect(requireActor(fixture.service)).rejects.toBeInstanceOf(ForbiddenException);

    expect(fixture.select).toHaveBeenCalledTimes(2);
    expect(fixture.pending).toHaveLength(0);
  });

  it("fails closed when a current identity exists without its alias", async () => {
    const fixture = databaseFixture([], [{ id: 41 }]);

    await expect(requireActor(fixture.service)).rejects.toBeInstanceOf(ForbiddenException);

    expect(fixture.select).toHaveBeenCalledTimes(2);
  });

  it("uses legacy membership only when both current identity sources are absent", async () => {
    const fixture = databaseFixture([], [], [{ id: 7 }]);

    await expect(requireActor(fixture.service, "Alice")).resolves.toBeUndefined();

    expect(fixture.select).toHaveBeenCalledTimes(3);
    expect(fixture.pending).toHaveLength(0);
  });

  it("fails closed when the case-insensitive legacy identity is duplicated", async () => {
    const fixture = databaseFixture([], [], [{ id: 7 }, { id: 8 }]);

    await expect(requireActor(fixture.service)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(fixture.select).toHaveBeenCalledTimes(3);
  });

  it("keeps indexed current lookups exact and makes only the legacy fallback case-insensitive", () => {
    const source = readFileSync(
      "src/services/work/EnterpriseWechatContextService.ts",
      "utf8",
    );
    expect(source).toContain("const normalizedUserid = actorUserid.trim().toLowerCase()");
    expect(source).toContain("eq(workMemberIdentityAlias.userid, normalizedUserid)");
    expect(source).toContain("eq(workMemberCurrent.userid, normalizedUserid)");
    expect(source).toContain("sql`lower(${workMember.userid}) = ${normalizedUserid}`");
    expect(source).toContain("work-member:${corpId}:${normalizedUserid}");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("WECHAT_WORK_MEMBER_CURRENT_AUTHORITY");
    expect(source).toContain('=== "verified"');
  });
});
