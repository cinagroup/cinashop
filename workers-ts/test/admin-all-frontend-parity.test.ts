import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ledgerNames = [
  "content", "product", "setting", "marketing", "work", "app", "system", "kefu",
  "cross-module", "user-order", "supplier-agent",
] as const;

type Route = {
  legacyPath?: string;
  legacy?: { path: string };
  status: string;
};

const inventory = JSON.parse(readFileSync("audit/admin-frontend-inventory.json", "utf8")) as {
  legacy: { routes: Array<{ path: string; surface: string }> };
};

describe("complete legacy Admin page semantic inventory", () => {
  it("classifies every authoritative business route exactly once across eleven ledgers", () => {
    const authority = inventory.legacy.routes
      .filter((route) => route.surface === "page")
      .map((route) => route.path);
    expect(authority).toHaveLength(274);
    expect(new Set(authority).size).toBe(274);

    const reviewed: string[] = [];
    const statusCounts = { candidate: 0, partial: 0, missing: 0, retired: 0 };
    for (const name of ledgerNames) {
      const report = JSON.parse(readFileSync(`audit/admin-legacy-${name}-route-parity.json`, "utf8")) as {
        summary: { legacyRoutes: number };
        routes: Route[];
      };
      expect(report.routes.length, name).toBe(report.summary.legacyRoutes);
      for (const route of report.routes) {
        const path = route.legacyPath ?? route.legacy?.path;
        expect(path, name).toBeTruthy();
        reviewed.push(path!);
        expect(route.status in statusCounts, `${name}: ${path}`).toBe(true);
        statusCounts[route.status as keyof typeof statusCounts] += 1;
      }
    }

    expect(reviewed).toHaveLength(274);
    expect(new Set(reviewed).size).toBe(274);
    expect(reviewed.sort()).toEqual(authority.sort());
    expect(statusCounts).toEqual({ candidate: 39, partial: 118, missing: 109, retired: 8 });
  });
});
