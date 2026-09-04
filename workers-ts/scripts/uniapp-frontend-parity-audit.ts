import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_ROUTE_RULES,
  REGISTERED_PAGE_ROUTES,
} from "../../view/uniapp-ts/src/config/navigation";

interface ManifestPage { path: string }
interface ManifestPackage { root: string; pages: ManifestPage[] }
interface Manifest { pages: ManifestPage[]; subPackages?: ManifestPackage[] }
interface Gap { id: string; legacyRoutes: string[] }
interface Audit {
  counting: {
    legacy: { logicalManifestRouteRecords: number; manifestSha256: string };
    target: { logicalManifestRouteRecords: number; manifestSha256: string };
    routeLedger: Record<string, number>;
  };
  directRegisteredLegacyRoutes: string[];
  gaps: Gap[];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const legacyManifestPath = resolve(
  process.env.LEGACY_UNIAPP_MANIFEST ?? resolve(repoRoot, "../cinashop-php/view/uniapp/pages.json"),
);
const targetManifestPath = resolve(repoRoot, "view/uniapp-ts/src/pages.json");
const auditPath = resolve(repoRoot, "workers-ts/audit/uniapp-frontend-parity.json");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function stripJsonComments(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        blockComment = false;
      } else {
        result += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (!inString && char === "/" && next === "/") {
      result += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    if (!inString && char === "/" && next === "*") {
      result += "  ";
      index += 1;
      blockComment = true;
      continue;
    }
    result += char;
    if (!inString && char === '"') {
      inString = true;
      escaped = false;
    } else if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    }
  }
  return result;
}

function parseManifest(raw: string, comments: boolean): Manifest {
  return JSON.parse(comments ? stripJsonComments(raw) : raw) as Manifest;
}

function manifestRoutes(manifest: Manifest): string[] {
  return [
    ...manifest.pages.map((page) => `/${page.path}`),
    ...(manifest.subPackages ?? []).flatMap((item) =>
      item.pages.map((page) => `/${item.root}/${page.path}`)),
  ];
}

function assertUnique(label: string, values: string[]): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length) throw new Error(`${label} contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
}

if (!existsSync(legacyManifestPath) || !statSync(legacyManifestPath).isFile()) {
  throw new Error(`Legacy UniApp manifest not found: ${legacyManifestPath}`);
}

const legacyRaw = readFileSync(legacyManifestPath, "utf8");
const targetRaw = readFileSync(targetManifestPath, "utf8");
const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Audit;
const legacyRoutes = manifestRoutes(parseManifest(legacyRaw, true));
const targetRoutes = manifestRoutes(parseManifest(targetRaw, false));
const mappedRoutes = Object.keys(LEGACY_ROUTE_RULES);
const gapRoutes = audit.gaps.flatMap((gap) => gap.legacyRoutes);
const accounted = [
  ...audit.directRegisteredLegacyRoutes,
  ...mappedRoutes,
  ...gapRoutes,
];

assertUnique("legacy manifest", legacyRoutes);
assertUnique("target manifest", targetRoutes);
assertUnique("migration ledger", accounted);

const expectedLegacy = [...legacyRoutes].sort();
const actualLegacy = [...accounted].sort();
if (JSON.stringify(expectedLegacy) !== JSON.stringify(actualLegacy)) {
  const missing = expectedLegacy.filter((route) => !actualLegacy.includes(route));
  const extra = actualLegacy.filter((route) => !expectedLegacy.includes(route));
  throw new Error(`Legacy route ledger drift; missing=${missing.join(",")}; extra=${extra.join(",")}`);
}

const registered = [...REGISTERED_PAGE_ROUTES].sort();
if (JSON.stringify([...targetRoutes].sort()) !== JSON.stringify(registered)) {
  throw new Error("REGISTERED_PAGE_ROUTES is not in lock-step with target pages.json");
}

for (const [source, rule] of Object.entries(LEGACY_ROUTE_RULES)) {
  if (!REGISTERED_PAGE_ROUTES.has(rule.target)) {
    throw new Error(`Legacy route ${source} maps to an unregistered target ${rule.target}`);
  }
}

if (sha256(legacyRaw) !== audit.counting.legacy.manifestSha256) {
  throw new Error("Legacy manifest SHA-256 changed; recount and review the route ledger");
}
if (sha256(targetRaw) !== audit.counting.target.manifestSha256) {
  throw new Error("Target manifest SHA-256 changed; recount and review registered routes");
}
if (legacyRoutes.length !== audit.counting.legacy.logicalManifestRouteRecords) {
  throw new Error("Legacy manifest route count does not match the audit artifact");
}
if (targetRoutes.length !== audit.counting.target.logicalManifestRouteRecords) {
  throw new Error("Target manifest route count does not match the audit artifact");
}

const candidate = Object.values(LEGACY_ROUTE_RULES)
  .filter((rule) => rule.coverage === "candidate_covered").length;
const partial = Object.values(LEGACY_ROUTE_RULES)
  .filter((rule) => rule.coverage === "partial_replacement").length;
const result = {
  ok: true,
  legacyManifest: legacyManifestPath,
  targetManifest: targetManifestPath,
  counts: {
    legacyLogicalRoutes: legacyRoutes.length,
    targetRoutes: targetRoutes.length,
    directRegistered: audit.directRegisteredLegacyRoutes.length,
    legacyCompatibilityRules: mappedRoutes.length,
    candidateCoveredRules: candidate,
    partialReplacementRules: partial,
    gaps: gapRoutes.length,
  },
  gapGroups: audit.gaps.map((gap) => ({ id: gap.id, routes: gap.legacyRoutes.length })),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
