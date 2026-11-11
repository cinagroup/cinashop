'use strict';

// Historical Uni assertions only. Read the complete live workflow, reverse the
// three already reviewed TS-only increments, then let the unchanged five-edit
// legacy-input proof run. This neither executes nor changes the actual gates.
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const WORKFLOW_FILE = '.github/workflows/workers-runtime-linux.yml';
const root = resolve(__dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw Error('Uni workflow continuity: ' + message); };
const image = source => ({ bytes: Buffer.byteLength(source), sha256: sha(source),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(source) + '\0').update(source).digest('hex') });
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const PINS = freeze({
  operations: {
    file: 'workers-ts/test/fixtures/purchased-label-operations-continuity-20261110.json',
    bytes: 37217, sha256: '60144df5fb7fe5d781e24ba935060434d23efce30c24d06841b85f16c40271de',
    schema: 'purchased-label-operations-continuity/v1', count: 6,
    predecessorCommit: '2e63c407db8b66baae76efbcb111f325417d1ad9',
    current: { bytes: 21550, sha256: '94f08a84a76181eb0f0229f0f82d1f731b9c39ebbe09b5ceebb4ae3741d6cac6', gitBlobSha1: 'c928028113d6f075c50baa87ccc8d25e1aac0a39' },
    predecessor: { bytes: 21512, sha256: 'cd1d81bab3cb25272b3eca15dedb979527ecbeabb382bc9c17a7da156fa14cfa', gitBlobSha1: '552bed24653cb1ea22716fc7ddf5ab9545c830d5' },
  },
  provider: {
    file: 'workers-ts/test/fixtures/provider-transport-source-continuity-20261109.json',
    bytes: 46704, sha256: 'be895c2c4a72e33c120aadd7da13fb71eae93b9ff6ff37e495ee6b8fcf81d1b1',
    schema: 'provider-transport-source-continuity/v1', count: 30, kind: 'validation-workflow',
    predecessorCommit: '353ec0ed03a860eafbc850e9983da505a7ade748',
    current: { bytes: 21512, sha256: 'cd1d81bab3cb25272b3eca15dedb979527ecbeabb382bc9c17a7da156fa14cfa', gitBlobSha1: '552bed24653cb1ea22716fc7ddf5ab9545c830d5' },
    predecessor: { bytes: 21344, sha256: 'a46eeed08813737bb08db126c7cb15a6d348be4bef114e799f8dc877da8d7dab', gitBlobSha1: '9cde8f6322ea33aa867886bd7c6d850128e2c348' },
  },
  refund: {
    file: 'workers-ts/test/fixtures/recharge-refund-notice-consumer-source-continuity-20261109.json',
    bytes: 655361, sha256: 'dc74c4abd38298c3feed1afa7a1578d57e2f753360115538e5716e4f68257532',
    schema: 'recharge-refund-source-continuity/v10', count: 47, kind: 'feature-source',
    predecessorCommit: '78240b7801a617ed5b1c1e444860228c066311b8',
    current: { bytes: 21344, sha256: 'a46eeed08813737bb08db126c7cb15a6d348be4bef114e799f8dc877da8d7dab', gitBlobSha1: '9cde8f6322ea33aa867886bd7c6d850128e2c348' },
    predecessor: { bytes: 20868, sha256: '2dd8f68b57e6566fc19b02a7b8614f45501f5498c080f34a3f7b799f953f2c79', gitBlobSha1: '32617fef592a8625adb355274e1a2ec1ae19b911' },
  },
});

function decodeWorkflowContinuityProof(kind, bytes) {
  if (typeof kind !== 'string' || !Object.hasOwn(PINS, kind)) fail('proof scope differs');
  const pin = PINS[kind];
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) fail('complete proof bytes differ');
  const proof = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  if (proof.schema !== pin.schema || proof.predecessorCommit !== pin.predecessorCommit
    || !Array.isArray(proof.sources) || proof.sources.length !== pin.count
    || new Set(proof.sources.map(row => row.file)).size !== pin.count) fail('complete proof scope differs');
  const rows = proof.sources.filter(row => row.file === WORKFLOW_FILE);
  if (rows.length !== 1) fail('workflow proof scope differs');
  const row = rows[0];
  if (row.kind !== pin.kind || JSON.stringify(row.current) !== JSON.stringify(pin.current)
    || JSON.stringify(row.predecessor) !== JSON.stringify(pin.predecessor)
    || row.origin.commit !== pin.predecessorCommit || row.origin.path !== WORKFLOW_FILE
    || row.origin.gitBlobSha1 !== pin.predecessor.gitBlobSha1 || !row.inverseEdits.length) fail('fixed workflow origin differs');
  return freeze(proof);
}

const proofs = Object.fromEntries(Object.entries(PINS).map(([kind, pin]) =>
  [kind, decodeWorkflowContinuityProof(kind, readFileSync(resolve(root, pin.file)))]));
const rows = ['operations', 'provider', 'refund'].map(kind => proofs[kind].sources.find(row => row.file === WORKFLOW_FILE));
for (let i = 1; i < rows.length; i++) {
  if (JSON.stringify(rows[i-1].predecessor) !== JSON.stringify(rows[i].current)) fail('complete intermediate image differs');
}

function projectCurrentWorkflowToLegacyCandidate(file, source) {
  if (file !== WORKFLOW_FILE) return source;
  if (typeof source !== 'string' || JSON.stringify(image(source)) !== JSON.stringify(rows[0].current))
    fail('current workflow source differs');
  for (const row of rows) {
    if (JSON.stringify(image(source)) !== JSON.stringify(row.current)) fail('complete current image differs');
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
    let boundary = 0;
    for (const edit of row.inverseEdits) {
      if (!Number.isSafeInteger(edit.start) || edit.start < boundary || !Array.isArray(edit.after) || !Array.isArray(edit.before)
        || !edit.after.every(line => typeof line === 'string') || !edit.before.every(line => typeof line === 'string')
        || !edit.after.length && !edit.before.length || edit.start + edit.after.length > lines.length
        || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
        fail('exact inverse source differs');
      if (Object.hasOwn(edit, 'anchorStart') && (!Number.isSafeInteger(edit.anchorStart) || edit.anchorStart < 0
        || !Array.isArray(edit.anchor) || edit.anchorStart + edit.anchor.length > lines.length
        || JSON.stringify(lines.slice(edit.anchorStart, edit.anchorStart + edit.anchor.length)) !== JSON.stringify(edit.anchor)))
        fail('exact source anchor differs');
      boundary = edit.start + edit.after.length;
    }
    for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
    source = lines.join('');
    if (JSON.stringify(image(source)) !== JSON.stringify(row.predecessor)) fail('complete predecessor differs');
  }
  return source;
}

module.exports = { WORKFLOW_FILE, PINS, decodeWorkflowContinuityProof, projectCurrentWorkflowToLegacyCandidate };
