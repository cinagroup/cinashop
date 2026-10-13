// Execute only after the coordinator explicitly releases its current Source freeze.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.argv[2] !== '--coordinated-release') throw Error('Explicit coordinated Source release is required');
const root = __dirname;
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const baseline = read('user-routine-candidate-local-prepare.json');
const candidate = read('user-routine-alias-candidate-summary.json');
const regression = read('user-routine-regression-local-1-result.json');
const types = read('user-routine-types-local-1-result.json');
const before = read('user-routine-types-local-before-1.json');
const after = read('user-routine-types-local-after-1.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = '767c94533f7fabd24d9cc784d50e4a7086dbb355dfb40115bf1ae757b063ca3a';
if (regression.exitCode !== 0 || regression.numPassedTests !== 194 || regression.numTotalTests !== 194 || regression.numFailedTests || regression.numPendingTests || regression.inputDrift.length || regression.beforeDigest !== expected || regression.afterDigest !== expected) throw Error('Complete regression not qualified');
if (types.commands.length !== 2 || types.commands.some(command => command.exitCode !== 0 || command.error || command.signal || fs.readFileSync(command.log).length)) throw Error('Types not qualified');
if (before.fileCount !== 3090 || after.fileCount !== 3090 || before.localManifestSha256 !== expected || after.localManifestSha256 !== expected || JSON.stringify(before.files) !== JSON.stringify(after.files)) throw Error('Type inputs not qualified');
const owned = [
  'workers-ts/src/services/other/LegacyShareCodeService.ts',
  'workers-ts/src/services/user/UserProfileService.ts',
  'workers-ts/src/controllers/api/v1/UserProfileController.ts',
  'workers-ts/test/legacy-user-routine-code.test.ts',
];
if (candidate.ownedInputs.length !== owned.length || candidate.ownedInputs.some(input => !owned.includes(input.path))) throw Error('Unexpected writeback scope');
const receiptPath = path.join(root, 'user-routine-source-writeback.json');
if (fs.existsSync(receiptPath)) throw Error('Writeback already recorded; do not overwrite receipt');
const prepared = owned.map(relative => {
  const input = candidate.ownedInputs.find(row => row.path === relative);
  const bytes = fs.readFileSync(path.join(baseline.local, relative));
  if (hash(bytes) !== input.sha256) throw Error('Candidate changed: ' + relative);
  const old = baseline.rows.find(row => row.path === relative);
  const target = path.join(baseline.source, relative);
  if (old) {
    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== old.sourceBaselineSha256) throw Error('Source baseline changed: ' + relative);
  } else if (fs.existsSync(target)) throw Error('New test Source already exists: ' + relative);
  return { relative, bytes, target, beforeSha256: old?.sourceBaselineSha256 ?? null, afterSha256: input.sha256 };
});
// Recheck every input together before the first mutation.
for (const item of prepared) {
  if (hash(fs.readFileSync(path.join(baseline.local, item.relative))) !== item.afterSha256) throw Error('Local changed before writeback');
  if (item.beforeSha256 ? hash(fs.readFileSync(item.target)) !== item.beforeSha256 : fs.existsSync(item.target)) throw Error('Source changed before writeback');
}
const startedAt = new Date().toISOString();
for (const item of prepared) fs.writeFileSync(item.target, item.bytes);
const rows = prepared.map(item => {
  const actual = hash(fs.readFileSync(item.target));
  if (actual !== item.afterSha256) throw Error('Source writeback byte mismatch: ' + item.relative);
  return { path: item.relative, sourceBeforeSha256: item.beforeSha256, candidateSha256: item.afterSha256, sourceAfterSha256: actual };
});
const receipt = { startedAt, finishedAt: new Date().toISOString(), coordinatedRelease: true, sourceWritebackCompleted: true, wholeCurrentSourceFrozen: false, validatedLocalInputCount: 3090, validatedLocalDigest: expected, source: baseline.source, local: baseline.local, rows, limits: ['Only these four Source files were copied.', 'Unrelated current Main changes and its newer Mini import graph are not covered by independent frozen LOCAL type checks.', 'No shared route, provider method, production configuration or deployment changes.'] };
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
