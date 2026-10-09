"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const BASELINE_PATH = resolve(__dirname, "d3-advisory-gate.baseline.json");
const SEVERITIES = new Set(["low", "moderate", "high", "critical"]);
const GHSA_URL = /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function strings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a nonempty-string array`);
  }
  const result = [...value].sort();
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function sources(value, label) {
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item) || item <= 0)) {
    throw new Error(`${label} must be a positive-integer array`);
  }
  const result = [...value].sort((a, b) => a - b);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function normalizeAudit(report, reviewedAdvisories) {
  object(report, "npm audit report");
  const raw = object(report.vulnerabilities, "npm audit vulnerabilities");
  const advisories = Object.create(null);
  const entries = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    const item = object(value, `vulnerability ${name}`);
    if (item.name !== name || !SEVERITIES.has(item.severity) || typeof item.isDirect !== "boolean"
      || typeof item.range !== "string" || !item.range || !Array.isArray(item.via)
      || item.via.length === 0) throw new Error(`invalid vulnerability entry ${name}`);
    const nodes = strings(item.nodes, `${name}.nodes`);
    if (!nodes.length || nodes.some((node) => !/(?:^|\/)node_modules\//.test(node)
      || node.includes("\\") || node.split("/").includes(".."))) {
      throw new Error(`invalid package path for ${name}`);
    }
    const viaPackages = [];
    const advisorySources = [];
    for (const via of item.via) {
      if (typeof via === "string") {
        viaPackages.push(via);
        continue;
      }
      const record = object(via, `${name}.via`);
      if (!Number.isSafeInteger(record.source) || record.source <= 0 || record.name !== name
        || record.dependency !== name || !GHSA_URL.test(record.url)
        || !SEVERITIES.has(record.severity) || typeof record.range !== "string" || !record.range) {
        throw new Error(`invalid direct advisory on ${name}`);
      }
      const id = String(record.source);
      if (advisories[id]) throw new Error(`duplicate direct advisory source ${id}`);
      const reviewed = reviewedAdvisories[id];
      if (!reviewed) throw new Error(`unknown direct advisory ${id} on ${name}`);
      advisories[id] = { package: name, url: record.url, severity: record.severity,
        range: record.range, chain: reviewed.chain };
      advisorySources.push(record.source);
    }
    entries[name] = { severity: item.severity, isDirect: item.isDirect, range: item.range,
      nodes, viaPackages: strings(viaPackages, `${name}.viaPackages`),
      advisorySources: sources(advisorySources, `${name}.advisorySources`),
      effects: strings(item.effects, `${name}.effects`) };
  }
  // npm can report a dependency cycle (notably Vue and its server renderer).
  // Propagate source chains to a fixed point instead of treating that cycle as
  // an error or silently leaving one of its affected package entries untyped.
  const chainSets = Object.create(null);
  for (const [name, item] of Object.entries(entries)) {
    chainSets[name] = new Set(item.advisorySources.map((id) => advisories[String(id)].chain));
    for (const parent of item.viaPackages) if (!entries[parent]) {
      throw new Error(`unknown propagated package ${parent} via ${name}`);
    }
  }
  let changed;
  do {
    changed = false;
    for (const [name, item] of Object.entries(entries)) for (const parent of item.viaPackages) {
      for (const chain of chainSets[parent]) if (!chainSets[name].has(chain)) {
        chainSets[name].add(chain);
        changed = true;
      }
    }
  } while (changed);
  for (const [name, item] of Object.entries(entries)) {
    if (!chainSets[name].size) throw new Error(`unclassified vulnerable package ${name}`);
    item.chains = [...chainSets[name]].sort();
  }
  const metadata = object(report.metadata, "npm audit metadata");
  const counts = object(metadata.vulnerabilities, "npm audit metadata.vulnerabilities");
  const actual = { low: 0, moderate: 0, high: 0, critical: 0 };
  for (const item of Object.values(entries)) actual[item.severity]++;
  if (counts.total !== Object.keys(entries).length || Object.keys(actual).some((key) => counts[key] !== actual[key])) {
    throw new Error("npm audit affected-package metadata disagrees with entries");
  }
  return { advisories, entries };
}

function compareMaps(actual, expected, label, issues) {
  for (const key of Object.keys(expected).sort()) {
    if (!Object.hasOwn(actual, key)) issues.push(`${label} disappeared without baseline review: ${key}`);
    else if (!isDeepStrictEqual(actual[key], expected[key])) {
      issues.push(`${label} changed: ${key}`);
    }
  }
  for (const key of Object.keys(actual).sort()) {
    if (!Object.hasOwn(expected, key)) issues.push(`unknown ${label}: ${key}`);
  }
}

function entryFingerprint(entry) {
  // npm recalculates propagated semver ranges and reverse `effects` even when
  // the lock, direct advisories, and forward dependency paths are unchanged.
  // The fields below capture every installed node and path into an advisory.
  return { severity: entry.severity, isDirect: entry.isDirect, nodes: entry.nodes,
    viaPackages: entry.viaPackages, advisorySources: entry.advisorySources, chains: entry.chains };
}

function evaluateAudit(report, baseline) {
  const issues = [];
  try {
    object(baseline, "reviewed baseline");
    if (baseline.schemaVersion !== 1) throw new Error("unsupported reviewed baseline version");
    const reviewed = object(baseline.advisories, "reviewed advisories");
    const expectedEntries = object(baseline.entries, "reviewed package entries");
    const resolved = object(baseline.resolvedAdvisories, "resolved advisories");
    const chainDefinitions = object(baseline.chains, "reviewed chains");
    for (const [id, record] of Object.entries(reviewed)) {
      if (!Number.isSafeInteger(Number(id)) || !Object.hasOwn(chainDefinitions, record.chain)) {
        throw new Error(`unclassified reviewed advisory ${id}`);
      }
    }
    const seenSources = [];
    for (const item of Object.values(object(report.vulnerabilities, "npm audit vulnerabilities"))) {
      if (!Array.isArray(item?.via)) continue;
      for (const via of item.via) if (via && typeof via === "object" && Number.isSafeInteger(via.source)) {
        seenSources.push(String(via.source));
      }
    }
    for (const id of seenSources) if (Object.hasOwn(resolved, id)) {
      issues.push(`resolved advisory reappeared: ${id} (${resolved[id].package})`);
    }
    const actual = normalizeAudit(report, reviewed);
    compareMaps(actual.advisories, reviewed, "direct advisory", issues);
    compareMaps(Object.fromEntries(Object.entries(actual.entries).map(([key, entry]) => [key, entryFingerprint(entry)])),
      Object.fromEntries(Object.entries(expectedEntries).map(([key, entry]) => [key, entryFingerprint(entry)])),
      "affected package entry", issues);
    const unknownChains = new Set(Object.values(actual.entries).flatMap((entry) => entry.chains)
      .filter((chain) => !Object.hasOwn(chainDefinitions, chain)));
    for (const chain of unknownChains) issues.push(`unknown scoped chain: ${chain}`);
    return { ok: issues.length === 0, issues, packageEntries: Object.keys(actual.entries).length,
      directAdvisoryObjects: Object.keys(actual.advisories).length,
      distinctAdvisoryUrls: new Set(Object.values(actual.advisories).map((item) => item.url)).size,
      scopedChains: Object.keys(chainDefinitions).length };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return { ok: false, issues };
  }
}

function loadJson(path) { return JSON.parse(readFileSync(path, "utf8")); }

function liveAudit() {
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = windows ? ["/d", "/s", "/c", "npm audit --package-lock-only --json --registry=https://registry.npmjs.org"]
    : ["audit", "--package-lock-only", "--json", "--registry=https://registry.npmjs.org"];
  const result = spawnSync(command, args,
    { cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 120000,
      maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`npm audit failed with status ${result.status}: ${(result.stderr || "").slice(0, 500)}`);
  }
  try {
    const report = JSON.parse(result.stdout);
    if (!report.vulnerabilities && typeof report.message === "string") {
      throw new Error(`npm audit unavailable: ${report.message}`);
    }
    return report;
  }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("npm audit unavailable:")) throw error;
    throw new Error(`npm audit did not return JSON: ${(result.stderr || "").slice(0, 500)}`);
  }
}

function main(argv) {
  if (argv.length !== 1 && !(argv.length === 2 && argv[0] === "--fixture")) {
    throw new Error("usage: node scripts/d3-advisory-gate.cjs --live | --fixture <npm-audit.json>");
  }
  const baseline = loadJson(BASELINE_PATH);
  const lockSha256 = createHash("sha256").update(readFileSync(resolve(__dirname, "../package-lock.json"))).digest("hex");
  if (baseline.lockSha256 !== lockSha256) {
    throw new Error(`package-lock.json SHA-256 changed: ${lockSha256}; review and update the D3 baseline`);
  }
  const report = argv[0] === "--live" && argv.length === 1 ? liveAudit()
    : argv[0] === "--fixture" ? loadJson(resolve(argv[1]))
      : (() => { throw new Error("unknown mode"); })();
  const result = evaluateAudit(report, baseline);
  if (!result.ok) {
    for (const issue of result.issues) process.stderr.write(`D3 advisory gate: ${issue}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`D3 advisory coverage passed: ${result.packageEntries} affected package entries, `
    + `${result.directAdvisoryObjects} direct advisory objects, ${result.distinctAdvisoryUrls} distinct advisory URLs, `
    + `${result.scopedChains} reviewed chains. These are not counts of independent vulnerabilities.\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`D3 advisory gate: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { evaluateAudit, normalizeAudit, main };
