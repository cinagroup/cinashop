const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkReleaseIdentity, runPreflight } = require('./release-upgrade-preflight.cjs');

const dcloudAppId = '__UNI__12345678';
const weixinAppId = 'wx0123456789abcdef';
const apiOrigin = 'https://api.example.test';
const androidSha = 'a'.repeat(64);
const iosSha = 'b'.repeat(64);

function fixture() {
  return {
    sourceManifest: {
      appid: dcloudAppId, versionName: '3.2.0', versionCode: '320',
      'mp-weixin': { appid: weixinAppId },
    },
    appBuildManifest: { id: dcloudAppId, version: { name: '3.2.0', code: '320' } },
    mpBuildProject: { appid: weixinAppId },
    requestSource: `let apiBase = "${apiOrigin}";`,
    appServiceBuild: `const api = "${apiOrigin}";`,
    mpRequestBuild: `const api = "${apiOrigin}";`,
    evidence: {
      published: {
        dcloudAppId, weixinAppId,
        weixin: { highestVersionName: '3.1.1', apiOrigin, evidenceRef: 'Weixin release console export' },
        android: { packageId: 'com.example.store', signingSha256: androidSha,
          highestVersionName: '3.1.1', highestVersionCode: 311, apiOrigin,
          evidenceRef: 'published signed APK inspection' },
        ios: { bundleId: 'com.example.store', signingSha256: iosSha,
          highestVersionName: '3.1.1', highestVersionCode: 311, apiOrigin,
          evidenceRef: 'App Store and signed IPA inspection' },
      },
      candidate: {
        weixin: { appId: weixinAppId, versionName: '3.2.0', apiOrigin,
          evidenceRef: 'candidate Weixin project inspection' },
        android: { dcloudAppId, packageId: 'com.example.store', signingSha256: androidSha,
          versionName: '3.2.0', versionCode: 320, apiOrigin, artifactSha256: 'c'.repeat(64),
          upgradeEligibilityRef: 'Play update eligibility inspection' },
        ios: { dcloudAppId, bundleId: 'com.example.store', signingSha256: iosSha,
          versionName: '3.2.0', versionCode: 320, apiOrigin, artifactSha256: 'd'.repeat(64),
          upgradeEligibilityRef: 'App Store update eligibility inspection' },
      },
    },
  };
}

test('requires explicit evidence and rejects absent channel records', () => {
  assert.throws(() => runPreflight(), /explicit path/);
  const input = fixture();
  input.evidence = {};
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('published.dcloudAppId')));
  assert.ok(issues.some(issue => issue.includes('published.android.signingSha256')));
  assert.ok(issues.some(issue => issue.includes('published.ios.bundleId')));
});

test('accepts a complete synthetic same-identity upgrade record', () => {
  assert.deepEqual(checkReleaseIdentity(fixture()), []);
});

test('accepts distinct iOS submission and delivered signing certificates when eligibility is recorded', () => {
  const input = fixture();
  input.evidence.candidate.ios.signingSha256 = 'e'.repeat(64);
  assert.deepEqual(checkReleaseIdentity(input), []);
});

test('requires channel-specific upgrade eligibility evidence for each native release', () => {
  const input = fixture();
  delete input.evidence.candidate.android.upgradeEligibilityRef;
  delete input.evidence.candidate.ios.upgradeEligibilityRef;
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('candidate.android.upgradeEligibilityRef is required')));
  assert.ok(issues.some(issue => issue.includes('candidate.ios.upgradeEligibilityRef is required')));
});

test('ignores commented API origin decoys and checks the executable initializer', () => {
  const input = fixture();
  input.requestSource = `// let apiBase = "${apiOrigin}";\nlet apiBase = "https://other.example.test";`;
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('candidate weixin API origin differs from source')));
  assert.ok(issues.some(issue => issue.includes('candidate android API origin differs from source')));

  input.requestSource = `const decoy = 'let apiBase = "${apiOrigin}";';\nlet apiBase = "https://other.example.test";`;
  assert.ok(checkReleaseIdentity(input).some(issue => issue.includes('candidate weixin API origin differs from source')));

  input.requestSource = `// let apiBase = "${apiOrigin}";`;
  assert.ok(checkReleaseIdentity(input).some(issue => issue.includes('unique top-level static HTTPS origin')));
});

test('rejects source and build identity mismatches, including touristappid', () => {
  const input = fixture();
  input.sourceManifest.appid = '';
  input.mpBuildProject.appid = 'touristappid';
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('source DCloud appid is absent')));
  assert.ok(issues.some(issue => issue.includes('built Weixin project appid')));
  assert.ok(issues.some(issue => issue.includes('touristappid')));
});

test('rejects versions that cannot replace the highest published packages', () => {
  const input = fixture();
  input.sourceManifest.versionCode = '311';
  input.appBuildManifest.version.code = '311';
  input.evidence.candidate.android.versionCode = 311;
  input.evidence.candidate.ios.versionCode = 311;
  input.evidence.candidate.android.versionName = '3.1.1';
  input.evidence.candidate.ios.versionName = '3.1.1';
  input.evidence.candidate.weixin.versionName = '3.1.1';
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('Weixin versionName must exceed')));
  assert.ok(issues.some(issue => issue.includes('android versionCode must match source and exceed')));
  assert.ok(issues.some(issue => issue.includes('ios versionCode must match source and exceed')));
  assert.ok(issues.some(issue => issue.includes('android versionName must match source and exceed')));
  assert.ok(issues.some(issue => issue.includes('ios versionName must match source and exceed')));
});

test('rejects malformed native signing evidence and a published API origin outside the candidate Worker', () => {
  const input = fixture();
  input.evidence.candidate.android.signingSha256 = 'not-a-fingerprint';
  input.evidence.candidate.ios.bundleId = 'com.example.other';
  input.evidence.published.weixin.apiOrigin = 'https://old.example.test';
  input.mpRequestBuild = 'another compiled endpoint';
  const issues = checkReleaseIdentity(input);
  assert.ok(issues.some(issue => issue.includes('candidate.android.signingSha256 must be a SHA-256 fingerprint')));
  assert.ok(issues.some(issue => issue.includes('ios bundleId')));
  assert.ok(issues.some(issue => issue.includes('published weixin API origin')));
  assert.ok(issues.some(issue => issue.includes('weixin build does not contain')));
});
