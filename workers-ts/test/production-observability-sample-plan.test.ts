import { describe, expect, it } from "vitest";
import {
  buildProductionObservabilitySamplePlan,
  classifyPlatformRows,
} from "../scripts/plan-production-observability-sample";

describe("TEST-003B fixed offline platform sample plan", () => {
  it("binds current 17-signal policy to two exact UTC windows and 9 native signals", () => {
    const plan = buildProductionObservabilitySamplePlan(new Date("2026-10-10T02:30:00.000Z"));
    expect(plan.windows).toEqual({
      fifteenMinutes: { start: "2026-10-10T02:15:00.000Z", end: "2026-10-10T02:30:00.000Z" },
      day: { start: "2026-10-09T02:30:00.000Z", end: "2026-10-10T02:30:00.000Z" },
    });
    expect(plan.policySignalCount).toBe(17);
    expect(plan.platformSignalCount).toBe(9);
    expect(plan.requiresCurrentFormalBindingPreflight).toBe(true);
    expect(plan.graphQl.map((source) => source.dataset)).toEqual([
      "hyperdriveQueriesAdaptiveGroups", "hyperdrivePoolSizesAdaptiveGroups",
      "queueMessageOperationsAdaptiveGroups", "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups", "r2OperationsAdaptiveGroups",
    ]);
    expect(plan.queuesRealtime.map((source) => source.resource)).toEqual([
      "cinashop-order", "cinashop-order-dlq", "cinashop-order-dlq-unarchived",
    ]);
    expect(plan.outsidePlatformSample).toHaveLength(8);
    expect(plan.outsidePlatformSample).toContain("refund_workflow");
    expect(plan.outsidePlatformSample).toContain("payment_reconciliation");
    expect(plan.outsidePlatformSample).toContain("print_workflow");
    // The checked-in policy still contains the pre-release Hyperdrive ID.
    // Current traffic can only be selected after a read-only formal binding check.
    expect(JSON.stringify(plan)).not.toContain("9748c294e21c49a99579c9cef70102e0");
  });

  it("never turns missing or denied metrics into zero errors", () => {
    expect(classifyPlatformRows({ success: false })).toBe("unavailable");
    expect(classifyPlatformRows({ success: true })).toBe("unavailable");
    expect(classifyPlatformRows({ success: true, errors: ["denied"], rows: [] })).toBe("unavailable");
    expect(classifyPlatformRows({ success: true, rows: [] })).toBe("no_traffic");
    expect(classifyPlatformRows({ success: true, rows: [{ errors: 0 }] })).toBe("observed");
    expect(() => buildProductionObservabilitySamplePlan(new Date("invalid"))).toThrow();
  });
});
