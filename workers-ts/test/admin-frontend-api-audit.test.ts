import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAdminFrontendApiAuditReport } from "../scripts/admin-frontend-api-audit";

interface ApiAuditReport {
  version: number;
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
    registered: boolean;
    matchedRoute: string | null;
    matchedHandler: string | null;
    availability: "executable" | "controlled_unavailable" | "unregistered";
  }>;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(testDir, "..");
const committed = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts.json"),
  "utf8",
)) as ApiAuditReport;

describe("Admin frontend API registration audit", () => {
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
});
