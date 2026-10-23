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

function reviewedFixture(reviewed = baseline) {
  const vulnerabilities = Object.create(null);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, entry] of Object.entries(reviewed.entries)) {
    vulnerabilities[name] = { name, severity: entry.severity, isDirect: entry.isDirect,
      range: entry.range, nodes: [...entry.nodes], effects: [...entry.effects],
      via: [...entry.viaPackages, ...entry.advisorySources.map((source) => {
        const advisory = reviewed.advisories[String(source)];
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
  assert.equal(Object.keys(baseline.entries).length, 51);
  assert.equal(Object.keys(baseline.advisories).length, 26);
  assert.equal(Object.keys(baseline.resolvedAdvisories).length, 13);
  assert.ok(Object.values(baseline.entries).every((entry) => entry.chains.length > 0
    && entry.chains.every((chain) => Object.hasOwn(baseline.chains, chain))));
  const result = evaluateAudit(reviewedFixture(), baseline);
  assert.deepEqual(result.issues, []);
  assert.equal(result.directAdvisoryObjects, 26);
  assert.equal(result.distinctAdvisoryUrls, 25);
  assert.equal(Object.keys(baseline.chains).length, 8);
  assert.equal(new Set(Object.values(baseline.entries).flatMap(entry => entry.chains)).size, 7);
});

test("all eight scoped Vite advisories have exact reversible source patches, while redirect advisories are forbidden", () => {
  const builder = require("./build-vite-safety-backport.cjs");
  const sources = baseline.entries.vite.advisorySources;
  assert.deepEqual(sources, [1116229, 1120784, 1123525, 1242622, 1242651, 1242658, 1242724, 1242730]);
  const fixes = builder.PATCHES.filter(patch => patch.advisory);
  assert.equal(fixes.length, 10);
  assert.equal(new Set(fixes.map(patch => patch.advisory)).size, 8);
  for (const id of sources) {
    const advisory = baseline.advisories[id];
    assert.equal(advisory.chain, "vite-toolchain");
    assert.equal(fixes.filter(patch => advisory.url.endsWith("/" + patch.advisory)).length, [1242724, 1242730].includes(id) ? 2 : 1);
  }
  for (const id of [1242604, 1242605]) {
    assert.equal(baseline.resolvedAdvisories[id].package, "follow-redirects");
    assert.equal(baseline.advisories[id], undefined);
  }
});

test("both newly patched Vite advisory tuples remain exact and cannot disappear or broaden", () => {
  for (const id of [1242724, 1242730]) {
    const changed = reviewedFixture();
    changed.vulnerabilities.vite.via.find(via => via.source === id).range = '<=6.4.2';
    rejected(changed, 'direct advisory changed');
    const removed = reviewedFixture();
    removed.vulnerabilities.vite.via = removed.vulnerabilities.vite.via.filter(via => via.source !== id);
    rejected(removed, 'direct advisory disappeared without baseline review');
    const redirected = reviewedFixture();
    redirected.vulnerabilities.vite.via.find(via => via.source === id).url = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';
    rejected(redirected, 'direct advisory changed');
  }
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
  added.vulnerabilities.qs.via.push({ source: 9999999, name: "qs", dependency: "qs",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "*" });
  rejected(added, "unknown direct advisory 9999999");

  const changed = reviewedFixture();
  const record = changed.vulnerabilities.qs.via.find((via) => typeof via === "object");
  record.range = "<6.15.3";
  rejected(changed, "direct advisory changed");
});

test("new propagated package, new node path, and changed propagation are rejected", () => {
  const added = reviewedFixture();
  added.vulnerabilities["new-glob-wrapper"] = { name: "new-glob-wrapper", severity: "high",
    isDirect: false, range: "*", nodes: ["node_modules/new-glob-wrapper"],
    effects: [], via: ["qs"] };
  refreshMetadata(added);
  rejected(added, "unknown affected package entry: new-glob-wrapper");

  const path = reviewedFixture();
  path.vulnerabilities.qs.nodes.push("node_modules/other/node_modules/qs");
  rejected(path, "affected package entry changed: qs");

  const edge = reviewedFixture();
  edge.vulnerabilities['@jest/core'].via = ["jest-config"];
  rejected(edge, "affected package entry changed: @jest/core");
});

test("npm-only propagated range and reverse effects changes do not change the scoped chain", () => {
  const fixture = reviewedFixture();
  fixture.vulnerabilities.jest.range = "24.2.0-alpha.0 - 30.2.0";
  fixture.vulnerabilities["jest-config"].effects.pop();
  assert.equal(evaluateAudit(fixture, baseline).ok, true);
});

test("all thirteen resolved or withdrawn advisory source IDs remain forbidden", () => {
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
    changed.vulnerabilities.qs.nodes.push("node_modules/new-path/node_modules/qs");
    writeFileSync(file, JSON.stringify(changed));
    const denied = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--fixture", file],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /affected package entry changed: qs/);
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
    assert.match(accepted.stdout, /51 affected package entries/);

    writeFileSync(file, JSON.stringify({ message: "simulated audit endpoint failure", error: {} }));
    const denied = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--live"],
      { encoding: "utf8", timeout: 10000, env });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /npm audit unavailable: simulated audit endpoint failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("withdrawn sprintf-js source and its exclusive propagated entries remain forbidden", () => {
  const source = baseline.resolvedAdvisories['1241202'];
  assert.equal(source.package, 'sprintf-js');
  assert.equal(source.url, 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c');
  assert.equal(source.resolution, 'upstream-withdrawn');
  assert.equal(source.withdrawnAt, '2026-10-22T19:21:04Z');
  for (const name of ['@istanbuljs/load-nyc-config', 'argparse', 'babel-plugin-istanbul', 'js-yaml', 'sprintf-js']) {
    assert.equal(baseline.entries[name], undefined);
    const returned = reviewedFixture();
    returned.vulnerabilities[name] = {name, severity:'high', isDirect:false, range:'*', nodes:[`node_modules/${name}`], effects:[], via:['qs']};
    refreshMetadata(returned);
    rejected(returned, `unknown affected package entry: ${name}`);
  }
  const returned = reviewedFixture();
  returned.vulnerabilities['sprintf-js'] = {name:'sprintf-js', severity:'moderate', isDirect:false, range:'<=1.1.3', nodes:['node_modules/sprintf-js'], effects:[],
    via:[{source:1241202, name:'sprintf-js', dependency:'sprintf-js', url:source.url, severity:'moderate', range:'<=1.1.3'}]};
  refreshMetadata(returned);
  rejected(returned, 'resolved advisory reappeared: 1241202');
});

const bracesReview = JSON.parse(readFileSync(resolve(__dirname,
  '../../../workers-ts/audit/uni-d3-braces-withdrawal-20261023.json'), 'utf8'));

function previousBracesBaseline() {
  const previous = structuredClone(baseline);
  const { source, ...advisory } = bracesReview.removed_advisory;
  previous.advisories[source] = advisory;
  delete previous.resolvedAdvisories[source];
  previous.reviewedReceipt = bracesReview.old_reviewed_receipt;
  for (const entry of [...bracesReview.removed_entries, ...bracesReview.remaining_graph_changes]) {
    previous.entries[entry.name] = structuredClone(entry.old);
  }
  return previous;
}

test('withdrawn braces source and all 26 exclusive package entries remain forbidden', () => {
  const source = baseline.resolvedAdvisories['1240992'];
  assert.equal(source.package, 'braces');
  assert.equal(source.url, 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm');
  assert.equal(source.resolution, 'upstream-withdrawn');
  assert.equal(source.withdrawnAt, '2026-10-23T12:53:02Z');
  assert.equal(bracesReview.removed_entries.length, 26);
  for (const { name } of bracesReview.removed_entries) {
    assert.equal(baseline.entries[name], undefined);
    const returned = reviewedFixture();
    returned.vulnerabilities[name] = { name, severity: 'high', isDirect: false, range: '*',
      nodes: [`node_modules/${name}`], effects: [], via: ['qs'] };
    refreshMetadata(returned);
    rejected(returned, `unknown affected package entry: ${name}`);
  }
  const returned = reviewedFixture(previousBracesBaseline());
  rejected(returned, 'resolved advisory reappeared: 1240992');
});

test('removing only braces reproduces the exact 77 to 51 forward-graph inventory correction', () => {
  const previous = previousBracesBaseline();
  assert.equal(Object.keys(previous.entries).length, 77);
  assert.equal(Object.keys(previous.advisories).length, 27);
  assert.equal(evaluateAudit(reviewedFixture(previous), previous).ok, true);
  const originalRed = evaluateAudit(reviewedFixture(), previous);
  assert.equal(originalRed.ok, false);
  assert.equal(originalRed.issues.length, 52);
  assert.deepEqual(originalRed.issues.slice().sort(), bracesReview.old_gate_reproduction.issues.slice().sort());

  // Derive reachability from the old graph before consulting new package names.
  const sources = Object.fromEntries(Object.entries(previous.entries).map(([name, entry]) =>
    [name, new Set(entry.advisorySources.filter(id => id !== 1240992))]));
  let changed;
  do {
    changed = false;
    for (const [name, entry] of Object.entries(previous.entries)) for (const via of entry.viaPackages) {
      for (const id of sources[via]) if (!sources[name].has(id)) { sources[name].add(id); changed = true; }
    }
  } while (changed);
  const removed = Object.keys(sources).filter(name => !sources[name].size).sort();
  assert.deepEqual(removed, bracesReview.removed_entries.map(entry => entry.name).sort());
  const survivors = Object.keys(sources).filter(name => sources[name].size).sort();
  assert.deepEqual(survivors, Object.keys(baseline.entries).sort());
  for (const name of survivors) {
    const before = previous.entries[name], after = baseline.entries[name];
    assert.deepEqual(after.nodes, before.nodes, name);
    assert.equal(after.isDirect, before.isDirect, name);
    assert.deepEqual(after.advisorySources, before.advisorySources.filter(id => id !== 1240992), name);
    assert.deepEqual(after.viaPackages, before.viaPackages.filter(via => sources[via].size), name);
    assert.deepEqual(after.chains, [...new Set([...sources[name]].map(id => previous.advisories[id].chain))].sort(), name);
  }
});

test('only six retained Jest entries lose high severity; every remaining severity is pinned', () => {
  const previous = previousBracesBaseline();
  const lowered = ['@jest/core', 'jest', 'jest-cli', 'jest-config', 'jest-environment-jsdom', 'jest-runner'];
  assert.deepEqual(Object.keys(baseline.entries).filter(name =>
    previous.entries[name].severity !== baseline.entries[name].severity).sort(), lowered.sort());
  for (const name of lowered) {
    assert.equal(previous.entries[name].severity, 'high');
    assert.equal(baseline.entries[name].severity, 'low');
    const raised = reviewedFixture();
    raised.vulnerabilities[name].severity = 'high';
    refreshMetadata(raised);
    rejected(raised, `affected package entry changed: ${name}`);
  }
});
