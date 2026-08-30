import { describe, expect, it, vi } from "vitest";
import type { WorkCallbackPayload } from "../src/models/schema";
import {
  parseEnterpriseWechatMemberSnapshot,
  prepareMemberProjection,
  type MemberProjectionClaim,
} from "../src/services/work/EnterpriseWechatMemberProjection";
import { EnterpriseWechatProviderError } from "../src/services/work/EnterpriseWechatProviderClient";
import { compareMemberProjectionFence } from "../src/services/work/EnterpriseWechatMemberCurrentService";

function snapshot(userid = "member-a"): Record<string, unknown> {
  return {
    errcode: 0,
    errmsg: "ok",
    userid,
    name: "Member A",
    position: "Engineering",
    mobile: "+6581234567",
    gender: "1",
    email: "member@example.test",
    biz_mail: "member@corp.example.test",
    direct_leader: ["leader-a"],
    avatar: "https://example.test/member/avatar",
    thumb_avatar: "https://example.test/member/thumb",
    telephone: "+65-61234567",
    alias: "member-a",
    enable: 1,
    hide_mobile: 0,
    address: "Singapore",
    open_userid: "open-member-a",
    main_department: 7,
    status: 1,
    qr_code: "https://example.test/member/qr",
    external_position: "Engineer",
    department: [7, 9],
    order: [10, 20],
    is_leader_in_dept: [1, 0],
    extattr: { attrs: [{ name: "level", value: "senior" }] },
    external_profile: { external_corp_name: "Example" },
  };
}

function claim(
  changeType: "create_user" | "update_user" | "delete_user",
  payload: WorkCallbackPayload,
): MemberProjectionClaim {
  return {
    eventId: 17,
    eventKey: "a".repeat(64),
    eventTime: 1_788_048_000,
    sequenceRank: changeType === "delete_user" ? 100 : changeType === "update_user" ? 50 : 10,
    corpId: "ww-member-test",
    msgType: "event",
    eventType: "change_contact",
    changeType,
    payload,
  };
}

describe("Enterprise WeChat member projection snapshot", () => {
  it("requires and canonicalizes one complete authoritative provider snapshot", () => {
    const parsed = parseEnterpriseWechatMemberSnapshot(snapshot(), "member-a");
    expect(parsed).toMatchObject({
      userid: "member-a",
      name: "Member A",
      gender: 1,
      enable: 1,
      isLeader: 1,
      mainDepartment: 7,
      departments: [
        { departmentId: 7, sortOrder: 10, isLeaderInDepartment: 1 },
        { departmentId: 9, sortOrder: 20, isLeaderInDepartment: 0 },
      ],
    });
    expect(parsed.directLeader).toBe('["leader-a"]');
    expect(parsed.extattr).toBe('{"attrs":[{"name":"level","value":"senior"}]}');
  });

  it("preserves omitted optional fields and rejects missing core snapshot fields", () => {
    const missingMobile = snapshot();
    delete missingMobile.mobile;
    expect(parseEnterpriseWechatMemberSnapshot(missingMobile, "member-a")).toMatchObject({
      mobile: undefined,
      profileComplete: false,
    });

    const missingName = snapshot();
    delete missingName.name;
    expect(() => parseEnterpriseWechatMemberSnapshot(missingName, "member-a"))
      .toThrow("callback_member_snapshot_incomplete");

    expect(() => parseEnterpriseWechatMemberSnapshot({
      ...snapshot(),
      userid: "another-member",
    }, "member-a")).toThrow("callback_member_snapshot_invalid");
    expect(() => parseEnterpriseWechatMemberSnapshot({
      ...snapshot(),
      order: [10],
    }, "member-a")).toThrow("callback_member_snapshot_invalid");
    expect(() => parseEnterpriseWechatMemberSnapshot({
      ...snapshot(),
      department: [7, 7],
    }, "member-a")).toThrow("callback_member_snapshot_invalid");
    expect(() => parseEnterpriseWechatMemberSnapshot({
      ...snapshot(),
      main_department: 8,
    }, "member-a")).toThrow("callback_member_snapshot_invalid");
    expect(() => parseEnterpriseWechatMemberSnapshot({
      ...snapshot(),
      userid: "_member-a",
    }, "_member-a")).toThrow("callback_member_snapshot_invalid");
  });

  it("case-folds UserID and accepts the complete uint32 department sort range", () => {
    const parsed = parseEnterpriseWechatMemberSnapshot({
      ...snapshot("Member-A"),
      order: [4_294_967_295, 2_147_483_648],
    }, "member-a");
    expect(parsed.userid).toBe("member-a");
    expect(parsed.departments.map((item) => item.sortOrder))
      .toEqual([4_294_967_295, 2_147_483_648]);
  });

  it("uses NewUserID as the rename snapshot identity", async () => {
    const directoryMember = vi.fn().mockResolvedValue(snapshot("member-new"));
    const prepared = await prepareMemberProjection(claim("update_user", {
      UserID: "member-old",
      NewUserID: "member-new",
    }), { directoryMember });
    expect(directoryMember).toHaveBeenCalledWith("member-new");
    expect(prepared).toMatchObject({
      kind: "snapshot",
      previousUserid: "member-old",
      targetUserid: "member-new",
      renamed: true,
    });
  });

  it("tombstones only delete callbacks and keeps provider visibility gaps unresolved", async () => {
    const directoryMember = vi.fn();
    await expect(prepareMemberProjection(claim("delete_user", {
      UserID: "member-a",
    }), { directoryMember })).resolves.toEqual({
      kind: "absent",
      previousUserid: "member-a",
      targetUserid: "member-a",
      renamed: false,
      source: "delete_callback",
    });
    expect(directoryMember).not.toHaveBeenCalled();
    await expect(prepareMemberProjection(claim("delete_user", {
      UserID: "member-a",
    }))).resolves.toMatchObject({ kind: "absent", source: "delete_callback" });

    directoryMember.mockRejectedValueOnce(new EnterpriseWechatProviderError(
      "not_found",
      "directory_member_get",
      60_111,
      200,
    ));
    await expect(prepareMemberProjection(claim("create_user", {
      UserID: "member-a",
    }), { directoryMember })).resolves.toMatchObject({
      kind: "not_found",
      source: "provider_not_found",
    });
  });

  it("orders latest-seen and applied fences lexicographically", () => {
    const baseline = { eventTime: 100, sequenceRank: 50, eventId: 20 };
    expect(compareMemberProjectionFence({ ...baseline, eventTime: 101, sequenceRank: 1 }, baseline))
      .toBeGreaterThan(0);
    expect(compareMemberProjectionFence({ ...baseline, sequenceRank: 100 }, baseline))
      .toBeGreaterThan(0);
    expect(compareMemberProjectionFence({ ...baseline, eventId: 21 }, baseline))
      .toBeGreaterThan(0);
    expect(compareMemberProjectionFence(baseline, { ...baseline, eventId: 21 }))
      .toBeLessThan(0);
    expect(compareMemberProjectionFence(baseline, baseline)).toBe(0);
  });

  it("leaves retryable and configuration provider failures to the durable pipeline", async () => {
    for (const kind of ["retryable", "configuration"] as const) {
      const failure = new EnterpriseWechatProviderError(
        kind,
        "directory_member_get",
        kind === "retryable" ? 45_009 : 48_002,
        kind === "retryable" ? 429 : 200,
        kind === "retryable" ? 120 : undefined,
      );
      await expect(prepareMemberProjection(claim("create_user", {
        UserID: "member-a",
      }), { directoryMember: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
    }
  });
});
