import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ANY";

interface RouteRecord {
  method: Method;
  path: string;
  normalizedPath: string;
  source: string;
  line: number;
  target: string;
  kind: "explicit" | "resource";
  unavailable?: boolean;
}

interface GroupRange {
  start: number;
  end: number;
  prefix: string;
}

interface SurfaceDefinition {
  name: string;
  phpFile: string;
  tsFiles: Array<{ file: string; prefix: string }>;
}

interface LegacyRouteDecision {
  surface: string;
  method: Method;
  path: string;
  status: "retired";
  reason: string;
  evidence: string[];
  replacement: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(workerRoot, "..");
const phpRoot = resolve(
  process.env.CINASHOP_PHP_ROOT ?? join(repositoryRoot, "..", "cinashop-php"),
);
const decisionFile = join(workerRoot, "audit", "legacy-route-decisions.json");

const surfaces: SurfaceDefinition[] = [
  {
    name: "api",
    phpFile: "route/api.php",
    tsFiles: [
      { file: "src/routes/v1/index.ts", prefix: "/api" },
      { file: "src/routes/v2/index.ts", prefix: "/api/v2" },
    ],
  },
  {
    name: "admin",
    phpFile: "route/admin.php",
    tsFiles: [{ file: "src/routes/adminapi.ts", prefix: "/adminapi" }],
  },
  {
    name: "supplier",
    phpFile: "route/supplier.php",
    tsFiles: [{ file: "src/routes/supplierapi.ts", prefix: "/supplierapi" }],
  },
  {
    name: "kefu",
    phpFile: "route/kefu.php",
    tsFiles: [{ file: "src/routes/kefuapi.ts", prefix: "/kefuapi" }],
  },
  {
    name: "out",
    phpFile: "route/out.php",
    tsFiles: [{ file: "src/routes/outapi.ts", prefix: "/outapi" }],
  },
  {
    name: "erp",
    phpFile: "route/erp.php",
    tsFiles: [],
  },
];

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function normalizePath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/?/, "/")
    .replace(/\/$/, "") || "/";
  return joined.replace(/\/\[:[^/\]]+\]/g, "/:param?").replace(/\/:[^/]+/g, "/:param");
}

function displayPath(...parts: string[]): string {
  return (
    parts
      .filter(Boolean)
      .join("/")
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/?/, "/")
      .replace(/\/$/, "") || "/"
  );
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = open; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }
    if (current === "{") depth += 1;
    if (current === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unmatched group brace at offset ${open}`);
}

function phpGroups(source: string): GroupRange[] {
  const groups: GroupRange[] = [];
  const pattern = /Route::group\s*\(\s*(?:(['"])(.*?)\1\s*,\s*)?function\s*\([^)]*\)\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf("{");
    groups.push({ start: open, end: matchingBrace(source, open), prefix: match[2] ?? "" });
  }
  return groups;
}

function parsePhpRoutes(file: string): RouteRecord[] {
  const absolute = join(phpRoot, file);
  const source = readFileSync(absolute, "utf8");
  const groups = phpGroups(source);
  const routes: RouteRecord[] = [];
  const pattern = /Route::(get|post|put|delete|patch|any|resource)\s*\(\s*(['"])(.*?)\2\s*,\s*(['"])(.*?)\4/g;

  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const routeType = match[1].toLowerCase();
    const path = match[3];
    const target = match[5];
    const prefixes = groups
      .filter((group) => group.start < offset && offset < group.end)
      .sort((left, right) => left.start - right.start)
      .map((group) => group.prefix);
    const fullPath = displayPath(...prefixes, path);
    const common = {
      source: relative(repositoryRoot, absolute).replace(/\\/g, "/"),
      line: lineAt(source, offset),
      target,
    };

    if (routeType !== "resource") {
      routes.push({
        method: routeType.toUpperCase() as Method,
        path: fullPath,
        normalizedPath: normalizePath(fullPath),
        kind: "explicit",
        ...common,
      });
      continue;
    }

    const statement = source.slice(offset, source.indexOf(";", offset) + 1);
    const actions = ["index", "create", "save", "read", "edit", "update", "delete"];
    const only = statement.match(/->only\s*\(\s*\[([\s\S]*?)\]\s*\)/)?.[1];
    const except = statement.match(/->except\s*\(\s*\[([\s\S]*?)\]\s*\)/)?.[1];
    const names = (value?: string) =>
      new Set([...(value ?? "").matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]));
    const onlyNames = names(only);
    const exceptNames = names(except);
    const enabled = actions.filter(
      (action) => (only ? onlyNames.has(action) : true) && !exceptNames.has(action),
    );
    const definitions: Record<string, { method: Method; suffix: string }> = {
      index: { method: "GET", suffix: "" },
      create: { method: "GET", suffix: "/create" },
      save: { method: "POST", suffix: "" },
      read: { method: "GET", suffix: "/:id" },
      edit: { method: "GET", suffix: "/:id/edit" },
      update: { method: "PUT", suffix: "/:id" },
      delete: { method: "DELETE", suffix: "/:id" },
    };
    for (const action of enabled) {
      const definition = definitions[action];
      const resourcePath = `${fullPath}${definition.suffix}`;
      routes.push({
        method: definition.method,
        path: resourcePath,
        normalizedPath: normalizePath(resourcePath),
        kind: "resource",
        ...common,
      });
    }
  }
  return routes;
}

function closingCall(source: string, start: number): number {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    const current = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      continue;
    }
    if (current === "(") depth += 1;
    if (current === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function parseTsRoutes(file: string, prefix: string): RouteRecord[] {
  const absolute = join(workerRoot, file);
  const source = readFileSync(absolute, "utf8");
  const routes: RouteRecord[] = [];
  const pattern = /\b[A-Za-z][A-Za-z0-9_]*Routes\.(get|post|put|delete|patch|all)\s*\(\s*(['"])(.*?)\2/g;
  for (const match of source.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const end = closingCall(source, offset);
    const statement = source.slice(offset, end + 1);
    const method = match[1] === "all" ? "ANY" : (match[1].toUpperCase() as Method);
    const path = displayPath(prefix, match[3]);
    routes.push({
      method,
      path,
      normalizedPath: normalizePath(path),
      source: relative(repositoryRoot, absolute).replace(/\\/g, "/"),
      line: lineAt(source, offset),
      target: statement.replace(/\s+/g, " ").slice(0, 240),
      kind: "explicit",
      unavailable: /Unavailable|notImplemented|status:\s*501|\b501\b/.test(statement),
    });
  }
  return routes;
}

function unique(routes: RouteRecord[]): RouteRecord[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = `${route.method} ${route.normalizedPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function key(route: RouteRecord): string {
  return `${route.method} ${route.normalizedPath}`;
}

function decisionKey(decision: LegacyRouteDecision): string {
  return `${decision.method} ${normalizePath(decision.path)}`;
}

function loadRouteDecisions(): LegacyRouteDecision[] {
  const parsed = JSON.parse(readFileSync(decisionFile, "utf8")) as {
    version?: unknown;
    decisions?: unknown;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.decisions)) {
    throw new Error(`Invalid legacy route decision manifest: ${decisionFile}`);
  }
  const decisions = parsed.decisions as LegacyRouteDecision[];
  const seen = new Set<string>();
  const evidenceExists = (reference: string): boolean => {
    const match = /^(cinashop-php\/[A-Za-z0-9_./-]+):(\d+)$/.exec(reference);
    if (!match) return false;
    const absolute = resolve(repositoryRoot, "..", match[1]);
    if (!existsSync(absolute)) return false;
    const line = Number(match[2]);
    return Number.isSafeInteger(line) && line > 0 && line <= readFileSync(absolute, "utf8").split("\n").length;
  };
  for (const decision of decisions) {
    if (
      decision.status !== "retired" ||
      !surfaces.some((surface) => surface.name === decision.surface) ||
      !["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"].includes(decision.method) ||
      !decision.path.startsWith("/") ||
      !decision.reason?.trim() ||
      !decision.replacement?.trim() ||
      !Array.isArray(decision.evidence) ||
      decision.evidence.length === 0 ||
      decision.evidence.some((item) => !item?.trim() || !evidenceExists(item))
    ) {
      throw new Error(`Invalid retired route decision: ${JSON.stringify(decision)}`);
    }
    const manifestKey = `${decision.surface} ${decisionKey(decision)}`;
    if (seen.has(manifestKey)) throw new Error(`Duplicate retired route decision: ${manifestKey}`);
    seen.add(manifestKey);
  }
  return decisions;
}

if (!existsSync(join(phpRoot, "route", "api.php"))) {
  throw new Error(`PHP source not found at ${phpRoot}; set CINASHOP_PHP_ROOT`);
}

const routeDecisions = loadRouteDecisions();

const reports = surfaces.map((surface) => {
  const php = unique(parsePhpRoutes(surface.phpFile));
  const ts = unique(surface.tsFiles.flatMap(({ file, prefix }) => parseTsRoutes(file, prefix)));
  const tsByKey = new Map(ts.filter((route) => !route.path.includes("*")).map((route) => [key(route), route]));
  const matched = php.filter((route) => tsByKey.has(key(route)));
  const unavailable = matched.filter((route) => tsByKey.get(key(route))?.unavailable);
  const missing = php.filter((route) => !tsByKey.has(key(route)));
  const surfaceDecisions = routeDecisions.filter((decision) => decision.surface === surface.name);
  const phpByKey = new Map(php.map((route) => [key(route), route]));
  const retired = surfaceDecisions.map((decision) => {
    const route = phpByKey.get(decisionKey(decision));
    if (!route) {
      throw new Error(
        `Retired route decision no longer matches PHP authority: ${surface.name} ${decisionKey(decision)}`,
      );
    }
    if (tsByKey.has(key(route))) {
      throw new Error(`Retired route is also registered in TypeScript: ${surface.name} ${key(route)}`);
    }
    return { ...route, decision };
  });
  const retiredKeys = new Set(retired.map((route) => key(route)));
  const actionableMissing = missing.filter((route) => !retiredKeys.has(key(route)));
  const additions = ts.filter((route) => !route.path.includes("*") && !php.some((item) => key(item) === key(route)));
  const effectivePhp = php.length - retired.length;
  return {
    surface: surface.name,
    php: php.length,
    ts: ts.filter((route) => !route.path.includes("*")).length,
    matched: matched.length,
    executableMatched: matched.length - unavailable.length,
    unavailable: unavailable.length,
    missing: missing.length,
    retired: retired.length,
    actionableMissing: actionableMissing.length,
    coveragePercent: Number(((matched.length / Math.max(php.length, 1)) * 100).toFixed(1)),
    executableCoveragePercent: Number(
      (((matched.length - unavailable.length) / Math.max(php.length, 1)) * 100).toFixed(1),
    ),
    effectiveExecutableCoveragePercent: Number(
      (((matched.length - unavailable.length) / Math.max(effectivePhp, 1)) * 100).toFixed(1),
    ),
    missingRoutes: missing,
    actionableMissingRoutes: actionableMissing,
    retiredRoutes: retired,
    unavailableRoutes: unavailable.map((route) => ({
      ...route,
      tsTarget: tsByKey.get(key(route))?.target,
    })),
    additions,
  };
});

const totals = reports.reduce(
  (result, report) => ({
    php: result.php + report.php,
    ts: result.ts + report.ts,
    matched: result.matched + report.matched,
    executableMatched: result.executableMatched + report.executableMatched,
    unavailable: result.unavailable + report.unavailable,
    missing: result.missing + report.missing,
    retired: result.retired + report.retired,
    actionableMissing: result.actionableMissing + report.actionableMissing,
  }),
  {
    php: 0,
    ts: 0,
    matched: 0,
    executableMatched: 0,
    unavailable: 0,
    missing: 0,
    retired: 0,
    actionableMissing: 0,
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      phpRoot,
      workerRoot,
      totals: {
        ...totals,
        coveragePercent: Number(((totals.matched / Math.max(totals.php, 1)) * 100).toFixed(1)),
        executableCoveragePercent: Number(
          ((totals.executableMatched / Math.max(totals.php, 1)) * 100).toFixed(1),
        ),
        effectiveExecutableCoveragePercent: Number(
          ((totals.executableMatched / Math.max(totals.php - totals.retired, 1)) * 100).toFixed(1),
        ),
      },
      surfaces: reports,
      limitations: [
        "Static route registration coverage does not prove response, permission, state-machine, data, or third-party parity.",
        "ThinkPHP resource routes are expanded to the standard seven REST actions after only/except filters.",
        "Wildcard 501 fallbacks never count as migrated routes.",
        "Routes wired to handlers named *Unavailable or containing an inline 501 are registered but not executable.",
        "Retired routes remain in the raw PHP denominator and missing count; effective coverage excludes only manifest entries with source evidence and a replacement.",
      ],
    },
    null,
    2,
  )}\n`,
);
