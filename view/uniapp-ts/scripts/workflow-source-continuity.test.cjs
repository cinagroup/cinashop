'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { WORKFLOW_FILE, PINS, decodeWorkflowContinuityProof,
  projectCurrentWorkflowToLegacyCandidate: project } = require('./workflow-source-continuity.cjs');
const root = resolve(__dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const current = readFileSync(resolve(root, WORKFLOW_FILE), 'utf8');
const legacyBytes = readFileSync(resolve(root, 'workers-ts/test/fixtures/legacy-php-input-source-binding-20261103.json'));
assert.equal(sha(legacyBytes), 'e5427c63002e4def70c41cd63c5c1e06bc771d6a2dc7400622db972f98f13d47');
const legacy = JSON.parse(legacyBytes);
const operationsPredecessor = current.replace(
  '        run: npm run test:admin-navigation && npm run test:purchased-label-tasks\n',
  '        run: npm run test:admin-navigation\n');
const intermediate = operationsPredecessor
  .replace("these exact predecessors' Git objects", "this exact predecessor's Git objects")
  .replace('fixed commits without', 'fixed commit without')
  .replace("          git fetch --no-tags --depth=1 origin 353ec0ed03a860eafbc850e9983da505a7ade748\n"
    + "          git cat-file -e '353ec0ed03a860eafbc850e9983da505a7ade748^{commit}'\n", '');

test('complete native workflow derives the independent legacy candidate through exactly the three reviewed increments', () => {
  assert.equal(Buffer.byteLength(current), 21550);
  assert.equal(sha(current), PINS.operations.current.sha256);
  assert.equal(Buffer.byteLength(operationsPredecessor), 21512);
  assert.equal(sha(operationsPredecessor), PINS.provider.current.sha256);
  assert.deepEqual(PINS.operations.predecessor, PINS.provider.current);
  assert.equal(Buffer.byteLength(intermediate), 21344);
  assert.equal(sha(intermediate), PINS.provider.predecessor.sha256);
  assert.deepEqual(PINS.provider.predecessor, PINS.refund.current);
  const candidate = project(WORKFLOW_FILE, current);
  assert.equal(candidate, legacy.images.candidate.raw_utf8);
  assert.equal(Buffer.byteLength(candidate), 20868);
  assert.equal(sha(candidate), PINS.refund.predecessor.sha256);
  assert.equal(readFileSync(resolve(root, WORKFLOW_FILE), 'utf8'), current);
  assert.equal(project('other.yml', current + '\n# unknown\n'), current + '\n# unknown\n');
});

for (const [label, source] of [
  ['append', current + '\n# unknown\n'], ['truncate', current.slice(1)],
  ['CRLF', current.replaceAll('\n', '\r\n')], ['duplicate', current + current], ['BOM', '\ufeff' + current],
  ['moving fixed TS ref', current.replace('origin 353ec0ed03a860eafbc850e9983da505a7ade748', 'origin main')],
  ['removed first fixed TS check', current.replace("          git cat-file -e '78240b7801a617ed5b1c1e444860228c066311b8^{commit}'\n", '')],
  ['removed second fixed TS check', current.replace("          git cat-file -e '353ec0ed03a860eafbc850e9983da505a7ade748^{commit}'\n", '')],
  ['ignored failure', current.replace('        run: |', '        continue-on-error: true\n        run: |')],
  ['removed purchased-label execution', operationsPredecessor],
  ['duplicated purchased-label execution', current.replace(' && npm run test:purchased-label-tasks', ' && npm run test:purchased-label-tasks && npm run test:purchased-label-tasks')],
  ['replaced Admin navigation', current.replace('npm run test:admin-navigation && npm run test:purchased-label-tasks', 'npm run test:purchased-label-tasks')],
  ['ignored purchased-label failure', current.replace(' && npm run test:purchased-label-tasks', ' && npm run test:purchased-label-tasks || true')],
  ['valid intermediate fallback', intermediate], ['old candidate fallback', legacy.images.candidate.raw_utf8],
  ['f2 fallback', legacy.images.predecessor.raw_utf8],
]) test('refuses unreviewed live workflow or historical fallback: ' + label, () => {
  assert.notEqual(source, current);
  assert.throws(() => project(WORKFLOW_FILE, source), /current workflow source differs/);
});

for (const value of [null, undefined, {}, [], Buffer.from(current)])
  test('requires a string complete current image: ' + String(value?.constructor?.name || value), () => {
    assert.throws(() => project(WORKFLOW_FILE, value), /current workflow source differs/);
  });

for (const kind of ['operations', 'provider', 'refund']) {
  const bytes = readFileSync(resolve(root, PINS[kind].file));
  test('decodes and freezes the complete independently pinned ' + kind + ' proof', () => {
    const proof = decodeWorkflowContinuityProof(kind, bytes);
    assert.equal(sha(bytes), PINS[kind].sha256);
    assert.equal(proof.sources.length, PINS[kind].count);
    const row = proof.sources.find(source => source.file === WORKFLOW_FILE);
    assert.deepEqual(row.current, PINS[kind].current);
    assert.deepEqual(row.predecessor, PINS[kind].predecessor);
    assert.deepEqual(row.origin, { commit: PINS[kind].predecessorCommit, path: WORKFLOW_FILE,
      gitBlobSha1: PINS[kind].predecessor.gitBlobSha1 });
    assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.sources) && Object.isFrozen(row.inverseEdits[0]));
  });
  for (const [label, altered] of [
    ['append', Buffer.concat([bytes, Buffer.from('\n')])], ['truncate', bytes.subarray(1)],
    ['CRLF', Buffer.from(bytes.toString('utf8').replaceAll('\n', '\r\n'))],
    ['canonical reserialization', Buffer.from(JSON.stringify(JSON.parse(bytes)))],
  ]) test('rejects changed complete ' + kind + ' proof bytes: ' + label, () => {
    assert.throws(() => decodeWorkflowContinuityProof(kind, altered), /complete proof bytes differ/);
  });
  for (const [label, mutate] of [
    ['unselected source', p => { p.sources.find(row => row.file !== WORKFLOW_FILE).current.sha256 = '0'.repeat(64); }],
    ['partial workflow-only proof', p => { p.sources = p.sources.filter(row => row.file === WORKFLOW_FILE); }],
    ['duplicate source', p => { p.sources.push(p.sources[0]); }],
    ['reordered source', p => { p.sources.reverse(); }],
    ['wrong origin', p => { p.sources.find(row => row.file === WORKFLOW_FILE).origin.commit = '0'.repeat(40); }],
    ['changed inverse', p => { p.sources.find(row => row.file === WORKFLOW_FILE).inverseEdits[0].start++; }],
    ['changed intermediate image', p => { p.sources.find(row => row.file === WORKFLOW_FILE).predecessor.bytes++; }],
  ]) test('rejects changed ' + kind + ' proof data: ' + label, () => {
    const proof = JSON.parse(bytes); mutate(proof);
    assert.throws(() => decodeWorkflowContinuityProof(kind, Buffer.from(JSON.stringify(proof, null, 2) + '\n')),
      /complete proof bytes differ/);
  });
}
test('proof scope cannot be selected by an unknown key', () => {
  for (const kind of ['unknown', '__proto__', 'toString', null])
    assert.throws(() => decodeWorkflowContinuityProof(kind, Buffer.alloc(0)), /proof scope differs/);
});

function restore(source, after, before) {
  assert.equal(source.split(after).length, 2, 'One exact reviewed source edit');
  return source.replace(after, before);
}
test('the original five-edit implementation and rejection checks retain their exact source bytes behind composition', () => {
  let source = readFileSync(resolve(__dirname, 'legacy-php-workflow-source-binding.cjs'), 'utf8');
  source = restore(source, "const { projectCurrentWorkflowToLegacyCandidate } = require('./workflow-source-continuity.cjs');\n", '');
  source = restore(source, `function projectCurrentLegacyPhpWorkflowPredecessor(file, source, input = proof) {
  if (file !== WORKFLOW_FILE) return source;
  verifyProof(input);
  return projectLegacyPhpWorkflowPredecessor(file, projectCurrentWorkflowToLegacyCandidate(file, source), input);
}

`, '');
  source = restore(source, '  const previous = projectCurrentLegacyPhpWorkflowPredecessor(WORKFLOW_FILE, source);',
    '  const previous = projectLegacyPhpWorkflowPredecessor(WORKFLOW_FILE, source);');
  source = restore(source, '  decodeLegacyPhpWorkflowProof, projectLegacyPhpWorkflowPredecessor: projectCurrentLegacyPhpWorkflowPredecessor, readFileSync };',
    '  decodeLegacyPhpWorkflowProof, projectLegacyPhpWorkflowPredecessor, readFileSync };');
  assert.equal(sha(source), 'd3188d37f9ef30a536a03863517646f70143844778dfc0f11d3bb9c24ad24a3a');
});
test('all earlier assertion bytes survive except the explicit current-to-candidate identity handoff', () => {
  let source = readFileSync(resolve(__dirname, 'legacy-php-workflow-source-binding.test.cjs'), 'utf8');
  source = restore(source, "const { projectCurrentWorkflowToLegacyCandidate } = require('./workflow-source-continuity.cjs');\n", '');
  source = restore(source, "require('./workflow-source-continuity.test.cjs');\n", '');
  source = restore(source, `  const candidate = projectCurrentWorkflowToLegacyCandidate(WORKFLOW_FILE, current);
  assert.equal(candidate, proof.images.candidate.raw_utf8);
  assert.equal(Buffer.byteLength(candidate), 20868);`, `  assert.equal(current, proof.images.candidate.raw_utf8);
  assert.equal(Buffer.byteLength(current), 20868);`);
  assert.equal(sha(source), '85ef1a6b358420a9cf89270ae510a3840b0a39dc27d5c7071d97ec9069ec296e');
  assert.equal(sha(readFileSync(resolve(__dirname, 'ci-migration-gates.test.cjs'))),
    '01f695cdddc38cbd5cdcfc4da702f3896cf1edea2d10fdf9476acc18168cfd2e');
});
