"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { delimiter, join, resolve } = require("node:path");
const test = require("node:test");
const { evaluateAudit } = require("./d3-advisory-gate.cjs");

const baseline = JSON.parse(readFileSync(resolve(__dirname, "d3-advisory-gate.baseline.json"), "utf8"));

function reviewedFixture() {
  const vulnerabilities = Object.create(null);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, entry] of Object.entries(baseline.entries)) {
    vulnerabilities[name] = { name, severity: entry.severity, isDirect: entry.isDirect,
      range: entry.range, nodes: [...entry.nodes], effects: [...entry.effects],
      via: [...entry.viaPackages, ...entry.advisorySources.map((source) => {
        const advisory = baseline.advisories[String(source)];
        return { source, name, dependency: name, url: advisory.url,
          severity: advisory.severity, range: advisory.range };
      })] };
    counts[entry.severity]++;
    counts.total++;
  }
  return { vulnerabilities, metadata: { vulnerabilities: counts } };
}

function refreshMetadata(fixture) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of Object.values(fixture.vulnerabilities)) {
    counts[entry.severity]++;
    counts.total++;
  }
  fixture.metadata.vulnerabilities = counts;
}

function rejected(fixture, fragment) {
  const result = evaluateAudit(fixture, baseline);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes(fragment)), JSON.stringify(result.issues));
}

test("reviewed package entries each resolve to a scoped advisory chain", () => {
  assert.equal(Object.keys(baseline.entries).length, 82);
  assert.equal(Object.keys(baseline.advisories).length, 23);
  assert.equal(Object.keys(baseline.resolvedAdvisories).length, 9);
  assert.ok(Object.values(baseline.entries).every((entry) => entry.chains.length > 0
    && entry.chains.every((chain) => Object.hasOwn(baseline.chains, chain))));
  const result = evaluateAudit(reviewedFixture(), baseline);
  assert.deepEqual(result.issues, []);
  assert.equal(result.directAdvisoryObjects, 23);
  assert.equal(result.distinctAdvisoryUrls, 22);
});

test("reviewed lock fingerprint is stable across Git checkout line endings", () => {
  const text = readFileSync(resolve(__dirname, "../package-lock.json"), "utf8");
  const fingerprint = (value) => createHash("sha256").update(JSON.stringify(JSON.parse(value))).digest("hex");
  assert.equal(fingerprint(text), baseline.lockSemanticSha256);
  assert.equal(fingerprint(text.replace(/\r?\n/g, "\n")), baseline.lockSemanticSha256);
  assert.equal(fingerprint(text.replace(/\r?\n/g, "\r\n")), baseline.lockSemanticSha256);
});

test("unknown direct advisory and a changed existing advisory fail closed", () => {
  const added = reviewedFixture();
  added.vulnerabilities.braces.via.push({ source: 9999999, name: "braces", dependency: "braces",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "*" });
  rejected(added, "unknown direct advisory 9999999");

  const changed = reviewedFixture();
  const record = changed.vulnerabilities.braces.via.find((via) => typeof via === "object");
  record.range = "<3.0.3";
  rejected(changed, "direct advisory changed");
});

test("new propagated package, new node path, and changed propagation are rejected", () => {
  const added = reviewedFixture();
  added.vulnerabilities["new-glob-wrapper"] = { name: "new-glob-wrapper", severity: "high",
    isDirect: false, range: "*", nodes: ["node_modules/new-glob-wrapper"],
    effects: [], via: ["braces"] };
  refreshMetadata(added);
  rejected(added, "unknown affected package entry: new-glob-wrapper");

  const path = reviewedFixture();
  path.vulnerabilities.braces.nodes.push("node_modules/other/node_modules/braces");
  rejected(path, "affected package entry changed: braces");

  const edge = reviewedFixture();
  edge.vulnerabilities.chokidar.via = ["micromatch"];
  rejected(edge, "affected package entry changed: chokidar");
});

test("npm-only propagated range and reverse effects changes do not change the scoped chain", () => {
  const fixture = reviewedFixture();
  fixture.vulnerabilities.jest.range = "24.2.0-alpha.0 - 30.2.0";
  fixture.vulnerabilities["@jest/environment"].effects.pop();
  assert.equal(evaluateAudit(fixture, baseline).ok, true);
});

test("all nine resolved advisory source IDs remain forbidden", () => {
  const fixture = reviewedFixture();
  for (const [source, record] of Object.entries(baseline.resolvedAdvisories)) {
    const name = record.package;
    if (!fixture.vulnerabilities[name]) fixture.vulnerabilities[name] = {
      name, severity: "moderate", isDirect: false, range: "*",
      nodes: [`node_modules/${name}`], effects: [], via: [] };
    fixture.vulnerabilities[name].via.push({ source: Number(source), name, dependency: name,
      url: record.url, severity: "moderate", range: "*" });
    refreshMetadata(fixture);
    rejected(fixture, `resolved advisory reappeared: ${source}`);
    fixture.vulnerabilities[name].via.pop();
    if (!baseline.entries[name]) delete fixture.vulnerabilities[name];
  }
});

test("offline CLI accepts the reviewed fixture and rejects a new path without running npm", () => {
  const dir = mkdtempSync(join(tmpdir(), "d3-advisory-gate-"));
  try {
    const file = join(dir, "audit.json");
    writeFileSync(file, JSON.stringify(reviewedFixture()));
    const accepted = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--fixture", file],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /affected package entries/);
    assert.match(accepted.stdout, /not counts of independent vulnerabilities/);

    const changed = reviewedFixture();
    changed.vulnerabilities.braces.nodes.push("node_modules/new-path/node_modules/braces");
    writeFileSync(file, JSON.stringify(changed));
    const denied = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--fixture", file],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /affected package entry changed: braces/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a semantic package-lock change before accepting an audit receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "d3-advisory-lock-"));
  try {
    const scripts = join(dir, "scripts");
    mkdirSync(scripts);
    copyFileSync(resolve(__dirname, "d3-advisory-gate.cjs"), join(scripts, "d3-advisory-gate.cjs"));
    copyFileSync(resolve(__dirname, "d3-advisory-gate.baseline.json"), join(scripts, "d3-advisory-gate.baseline.json"));
    const changedLock = JSON.parse(readFileSync(resolve(__dirname, "../package-lock.json"), "utf8"));
    changedLock.packages["node_modules/proxy-addr"].version = "2.0.7";
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(changedLock));
    const file = join(dir, "audit.json");
    writeFileSync(file, JSON.stringify(reviewedFixture()));
    const denied = spawnSync(process.execPath, [join(scripts, "d3-advisory-gate.cjs"), "--fixture", file],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /package-lock\.json semantic SHA-256 changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live CLI consumes npm audit JSON and rejects an endpoint error", () => {
  const dir = mkdtempSync(join(tmpdir(), "d3-advisory-npm-"));
  try {
    const file = join(dir, "audit.json");
    const shim = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
    writeFileSync(shim, process.platform === "win32" ? '@echo off\r\ntype "%D3_AUDIT_FIXTURE%"\r\n'
      : '#!/bin/sh\ncat "$D3_AUDIT_FIXTURE"\n');
    if (process.platform !== "win32") chmodSync(shim, 0o755);
    const env = { ...process.env, D3_AUDIT_FIXTURE: file };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") {
      env[key] = `${dir}${delimiter}${env[key]}`;
    }
    writeFileSync(file, JSON.stringify(reviewedFixture()));
    const accepted = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--live"],
      { encoding: "utf8", timeout: 10000, env });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /82 affected package entries/);

    writeFileSync(file, JSON.stringify({ message: "simulated audit endpoint failure", error: {} }));
    const denied = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--live"],
      { encoding: "utf8", timeout: 10000, env });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /npm audit unavailable: simulated audit endpoint failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
