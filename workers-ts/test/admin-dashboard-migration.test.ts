import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAdminDashboardPeriod,
  dashboardComparison,
  parseAdminHomeCycle,
} from "@/services/admin/AdminDashboardService";

const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

describe("admin dashboard migration", () => {
  it("cuts all calendar windows at Asia/Shanghai midnight", () => {
    const beforeMidnight = buildAdminDashboardPeriod(
      "thirtyday",
      epoch("2026-08-27T15:59:59.000Z"),
    );
    const atMidnight = buildAdminDashboardPeriod(
      "thirtyday",
      epoch("2026-08-27T16:00:00.000Z"),
    );
    expect(beforeMidnight.currentEnd).toBe(epoch("2026-08-27T16:00:00.000Z"));
    expect(atMidnight.currentEnd).toBe(epoch("2026-08-28T16:00:00.000Z"));
    expect(atMidnight.currentStart - atMidnight.previousStart).toBe(30 * 86_400);
    expect(atMidnight.currentEnd - atMidnight.currentStart).toBe(30 * 86_400);
    expect(atMidnight.bucketKeys).toHaveLength(30);
  });

  it("uses non-overlapping week, month, and year comparison periods", () => {
    const now = epoch("2026-08-27T04:00:00.000Z");
    const week = buildAdminDashboardPeriod("week", now);
    expect(week.currentStart).toBe(epoch("2026-08-23T16:00:00.000Z"));
    expect(week.currentStart - week.previousStart).toBe(7 * 86_400);
    expect(week.currentEnd - week.currentStart).toBe(7 * 86_400);
    expect(week.labels).toEqual(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);

    const month = buildAdminDashboardPeriod("month", now);
    expect(month.previousStart).toBe(epoch("2026-06-30T16:00:00.000Z"));
    expect(month.currentStart).toBe(epoch("2026-07-31T16:00:00.000Z"));
    expect(month.currentEnd).toBe(epoch("2026-08-31T16:00:00.000Z"));

    const year = buildAdminDashboardPeriod("year", now);
    expect(year.previousStart).toBe(epoch("2024-12-31T16:00:00.000Z"));
    expect(year.currentStart).toBe(epoch("2025-12-31T16:00:00.000Z"));
    expect(year.currentEnd).toBe(epoch("2026-12-31T16:00:00.000Z"));
  });

  it("validates the public cycle and preserves PHP comparison direction", () => {
    expect(parseAdminHomeCycle()).toBe("thirtyday");
    expect(parseAdminHomeCycle("week")).toBe("week");
    expect(() => parseAdminHomeCycle("custom")).toThrow("cycle 仅支持");
    expect(dashboardComparison(15, 10)).toEqual({ data: 15, percent: 50, is_plus: 1 });
    expect(dashboardComparison(5, 10)).toEqual({ data: 5, percent: 50, is_plus: -1 });
    expect(dashboardComparison(0, 0)).toEqual({ data: 0, percent: 0, is_plus: 0 });
  });

  it("registers four distinct PHP-compatible endpoints on both admin surfaces", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const source of [adminRoutes, v1Routes]) {
      expect(source).toContain("AdminController.adminHomeHeader");
      expect(source).toContain("AdminController.adminOrderChart");
      expect(source).toContain("AdminController.adminUserChart");
      expect(source).toContain("AdminController.adminPurchaseRanking");
    }
    expect(adminRoutes).not.toContain(
      'adminapiRoutes.get("/home/order", adminAuth, AdminController.adminDashboard)',
    );
    expect(adminRoutes).not.toContain(
      'adminapiRoutes.get("/home/user", adminAuth, AdminController.adminDashboard)',
    );
  });

  it("filters deleted evidence and performs grouping in PostgreSQL", () => {
    const service = readFileSync("src/services/admin/AdminDashboardService.ts", "utf8");
    expect(service).toContain("AT TIME ZONE 'Asia/Shanghai'");
    expect(service).toContain("is_system_del = 0");
    expect(service).toContain("delete_time IS NULL");
    expect(service).toContain("GROUP BY 1, 2");
    expect(service).toContain("MATERIALIZED");
  });
});
