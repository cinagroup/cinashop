import { describe, expect, it } from "vitest";
import {
  assertActiveAgentSelfService,
  assertDivisionApplicationEligibility,
  normalizeDivisionEndTime,
  normalizeDivisionPercent,
  parseDivisionDateRange,
  validateDivisionHierarchy,
  validateDivisionApplicationInput,
  type DivisionParentSnapshot,
} from "@/services/division/DivisionManagementService";

function parent(overrides: Partial<DivisionParentSnapshot> = {}): DivisionParentSnapshot {
  return {
    uid: 10,
    divisionType: 1,
    divisionStatus: 1,
    divisionId: 10,
    agentId: 0,
    divisionPercent: 60,
    divisionEndTime: 1_800_000_000,
    status: 1,
    isDel: 0,
    ...overrides,
  };
}

describe("division management validation", () => {
  it("rejects bad agent application fields and ineligible ownership before SMS consumption", () => {
    const input = { uid: 25, id: 9, divisionName: "青山代理商", name: "Alice", phone: "13800138000", divisionInvite: 123456, images: ["/assets/one"] };
    expect(validateDivisionApplicationInput(input)).toBe('["/assets/one"]');
    expect(() => validateDivisionApplicationInput({ ...input, divisionInvite: 0 })).toThrow("邀请码错误");
    expect(() => validateDivisionApplicationInput({ ...input, phone: "not-phone" })).toThrow("手机号格式错误");
    expect(() => validateDivisionApplicationInput({ ...input, id: -1 })).toThrow("申请编号错误");
    const applicant = { isDel: 0, status: 1, divisionType: 0, phone: input.phone };
    const divisions = [{ uid: 10, divisionEndTime: 1_800_000_000 }];
    expect(() => assertDivisionApplicationEligibility(input, applicant, divisions, 1_700_000_000)).not.toThrow();
    expect(() => assertDivisionApplicationEligibility(input, { ...applicant, phone: "13900139000" }, divisions, 1_700_000_000)).toThrow("已绑定手机号");
    expect(() => assertDivisionApplicationEligibility(input, { ...applicant, divisionType: 2 }, divisions, 1_700_000_000)).toThrow("拥有事业部角色");
    expect(() => assertDivisionApplicationEligibility(input, applicant, [], 1_700_000_000)).toThrow("事业部不存在");
    expect(() => assertDivisionApplicationEligibility(input, applicant, divisions, 1_900_000_000)).toThrow("事业部已到期");
  });
  it("requires a live unexpired agent for customer-side staff reads and writes", () => {
    const agent = parent({ divisionType: 2, divisionStatus: 1, divisionEndTime: 1_800_000_000 });
    expect(() => assertActiveAgentSelfService(agent, 1_700_000_000)).not.toThrow();
    for (const inactive of [
      undefined,
      parent({ divisionType: 1 }),
      parent({ divisionType: 2, divisionStatus: 0 }),
      parent({ divisionType: 2, status: 0 }),
      parent({ divisionType: 2, isDel: 1 }),
      parent({ divisionType: 2, divisionEndTime: 1_600_000_000 }),
    ]) expect(() => assertActiveAgentSelfService(inactive, 1_700_000_000)).toThrow("有效代理商");
  });
  it("accepts integer percentages at both boundaries", () => {
    expect(normalizeDivisionPercent(0)).toBe(0);
    expect(normalizeDivisionPercent("100")).toBe(100);
  });

  it("rejects fractional and out-of-range percentages", () => {
    expect(() => normalizeDivisionPercent(10.5)).toThrow("整数");
    expect(() => normalizeDivisionPercent(101)).toThrow("0 到 100");
  });

  it("normalizes an end date to the UTC+8 end of day", () => {
    expect(normalizeDivisionEndTime("2026-08-09")).toBe(
      Math.floor(Date.parse("2026-08-09T23:59:59+08:00") / 1000),
    );
  });

  it("allows an agent whose rate and expiry are within its division", () => {
    expect(() => validateDivisionHierarchy(2, 60, 1_800_000_000, parent())).not.toThrow();
  });

  it("rejects an agent rate higher than its division", () => {
    expect(() => validateDivisionHierarchy(2, 61, 1_700_000_000, parent())).toThrow("不能高于");
  });

  it("rejects an agent expiry later than its division", () => {
    expect(() => validateDivisionHierarchy(2, 50, 1_800_000_001, parent())).toThrow("不能晚于");
  });

  it("requires an active parent with the correct role", () => {
    expect(() => validateDivisionHierarchy(2, 50, 0, parent({ divisionStatus: 0 }))).toThrow("已停用");
    expect(() => validateDivisionHierarchy(3, 20, 0, parent())).toThrow("不是代理商");
  });

  it("allows a staff rate equal to the parent in the admin workflow", () => {
    expect(() =>
      validateDivisionHierarchy(
        3,
        40,
        1_700_000_000,
        parent({ divisionType: 2, divisionPercent: 40, agentId: 10 }),
      ),
    ).not.toThrow();
  });
});

describe("division reporting date ranges", () => {
  it("uses hourly buckets for one local day", () => {
    const range = parseDivisionDateRange("2026-08-09", "2026-08-09");
    expect(range.bucket).toBe("hour");
    expect(range.xAxis).toHaveLength(24);
    expect(range.xAxis[0]).toBe("00");
    expect(range.xAxis[23]).toBe("23");
  });

  it("uses daily buckets through 92 days", () => {
    const range = parseDivisionDateRange("2026-08-01", "2026-08-03");
    expect(range.bucket).toBe("day");
    expect(range.xAxis).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("uses monthly buckets for longer bounded ranges", () => {
    const range = parseDivisionDateRange("2026-01-01", "2026-05-01");
    expect(range.bucket).toBe("month");
    expect(range.xAxis).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  });

  it("rejects reversed and unbounded reporting ranges", () => {
    expect(() => parseDivisionDateRange("2026-08-10", "2026-08-09")).toThrow("不能早于");
    expect(() => parseDivisionDateRange("2025-01-01", "2026-08-09")).toThrow("不能超过 366 天");
  });
});
