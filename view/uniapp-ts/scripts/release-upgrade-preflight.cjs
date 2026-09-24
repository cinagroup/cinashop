// Offline metadata preflight for an in-place replacement of the published UniApp.
// Usage: node scripts/release-upgrade-preflight.cjs C:/outside-repo/release-evidence.json
// The evidence must be independently transcribed from the published channels and
// candidate packages. This metadata check does not inspect a signature or a live API.
// Compiled JavaScript is checked only for an origin literal; the actual request
// destination, signed package contents, and channel upgrade eligibility require
// separate release verification.
// Signing fingerprints record observed artifacts; equality across store submission
// and delivery certificates is not assumed.
// Required JSON shape (all values are real evidence, never fill from the old source):
// {
//   "published": {
//     "dcloudAppId": "...", "weixinAppId": "...",
//     "weixin": { "highestVersionName": "x.y.z", "apiOrigin": "https://...", "evidenceRef": "..." },
//     "android": { "packageId": "...", "signingSha256": "64 hex chars",
//       "highestVersionName": "x.y.z", "highestVersionCode": 1,
//       "apiOrigin": "https://...", "evidenceRef": "..." },
//     "ios": { "bundleId": "...", "signingSha256": "64 hex chars",
//       "highestVersionName": "x.y.z", "highestVersionCode": 1,
//       "apiOrigin": "https://...", "evidenceRef": "..." }
//   },
//   "candidate": {
//     "weixin": { "appId": "...", "versionName": "x.y.z", "apiOrigin": "https://...", "evidenceRef": "..." },
//     "android": { "dcloudAppId": "...", "packageId": "...", "signingSha256": "64 hex chars",
//       "versionName": "x.y.z", "versionCode": 2,
//       "apiOrigin": "https://...", "artifactSha256": "64 hex chars",
//       "upgradeEligibilityRef": "channel-specific update verification evidence" },
//     "ios": { "dcloudAppId": "...", "bundleId": "...", "signingSha256": "64 hex chars",
//       "versionName": "x.y.z", "versionCode": 2,
//       "apiOrigin": "https://...", "artifactSha256": "64 hex chars",
//       "upgradeEligibilityRef": "channel-specific update verification evidence" }
//   }
// }
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const projectRoot = resolve(__dirname, '..');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveCode(value) {
  const text = String(value ?? '');
  return /^(?:[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

function dottedVersion(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function newerVersion(candidate, published) {
  const a = dottedVersion(candidate);
  const b = dottedVersion(published);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function httpsOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && url.origin === value;
  } catch {
    return false;
  }
}

function sourceApiOrigin(source) {
  if (typeof source !== 'string') return undefined;
  const file = ts.createSourceFile('request.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) return undefined;
  const declarations = file.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'apiBase');
  const initializer = declarations.length === 1 ? declarations[0].initializer : undefined;
  if (!initializer || !ts.isStringLiteral(initializer)) return undefined;
  return initializer.text;
}

function checkReleaseIdentity(input) {
  const issues = [];
  const source = object(input.sourceManifest);
  const appBuild = object(input.appBuildManifest);
  const mpBuild = object(input.mpBuildProject);
  const evidence = object(input.evidence);
  const published = object(evidence.published);
  const candidate = object(evidence.candidate);
  const publishedWechat = object(published.weixin);
  const candidateWechat = object(candidate.weixin);

  const requiredText = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) issues.push(`${label} is required`);
    return typeof value === 'string' && !!value.trim();
  };
  const equal = (actual, expected, label) => {
    if (actual !== expected) issues.push(`${label} does not match independently recorded evidence`);
  };
  const sha256 = (value, label) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) issues.push(`${label} must be a SHA-256 fingerprint`);
  };
  const nativeId = (value, channel, label) => {
    const pattern = channel === 'android'
      ? /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/
      : /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
    if (typeof value !== 'string' || !pattern.test(value)) issues.push(`${label} is not a package or bundle identifier`);
  };
  const origin = (value, label) => {
    if (!httpsOrigin(value)) issues.push(`${label} must be an HTTPS origin without a path`);
  };

  requiredText(published.dcloudAppId, 'published.dcloudAppId');
  requiredText(published.weixinAppId, 'published.weixinAppId');
  if (!/^__UNI__[A-Z0-9]+$/.test(source.appid ?? '')) issues.push('source DCloud appid is absent or invalid');
  if (!/^wx[0-9a-f]{16}$/.test(object(source['mp-weixin']).appid ?? '')) issues.push('source Weixin appid is absent or invalid');
  equal(source.appid, published.dcloudAppId, 'source DCloud appid');
  equal(appBuild.id, source.appid, 'built App DCloud id');
  equal(object(source['mp-weixin']).appid, published.weixinAppId, 'source Weixin appid');
  equal(mpBuild.appid, published.weixinAppId, 'built Weixin project appid');
  if (mpBuild.appid === 'touristappid') issues.push('built Weixin project still uses touristappid');

  const sourceCode = positiveCode(source.versionCode);
  if (sourceCode === null) issues.push('source versionCode must be a positive integer');
  if (positiveCode(object(appBuild.version).code) !== sourceCode) issues.push('built App versionCode differs from source');
  if (!dottedVersion(source.versionName)) issues.push('source versionName must use numeric dotted components');
  if (object(appBuild.version).name !== source.versionName) issues.push('built App versionName differs from source');
  requiredText(candidateWechat.evidenceRef, 'candidate.weixin.evidenceRef');
  equal(candidateWechat.appId, published.weixinAppId, 'candidate Weixin appid');
  equal(candidateWechat.versionName, source.versionName, 'candidate Weixin versionName');
  if (!newerVersion(candidateWechat.versionName, publishedWechat.highestVersionName)) {
    issues.push('candidate Weixin versionName must exceed the highest published version');
  }

  const apiOrigin = sourceApiOrigin(input.requestSource);
  if (!httpsOrigin(apiOrigin)) issues.push('source mobile API origin is not a unique top-level static HTTPS origin');
  for (const [channel, bundle] of [
    ['weixin', input.mpRequestBuild],
    ['app', input.appServiceBuild],
  ]) {
    if (typeof bundle !== 'string' || !apiOrigin || !bundle.includes(apiOrigin)) {
      issues.push(`${channel} build does not contain the source API origin literal`);
    }
  }

  for (const channel of ['weixin', 'android', 'ios']) {
    const old = object(published[channel]);
    const next = object(candidate[channel]);
    requiredText(old.evidenceRef, `published.${channel}.evidenceRef`);
    if (channel !== 'weixin') {
      const key = channel === 'android' ? 'packageId' : 'bundleId';
      nativeId(old[key], channel, `published.${channel}.${key}`);
      nativeId(next[key], channel, `candidate.${channel}.${key}`);
      equal(next[key], old[key], `candidate ${channel} ${key}`);
      sha256(old.signingSha256, `published.${channel}.signingSha256`);
      sha256(next.signingSha256, `candidate.${channel}.signingSha256`);
      requiredText(next.upgradeEligibilityRef, `candidate.${channel}.upgradeEligibilityRef`);
      sha256(next.artifactSha256, `candidate.${channel}.artifactSha256`);
      equal(next.dcloudAppId, published.dcloudAppId, `candidate ${channel} DCloud appid`);
      const highest = positiveCode(old.highestVersionCode);
      const nextCode = positiveCode(next.versionCode);
      if (highest === null || nextCode === null || nextCode <= highest || nextCode !== sourceCode) {
        issues.push(`candidate ${channel} versionCode must match source and exceed the highest published code`);
      }
      if (next.versionName !== source.versionName || !newerVersion(next.versionName, old.highestVersionName)) {
        issues.push(`candidate ${channel} versionName must match source and exceed the highest published version`);
      }
    }
    origin(old.apiOrigin, `published.${channel}.apiOrigin`);
    origin(next.apiOrigin, `candidate.${channel}.apiOrigin`);
    if (apiOrigin && old.apiOrigin !== apiOrigin) issues.push(`published ${channel} API origin differs from source; verify old-origin routing separately`);
    if (apiOrigin && next.apiOrigin !== apiOrigin) issues.push(`candidate ${channel} API origin differs from source`);
  }
  return issues;
}

function runPreflight(evidencePath, root = projectRoot) {
  if (!evidencePath) throw new Error('explicit path to local release evidence JSON is required');
  const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  return checkReleaseIdentity({
    evidence: JSON.parse(readFileSync(resolve(evidencePath), 'utf8')),
    sourceManifest: readJson('src/manifest.json'),
    appBuildManifest: readJson('dist/build/app/manifest.json'),
    mpBuildProject: readJson('dist/build/mp-weixin/project.config.json'),
    requestSource: readFileSync(resolve(root, 'src/utils/request.ts'), 'utf8'),
    appServiceBuild: readFileSync(resolve(root, 'dist/build/app/app-service.js'), 'utf8'),
    mpRequestBuild: readFileSync(resolve(root, 'dist/build/mp-weixin/utils/request.js'), 'utf8'),
  });
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/release-upgrade-preflight.cjs <outside-repo-release-evidence.json>');
    const issues = runPreflight(process.argv[2]);
    if (issues.length) {
      process.stderr.write(`UniApp release preflight blocked:\n- ${issues.join('\n- ')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('UniApp release metadata preflight passed. Build checks prove origin literal presence only; actual request destinations, signed packages, channel upgrade eligibility, and live channels remain unverified release gates.\n');
    }
  } catch (error) {
    process.stderr.write(`UniApp release preflight blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { checkReleaseIdentity, runPreflight };
