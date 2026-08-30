import { describe, expect, it, vi } from "vitest";
import type { WorkCallbackPayload } from "../src/models/schema";
import {
  departmentProjectionIdentity,
  isDepartmentProjectionEvent,
  parseEnterpriseWechatDepartmentSnapshot,
  prepareDepartmentProjection,
  type DepartmentProjectionClaim,
} from "../src/services/work/EnterpriseWechatDepartmentProjection";
import { EnterpriseWechatProviderError } from "../src/services/work/EnterpriseWechatProviderClient";

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    errcode: 0,
    errmsg: "ok",
    department: {
      id: 7,
      name: "Engineering",
      name_en: "Engineering",
      parentid: 1,
      order: 4_294_967_295,
      department_leader: ["Leader-A", "leader-b"],
      ...overrides,
    },
  };
}

function claim(
  changeType: "create_party" | "update_party" | "delete_party",
  payload: WorkCallbackPayload = { Id: "7" },
): DepartmentProjectionClaim {
  return {
    eventId: 19,
    eventKey: "a".repeat(64),
    subjectKeyHash: "b".repeat(64),
    eventTime: 1_788_048_000,
    sequenceRank: changeType === "delete_party" ? 100 : changeType === "update_party" ? 50 : 10,
    corpId: "ww-department-test",
    msgType: "event",
    eventType: "change_contact",
    changeType,
    payload,
  };
}

describe("Enterprise WeChat department projection", () => {
  it("parses one complete authoritative snapshot and preserves provider order", () => {
    expect(parseEnterpriseWechatDepartmentSnapshot(response(), 7)).toEqual({
      departmentId: 7,
      name: "Engineering",
      nameEn: "Engineering",
      parentDepartmentId: 1,
      sortOrder: 4_294_967_295,
      leaders: ["leader-a", "leader-b"],
    });
    expect(parseEnterpriseWechatDepartmentSnapshot(response({
      parentid: 0,
      order: 0,
      department_leader: [],
    }), 7)).toMatchObject({
      parentDepartmentId: null,
      sortOrder: 0,
      leaders: [],
    });
  });

  it("rejects identity, hierarchy, uint32, leader, and completeness drift", () => {
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({ id: 8 }), 7))
      .toThrow("callback_department_snapshot_invalid");
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({ parentid: 7 }), 7))
      .toThrow("callback_department_snapshot_invalid");
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({ order: -1 }), 7))
      .toThrow("callback_department_snapshot_invalid");
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({ order: 4_294_967_296 }), 7))
      .toThrow("callback_department_snapshot_invalid");
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({
      department_leader: ["Leader-A", "leader-a"],
    }), 7)).toThrow("callback_department_snapshot_invalid");
    expect(() => parseEnterpriseWechatDepartmentSnapshot(response({
      department_leader: Array.from({ length: 11 }, (_, index) => `leader-${index}`),
    }), 7)).toThrow("callback_department_snapshot_invalid");

    const missingLeaders = response();
    delete (missingLeaders.department as Record<string, unknown>).department_leader;
    expect(() => parseEnterpriseWechatDepartmentSnapshot(missingLeaders, 7))
      .toThrow("callback_department_snapshot_incomplete");
    const missingEnglishName = response();
    delete (missingEnglishName.department as Record<string, unknown>).name_en;
    expect(() => parseEnterpriseWechatDepartmentSnapshot(missingEnglishName, 7))
      .toThrow("callback_department_snapshot_incomplete");
  });

  it("recognizes only the three department callback variants with a positive int32 Id", () => {
    for (const changeType of ["create_party", "update_party", "delete_party"] as const) {
      const event = claim(changeType);
      expect(isDepartmentProjectionEvent(event)).toBe(true);
      expect(departmentProjectionIdentity(event)).toBe(7);
    }
    expect(isDepartmentProjectionEvent({
      msgType: "event",
      eventType: "change_contact",
      changeType: "create_user",
    })).toBe(false);
    for (const Id of ["0", "01", "2147483648", "7.0", "-7", " 7"] as const) {
      expect(() => departmentProjectionIdentity(claim("create_party", { Id })))
        .toThrow("callback_projection_field_invalid");
    }
  });

  it("never constructs or calls a provider for callback-authoritative deletion", async () => {
    const directoryDepartment = vi.fn();
    await expect(prepareDepartmentProjection(
      claim("delete_party"),
      { directoryDepartment },
    )).resolves.toEqual({
      kind: "absent",
      departmentId: 7,
      source: "delete_callback",
    });
    expect(directoryDepartment).not.toHaveBeenCalled();
    await expect(prepareDepartmentProjection(claim("delete_party")))
      .resolves.toMatchObject({ kind: "absent", source: "delete_callback" });
  });

  it("keeps provider not-found and incomplete responses refresh-only", async () => {
    const notFound = new EnterpriseWechatProviderError(
      "not_found",
      "directory_department_get",
      60_003,
      200,
    );
    await expect(prepareDepartmentProjection(claim("update_party"), {
      directoryDepartment: vi.fn().mockRejectedValue(notFound),
    })).resolves.toEqual({
      kind: "not_found",
      departmentId: 7,
      source: "provider_not_found",
    });

    const incomplete = response();
    delete (incomplete.department as Record<string, unknown>).department_leader;
    await expect(prepareDepartmentProjection(claim("update_party"), {
      directoryDepartment: vi.fn().mockResolvedValue(incomplete),
    })).resolves.toEqual({
      kind: "incomplete",
      departmentId: 7,
      source: "provider_scope_incomplete",
    });
  });

  it("leaves retryable, configuration, and terminal provider failures to the durable pipeline", async () => {
    for (const kind of ["retryable", "configuration", "terminal"] as const) {
      const failure = new EnterpriseWechatProviderError(
        kind,
        "directory_department_get",
        kind === "retryable" ? 45_009 : 48_002,
        kind === "retryable" ? 429 : 200,
        kind === "retryable" ? 120 : undefined,
      );
      await expect(prepareDepartmentProjection(claim("create_party"), {
        directoryDepartment: vi.fn().mockRejectedValue(failure),
      })).rejects.toBe(failure);
    }
  });
});
