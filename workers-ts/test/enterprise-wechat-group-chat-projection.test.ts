import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WorkCallbackPayload } from "../src/models/schema";
import {
  groupChatProjectionIdentity,
  isGroupChatProjectionEvent,
  parseEnterpriseWechatGroupChatSnapshot,
  prepareGroupChatProjection,
  type GroupChatProjectionClaim,
} from "../src/services/work/EnterpriseWechatGroupChatProjection";
import { compareGroupChatProjectionFence } from "../src/services/work/EnterpriseWechatGroupChatCurrentService";
import { EnterpriseWechatProviderError } from "../src/services/work/EnterpriseWechatProviderClient";

function member(
  userid: string,
  type: 1 | 2,
  overrides: Record<string, unknown> = {},
) {
  return {
    userid,
    type,
    ...(type === 2 ? { unionid: `union-${userid}` } : {}),
    join_time: 1_788_048_000,
    join_scene: 1,
    invitor: { userid: "Owner-A" },
    group_nickname: `${userid} nickname`,
    name: `${userid} name`,
    state: "channel-state",
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    errcode: 0,
    errmsg: "ok",
    group_chat: {
      chat_id: "wr-chat-1",
      name: "Customer Group",
      owner: "Owner-A",
      create_time: 1_788_000_000,
      notice: "Line one\nLine two",
      admin_list: [{ userid: "Admin-B" }],
      member_list: [
        member("external-c", 2),
        member("Owner-A", 1),
        member("Admin-B", 1),
      ],
      status: 0,
      ...overrides,
    },
  };
}

function claim(
  changeType: "create" | "update" | "dismiss",
  payload: WorkCallbackPayload = { ChatId: "wr-chat-1" },
): GroupChatProjectionClaim {
  return {
    eventId: 61,
    eventKey: "a".repeat(64),
    subjectKeyHash: "b".repeat(64),
    eventTime: 1_788_048_000,
    sequenceRank: changeType === "dismiss" ? 100 : changeType === "update" ? 50 : 10,
    corpId: "ww-group-test",
    msgType: "event",
    eventType: "change_external_chat",
    changeType,
    payload,
  };
}

describe("Enterprise WeChat group-chat projection", () => {
  it("parses a complete group/member snapshot and canonicalizes employee identities", () => {
    const snapshot = parseEnterpriseWechatGroupChatSnapshot(response(), "wr-chat-1");
    expect(snapshot).toMatchObject({
      chatId: "wr-chat-1",
      owner: "owner-a",
      notice: "Line one\nLine two",
      adminList: ["admin-b"],
      providerStatus: 0,
    });
    expect(snapshot.members.map((item) => [item.userid, item.type])).toEqual([
      ["admin-b", 1],
      ["external-c", 2],
      ["owner-a", 1],
    ]);
  });

  it("rejects duplicate identities, missing owner/admin members, oversize lists, and identity drift", () => {
    expect(() => parseEnterpriseWechatGroupChatSnapshot(response({
      member_list: [member("Owner-A", 1), member("owner-a", 1)],
      admin_list: [],
    }), "wr-chat-1")).toThrow("callback_group_chat_snapshot_invalid");
    expect(() => parseEnterpriseWechatGroupChatSnapshot(response({
      owner: "missing-owner",
    }), "wr-chat-1")).toThrow("callback_group_chat_snapshot_invalid");
    expect(() => parseEnterpriseWechatGroupChatSnapshot(response({
      admin_list: [{ userid: "external-c" }],
    }), "wr-chat-1")).toThrow("callback_group_chat_snapshot_invalid");
    expect(() => parseEnterpriseWechatGroupChatSnapshot(response({
      member_list: Array.from({ length: 2_001 }, (_, index) => member(`member-${index}`, 1)),
      admin_list: [],
      owner: "member-0",
    }), "wr-chat-1")).toThrow("callback_group_chat_snapshot_invalid");
    expect(() => parseEnterpriseWechatGroupChatSnapshot(response({
      chat_id: "wr-chat-other",
    }), "wr-chat-1")).toThrow("callback_group_chat_snapshot_invalid");
  });

  it("classifies a structurally incomplete response as retryable refresh-only", async () => {
    const incomplete = response();
    delete (incomplete.group_chat as Record<string, unknown>).member_list;
    await expect(prepareGroupChatProjection(claim("update"), {
      externalGroupChat: vi.fn().mockResolvedValue(incomplete),
    })).resolves.toEqual({
      kind: "incomplete",
      chatId: "wr-chat-1",
      source: "provider_scope_incomplete",
    });
  });

  it("never constructs or invokes a provider for callback-authoritative dismissal", async () => {
    const externalGroupChat = vi.fn();
    await expect(prepareGroupChatProjection(claim("dismiss"), { externalGroupChat }))
      .resolves.toEqual({
        kind: "absent",
        chatId: "wr-chat-1",
        source: "dismiss_callback",
      });
    await expect(prepareGroupChatProjection(claim("dismiss")))
      .resolves.toMatchObject({ kind: "absent" });
    expect(externalGroupChat).not.toHaveBeenCalled();
  });

  it("keeps provider not-found refresh-only and propagates other provider failures", async () => {
    const notFound = new EnterpriseWechatProviderError(
      "not_found",
      "external_group_chat_get",
      40_050,
      200,
    );
    await expect(prepareGroupChatProjection(claim("update"), {
      externalGroupChat: vi.fn().mockRejectedValue(notFound),
    })).resolves.toEqual({
      kind: "not_found",
      chatId: "wr-chat-1",
      source: "provider_not_found",
    });

    for (const kind of ["retryable", "configuration", "terminal"] as const) {
      const failure = new EnterpriseWechatProviderError(
        kind,
        "external_group_chat_get",
        kind === "retryable" ? 45_009 : 48_002,
        kind === "retryable" ? 429 : 200,
      );
      await expect(prepareGroupChatProjection(claim("create"), {
        externalGroupChat: vi.fn().mockRejectedValue(failure),
      })).rejects.toBe(failure);
    }
  });

  it("recognizes exactly three variants and makes dismissal dominate later non-terminal events", () => {
    for (const changeType of ["create", "update", "dismiss"] as const) {
      expect(isGroupChatProjectionEvent(claim(changeType))).toBe(true);
      expect(groupChatProjectionIdentity(claim(changeType))).toBe("wr-chat-1");
    }
    expect(isGroupChatProjectionEvent({
      msgType: "event",
      eventType: "change_external_contact",
      changeType: "update",
    })).toBe(false);
    expect(() => groupChatProjectionIdentity(claim("create", { ChatId: " wr-chat-1 " })))
      .toThrow("callback_projection_field_invalid");
    expect(compareGroupChatProjectionFence(
      { eventTime: 100, sequenceRank: 100, eventId: 1 },
      { eventTime: 200, sequenceRank: 50, eventId: 2 },
    )).toBeGreaterThan(0);
  });

  it("keeps the three-table, tombstone, visibility-gate, and callback contracts wired", () => {
    const schema = readFileSync("src/models/schema/work_group_chat_current.ts", "utf8");
    const current = readFileSync(
      "src/services/work/EnterpriseWechatGroupChatCurrentService.ts",
      "utf8",
    );
    const callback = readFileSync(
      "src/services/work/EnterpriseWechatCallbackService.ts",
      "utf8",
    );
    const context = readFileSync(
      "src/services/work/EnterpriseWechatContextService.ts",
      "utf8",
    );
    const catalog = readFileSync(
      "src/services/work/EnterpriseWechatCatalogService.ts",
      "utf8",
    );
    expect((schema.match(/pgTable\(/g) ?? [])).toHaveLength(3);
    expect(schema).toContain('"work_group_chat_projection_fence"');
    expect(schema).toContain('"work_group_chat_member_current"');
    expect(current).toContain('lifecycleState: "LEFT"');
    expect(current).toContain('lifecycleState: "DISMISSED"');
    expect(current).not.toContain("delete(workGroupChatMemberCurrent)");
    expect(callback).toContain("WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY");
    expect(callback).toContain("externalGroupChatProvider");
    expect(callback).toContain("Group dismissal is terminal");
    expect(context).toContain("requireGroupScopeByIdInTx(tx, claims)");
    expect(context).toContain("this.loadGroupClientProjections(scope.corpId, scope.actorUserid, externalIds, tx)");
    expect(context).toContain("userid: workMemberCurrent.userid");
    expect(context).toContain('groupProjectionSource: scope.source');
    expect(catalog).toContain("group_chat_current_authority_disabled");
    expect(catalog).toContain("group_event.event_type = 'change_external_chat'");
    expect(catalog).toContain("member_event.event_type = 'change_external_chat'");
  });
});
