import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WorkCallbackPayload } from "../src/models/schema";
import {
  externalTagProjectionIdentity,
  isExternalTagProjectionEvent,
  parseEnterpriseWechatExternalTagCatalogSnapshot,
  prepareExternalTagProjection,
  type ExternalTagProjectionClaim,
} from "../src/services/work/EnterpriseWechatExternalTagProjection";
import { compareExternalTagProjectionFence } from "../src/services/work/EnterpriseWechatExternalTagCurrentService";
import { EnterpriseWechatProviderError } from "../src/services/work/EnterpriseWechatProviderClient";

function tag(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Tag ${id}`,
    create_time: 1_788_000_000,
    order: 10,
    deleted: false,
    ...overrides,
  };
}

function group(id: string, overrides: Record<string, unknown> = {}) {
  return {
    group_id: id,
    group_name: `Group ${id}`,
    create_time: 1_788_000_000,
    order: 5,
    deleted: false,
    tag: [tag("et-tag-1"), tag("et-tag-2", { order: 20 })],
    ...overrides,
  };
}

function response(groups: Array<Record<string, unknown>> = [group("et-group-1")]) {
  return { errcode: 0, errmsg: "ok", tag_group: groups };
}

function claim(
  changeType: "create" | "update" | "delete" | "shuffle",
  payload: WorkCallbackPayload,
): ExternalTagProjectionClaim {
  return {
    eventId: 71,
    eventKey: "a".repeat(64),
    subjectKeyHash: "b".repeat(64),
    eventTime: 1_788_048_000,
    sequenceRank: changeType === "delete" ? 100 : changeType === "create" ? 10 : 50,
    corpId: "ww-tag-test",
    msgType: "event",
    eventType: "change_external_tag",
    changeType,
    payload,
  };
}

describe("Enterprise WeChat external-tag projection", () => {
  it("uses remote string identities for tag, group, scoped shuffle, and full shuffle", () => {
    expect(externalTagProjectionIdentity(claim("update", {
      TagType: "tag",
      Id: "et-tag-1",
    }))).toEqual({ strategyId: 0, subjectType: "tag", remoteId: "et-tag-1", scope: "tag" });
    expect(externalTagProjectionIdentity(claim("create", {
      TagType: "tag_group",
      Id: "et-group-1",
      StrategyId: 17,
    }))).toEqual({ strategyId: 17, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" });
    expect(externalTagProjectionIdentity(claim("shuffle", { Id: "et-group-1" })))
      .toEqual({ strategyId: 0, subjectType: "catalog", remoteId: "et-group-1", scope: "group" });
    expect(externalTagProjectionIdentity(claim("shuffle", { StrategyId: 17 })))
      .toEqual({ strategyId: 17, subjectType: "catalog", remoteId: "*", scope: "catalog" });
  });

  it("parses a bounded ordinary catalog and preserves explicit deleted flags", () => {
    const identity = externalTagProjectionIdentity(claim("shuffle", {}));
    const parsed = parseEnterpriseWechatExternalTagCatalogSnapshot(response([
      group("et-group-2", { order: 20, tag: [tag("et-tag-3", { deleted: true })] }),
      group("et-group-1"),
    ]), identity);
    expect(parsed.groups.map((item) => item.groupId)).toEqual(["et-group-1", "et-group-2"]);
    expect(parsed.groups[1].tags[0]).toMatchObject({ tagId: "et-tag-3", deleted: true });
  });

  it("parses strategy catalogs only with an exact strategy id and no deleted flags", () => {
    const identity = externalTagProjectionIdentity(claim("update", {
      StrategyId: 17,
      TagType: "tag_group",
      Id: "et-group-1",
    }));
    const strategyGroup = group("et-group-1", {
      strategy_id: 17,
      tag: [tag("et-tag-1")],
    }) as Record<string, unknown>;
    delete strategyGroup.deleted;
    for (const item of strategyGroup.tag as Array<Record<string, unknown>>) delete item.deleted;
    expect(parseEnterpriseWechatExternalTagCatalogSnapshot(
      response([strategyGroup]),
      identity,
    ).strategyId).toBe(17);
    expect(() => parseEnterpriseWechatExternalTagCatalogSnapshot(
      response([{ ...strategyGroup, strategy_id: 18 }]),
      identity,
    )).toThrow("callback_external_tag_snapshot_invalid");
  });

  it("rejects duplicate remote identities, targeted scope drift, and incomplete fields", () => {
    const catalog = externalTagProjectionIdentity(claim("shuffle", {}));
    expect(() => parseEnterpriseWechatExternalTagCatalogSnapshot(response([
      group("et-group-1"), group("et-group-1"),
    ]), catalog)).toThrow("callback_external_tag_snapshot_invalid");
    expect(() => parseEnterpriseWechatExternalTagCatalogSnapshot(response([
      group("et-group-1", { tag: [tag("et-same"), tag("et-same")] }),
    ]), catalog)).toThrow("callback_external_tag_snapshot_invalid");
    const target = externalTagProjectionIdentity(claim("update", {
      TagType: "tag",
      Id: "et-missing",
    }));
    expect(() => parseEnterpriseWechatExternalTagCatalogSnapshot(response(), target))
      .toThrow("callback_external_tag_snapshot_incomplete");
  });

  it("never invokes a provider for callback-authoritative delete", async () => {
    const corpTagList = vi.fn();
    const strategyTagList = vi.fn();
    await expect(prepareExternalTagProjection(claim("delete", {
      TagType: "tag_group",
      Id: "et-group-1",
    }), { corpTagList, strategyTagList })).resolves.toMatchObject({
      kind: "absent",
      identity: { subjectType: "tag_group", remoteId: "et-group-1" },
    });
    expect(corpTagList).not.toHaveBeenCalled();
    expect(strategyTagList).not.toHaveBeenCalled();
  });

  it("selects corp/strategy providers and keeps not-found refresh-only", async () => {
    const corpTagList = vi.fn().mockResolvedValue(response());
    const strategyGroup = group("et-group-1", { strategy_id: 17 }) as Record<string, unknown>;
    delete strategyGroup.deleted;
    for (const item of strategyGroup.tag as Array<Record<string, unknown>>) delete item.deleted;
    const strategyTagList = vi.fn().mockResolvedValue(response([strategyGroup]));
    await prepareExternalTagProjection(claim("update", {
      TagType: "tag",
      Id: "et-tag-1",
    }), { corpTagList, strategyTagList });
    await prepareExternalTagProjection(claim("shuffle", {
      StrategyId: 17,
      Id: "et-group-1",
    }), { corpTagList, strategyTagList });
    expect(corpTagList).toHaveBeenCalledWith(["et-tag-1"], []);
    expect(strategyTagList).toHaveBeenCalledWith(17, [], ["et-group-1"]);

    const notFound = new EnterpriseWechatProviderError(
      "not_found", "external_corp_tag_list", 40_068, 200,
    );
    await expect(prepareExternalTagProjection(claim("update", {
      TagType: "tag",
      Id: "et-tag-1",
    }), {
      corpTagList: vi.fn().mockRejectedValue(notFound),
      strategyTagList,
    })).resolves.toMatchObject({ kind: "not_found" });
  });

  it("recognizes all four variants and makes deletion terminal", () => {
    for (const changeType of ["create", "update", "delete", "shuffle"] as const) {
      expect(isExternalTagProjectionEvent(claim(changeType,
        changeType === "shuffle" ? {} : { TagType: "tag", Id: "et-tag-1" })))
        .toBe(true);
    }
    expect(compareExternalTagProjectionFence(
      { eventTime: 100, sequenceRank: 100, eventId: 1 },
      { eventTime: 200, sequenceRank: 50, eventId: 2 },
    )).toBeGreaterThan(0);
  });

  it("keeps three current tables, no hard deletes, authority gate, and explicit batch ignore", () => {
    const schema = readFileSync("src/models/schema/work_external_tag_current.ts", "utf8");
    const current = readFileSync(
      "src/services/work/EnterpriseWechatExternalTagCurrentService.ts",
      "utf8",
    );
    const callback = readFileSync(
      "src/services/work/EnterpriseWechatCallbackService.ts",
      "utf8",
    );
    const catalog = readFileSync(
      "src/services/work/EnterpriseWechatCatalogService.ts",
      "utf8",
    );
    const crypto = readFileSync(
      "src/services/work/EnterpriseWechatCallbackCrypto.ts",
      "utf8",
    );
    expect((schema.match(/pgTable\(/g) ?? [])).toHaveLength(3);
    expect(schema).toContain('"work_external_tag_projection_fence"');
    expect(current).not.toContain("delete(workExternalTag");
    expect(callback).toContain("WECHAT_WORK_TAG_CURRENT_AUTHORITY");
    expect(callback).toContain("externalTagProvider");
    expect(catalog).toContain("external_tag_current_authority_disabled");
    expect(catalog).toContain("WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY");
    expect(catalog).toContain("tag_event.change_type IN ('create','update','delete','shuffle')");
    expect(catalog).toContain("group_event.change_type IN ('create','update','delete','shuffle')");
    expect(crypto).toContain('event === "batch_job_result"');
    expect(crypto).toContain("recognized: false");
    expect(crypto).toContain('"ErrCode"');
    expect(crypto).not.toContain('"ErrMsg"');
  });
});
