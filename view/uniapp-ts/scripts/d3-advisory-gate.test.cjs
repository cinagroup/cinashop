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
const preSecurityBaselineBytes = readFileSync(resolve(__dirname, "d3-advisory-gate.pre-security-backports-20261028.baseline.json"));
const preSecurityBaseline = JSON.parse(preSecurityBaselineBytes.toString("utf8"));

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
  assert.equal(Object.keys(baseline.entries).length, 48);
  assert.equal(Object.keys(baseline.advisories).length, 25);
  assert.equal(Object.keys(baseline.resolvedAdvisories).length, 23);
  assert.ok(Object.values(baseline.entries).every((entry) => entry.chains.length > 0
    && entry.chains.every((chain) => Object.hasOwn(baseline.chains, chain))));
  const result = evaluateAudit(reviewedFixture(), baseline);
  assert.deepEqual(result.issues, []);
  assert.equal(result.directAdvisoryObjects, 25);
  assert.equal(result.distinctAdvisoryUrls, 24);
  assert.equal(Object.keys(baseline.chains).length, 8);
  assert.equal(new Set(Object.values(baseline.entries).flatMap(entry => entry.chains)).size, 6);
});

test("all eight scoped Vite advisories have exact reversible source patches, while redirect advisories are forbidden", () => {
  const builder = require("./build-vite-safety-backport.cjs");
  const sources = baseline.entries.vite.advisorySources;
  assert.deepEqual(sources, [1116229, 1120784, 1242622, 1242651, 1242658, 1242724, 1242730, 1243432]);
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
  added.vulnerabilities.vite.via.push({ source: 9999999, name: "vite", dependency: "vite",
    url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", range: "*" });
  rejected(added, "unknown direct advisory 9999999");

  const changed = reviewedFixture();
  const record = changed.vulnerabilities.vite.via.find((via) => typeof via === "object");
  record.range = "*";
  rejected(changed, "direct advisory changed");
});

test("new propagated package, new node path, and changed propagation are rejected", () => {
  const added = reviewedFixture();
  added.vulnerabilities["new-glob-wrapper"] = { name: "new-glob-wrapper", severity: "high",
    isDirect: false, range: "*", nodes: ["node_modules/new-glob-wrapper"],
    effects: [], via: ["vite"] };
  refreshMetadata(added);
  rejected(added, "unknown affected package entry: new-glob-wrapper");

  const path = reviewedFixture();
  path.vulnerabilities.vite.nodes.push("node_modules/other/node_modules/vite");
  rejected(path, "affected package entry changed: vite");

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

test("all twenty-three resolved, withdrawn or replaced advisory source IDs remain forbidden", () => {
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
    changed.vulnerabilities.vite.nodes.push("node_modules/new-path/node_modules/vite");
    writeFileSync(file, JSON.stringify(changed));
    const denied = spawnSync(process.execPath, [resolve(__dirname, "d3-advisory-gate.cjs"), "--fixture", file],
      { encoding: "utf8", timeout: 10000 });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /affected package entry changed: vite/);
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
    assert.match(accepted.stdout, /48 affected package entries/);

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
    returned.vulnerabilities[name] = {name, severity:'high', isDirect:false, range:'*', nodes:[`node_modules/${name}`], effects:[], via:['vite']};
    refreshMetadata(returned);
    rejected(returned, `unknown affected package entry: ${name}`);
  }
  const returned = reviewedFixture();
  returned.vulnerabilities['sprintf-js'] = {name:'sprintf-js', severity:'moderate', isDirect:false, range:'<=1.1.3', nodes:['node_modules/sprintf-js'], effects:[],
    via:[{source:1241202, name:'sprintf-js', dependency:'sprintf-js', url:source.url, severity:'moderate', range:'<=1.1.3'}]};
  refreshMetadata(returned);
  rejected(returned, 'resolved advisory reappeared: 1241202');
});

// Historical77->51 checks use the exact reviewed pre-body-parser baseline.
// Current patched dependency tuples remain checked against the live baseline.
const preBodyParserBaselineBytes = readFileSync(resolve(__dirname, "d3-advisory-gate.pre-body-parser-20261024.baseline.json"));
const preBodyParserBaseline = JSON.parse(preBodyParserBaselineBytes.toString("utf8"));
test('pre-body-parser historical51 baseline retains its exact reviewed bytes', () => {
  assert.equal(createHash('sha256').update(preBodyParserBaselineBytes).digest('hex'), '5b82bc7222590c0904d7091981640bf559aa6dc625df27ef4eb545493d7eebc2');
  assert.equal(Object.keys(preBodyParserBaseline.entries).length, 51);
  assert.equal(Object.keys(preBodyParserBaseline.advisories).length, 26);
  assert.equal(Object.keys(preBodyParserBaseline.resolvedAdvisories).length, 13);
  assert.equal(preBodyParserBaseline.lockSemanticSha256, '5f3a3a04a94f2201e54acd4c3eac651a606a25eb9e426916a3034a33fbc59e00');
});

const bracesReview = JSON.parse(readFileSync(resolve(__dirname,
  '../../../workers-ts/audit/uni-d3-braces-withdrawal-20261023.json'), 'utf8'));

function previousBracesBaseline() {
  const previous = structuredClone(preBodyParserBaseline);
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
      nodes: [`node_modules/${name}`], effects: [], via: ['vite'] };
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
  const originalRed = evaluateAudit(reviewedFixture(preBodyParserBaseline), previous);
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
  assert.deepEqual(survivors, Object.keys(preBodyParserBaseline.entries).sort());
  for (const name of survivors) {
    const before = previous.entries[name], after = preBodyParserBaseline.entries[name];
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
  assert.deepEqual(Object.keys(preBodyParserBaseline.entries).filter(name =>
    previous.entries[name].severity !== preBodyParserBaseline.entries[name].severity).sort(), lowered.sort());
  for (const name of lowered) {
    assert.equal(previous.entries[name].severity, 'high');
    assert.equal(preBodyParserBaseline.entries[name].severity, 'low');
    const raised = reviewedFixture();
    raised.vulnerabilities[name].severity = 'high';
    refreshMetadata(raised);
    rejected(raised, `affected package entry changed: ${name}`);
  }
});

test('body-parser patch preserves every other reviewed forward graph and resolved source', () => {
  const baseline = preViteSourceBaseline; // Preserve the original body-parser review's exact historical authority.
  assert.deepEqual(baseline.advisories, preBodyParserBaseline.advisories);
  assert.deepEqual(baseline.chains, preBodyParserBaseline.chains);
  const { '1243073': patched, ...previousResolved } = baseline.resolvedAdvisories;
  assert.deepEqual(previousResolved, preBodyParserBaseline.resolvedAdvisories);
  assert.equal(patched.package, 'body-parser');
  assert.equal(patched.resolution, 'patched');
  assert.equal(patched.fixedVersion, '1.20.9');
  assert.equal(patched.affectedRange, '<1.20.9');
  assert.equal(patched.url, 'https://github.com/advisories/GHSA-27r3-jxmh-p828');
  assert.equal(baseline.entries['body-parser'], undefined);
  const expected = structuredClone(preBodyParserBaseline.entries);
  delete expected['body-parser'];
  const forwardGraph = entries => Object.fromEntries(Object.entries(entries).map(([name, entry]) =>
    [name, Object.fromEntries(Object.entries(entry).filter(([key]) => !['range', 'effects'].includes(key)))]));
  assert.deepEqual(forwardGraph(baseline.entries), forwardGraph(expected));
  assert.deepEqual(baseline.entries.qs.nodes, ['node_modules/qs']);
  assert.deepEqual(baseline.entries.qs.advisorySources, [1158506, 1158507]);
});

test('patched body-parser high advisory cannot be restored as an accepted allowance', () => {
  const returned = reviewedFixture();
  returned.vulnerabilities['body-parser'] = { name: 'body-parser', severity: 'high',
    isDirect: false, range: '<1.20.9', nodes: ['node_modules/body-parser'], effects: [],
    via: [{ source: 1243073, name: 'body-parser', dependency: 'body-parser', severity: 'high',
      range: '<1.20.9', url: 'https://github.com/advisories/GHSA-27r3-jxmh-p828' }] };
  refreshMetadata(returned);
  rejected(returned, 'resolved advisory reappeared: 1243073');
  rejected(returned, 'unknown direct advisory 1243073');
});

function rejectsPatchedLockMutation(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'd3-body-parser-lock-'));
  try {
    const scripts = join(dir, 'scripts');
    mkdirSync(scripts);
    for (const file of ['d3-advisory-gate.cjs', 'd3-advisory-gate.baseline.json']) {
      copyFileSync(resolve(__dirname, file), join(scripts, file));
    }
    const changed = JSON.parse(readFileSync(resolve(__dirname, '../package-lock.json'), 'utf8'));
    mutate(changed.packages);
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(changed));
    writeFileSync(join(dir, 'audit.json'), JSON.stringify(reviewedFixture()));
    const denied = spawnSync(process.execPath, [join(scripts, 'd3-advisory-gate.cjs'), '--fixture', join(dir, 'audit.json')],
      { encoding: 'utf8', timeout: 10000 });
    assert.ifError(denied.error);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /package-lock\.json semantic SHA-256 changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('reverting the patched body-parser lock is rejected before the audit receipt', () => {
  rejectsPatchedLockMutation(packages => { packages['node_modules/body-parser'].version = '1.20.6'; });
});

test('reverting shared Express/body-parser root qs is rejected before the audit receipt', () => {
  rejectsPatchedLockMutation(packages => { packages['node_modules/qs'].version = '6.15.3'; });
});

test('historical nested qs node mutation stays rejected and fixed qs cannot return now', () => {
  const historical = reviewedFixture(preSecurityBaseline);
  historical.vulnerabilities.qs.nodes.push('node_modules/body-parser/node_modules/qs');
  const oldResult = evaluateAudit(historical, preSecurityBaseline);
  assert.equal(oldResult.ok, false);
  assert.ok(oldResult.issues.some(x => x.includes('affected package entry changed: qs')));
  const returned = reviewedFixture();
  returned.vulnerabilities.qs = {name:'qs',severity:'moderate',isDirect:false,range:'<=6.16.0',nodes:['node_modules/qs','node_modules/body-parser/node_modules/qs'],effects:[],via:[{source:1158506,name:'qs',dependency:'qs',severity:'moderate',range:'>=6.14.2 <=6.15.3',url:baseline.resolvedAdvisories['1158506'].url}]};
  refreshMetadata(returned);
  rejected(returned, 'resolved advisory reappeared: 1158506');
});

// This exact snapshot predates the reviewed npm numeric-source replacement.
const preViteSourceBaselineBytes = readFileSync(resolve(__dirname, "d3-advisory-gate.pre-vite-source-20261027.baseline.json"));
const preViteSourceBaseline = JSON.parse(preViteSourceBaselineBytes.toString("utf8"));
test('Vite source replacement preserves the complete earlier reviewed baseline and every unrelated tuple', () => {
  const baseline = preQsCommaBaseline; // Preserve the original Vite review against its exact resulting baseline.
  assert.equal(createHash('sha256').update(preViteSourceBaselineBytes).digest('hex'), 'a80b3b1cb4ba8e0e9861afdbc08e169baf94e4e9a34503cd828b8d791a91eaf8');
  const expected = structuredClone(preViteSourceBaseline);
  const old = expected.advisories['1123525'];
  assert.deepEqual(old, { package:'vite', url:'https://github.com/advisories/GHSA-fx2h-pf6j-xcff', severity:'high', range:'<=6.4.2', chain:'vite-toolchain' });
  delete expected.advisories['1123525']; expected.advisories['1243432'] = { ...old, severity:'moderate' };
  expected.entries.vite.advisorySources = expected.entries.vite.advisorySources.filter(id => id !== 1123525).concat(1243432).sort((a,b)=>a-b);
  expected.resolvedAdvisories['1123525'] = { package:'vite', url:old.url, resolution:'upstream-source-replaced', replacementSource:1243432, affectedRange:'<=6.4.2', note:'Retired numeric npm source, not a newly resolved vulnerability. The identical GHSA remains reviewed only under source1243432/moderate; existing source backport is unchanged.' };
  expected.reviewedReceipt = baseline.reviewedReceipt;
  assert.deepEqual(baseline, expected);
  assert.deepEqual(baseline.advisories['1243432'], { ...old, severity:'moderate' });
  assert.equal(baseline.advisories['1123525'], undefined);
  const builder = require('./build-vite-safety-backport.cjs');
  assert.equal(builder.PATCHES.filter(p => p.advisory === 'GHSA-fx2h-pf6j-xcff').length, 1);
  assert.equal(builder.PATCHES.find(p => p.advisory === 'GHSA-fx2h-pf6j-xcff').commit, '96b0c10162e9c55485d922db2cfc6b8227cbc176');
});
for (const kind of ['source','url','severity','range','missing','old-source']) test('reviewed replacement rejects changed ' + kind, () => {
  const report = reviewedFixture(), via = report.vulnerabilities.vite.via;
  const entry = via.find(v => v && typeof v === 'object' && v.source === 1243432);
  if (kind === 'source') entry.source = 9999999;
  if (kind === 'url') entry.url = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';
  if (kind === 'severity') entry.severity = 'high';
  if (kind === 'range') entry.range = '*';
  if (kind === 'missing') report.vulnerabilities.vite.via = via.filter(v => v !== entry);
  if (kind === 'old-source') entry.source = 1123525;
  const result = evaluateAudit(report, baseline); assert.equal(result.ok, false);
  if (kind === 'old-source') assert(result.issues.some(v => v.includes('resolved advisory reappeared: 1123525')));
});

const preQsCommaBaselineBytes = readFileSync(resolve(__dirname, "d3-advisory-gate.pre-qs-comma-20261027.baseline.json"));
const preQsCommaBaseline = JSON.parse(preQsCommaBaselineBytes.toString("utf8"));
test('historical qs comma advisory preserves every previously reviewed tuple and installed forward path', () => {
  const baseline = preSecurityBaseline;
  assert.equal(createHash('sha256').update(preQsCommaBaselineBytes).digest('hex'), 'f62308efc2f92f0424407851024a2915f9bfa21741bacb15ca77ff1fdb80341d');
  const expected = structuredClone(preQsCommaBaseline);
  expected.advisories['1243452'] = { package:'qs', url:'https://github.com/advisories/GHSA-6pq8-jhm2-2vcw', severity:'moderate', range:'>=6.7.0 <=6.16.0', chain:'h5-ssr' };
  expected.entries.qs.advisorySources = [1158506,1158507,1243452];
  expected.entries.qs.range = '2.2.5 - 6.16.0';
  expected.reviewedReceipt = baseline.reviewedReceipt;
  assert.deepEqual(baseline, expected);
  assert.equal(evaluateAudit(reviewedFixture(preQsCommaBaseline), preQsCommaBaseline).ok, true);
  assert.deepEqual(baseline.entries.qs.nodes, ['node_modules/qs']);
  assert.equal(baseline.advisories['1243452'].chain, 'h5-ssr');
});
for (const kind of ['source','url','severity','range','missing','new-node','old-source-disappeared']) test('historical qs comma review rejects changed ' + kind, () => {
  const baseline = preSecurityBaseline;
  const report = reviewedFixture(baseline), via = report.vulnerabilities.qs.via;
  const entry = via.find(v => v && typeof v === 'object' && v.source === 1243452);
  if (kind === 'source') entry.source = 9999999;
  if (kind === 'url') entry.url = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';
  if (kind === 'severity') entry.severity = 'low';
  if (kind === 'range') entry.range = '*';
  if (kind === 'missing') report.vulnerabilities.qs.via = via.filter(v => v !== entry);
  if (kind === 'new-node') report.vulnerabilities.qs.nodes.push('node_modules/body-parser/node_modules/qs');
  if (kind === 'old-source-disappeared') report.vulnerabilities.qs.via = via.filter(v => v.source !== 1158506);
  const result = evaluateAudit(report, baseline); assert.equal(result.ok, false);
  const fragment = kind === 'source' ? 'unknown direct advisory 9999999' : kind === 'new-node' ? 'affected package entry changed: qs'
    : ['missing','old-source-disappeared'].includes(kind) ? 'direct advisory disappeared without baseline review' : 'direct advisory changed: 1243452';
  assert.ok(result.issues.some(v => v.includes(fragment)), JSON.stringify(result.issues));
});


// Exact2026-10-28 C3 inventory delta. Older history is pinned separately above.
test('C3 preserves all old50 tuples except the complete reviewed exact delta', () => {
  assert.equal(createHash('sha256').update(preSecurityBaselineBytes).digest('hex'), '778662a60ae0eb6874b9705a98effe2ce39ec337a41ce0b853a77a3bdbbf20f4');
  assert.equal(Object.keys(preSecurityBaseline.entries).length,50);
  assert.equal(Object.keys(preSecurityBaseline.advisories).length,27);
  assert.equal(Object.keys(preSecurityBaseline.resolvedAdvisories).length,15);
  for(const [id,record] of Object.entries(preSecurityBaseline.resolvedAdvisories)) assert.deepEqual(baseline.resolvedAdvisories[id],record,id);
  assert.deepEqual(Object.keys(baseline.resolvedAdvisories).filter(id=>!Object.hasOwn(preSecurityBaseline.resolvedAdvisories,id)).map(Number).sort((a,b)=>a-b),[1158506,1158507,1243452,1243505,1243633,1243637,1243649,1243657]);
  const {intlify:oldIntlify,...oldChains}=preSecurityBaseline.chains,{intlify:newIntlify,...newChains}=baseline.chains;
  assert.deepEqual(newChains,oldChains); assert.notEqual(newIntlify,oldIntlify);
  const advisories=structuredClone(preSecurityBaseline.advisories);
  for(const id of ['1158506','1158507','1243452'])delete advisories[id];
  advisories['1243629']={"package":"@intlify/core-base","url":"https://github.com/advisories/GHSA-8rc2-428q-7ww3","severity":"low","range":">=9.0.0-beta.12 <11.4.14","chain":"intlify"}; assert.deepEqual(baseline.advisories,advisories);
  const expected=structuredClone(preSecurityBaseline.entries);delete expected.express;delete expected.qs;
  expected['@intlify/core-base'].advisorySources=[1106453,1146054,1243629];expected['@intlify/core-base'].isDirect=true;expected['@intlify/core-base'].range='<=11.4.13';
  expected['jest-config'].isDirect=true;expected['@dcloudio/uni-cloud'].effects=[];expected['@dcloudio/uni-components'].effects=['@dcloudio/uni-app'];expected['@jest/core'].effects=['jest','jest-cli'];
  assert.deepEqual(baseline.entries,expected);
});

const c3NewResolved={"1158506":{"package":"qs","url":"https://github.com/advisories/GHSA-x5fp-wj9c-mxmx","resolution":"patched","fixedVersion":"6.16.2","affectedRange":">=6.14.2 <=6.15.3","reason":"Adopted official qs6.16.2, shared by actual Express4.22.3 and body-parser1.20.9 consumers; fixedVersion is the verified adopted version, not a claim about the earliest upstream fixed release. Full official tar SRI/installed bytes and actual SSR/parser controls are reviewed."},"1158507":{"package":"qs","url":"https://github.com/advisories/GHSA-4mjr-xmp4-gh2g","resolution":"patched","fixedVersion":"6.16.2","affectedRange":">=2.2.5 <6.16.0","reason":"Adopted official qs6.16.2, shared by actual Express4.22.3 and body-parser1.20.9 consumers; fixedVersion is the verified adopted version, not a claim about the earliest upstream fixed release. Full official tar SRI/installed bytes and actual SSR/parser controls are reviewed."},"1243452":{"package":"qs","url":"https://github.com/advisories/GHSA-6pq8-jhm2-2vcw","resolution":"patched","fixedVersion":"6.16.2","affectedRange":">=6.7.0 <=6.16.0","reason":"Adopted official qs6.16.2, shared by actual Express4.22.3 and body-parser1.20.9 consumers; fixedVersion is the verified adopted version, not a claim about the earliest upstream fixed release. Full official tar SRI/installed bytes and actual SSR/parser controls are reviewed."},"1243505":{"package":"deepmerge","url":"https://github.com/advisories/GHSA-gcqx-w48m-w2h4","resolution":"external-dependency-removed-with-verified-local-source-fork","reason":"Actual jest-config27.5.1 retains identity/API, embeds source-patched deepmerge4.3.1 CJS with complete MIT license, and removes its external deepmerge dependency. The installed full graph contains no external deepmerge node. This is not an official fixed upstream Jest/deepmerge release.","sourceContract":"view/uniapp-ts/vendor/jest-config-27.5.1-source.json","derivedArchiveSha256":"6baf951142521c91b421f3ed56f79b37dcd3270ca90691a29d12aa810d455114","officialFixedRelease":false},"1243633":{"package":"vue-i18n","url":"https://github.com/advisories/GHSA-8rc2-428q-7ww3","resolution":"unused-root-package-copies-removed","removedVersion":"9.14.5","affectedRange":">=9.0.0-beta.5 <11.4.14","reason":"The unused root vue-i18n9.14.5 dependency and its affected nested copies are absent from the actual C3 full lock/installed graph. The retained DCloud private runtime and core-base9.1.9 remain. This records dependency removal, not an official fixed9.x release or a srcdoc repair to retained9.1.9."},"1243637":{"package":"@intlify/shared","url":"https://github.com/advisories/GHSA-83rm-6c8r-g728","resolution":"unused-root-package-copies-removed","removedVersion":"9.14.5","affectedRange":"=9.14.5","reason":"The unused root vue-i18n9.14.5 dependency and its affected nested copies are absent from the actual C3 full lock/installed graph. The retained DCloud private runtime and core-base9.1.9 remain. This records dependency removal, not an official fixed9.x release or a srcdoc repair to retained9.1.9."},"1243649":{"package":"@intlify/core-base","url":"https://github.com/advisories/GHSA-83rm-6c8r-g728","resolution":"unused-root-package-copies-removed","removedVersion":"9.14.5","affectedRange":"=9.14.5","reason":"The unused root vue-i18n9.14.5 dependency and its affected nested copies are absent from the actual C3 full lock/installed graph. The retained DCloud private runtime and core-base9.1.9 remain. This records dependency removal, not an official fixed9.x release or a srcdoc repair to retained9.1.9."},"1243657":{"package":"vue-i18n","url":"https://github.com/advisories/GHSA-83rm-6c8r-g728","resolution":"unused-root-package-copies-removed","removedVersion":"9.14.5","affectedRange":"=9.14.5","reason":"The unused root vue-i18n9.14.5 dependency and its affected nested copies are absent from the actual C3 full lock/installed graph. The retained DCloud private runtime and core-base9.1.9 remain. This records dependency removal, not an official fixed9.x release or a srcdoc repair to retained9.1.9."}};
for(const [id,expected] of Object.entries(c3NewResolved))test('reviewed C3 resolved source '+id+' cannot reappear',()=>{
  assert.deepEqual(baseline.resolvedAdvisories[id],expected); assert.equal(baseline.advisories[id],undefined);
  const fixture=reviewedFixture(),name=expected.package;
  if(!fixture.vulnerabilities[name])fixture.vulnerabilities[name]={name,severity:'moderate',isDirect:false,range:'*',nodes:['node_modules/'+name],effects:[],via:[]};
  fixture.vulnerabilities[name].via.push({source:Number(id),name,dependency:name,url:expected.url,severity:'moderate',range:'*'});
  refreshMetadata(fixture);rejected(fixture,'resolved advisory reappeared: '+id);
});

test('source1243629 is exact and linked to all7 published source patches and real consumer/runtime evidence',()=>{
  const expected={"rawAuditSha256":"82e18c448356d03b524ea24d453186f612ba97d2ab0a603393b564cfaa84ebc4","lockSemanticSha256":"9636a49bcc355d00c59e83a19f4b8b87cd4ddcdc00d2beb8e94af4e80480cfea","intlify":{"npmSourceId":1243629,"advisory":"GHSA-8rc2-428q-7ww3","officialFixCommit":"d657ce8f4b3b6b198a8f6e3d09e2b57a5d019fb8","contractSha256":"3cfa77d693f397239771b90307bb92d63a897a48d51c889c75e689f4d4033131","derivedArchiveSha256":"ad1f2afe8f76ec37e2e6124a1b0ce6c20035600b35d3796ed6c56f06487c3951","patchedDistributions":["dist/core-base.cjs.js","dist/core-base.cjs.prod.js","dist/core-base.esm-browser.js","dist/core-base.esm-browser.prod.js","dist/core-base.esm-bundler.js","dist/core-base.global.js","dist/core-base.global.prod.js"],"archiveFileCount":12,"securityBackportTests":29,"runtimeGraphTests":13}};
  const review=JSON.parse(readFileSync(resolve(__dirname,'../../../workers-ts/audit/uni-d3-security-backports-20261028.json'),'utf8'));
  assert.deepEqual(review.regressionContract,expected);
  const formal12={"scripts/build-intlify-core-safety-backport.cjs":"f0f9f3fdcb695beec2d714685c29a1752f7b31d531a47ddfbae8bfd03c4cd229","scripts/build-jest-deepmerge-safety-backport.cjs":"b125432c63b0d24412cc61a00cdc020975fe4052a2ecd6494b62e50d87795763","scripts/intlify-core-safety-backport.test.cjs":"ae6fc0f2ea28f597378187b9872a5200a314cddabdaa8a3194b1c549adcb96fd","scripts/jest-deepmerge-safety-backport.test.cjs":"a811e5963ce72f03d9774eb6edc978ef871e90248caab5ca14d4e8e37c89e88a","scripts/security-archive-tools.cjs":"821cdda56984920883aad0ef7dbbc6ebbc753d333d2a7e7da38dfc36f4501bd6","scripts/security-consumer-test-helpers.cjs":"b074c8382df2b98399e8b17b9733b6aeaab143d2eb554c9887ed73f12282dfdd","scripts/security-source-archive.test.cjs":"ca6c7a1dcde10eca1e6505ddc845d85d302c835392cfcb9d69b76b0c9aa5d9b6","vendor/intlify-core-base-9.1.9-mixed-escape-backport.tgz":"ad1f2afe8f76ec37e2e6124a1b0ce6c20035600b35d3796ed6c56f06487c3951","vendor/intlify-core-base-9.1.9-source.json":"3cfa77d693f397239771b90307bb92d63a897a48d51c889c75e689f4d4033131","vendor/intlify-dcloud-runtime-source.json":"4d35346cc02214617a6f4bc7953fb397ea4a2e1106f87f51b7a23d810274dd80","vendor/jest-config-27.5.1-deepmerge-safety-backport.tgz":"6baf951142521c91b421f3ed56f79b37dcd3270ca90691a29d12aa810d455114","vendor/jest-config-27.5.1-source.json":"a37b25669c2b5a39da0a6485a3dd82dc5d85e1ccb204c3d547bf8588e17a2d15"};assert.equal(Object.keys(formal12).length,12);
  for(const [rel,hash] of Object.entries(formal12))assert.equal(createHash('sha256').update(readFileSync(resolve(__dirname,'..',rel))).digest('hex'),hash,rel);
  const B=require('./build-intlify-core-safety-backport.cjs'),contract=B.CONTRACT;
  assert.equal(B.CONTRACT_SHA256,expected.intlify.contractSha256);assert.equal(contract.npmSourceId,1243629);assert.equal(contract.advisory,expected.intlify.advisory);assert.equal(contract.officialFixCommit,expected.intlify.officialFixCommit);assert.equal(contract.source.version,'9.1.9');
  assert.equal(contract.all7PublishedDistributionsPatchedDirectlyNotRebuiltFromTS,true);assert.equal(contract.source.fileCount,12);assert.equal(contract.derived.fileCount,12);
  assert.deepEqual(contract.allowedNewFiles,[]);assert.deepEqual(contract.allowedChangedOriginalFiles,expected.intlify.patchedDistributions);assert.deepEqual(contract.patches.map(p=>p.file),expected.intlify.patchedDistributions);
  const verified=B.verifyDerived(readFileSync(resolve(__dirname,'../vendor/intlify-core-base-9.1.9-mixed-escape-backport.tgz')));
  assert.equal(verified.sha256,expected.intlify.derivedArchiveSha256);assert.equal(verified.fileCount,12);assert.deepEqual(verified.patchedPublishedDistributions,expected.intlify.patchedDistributions);
  const pkg=JSON.parse(readFileSync(resolve(__dirname,'../package.json'),'utf8'));
  assert.equal(pkg.scripts['test:security-backports'],'node --test --test-concurrency=1 scripts/security-source-archive.test.cjs scripts/jest-deepmerge-safety-backport.test.cjs scripts/intlify-core-safety-backport.test.cjs');assert.ok(pkg.scripts['test:toolchain'].endsWith(' && npm run test:security-backports'));
  assert.equal(createHash('sha256').update(readFileSync(resolve(__dirname,'runtime-i18n-audit.test.cjs'))).digest('hex'),'45361a067027ac17842d6f0e180f8d3bff2e857b9ff4ef56d9c2e4c98ccff931');
});
for(const kind of ['source','url','severity','range','missing','new-node'])test('reviewed mixed source rejects '+kind,()=>{
  const fixture=reviewedFixture(),entry=fixture.vulnerabilities['@intlify/core-base'],record=entry.via.find(v=>v&&typeof v==='object'&&v.source===1243629);
  if(kind==='source')record.source=9999999;if(kind==='url')record.url='https://github.com/advisories/GHSA-aaaa-bbbb-cccc';if(kind==='severity')record.severity='high';if(kind==='range')record.range='*';if(kind==='missing')entry.via=entry.via.filter(v=>v!==record);if(kind==='new-node')entry.nodes.push('node_modules/other/node_modules/@intlify/core-base');
  const result=evaluateAudit(fixture,baseline);assert.equal(result.ok,false);
  const fragment=kind==='source'?'unknown direct advisory 9999999':kind==='missing'?'direct advisory disappeared without baseline review':kind==='new-node'?'affected package entry changed: @intlify/core-base':'direct advisory changed: 1243629';assert.ok(result.issues.some(x=>x.includes(fragment)),JSON.stringify(result.issues));
});
