import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAdminFrontendApiAuditReport, normalizeAdminAuditSource } from "../scripts/admin-frontend-api-audit";

interface ApiAuditReport {
  version: number;
  methodology: Record<string, string>;
  backend: {
    file: string;
    sha256: string;
    registeredRoutes: Array<{
      method: string;
      path: string;
      line: number;
      handler: string;
      availability: "executable" | "controlled_unavailable";
    }>;
  };
  frontendSources: Array<{ file: string; sha256: string }>;
  counts: {
    callSites: number;
    pathVariants: number;
    registered: number;
    executable: number;
    controlledUnavailable: number;
    unregistered: number;
    unresolved: number;
  };
  unregistered: unknown[];
  unresolved: unknown[];
  controlledUnavailable: unknown[];
  calls: Array<{
    method: string;
    path: string;
    source: string;
    line: number;
    registered: boolean;
    matchedRoute: string | null;
    matchedHandler: string | null;
    availability: "executable" | "controlled_unavailable" | "unregistered";
  }>;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(testDir, "..");
const committed = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-guest-invoice-manual-red-note-followup-20261013.json"),
  "utf8",
)) as ApiAuditReport;
const historicalRaw = readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-legacy-role-operations-followup-20261009.json"),
  "utf8",
);
const historical = JSON.parse(historicalRaw) as ApiAuditReport;

function withoutLine<T extends { line: number }>(entry: T): Omit<T, "line"> {
  const { line: _line, ...semantic } = entry;
  return semantic;
}

function semanticCounts(entries: Array<{ line: number }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = JSON.stringify(withoutLine(entry));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("Admin frontend API registration audit", () => {
  it.each(["\n", "\r\n", "\r"])("canonicalizes source line endings %j without changing handler text", (ending) => {
    const lines = ["(c) =>", "  c.json({ status: 200 })", ""];
    expect(normalizeAdminAuditSource(lines.join(ending))).toBe(lines.join("\n"));
  });

  it("has no statically unregistered or unresolved request paths", () => {
    expect(committed.version).toBe(2);
    expect(committed.counts.callSites).toBeGreaterThan(250);
    expect(committed.counts.pathVariants).toBe(committed.calls.length);
    expect(committed.counts.registered).toBe(committed.calls.length);
    expect(committed.counts.executable + committed.counts.controlledUnavailable).toBe(committed.calls.length);
    expect(committed.counts.controlledUnavailable).toBe(committed.controlledUnavailable.length);
    expect(committed.counts.unregistered).toBe(0);
    expect(committed.counts.unresolved).toBe(0);
    expect(committed.unregistered).toEqual([]);
    expect(committed.unresolved).toEqual([]);
    expect(committed.calls.every((call) => call.registered && call.matchedRoute && call.matchedHandler)).toBe(true);
  });

  it("recomputes the same deterministic report from the current frontend and routes", () => {
    expect(buildAdminFrontendApiAuditReport()).toEqual(committed);
  });

  it("retains the reviewed October 9 inventory and adds exactly the four manual red-note API contracts", () => {
    expect(createHash("sha256").update(normalizeAdminAuditSource(historicalRaw)).digest("hex"))
      .toBe("2f870baccb6152d19d62327b52ba58f3954119e4789201c9040dbb7f84858ab9");
    const routes = [
      { method: "GET", path: "/order/invoices/:id/red-notes", handler: "AdminInvoiceRedNote.list", availability: "executable" },
      { method: "POST", path: "/order/invoices/:id/red-notes", handler: "AdminInvoiceRedNote.record", availability: "executable" },
      { method: "POST", path: "/order/invoices/:id/red-notes/:recordId/review", handler: "AdminInvoiceRedNote.review", availability: "executable" },
      { method: "GET", path: "/order/invoices/:id/red-notes/operations/:requestId", handler: "AdminInvoiceRedNote.operation", availability: "executable" },
    ];
    const calls = routes.map((route) => ({
      method: route.method,
      path: route.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, ":param"),
      source: "view/admin-ts/src/api/invoiceManagement.ts",
      registered: true,
      matchedRoute: route.path,
      matchedHandler: route.handler,
      availability: route.availability,
    }));
    const isManualRoute = (route: { method: string; path: string }) =>
      routes.some((expected) => route.method === expected.method && route.path === expected.path);
    const isManualCall = (call: { method: string; path: string }) =>
      calls.some((expected) => call.method === expected.method && call.path === expected.path);
    expect(historical.backend.registeredRoutes.some(isManualRoute)).toBe(false);
    expect(historical.calls.some(isManualCall)).toBe(false);
    expect(committed.backend.registeredRoutes.filter(isManualRoute).map(withoutLine)).toEqual(routes);
    expect(committed.calls.filter(isManualCall).map(withoutLine)).toEqual(calls);
    expect(semanticCounts(committed.backend.registeredRoutes.filter((route) => !isManualRoute(route))))
      .toEqual(semanticCounts(historical.backend.registeredRoutes));
    expect(semanticCounts(committed.calls.filter((call) => !isManualCall(call))))
      .toEqual(semanticCounts(historical.calls));
    expect(committed.counts).toEqual({
      ...historical.counts,
      callSites: historical.counts.callSites + calls.length,
      pathVariants: historical.counts.pathVariants + calls.length,
      registered: historical.counts.registered + calls.length,
      executable: historical.counts.executable + calls.length,
    });
    expect(committed.methodology).toEqual(historical.methodology);
    expect(committed.backend.file).toBe(historical.backend.file);
    expect(committed.frontendSources).toEqual(historical.frontendSources.map((entry) =>
      entry.file === "view/admin-ts/src/api/invoiceManagement.ts"
        ? { ...entry, sha256: "9678c08907accc39f13a7fcf4e785709b0821ba68264abbaa2a0a37fcc700aec" }
        : entry));
    expect(committed.controlledUnavailable).toEqual(historical.controlledUnavailable);
    expect(committed.unregistered).toEqual(historical.unregistered);
    expect(committed.unresolved).toEqual(historical.unresolved);
  });
});
