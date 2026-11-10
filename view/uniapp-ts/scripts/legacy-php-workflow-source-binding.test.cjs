'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, openSync, closeSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');
const { projectCurrentWorkflowToLegacyCandidate } = require('./workflow-source-continuity.cjs');
require('./workflow-source-continuity.test.cjs');
const { WORKFLOW_FILE, PROOF_FILE, PROOF_SHA, proof, decodeLegacyPhpWorkflowProof,
  projectLegacyPhpWorkflowPredecessor: project, readFileSync: historicalRead } = require('./legacy-php-workflow-source-binding.cjs');

const root = resolve(__dirname, '../../..'), workflow = resolve(root, WORKFLOW_FILE);
const current = readFileSync(workflow, 'utf8'), previous = proof.images.predecessor.raw_utf8;
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = () => structuredClone(proof);

test('real current bytes use the existing complete five-edit Worker proof and exact f2 predecessor', () => {
  const bytes = readFileSync(resolve(root, PROOF_FILE));
  assert.equal(sha(bytes), PROOF_SHA);
  const candidate = projectCurrentWorkflowToLegacyCandidate(WORKFLOW_FILE, current);
  assert.equal(candidate, proof.images.candidate.raw_utf8);
  assert.equal(Buffer.byteLength(candidate), 20868);
  assert.equal(project(WORKFLOW_FILE, current), previous);
  assert.equal(Buffer.byteLength(previous), 19659);
  assert.equal(sha(previous), '30c49172a5fa6fa01a18131f344f614cf9e640b50fd59daa39209e54631aecce');
  assert.equal(proof.predecessor_commit, 'f2a848eb6b8375b292de33df2937e9c091673662');
  assert.equal(proof.inverse_edits.length, 5);
  for (const edit of proof.inverse_edits) assert.ok(current.includes(edit.after.join('')));
  assert.equal(previous.includes('environment: legacy-php-readonly'), false);
  assert.equal(previous.includes('LEGACY_PHP_READONLY_SSH_KEY'), false);
  assert.ok(current.includes('environment: legacy-php-readonly'));
  assert.ok(current.includes('ssh-strict: true'));
  assert.ok(current.includes('persist-credentials: false'));
  assert.ok(current.includes('set -euo pipefail'));
  assert.equal(readFileSync(workflow, 'utf8'), current);
});

test('f2 is the old Uni partition input; the existing 20f baseline and all old assertion bytes remain unchanged', () => {
  const oldProofBytes = readFileSync(resolve(root, proof.unchanged_proof.file));
  assert.equal(sha(oldProofBytes), '72feefd0ae48a70f80edfc8c8124e880421754e50b45a496e9b284cc5023c1f0');
  const oldProof = JSON.parse(oldProofBytes);
  assert.equal(previous, oldProof.images.candidate.raw_utf8);
  const baselineFile = resolve(__dirname, 'ci-migration-gates.baseline.json');
  assert.equal(sha(readFileSync(baselineFile)), '4c8cd467d196650fa5d9fac21a6279199a455eb812646dda0d96e8083737e9c2');
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  assert.equal(baseline.source.sha256, oldProof.images.parent.sha256);
  assert.equal(baseline.source.commit, '20f180ae24a88f40fe6d0a35c26d2cae0204ca01');
  assert.deepEqual(baseline.workflow, YAML.parse(oldProof.images.parent.raw_utf8));
  const after = "const { readFileSync } = require('./legacy-php-workflow-source-binding.cjs');";
  const before = "const { readFileSync } = require('node:fs');";
  const oldTest = readFileSync(resolve(__dirname, 'ci-migration-gates.test.cjs'), 'utf8');
  const testImport = "require('./legacy-php-workflow-source-binding.test.cjs');\n";
  assert.equal(oldTest.split(after).length, 2);
  assert.equal(oldTest.split(testImport).length, 2);
  assert.equal(sha(oldTest.replace(after, before).replace(testImport, '')), '624a77aefb8fcaaa3e6c246c24d17c2351429334f7be8b26112a27b48ce11a54');
});

test('only the exact workflow pathname is projected; native UTF8, Buffer, URL and descriptor forms remain explicit', () => {
  assert.equal(historicalRead(workflow, 'utf8'), previous);
  assert.equal(historicalRead(workflow, { encoding: 'utf8' }), previous);
  assert.deepEqual(historicalRead(workflow), Buffer.from(previous));
  assert.equal(historicalRead(pathToFileURL(workflow), 'utf8'), previous);
  assert.equal(historicalRead(Buffer.from(workflow), 'utf8'), previous);
  const unrelated = resolve(__dirname, 'ci-migration-gates.baseline.json');
  assert.deepEqual(historicalRead(unrelated), readFileSync(unrelated));
  assert.equal(project('other.yml', current + '\n# drift\n'), current + '\n# drift\n');
  const fd = openSync(workflow, 'r');
  try { assert.deepEqual(historicalRead(fd), Buffer.from(current)); } finally { closeSync(fd); }
  const directory = mkdtempSync(join(tmpdir(), 'uni-workflow-readport-'));
  try {
    const outside = join(directory, 'workers-runtime-linux.yml');
    writeFileSync(outside, '# unrelated unreviewed document\n');
    assert.equal(historicalRead(outside, 'utf8'), '# unrelated unreviewed document\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [label, source] of [
  ['append', current + '\n# unreviewed\n'], ['truncate', current.slice(1)],
  ['CRLF', current.replaceAll('\n', '\r\n')], ['duplicate', current + current],
  ['moving PHP ref', current.replace('ref: 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5', 'ref: main')],
  ['wrong environment', current.replace('environment: legacy-php-readonly', 'environment: other')],
  ['credential persistence', current.replace('persist-credentials: false', 'persist-credentials: true')],
  ['removed strict SSH', current.replace('ssh-strict: true', 'ssh-strict: false')],
  ['removed pipefail', current.replace('          set -euo pipefail\n', '')],
  ['f2 fallback', previous],
]) test('rejects unknown current workflow bytes: ' + label, () => {
  assert.throws(() => project(WORKFLOW_FILE, source), /current workflow source differs/);
});

for (const image of ['candidate', 'predecessor']) for (const field of ['text', 'digest', 'bytes', 'origin'])
  test('rejects changed complete ' + image + ' image ' + field, () => {
    const changed = clone(), row = changed.images[image];
    if (field === 'text') row.raw_utf8 += '\n';
    if (field === 'digest') row.sha256 = '0'.repeat(64);
    if (field === 'bytes') row.bytes++;
    if (field === 'origin') row.origins.push('0'.repeat(40));
    assert.throws(() => project(WORKFLOW_FILE, current, changed), /complete proof differs/);
  });

for (const index of [0, 1, 2, 3, 4]) for (const field of ['position', 'after', 'before'])
  test('rejects changed exact inverse ' + index + ' ' + field, () => {
    const changed = clone(), edit = changed.inverse_edits[index];
    if (field === 'position') edit.start++;
    if (field === 'after') edit.after.push('# unreviewed current\n');
    if (field === 'before') edit.before.push('# unreviewed previous\n');
    assert.throws(() => project(WORKFLOW_FILE, current, changed), /complete proof differs/);
  });

for (const [label, mutate] of [
  ['missing edit', p => p.inverse_edits.pop()],
  ['reordered edits', p => p.inverse_edits.reverse()],
  ['duplicated edit', p => p.inverse_edits.push(structuredClone(p.inverse_edits[0]))],
  ['whole-image shortcut', p => { p.inverse_edits = [{ start: 0,
    after: p.images.candidate.raw_utf8.match(/[^\n]*\n|[^\n]+$/g), before: p.images.predecessor.raw_utf8.match(/[^\n]*\n|[^\n]+$/g) }]; }],
  ['wrong scope', p => { p.file = 'other.yml'; }],
  ['wrong historical commit', p => { p.predecessor_commit = '0'.repeat(40); }],
  ['changed earlier proof', p => { p.unchanged_proof.sha256 = '0'.repeat(64); }],
  ['extra proof field', p => { p.unreviewed = true; }],
]) test('rejects changed proof: ' + label, () => {
  const changed = clone(); mutate(changed);
  assert.throws(() => project(WORKFLOW_FILE, current, changed), /complete proof differs/);
});

test('raw proof formatting and encoding cannot bypass the independent exact-byte pin', () => {
  const bytes = readFileSync(resolve(root, PROOF_FILE));
  for (const changed of [Buffer.concat([bytes, Buffer.from('\n')]), bytes.subarray(1),
    Buffer.from(bytes.toString('utf8').replaceAll('\n', '\r\n')), Buffer.from(JSON.stringify(proof))])
    assert.throws(() => decodeLegacyPhpWorkflowProof(changed), /raw proof bytes differ/);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.images) && Object.isFrozen(proof.inverse_edits[0]));
});
