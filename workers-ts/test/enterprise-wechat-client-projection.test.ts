import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Container } from "../src/lib/di";
import type { WorkCallbackPayload } from "../src/models/schema";
import { EnterpriseWechatCatalogService } from "../src/services/work/EnterpriseWechatCatalogService";
import {
  clientProjectionIdentity,
  EnterpriseWechatClientProjectionError,
  isClientProjectionEvent,
  parseEnterpriseWechatClientPage,
  prepareClientProjection,
  type ClientProjectionClaim,
} from "../src/services/work/EnterpriseWechatClientProjection";
import { EnterpriseWechatProviderError } from "../src/services/work/EnterpriseWechatProviderClient";

function follow(userid: string, overrides: Record<string, unknown> = {}) {
  return {
    userid,
    remark: "owner remark",
    description: "description",
    createtime: 1_788_048_000,
    remark_corp_name: "Remark Corp",
    remark_mobiles: ["+8613800000000"],
    add_way: 1,
    oper_userid: "Operator-A",
    state: "channel-state",
    tags: [{
      group_name: "Lifecycle",
      tag_name: "VIP",
      type: 1,
      tag_id: "et-tag-1",
    }],
    ...overrides,
  };
}

function response(
  follows: unknown[] = [follow("Owner-A")],
  overrides: Record<string, unknown> = {},
) {
  return {
    errcode: 0,
    errmsg: "ok",
    external_contact: {
      external_userid: "wo-client-1",
      name: "Example Customer",
      avatar: "https://example.test/avatar.png",
      type: 1,
      gender: 2,
      unionid: "union-1",
      position: "Buyer",
      corp_name: "Example",
      corp_full_name: "Example Pte Ltd",
      external_profile: { external_attr: [] },
    },
    follow_user: follows,
    ...overrides,
  };
}

function claim(
  changeType:
    | "add_external_contact"
    | "edit_external_contact"
    | "del_external_contact"
    | "del_follow_user",
  payload: WorkCallbackPayload = {
    ExternalUserID: "wo-client-1",
    UserID: "Owner-A",
  },
): ClientProjectionClaim {
  return {
    eventId: 41,
    eventKey: "a".repeat(64),
    subjectKeyHash: "b".repeat(64),
    eventTime: 1_788_048_000,
    sequenceRank: changeType.startsWith("del_") ? 100 : changeType.startsWith("edit_") ? 50 : 10,
    corpId: "ww-client-test",
    msgType: "event",
    eventType: "change_external_contact",
    changeType,
    payload,
  };
}

describe("Enterprise WeChat client projection", () => {
  it("parses a bounded client page and treats omitted tags as an authoritative empty set", () => {
    const withoutTags = follow("Owner-A");
    delete (withoutTags as Record<string, unknown>).tags;
    const page = parseEnterpriseWechatClientPage(response([withoutTags]), "wo-client-1");
    expect(page.profile).toMatchObject({
      externalUserid: "wo-client-1",
      name: "Example Customer",
      type: 1,
      gender: 2,
    });
    expect(page.follows).toEqual([expect.objectContaining({
      userid: "owner-a",
      operUserid: "operator-a",
      tags: [],
    })]);
  });

  it("exhausts cursor pages, preserves every follow, and keys a personal tag without tag_id", async () => {
    const externalContact = vi.fn()
      .mockResolvedValueOnce(response([follow("Owner-A")], { next_cursor: "cursor-2" }))
      .mockResolvedValueOnce(response([follow("Owner-B", {
        tags: [{ group_name: "Personal", tag_name: "Priority", type: 2 }],
      })]));
    const prepared = await prepareClientProjection(
      claim("add_external_contact"),
      { externalContact },
    );
    expect(externalContact).toHaveBeenNthCalledWith(1, "wo-client-1", undefined);
    expect(externalContact).toHaveBeenNthCalledWith(2, "wo-client-1", "cursor-2");
    expect(prepared).toMatchObject({
      kind: "snapshot",
      callbackUserid: "owner-a",
      snapshot: { follows: [{ userid: "owner-a" }, { userid: "owner-b" }] },
    });
    if (prepared.kind !== "snapshot") throw new Error("snapshot expected");
    expect(prepared.snapshot.follows[1].tags[0]).toMatchObject({
      tagId: null,
      tagName: "Priority",
      type: 2,
      sortOrder: 0,
    });
    expect(prepared.snapshot.follows[1].tags[0].tagKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never constructs or invokes a provider for either callback-authoritative delete", async () => {
    const externalContact = vi.fn();
    for (const changeType of ["del_external_contact", "del_follow_user"] as const) {
      await expect(prepareClientProjection(claim(changeType), { externalContact }))
        .resolves.toEqual({
          kind: "absent",
          externalUserid: "wo-client-1",
          userid: "owner-a",
          source: "delete_callback",
        });
    }
    expect(externalContact).not.toHaveBeenCalled();
  });

  it("requires the provider snapshot to contain the callback relationship and never fabricates it", async () => {
    await expect(prepareClientProjection(claim("edit_external_contact"), {
      externalContact: vi.fn().mockResolvedValue(response([follow("Owner-B")])),
    })).resolves.toEqual({
      kind: "incomplete",
      externalUserid: "wo-client-1",
      callbackUserid: "owner-a",
      source: "provider_scope_incomplete",
    });
  });

  it("classifies cross-page drift and cursor loops as retryable projection drift", async () => {
    const changedProfile = response([follow("Owner-B")], { next_cursor: "" });
    (changedProfile.external_contact as Record<string, unknown>).name = "Changed During Pagination";
    for (const externalContact of [
      vi.fn()
        .mockResolvedValueOnce(response([follow("Owner-A")], { next_cursor: "cursor-2" }))
        .mockResolvedValueOnce(changedProfile),
      vi.fn()
        .mockResolvedValueOnce(response([follow("Owner-A")], { next_cursor: "cursor-2" }))
        .mockResolvedValueOnce(response([follow("Owner-B")], { next_cursor: "cursor-2" })),
    ]) {
      const error = await prepareClientProjection(
        claim("add_external_contact"),
        { externalContact },
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(EnterpriseWechatClientProjectionError);
      expect(error).toMatchObject({
        errorCode: "callback_client_snapshot_drift",
        terminal: false,
      });
    }
  });

  it("keeps provider not-found refresh-only and propagates other provider failures", async () => {
    const notFound = new EnterpriseWechatProviderError(
      "not_found",
      "external_contact_get",
      40_096,
      200,
    );
    await expect(prepareClientProjection(claim("edit_external_contact"), {
      externalContact: vi.fn().mockRejectedValue(notFound),
    })).resolves.toMatchObject({ kind: "not_found", source: "provider_not_found" });

    for (const kind of ["retryable", "configuration", "terminal"] as const) {
      const failure = new EnterpriseWechatProviderError(
        kind,
        "external_contact_get",
        kind === "retryable" ? 45_009 : 48_002,
        kind === "retryable" ? 429 : 200,
      );
      await expect(prepareClientProjection(claim("add_external_contact"), {
        externalContact: vi.fn().mockRejectedValue(failure),
      })).rejects.toBe(failure);
    }
  });

  it("recognizes exactly four variants and normalizes only the member identity", () => {
    for (const changeType of [
      "add_external_contact",
      "edit_external_contact",
      "del_external_contact",
      "del_follow_user",
    ] as const) {
      expect(isClientProjectionEvent(claim(changeType))).toBe(true);
      expect(clientProjectionIdentity(claim(changeType))).toEqual({
        externalUserid: "wo-client-1",
        userid: "owner-a",
      });
    }
    expect(isClientProjectionEvent({
      msgType: "event",
      eventType: "change_external_chat",
      changeType: "create",
    })).toBe(false);
    expect(() => clientProjectionIdentity(claim("add_external_contact", {
      ExternalUserID: "wo-client-1",
      UserID: " owner-a ",
    }))).toThrow("callback_projection_field_invalid");
  });

  it("keeps the five-table fence, fail-closed read, and visibility-gate contracts wired", () => {
    const schema = readFileSync("src/models/schema/work_client_current.ts", "utf8");
    const current = readFileSync(
      "src/services/work/EnterpriseWechatClientCurrentService.ts",
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
    expect((schema.match(/pgTable\(/g) ?? [])).toHaveLength(5);
    expect(schema).toContain('"work_client_projection_fence"');
    expect(schema).toContain('"work_client_follow_projection_fence"');
    expect(schema).toContain('"work_client_follow_tag_current"');
    expect(schema).not.toContain("legacyClientId");
    expect(current).toContain("lockClientProjectionIdentity");
    expect(current).toContain("A snapshot triggered by employee B");
    expect(current).toContain("must not revive A's callback-authoritative tombstone");
    expect(callback).toContain("WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY");
    expect(callback).toContain("WECHAT_WORK_CLIENT_CURRENT_AUTHORITY");
    expect(callback).toContain('clientProjection.kind === "absent" && result !== "superseded"');
    expect(context).toContain("client_projection_source");
    expect(current).toContain("clientProfileFenceEventIdAtFetch");
    expect(current).toContain('projectionError("callback_client_snapshot_drift", false)');
    expect(context).toContain("客户当前投影尚未通过启用验收");
    expect(context).toContain("Promise.resolve(scope.tags)");
    expect(context).toContain("limit(MAX_CURRENT_FOLLOW_TAGS)");
    expect(catalog).toContain("client_current_authority_disabled");
    expect(catalog).toContain("INNER JOIN work_client_projection_fence AS fence");
    expect(catalog).toContain("SELECT count(*)::double precision AS total_count FROM eligible");
    expect(catalog).toContain("SELECT count(*)::double precision AS total_count FROM eligible_legacy");
  });

  it("keeps the exact count when a current or legacy page is past the last row", async () => {
    for (const scenario of [
      {
        env: { WECHAT_WORK_CLIENT_CURRENT_AUTHORITY: "verified" },
        row: { id: null, total_count: 3 },
        count: 3,
        authority: "enterprise_wechat_client_current",
      },
      {
        env: {},
        row: { id: null, blocked_current_rows: 0, total_count: 4 },
        count: 4,
        authority: "postgresql_imported_history",
      },
    ] as const) {
      const db = { execute: vi.fn(async () => [scenario.row]) };
      const service = new EnterpriseWechatCatalogService(
        { db } as unknown as Container,
        scenario.env,
      );
      await expect(service.clients({ page: "999", limit: "20" })).resolves.toMatchObject({
        list: [],
        count: scenario.count,
        client_catalog_authority: scenario.authority,
      });
      expect(db.execute).toHaveBeenCalledOnce();
    }
  });
});
