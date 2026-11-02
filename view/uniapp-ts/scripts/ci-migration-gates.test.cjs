'use strict';

// Read the actual Actions document with the already locked Uni YAML parser.
// The full accepted workflow is independent input: deleting a gate, changing a
// different frontend or weakening a dependency result must fail this check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const baseline = JSON.parse(readFileSync(resolve(__dirname, 'ci-migration-gates.baseline.json'), 'utf8'));
assert.equal(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
  '69ba97d539fcffad493cd61b6a2114834045fde9aeae6037c3e1f6af94800362');
assert.equal(baseline.version, 1);
assert.equal(baseline.source.commit, '20f180ae24a88f40fe6d0a35c26d2cae0204ca01');
assert.equal(baseline.source.sha256, 'fae6a6cf86ec9c020280565341781fa59b8a65796b6a6c8400585bf6e79f69f1');
const workflow = YAML.parse(readFileSync(resolve(__dirname, '../../../.github/workflows/workers-runtime-linux.yml'), 'utf8'));
const prior = baseline.workflow.jobs.frontends;
const originalUni = prior.strategy.matrix.include.find(row => row.directory === 'uniapp-ts');
const originalAuthors = prior.steps.find(step => step.name === 'Verify editorial author navigation and immutable PHP styles');
const originalSecurity = prior.steps.find(step => step.name === 'Verify frontend dependency security regressions');
assert.ok(originalUni && originalAuthors && originalSecurity);
const groupIds = ['uni-core', 'uni-authors'];
const setupNames = ['Check out repository', 'Set up Node.js', 'Verify pinned Node and npm', 'Install locked dependencies'];
const setup = setupNames.map(name => {
  const step = structuredClone(prior.steps.find(item => item.name === name));
  assert.ok(step);
  delete step['working-directory'];
  if (step.with) step.with['cache-dependency-path'] = 'view/uniapp-ts/package-lock.json';
  return step;
});
const partition = { name: 'Verify complete frontend gate partition',
  run: 'node --test --test-concurrency=1 scripts/ci-migration-gates.test.cjs' };
const aggregateRun = 'test "$CORE_RESULT" = "success"\ntest "$AUTHORS_RESULT" = "success"\n';

function verify(document) {
  const preserved = structuredClone(document), expected = structuredClone(baseline.workflow);
  for (const id of [...groupIds, 'uniapp']) delete preserved.jobs[id];
  expected.jobs.frontends.strategy.matrix.include = prior.strategy.matrix.include.filter(row => row.directory !== 'uniapp-ts');
  expected.jobs.frontends.steps = prior.steps.filter(step => step !== originalAuthors);
  assert.deepEqual(preserved, expected, 'every other frontend, audit, pin, permission, trigger and job remains unchanged');

  for (const [id, name, last] of [
    ['uni-core', 'UniApp type, runtime and three-platform build execution', [
      { name: 'Run type, test and build contract', run: originalUni.command },
      { name: originalSecurity.name, run: originalSecurity.run },
    ]],
    ['uni-authors', 'UniApp editorial author and PHP style execution', [
      { name: originalAuthors.name, run: originalAuthors.run },
    ]],
  ]) assert.deepEqual(document.jobs[id], {
    name, 'runs-on': prior['runs-on'], 'timeout-minutes': 20,
    defaults: { run: { 'working-directory': 'view/uniapp-ts' } },
    steps: [...setup, partition, ...last],
  }, id + ' retains its complete original command, exact install and unchanged 20-minute budget');

  assert.deepEqual(document.jobs.uniapp, {
    name: 'UniApp build', if: '${{ always() }}', needs: groupIds, 'runs-on': prior['runs-on'], 'timeout-minutes': 2,
    steps: [{ name: 'Require both unchanged UniApp gate groups to succeed', shell: 'bash',
      env: { CORE_RESULT: '${{ needs.uni-core.result }}', AUTHORS_RESULT: '${{ needs.uni-authors.result }}' }, run: aggregateRun }],
  });
  assert.equal(Object.values(document.jobs).filter(job => job.name === 'UniApp build').length, 1);
  assert.equal(document.jobs.frontends.strategy.matrix.include.some(row => row.name === 'UniApp'), false);
}

test('actual workflow preserves every accepted gate and the unique required UniApp build name', () => verify(workflow));
test('the locked YAML parser rejects duplicate workflow keys', () => {
  assert.throws(() => YAML.parse('jobs:\n  uniapp: 1\n  uniapp: 2\n'));
});

for (const [group, field, command] of [
  ['uni-core', 'Run type, test and build contract', originalUni.command],
  ['uni-authors', originalAuthors.name, originalAuthors.run],
]) for (const removed of command.split(' && ')) test(`${group} refuses omission of ${removed}`, () => {
  const mutant = structuredClone(workflow);
  mutant.jobs[group].steps.find(step => step.name === field).run = command.split(' && ').filter(part => part !== removed).join(' && ');
  assert.throws(() => verify(mutant));
});

for (const [label, mutate] of [
  ['duplicate author command', d => { d.jobs['uni-authors'].steps.at(-1).run += ' && npm run test:diy-promotion-author'; }],
  ['missing shared security regressions', d => { d.jobs['uni-core'].steps.pop(); }],
  ['ignored execution failure', d => { d.jobs['uni-core']['continue-on-error'] = true; }],
  ['larger job budget', d => { d.jobs['uni-core']['timeout-minutes'] = 21; }],
  ['conditional author skip', d => { d.jobs['uni-authors'].if = '${{ false }}'; }],
  ['aggregate skipped on dependency failure', d => { delete d.jobs.uniapp.if; }],
  ['unrelated PC/Kefu dependency on required check', d => { d.jobs.uniapp.needs.push('frontends'); }],
  ['wrong accepted result', d => { d.jobs.uniapp.steps[0].run = 'true\n'; }],
  ['dropped PC and Kefu audit', d => { d.jobs.frontends.steps = d.jobs.frontends.steps.filter(step => step.name !== 'Audit complete Kefu and PC dependency trees'); }],
]) test('refuses ' + label, () => { const mutant = structuredClone(workflow); mutate(mutant); assert.throws(() => verify(mutant)); });

// Execute the real Actions aggregate shell, rather than a JavaScript substitute.
// Only both success results may satisfy the preserved required check.
for (const core of ['success', 'failure', 'cancelled', 'skipped']) {
  for (const authors of ['success', 'failure', 'cancelled', 'skipped']) {
    test(`actual bash aggregate core=${core} authors=${authors}`, () => {
      verify(workflow);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', workflow.jobs.uniapp.steps[0].run], {
        env: { PATH: process.env.PATH, LANG: 'C', CORE_RESULT: core, AUTHORS_RESULT: authors },
        encoding: 'utf8', timeout: 3000, windowsHide: true,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status === 0, core === 'success' && authors === 'success');
    });
  }
}
