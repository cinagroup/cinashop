'use strict';

// Historical input for the unchanged Uni partition proof only. The real
// workflow and its private-source checks are neither edited nor executed here.
const { createHash } = require('node:crypto');
const { readFileSync: readDiskFileSync } = require('node:fs');
const { relative, resolve } = require('node:path');
const { fileURLToPath } = require('node:url');

const root = resolve(__dirname, '../../..');
const WORKFLOW_FILE = '.github/workflows/workers-runtime-linux.yml';
const PROOF_FILE = 'workers-ts/test/fixtures/legacy-php-input-source-binding-20261103.json';
const PROOF_SHA = 'e5427c63002e4def70c41cd63c5c1e06bc771d6a2dc7400622db972f98f13d47';
const PROOF_CANONICAL_SHA = 'b08224e299db85e6dcc039ef3a9297a5155a6f5411bff20060af22f57307a56d';
const PREDECESSOR = 'f2a848eb6b8375b292de33df2937e9c091673662';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error('Legacy PHP Uni readport: ' + message); };
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function verifyProof(proof) {
  // Pin the complete independent Worker proof, including its historical
  // imports/old-proof identity; no partial fixture or generated expected graph.
  if (sha(JSON.stringify(proof)) !== PROOF_CANONICAL_SHA) fail('complete proof differs');
  if (proof.format_version !== 1 || proof.file !== WORKFLOW_FILE || proof.predecessor_commit !== PREDECESSOR)
    fail('proof scope differs');
  for (const [name, bytes, digest, origins] of [
    ['candidate', 20868, '2dd8f68b57e6566fc19b02a7b8614f45501f5498c080f34a3f7b799f953f2c79', []],
    ['predecessor', 19659, '30c49172a5fa6fa01a18131f344f614cf9e640b50fd59daa39209e54631aecce', [PREDECESSOR]],
  ]) {
    const image = proof.images[name];
    if (typeof image.raw_utf8 !== 'string' || image.bytes !== bytes || image.sha256 !== digest
      || Buffer.byteLength(image.raw_utf8, 'utf8') !== bytes || sha(image.raw_utf8) !== digest
      || JSON.stringify(image.origins) !== JSON.stringify(origins)) fail('complete image differs');
  }
  if (proof.inverse_edits.length !== 5
    || sha(JSON.stringify(proof.inverse_edits)) !== 'ba84ed0576f18c52aaf14bd5c1a589019aed46a09759220453aa9188837c9f3b')
    fail('five exact inverse edits differ');
}

function decodeLegacyPhpWorkflowProof(bytes) {
  if (!Buffer.isBuffer(bytes) || sha(bytes) !== PROOF_SHA) fail('raw proof bytes differ');
  const proof = JSON.parse(utf8(bytes));
  verifyProof(proof);
  return freeze(proof);
}

const proof = decodeLegacyPhpWorkflowProof(readDiskFileSync(resolve(root, PROOF_FILE)));
const oldProof = readDiskFileSync(resolve(root, proof.unchanged_proof.file));
if (sha(oldProof) !== proof.unchanged_proof.sha256) fail('unchanged earlier proof bytes differ');

function projectLegacyPhpWorkflowPredecessor(file, source, input = proof) {
  if (file !== WORKFLOW_FILE) return source;
  verifyProof(input);
  if (typeof source !== 'string' || source !== input.images.candidate.raw_utf8
    || sha(source) !== input.images.candidate.sha256) fail('current workflow source differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  let boundary = lines.length;
  for (const edit of [...input.inverse_edits].reverse()) {
    if (!Number.isSafeInteger(edit.start) || edit.start < 0 || !Array.isArray(edit.after) || !Array.isArray(edit.before)
      || !edit.after.every(line => typeof line === 'string') || !edit.before.every(line => typeof line === 'string')
      || edit.start + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      fail('exact inverse source differs');
    lines.splice(edit.start, edit.after.length, ...edit.before);
    boundary = edit.start;
  }
  const previous = lines.join('');
  if (previous !== input.images.predecessor.raw_utf8
    || Buffer.byteLength(previous, 'utf8') !== input.images.predecessor.bytes
    || sha(previous) !== input.images.predecessor.sha256) fail('complete predecessor differs');
  return previous;
}

// Verify the complete derivation before supplying any historical read.
projectLegacyPhpWorkflowPredecessor(WORKFLOW_FILE, proof.images.candidate.raw_utf8);

function readFileSync(file, options) {
  const value = readDiskFileSync(file, options);
  if (typeof file === 'number') return value;
  const path = resolve(typeof file === 'string' ? file : file instanceof URL ? fileURLToPath(file) : utf8(file));
  if (relative(root, path).replace(/\\/g, '/') !== WORKFLOW_FILE) return value;
  const source = typeof value === 'string' ? value : utf8(value);
  const previous = projectLegacyPhpWorkflowPredecessor(WORKFLOW_FILE, source);
  return typeof value === 'string' ? previous : Buffer.from(previous, 'utf8');
}

module.exports = { WORKFLOW_FILE, PROOF_FILE, PROOF_SHA, proof,
  decodeLegacyPhpWorkflowProof, projectLegacyPhpWorkflowPredecessor, readFileSync };
