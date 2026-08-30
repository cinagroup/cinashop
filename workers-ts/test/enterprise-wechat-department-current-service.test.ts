import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../src/lib/di";
import type { WorkDepartmentCurrent } from "../src/models/schema";
import {
  applyDepartmentCurrentProjection,
} from "../src/services/work/EnterpriseWechatDepartmentCurrentService";
import type {
  DepartmentProjectionClaim,
  PreparedDepartmentProjection,
} from "../src/services/work/EnterpriseWechatDepartmentProjection";

const claim: DepartmentProjectionClaim = {
  eventId: 19,
  eventKey: "a".repeat(64),
  subjectKeyHash: "b".repeat(64),
  eventTime: 1_000,
  sequenceRank: 100,
  corpId: "ww-department-test",
  msgType: "event",
  eventType: "change_contact",
  changeType: "delete_party",
  payload: { Id: "7" },
};

function fence() {
  return {
    corpId: claim.corpId,
    departmentId: 7,
    lastEventId: claim.eventId,
    lastEventKey: claim.eventKey,
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: claim.eventTime,
    lastSequenceRank: claim.sequenceRank,
    createTime: 900,
    updateTime: 1_000,
  };
}

function current(overrides: Partial<WorkDepartmentCurrent> = {}): WorkDepartmentCurrent {
  return {
    corpId: claim.corpId,
    departmentId: 7,
    lifecycleState: "ACTIVE",
    profileComplete: true,
    name: "Engineering",
    nameEn: "Engineering",
    parentDepartmentId: 1,
    sortOrder: 10,
    lastEventId: 18,
    lastEventKey: "c".repeat(64),
    lastEventSubjectKeyHash: claim.subjectKeyHash,
    lastEventTime: 999,
    lastSequenceRank: 50,
    createTime: 800,
    updateTime: 999,
    deletedTime: null,
    ...overrides,
  };
}

function selectBuilder(rows: unknown[]) {
  const builder = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    for: vi.fn(async () => rows),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

function databaseFixture(...selectResults: unknown[][]) {
  const pending = [...selectResults];
  const updateValues: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => {
    const builder = {
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(async () => [{ departmentId: 7 }]),
    };
    return builder;
  });
  const deleteWhere = vi.fn(async () => []);
  const db = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => selectBuilder(pending.shift() ?? [])),
    update,
    delete: vi.fn(() => ({ where: deleteWhere })),
    insert: vi.fn(),
  };
  return { db: db as unknown as DbClient, raw: db, updateValues, pending };
}

describe("Enterprise WeChat department current service", () => {
  it("tombstones only the target and clears leaders without consulting child/member rows", async () => {
    const fixture = databaseFixture([fence()], [current()]);
    const prepared: PreparedDepartmentProjection = {
      kind: "absent",
      departmentId: 7,
      source: "delete_callback",
    };

    await expect(applyDepartmentCurrentProjection(
      fixture.db,
      claim,
      prepared,
      1_100,
    )).resolves.toBe("applied");

    expect(fixture.raw.select).toHaveBeenCalledTimes(2);
    expect(fixture.raw.delete).toHaveBeenCalledOnce();
    expect(fixture.raw.update).toHaveBeenCalledOnce();
    expect(fixture.updateValues).toEqual([expect.objectContaining({
      lifecycleState: "DELETED",
      profileComplete: false,
      lastEventId: 19,
      deletedTime: 1_100,
    })]);
    expect(fixture.updateValues[0]).not.toHaveProperty("name");
    expect(fixture.pending).toHaveLength(0);
  });

  it("returns refresh-required without reading or mutating business current state", async () => {
    const fixture = databaseFixture([{ ...fence(), lastSequenceRank: 50 }]);
    await expect(applyDepartmentCurrentProjection(fixture.db, {
      ...claim,
      changeType: "update_party",
      sequenceRank: 50,
    }, {
      kind: "not_found",
      departmentId: 7,
      source: "provider_not_found",
    }, 1_100)).resolves.toBe("refresh-required");
    expect(fixture.raw.select).toHaveBeenCalledOnce();
    expect(fixture.raw.update).not.toHaveBeenCalled();
    expect(fixture.raw.delete).not.toHaveBeenCalled();
  });

  it("rejects a two-node hierarchy cycle before any business write", async () => {
    const updateClaim: DepartmentProjectionClaim = {
      ...claim,
      changeType: "update_party",
      sequenceRank: 50,
    };
    const fixture = databaseFixture(
      [{ ...fence(), lastSequenceRank: 50 }],
      [current({ lifecycleState: "UNRESOLVED", profileComplete: false, name: null,
        nameEn: null, parentDepartmentId: null, sortOrder: null, lastEventId: null,
        lastEventKey: null, lastEventSubjectKeyHash: null, lastEventTime: 0,
        lastSequenceRank: 0, deletedTime: null })],
      [current({ departmentId: 8, parentDepartmentId: 7 })],
    );
    await expect(applyDepartmentCurrentProjection(fixture.db, updateClaim, {
      kind: "snapshot",
      departmentId: 7,
      snapshot: {
        departmentId: 7,
        name: "Engineering",
        nameEn: "Engineering",
        parentDepartmentId: 8,
        sortOrder: 10,
        leaders: [],
      },
    }, 1_100)).rejects.toThrow("callback_department_hierarchy_cycle");
    expect(fixture.raw.update).not.toHaveBeenCalled();
    expect(fixture.raw.delete).not.toHaveBeenCalled();
  });

  it("fails closed when applied current is newer than the exact latest-seen fence", async () => {
    const fixture = databaseFixture([fence()], [current({
      lastEventId: 20,
      lastEventTime: 1_001,
      lastSequenceRank: 10,
    })]);
    await expect(applyDepartmentCurrentProjection(fixture.db, claim, {
      kind: "absent",
      departmentId: 7,
      source: "delete_callback",
    }, 1_100)).rejects.toThrow("callback_department_current_ahead_of_seen_fence");
    expect(fixture.raw.update).not.toHaveBeenCalled();
  });
});
