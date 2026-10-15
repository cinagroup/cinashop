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
    rootRouteSources?: Array<{ file: string; sha256: string }>;
    registeredRoutes: Array<{
      source?: string;
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
const guestFollowupRaw = readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-guest-invoice-manual-red-note-followup-20261013.json"), "utf8");
const guestFollowup = JSON.parse(guestFollowupRaw) as ApiAuditReport;
const current = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts.json"), "utf8")) as ApiAuditReport;
const merged = JSON.parse(readFileSync(
  join(workerRoot, "audit", "admin-frontend-api-contracts-merged-work-branches-20261015.json"), "utf8")) as ApiAuditReport;
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
    expect(current.version).toBe(2);
    expect(current.counts.callSites).toBeGreaterThan(250);
    expect(current.counts.pathVariants).toBe(current.calls.length);
    expect(current.counts.registered).toBe(current.calls.length);
    expect(current.counts.executable + current.counts.controlledUnavailable).toBe(current.calls.length);
    expect(current.counts.controlledUnavailable).toBe(current.controlledUnavailable.length);
    expect(current.counts.unregistered).toBe(0);
    expect(current.counts.unresolved).toBe(0);
    expect(current.unregistered).toEqual([]);
    expect(current.unresolved).toEqual([]);
    expect(current.calls.every((call) => call.registered && call.matchedRoute && call.matchedHandler)).toBe(true);
  });

  it("recomputes the same deterministic report from the current frontend and routes", () => {
    expect(buildAdminFrontendApiAuditReport()).toEqual(current);
    expect(current).toEqual(merged);
  });

  it("expands the moderation mode type alias into both registered form routes", () => {
    const forms = current.calls.filter(call => call.source === "view/admin-ts/src/api/productModeration.ts"
      && call.method === "GET" && /^\/product\/product\/(verify|remove)\/:param$/.test(call.path));
    expect(forms.map(call => ({ path: call.path, route: call.matchedRoute, handler: call.matchedHandler,
      registered: call.registered, availability: call.availability }))).toEqual([
      { path: "/product/product/verify/:param", route: "/product/product/verify/:id",
        handler: "AdminProductModeration.verifyForm", registered: true, availability: "executable" },
      { path: "/product/product/remove/:param", route: "/product/product/remove/:id",
        handler: "AdminProductModeration.removeForm", registered: true, availability: "executable" },
    ]);
  });

  it('accounts for all six durable video upload endpoints through their actual Admin handlers', () => {
    const actual=current.calls.filter(call=>call.source==='view/admin-ts/src/api/productVideoUpload.ts')
      .map(call=>({method:call.method,path:call.path,route:call.matchedRoute,handler:call.matchedHandler,
        registered:call.registered,availability:call.availability})).sort((a,b)=>(a.method+a.path).localeCompare(b.method+b.path));
    const expected=[
      ['GET','/file/video_uploads/:param','/file/video_uploads/:uploadId','query'],
      ['GET','/file/video_uploads/:param/preview','/file/video_uploads/:uploadId/preview','preview'],
      ['POST','/file/video_uploads/:param','/file/video_uploads/:uploadId','initialize'],
      ['POST','/file/video_uploads/:param/cancel','/file/video_uploads/:uploadId/cancel','cancel'],
      ['POST','/file/video_uploads/:param/complete','/file/video_uploads/:uploadId/complete','complete'],
      ['PUT','/file/video_uploads/:param/parts/:param','/file/video_uploads/:uploadId/parts/:part','part'],
    ].map(([method,path,route,handler])=>({method,path,route,handler:'AdminProductVideo.'+handler,registered:true,availability:'executable'}))
      .sort((a,b)=>(a.method+a.path).localeCompare(b.method+b.path));
    expect(actual).toEqual(expected);
  });

  it("resolves the absolute ERP consumer through the real mounted v1 Admin root and pins every source", () => {
    expect(current.calls.find(call => call.method === "GET" && call.path === "/api/admin/erp/config"))
      .toMatchObject({ source: "view/admin-ts/src/api/productStock.ts", registered: true,
        matchedRoute: "/api/admin/erp/config", matchedHandler: "AdminController.adminErpConfig", availability: "executable" });
    const route = current.backend.registeredRoutes.find(route => route.method === "GET" && route.path === "/api/admin/erp/config");
    expect(route).toMatchObject({ source: "workers-ts/src/routes/v1/index.ts", handler: "AdminController.adminErpConfig" });
    expect(route?.line).toBeGreaterThan(0);
    expect(current.backend.rootRouteSources?.map(source => source.file)).toEqual([
      "workers-ts/src/app.ts", "workers-ts/src/routes/index.ts", "workers-ts/src/routes/v1/index.ts",
    ]);
    for (const source of current.backend.rootRouteSources ?? []) {
      const text = readFileSync(join(workerRoot, "..", source.file), "utf8");
      expect(source.sha256).toBe(createHash("sha256").update(normalizeAdminAuditSource(text)).digest("hex"));
    }
    expect(current.backend.registeredRoutes.some(route => route.path === "/api/v1/admin/erp/config")).toBe(false);
  });

  it("retains the reviewed October 9 inventory and adds exactly the four manual red-note API contracts", () => {
    expect(createHash("sha256").update(normalizeAdminAuditSource(guestFollowupRaw)).digest("hex"))
      .toBe("570b1f0ae132e3fd9b52ace2d7d6ecfceb31f1bd38d0d36c9c144b6c2320611e");
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
    expect(guestFollowup.backend.registeredRoutes.filter(isManualRoute).map(withoutLine)).toEqual(routes);
    expect(guestFollowup.calls.filter(isManualCall).map(withoutLine)).toEqual(calls);
    expect(semanticCounts(guestFollowup.backend.registeredRoutes.filter((route) => !isManualRoute(route))))
      .toEqual(semanticCounts(historical.backend.registeredRoutes));
    expect(semanticCounts(guestFollowup.calls.filter((call) => !isManualCall(call))))
      .toEqual(semanticCounts(historical.calls));
    expect(guestFollowup.counts).toEqual({
      ...historical.counts,
      callSites: historical.counts.callSites + calls.length,
      pathVariants: historical.counts.pathVariants + calls.length,
      registered: historical.counts.registered + calls.length,
      executable: historical.counts.executable + calls.length,
    });
    expect(guestFollowup.methodology).toEqual(historical.methodology);
    expect(guestFollowup.backend.file).toBe(historical.backend.file);
    expect(guestFollowup.frontendSources).toEqual(historical.frontendSources.map((entry) =>
      entry.file === "view/admin-ts/src/api/invoiceManagement.ts"
        ? { ...entry, sha256: "9678c08907accc39f13a7fcf4e785709b0821ba68264abbaa2a0a37fcc700aec" }
        : entry));
    expect(guestFollowup.controlledUnavailable).toEqual(historical.controlledUnavailable);
    expect(guestFollowup.unregistered).toEqual(historical.unregistered);
    expect(guestFollowup.unresolved).toEqual(historical.unresolved);
  });
});
