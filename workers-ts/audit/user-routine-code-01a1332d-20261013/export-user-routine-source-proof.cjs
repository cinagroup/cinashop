const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const source = String.raw`\\tsclient\I\cinagroup\cinashop`;
const archive = path.join(root, 'user-routine-code-local-final-evidence-20261013');
const destination = path.join(source, 'workers-ts/audit/user-routine-code-01a1332d-20261013');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const receiptPath = path.join(root, 'user-routine-source-writeback.json');
if (!fs.existsSync(receiptPath)) throw Error('Actual coordinated Source writeback receipt is required');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(archive, 'local-final-summary.json'), 'utf8'));
if (!receipt.sourceWritebackCompleted || receipt.rows.length !== 4) throw Error('Writeback not qualified');
for (const row of receipt.rows) {
  if (hash(fs.readFileSync(path.join(source, row.path))) !== row.candidateSha256 || row.sourceAfterSha256 !== row.candidateSha256) throw Error('Current Source candidate drift: ' + row.path);
}
const artifacts = [];
function copy(from, relative) {
  const target = path.resolve(destination, relative);
  if (!target.startsWith(destination + path.sep)) throw Error('Archive path escaped destination');
  const bytes = fs.readFileSync(from);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && hash(fs.readFileSync(target)) !== hash(bytes)) throw Error('Existing different Source evidence: ' + relative);
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
  if (hash(fs.readFileSync(target)) !== hash(bytes)) throw Error('Source evidence export drift: ' + relative);
  artifacts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
}
for (const artifact of summary.artifacts) {
  const from = path.resolve(archive, artifact.path);
  if (!from.startsWith(archive + path.sep)) throw Error('Local artifact escaped archive');
  if (hash(fs.readFileSync(from)) !== artifact.sha256) throw Error('Local archived proof drift');
  copy(from, artifact.path);
}
copy(path.join(archive, 'local-final-summary.json'), 'local-final-summary.json');
copy(receiptPath, 'user-routine-source-writeback.json');
copy(__filename, 'export-user-routine-source-proof.cjs');
const docRelative = 'workers-ts/docs/user-routine-code-migration-20261013.md';
const archivedDraftBytes = fs.readFileSync(path.join(archive, 'candidate', docRelative));
let doc = archivedDraftBytes.toString('utf8');
function replaceOnce(from, to) {
  if (!doc.includes(from) || doc.indexOf(from) !== doc.lastIndexOf(from)) throw Error('Missing or ambiguous draft anchor: ' + from);
  doc = doc.replace(from, to);
}
replaceOnce('# Personal routine_code migration — local draft, 2026-10-13', '# Personal routine_code migration — accepted source, 2026-10-13');
replaceOnce('Status: LOCAL candidate only. Three source candidates and one new test remain in the task-owned validation copy; no shared Source writeback has occurred.', `Status: The three implementation files and one new test were written to shared Source at ${receipt.finishedAt} after the main coordinator explicitly released its freeze. The guarded writeback receipt confirms that all four Source files exactly match the tested local candidates.`);
replaceOnce('## Current local alias', '## Accepted source alias');
replaceOnce('This draft makes no stronger revocation claim.', 'This migration makes no stronger revocation claim.');
replaceOnce('The four current local candidate inputs were independently hash checked:', 'The four tested local inputs were independently hash checked and later accepted into Source with these exact bytes:');
replaceOnce('| Local candidate | SHA256 |', '| Accepted source input | SHA256 |');
replaceOnce('Current alias candidates are still local and are not included in that unchanged-Source claim.', 'That unchanged-Source comparison describes the historical pre-writeback state. The separate guarded writeback receipt establishes the later four-file Source parity; the local type run does not qualify the whole current Source repository.');
replaceOnce('The coordinator owns these commands; this documentation task launches no typecheck, test, PG server or build.', 'The receipts record the actual commands and frozen inputs; the source archive export launches no additional typecheck, test, PG server or build.');
replaceOnce('Active main runner/Mini files, uncollected alias Source changes and later frontend pages registration do not receive current whole-Source type acceptance from this frozen local run.', 'The four accepted Source files match the frozen local candidates. Active main runner/Mini files and later frontend pages registration do not receive current whole-Source type acceptance from this frozen local run.');
replaceOnce('The three recorded original Source baselines also have zero drift; this does not mean the local alias candidates have been applied to Source.', 'The three recorded original Source baselines had zero drift during the native run. The later guarded writeback receipt separately records their replacement and the new test with the exact qualified candidate bytes.');
const integrationHeading = '## Source integration gate';
if (!doc.includes(integrationHeading)) throw Error('Missing source integration gate');
doc = doc.slice(0, doc.indexOf(integrationHeading)) + `## Recorded Source integration\n\nThe main coordinator explicitly released its prior source freeze and authorized this four-file writeback. The guarded writer verified every original Source baseline, the new test's absence and every tested local candidate hash twice before writing. It completed at ${receipt.finishedAt}; all four recorded Source-after hashes equal the local tested hashes. Shared Mini, routes, Auth, runner, frontend pages, grants and the two root migration checklists were outside this writeback.\n\nThe [Source audit summary](../audit/user-routine-code-01a1332d-20261013/routine-code-final-summary.json) contains the actual writeback receipt and same-byte archived local proofs. The original local draft is preserved inside the audit's candidate directory; this accepted-source document is derived separately so historical evidence is not rewritten. The prior main 4031-input snapshot and its 1130 distinct passed cases predate this writeback and receive no new routine-code credit.\n\nThe local 3090-input regression and full type checks qualify the four accepted files within their recorded snapshot. The current main Mini whole file, later pages registration and unrelated parallel changes remain outside that snapshot; no current whole-Source build or type result is asserted here. Referral policy and registration rewards remain a separate migration scope.\n`;
const docBytes = Buffer.from(doc, 'utf8');
const docTarget = path.join(source, docRelative);
if (fs.existsSync(docTarget) && hash(fs.readFileSync(docTarget)) !== hash(docBytes)) throw Error('Existing different Source doc');
if (!fs.existsSync(docTarget)) fs.writeFileSync(docTarget, docBytes);
if (hash(fs.readFileSync(docTarget)) !== hash(docBytes)) throw Error('Source doc export drift');
const final = { ...summary, archivedToSourceAt: new Date().toISOString(), sourceWritebackCompleted: true, sourceWriteback: receipt, sourceDoc: { path: docRelative, sha256: hash(docBytes), derivedFromArchivedDraftSha256: hash(archivedDraftBytes) }, wholeCurrentSourceTypeChecksPassed: false, limits: ['Independent LOCAL 3090 snapshot and its four owned candidate Source files are qualified.', 'The active coordinator current whole repository and newer Mini imports/pages are not credited by this local snapshot.', 'Cash registration rewards and referral binding policy are independent future migration scopes.', 'No deployment, live provider or physical device acceptance.'], sourceArchivedArtifacts: artifacts };
const finalPath = path.join(destination, 'routine-code-final-summary.json');
if (fs.existsSync(finalPath)) throw Error('Do not replace immutable Source final summary');
fs.writeFileSync(finalPath, JSON.stringify(final, null, 2) + '\n');
console.log(JSON.stringify({ path: finalPath, sha256: hash(fs.readFileSync(finalPath)), artifactCount: artifacts.length, sourceTargets: 4, sourceDocSha256: hash(docBytes), wholeCurrentSourceTypeChecksPassed: false }));
