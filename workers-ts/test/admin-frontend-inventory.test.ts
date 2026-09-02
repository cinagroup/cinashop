import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface RouteEntry {
  path: string;
  component: string;
  resolvedComponent: string | null;
  surface: "page" | "auxiliary" | "layout" | "other";
}

interface InventorySide {
  routeFiles: Array<{ file: string; sha256: string }>;
  pageVueFiles: string[];
  routes: RouteEntry[];
  unresolvedComponents: string[];
  unroutedPageFiles: string[];
  counts: {
    pageVueFiles: number;
    routeRecords: number;
    businessPageRouteRecords: number;
    distinctRoutedPageComponents: number;
    auxiliaryRouteRecords: number;
    layoutRouteRecords: number;
    otherRouteRecords: number;
    unresolvedComponents: number;
    unroutedPageFiles: number;
  };
}

interface InventoryReport {
  version: number;
  legacy: InventorySide;
  target: InventorySide;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(testDir, "..");
const repositoryRoot = resolve(workerRoot, "..");
const adminRoot = join(repositoryRoot, "view", "admin-ts");
const report = JSON.parse(
  readFileSync(join(workerRoot, "audit", "admin-frontend-inventory.json"), "utf8"),
) as InventoryReport;

function listVueFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      if (statSync(file).isDirectory()) visit(file);
      else if (extname(file).toLowerCase() === ".vue") {
        files.push(relative(adminRoot, file).replace(/\\/g, "/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

function sha256(file: string): string {
  const canonicalText = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonicalText).digest("hex");
}

function assertInternallyConsistent(side: InventorySide) {
  expect(side.routes).toHaveLength(side.counts.routeRecords);
  expect(side.pageVueFiles).toHaveLength(side.counts.pageVueFiles);
  expect(side.routes.filter((route) => route.surface === "page")).toHaveLength(
    side.counts.businessPageRouteRecords,
  );
  expect(new Set(
    side.routes
      .filter((route) => route.surface === "page" && route.resolvedComponent)
      .map((route) => route.resolvedComponent),
  ).size).toBe(side.counts.distinctRoutedPageComponents);
  expect(side.routes.filter((route) => route.surface === "auxiliary")).toHaveLength(
    side.counts.auxiliaryRouteRecords,
  );
  expect(side.routes.filter((route) => route.surface === "layout")).toHaveLength(
    side.counts.layoutRouteRecords,
  );
  expect(side.routes.filter((route) => route.surface === "other")).toHaveLength(
    side.counts.otherRouteRecords,
  );
  expect(side.unresolvedComponents).toHaveLength(side.counts.unresolvedComponents);
  expect(side.unroutedPageFiles).toHaveLength(side.counts.unroutedPageFiles);
}

describe("Admin frontend navigation inventory", () => {
  it("keeps the committed legacy authority snapshot internally consistent", () => {
    expect(report.version).toBe(1);
    assertInternallyConsistent(report.legacy);
    expect(report.legacy.routeFiles.length).toBeGreaterThan(1);
    expect(new Set(report.legacy.routeFiles.map((entry) => entry.file)).size).toBe(
      report.legacy.routeFiles.length,
    );
    expect(report.legacy.counts.unresolvedComponents).toBe(0);
  });

  it("fails when target pages or router records drift from the committed audit", () => {
    assertInternallyConsistent(report.target);
    expect(report.target.pageVueFiles).toEqual(
      listVueFiles(join(adminRoot, "src", "pages")),
    );
    expect(report.target.counts.unresolvedComponents).toBe(0);

    for (const entry of report.target.routeFiles) {
      const file = join(adminRoot, entry.file);
      expect(existsSync(file), entry.file).toBe(true);
      expect(sha256(file), entry.file).toBe(entry.sha256);
    }
    for (const route of report.target.routes) {
      if (!route.resolvedComponent) continue;
      expect(existsSync(join(adminRoot, route.resolvedComponent)), route.path).toBe(true);
    }
  });
});
