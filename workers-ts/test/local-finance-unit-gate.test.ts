import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { captureUnitInputs, changedUnitInputs, finishUnitGate, unitGateArguments, unitGateEnvironment } from '../scripts/local-finance-unit-gate.mjs';
import { progressModule, progressReporter } from './helpers/unitProgressFixture';

const owned: string[] = [];
const root = resolve(import.meta.dirname, '..');
const connection = 'postgresql://finance_test:fixture@127.0.0.1:54321/cinashop_finance_test';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cinashop-unit-gate-'));
  owned.push(directory);
  const worker = join(directory, 'workers-ts');
  const output = join(directory, 'output');
  mkdirSync(worker); mkdirSync(output);
  return { directory, worker, output };
}
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('complete local unit gate', () => {
  it.each([1, 2])('uses native shard %i without file/name filters and keeps complete JSON output', shard => {
    expect(unitGateArguments(shard, 'output')).toEqual(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts',
      `--shard=${shard}/2`, '--maxWorkers=2', '--reporter=default', '--reporter=json', '--reporter=./scripts/local-unit-progress.mjs',
      `--outputFile.json=${join('output', 'unit-shard-results.json')}`]);
  });
  it.each([0, 3, -1, '1', undefined])('rejects invalid shard %s', shard => {
    expect(() => unitGateArguments(shard, 'output')).toThrow('Only native unit shard');
  });
  it('passes OS paths but removes ambient production credentials and test overrides', () => {
    const environment = unitGateEnvironment({ Path: 'native-path', SYSTEMROOT: 'windows', TEMP: 'temp',
      DATABASE_URL: 'production', TEST_FINANCE_POSTGRES_URL: 'production', TEST_OTHER_URL: 'production',
      CLOUDFLARE_API_TOKEN: 'secret', UPSTASH_REDIS_REST_TOKEN: 'secret', NODE_OPTIONS: '--require=unsafe',
      MINIFLARE_WORKERD_PATH: 'trusted-workerd', WRANGLER_LOG_PATH: 'elsewhere', NODE_ENV: 'production' }, connection, 'output');
    expect(environment).toEqual({ Path: 'native-path', SYSTEMROOT: 'windows', TEMP: 'temp', MINIFLARE_WORKERD_PATH: 'trusted-workerd',
      CI: 'true', NODE_ENV: 'test', TEST_FINANCE_POSTGRES_URL: connection, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join('output', 'wrangler.log'),
      CINASHOP_UNIT_GATE_OUTPUT_DIR: 'output' });
  });
  it.each([
    connection.replace('127.0.0.1', 'production.example'), connection.replace('finance_test:', 'postgres:'),
    connection.replace('/cinashop_finance_test', '/production'), `${connection}?host=production.example`,
    connection.replace(':54321', ''), connection.replace('postgresql:', 'https:'),
  ])('rejects a non-dedicated connection before starting tests: %s', value => {
    expect(() => unitGateEnvironment({}, value, 'output')).toThrow('dedicated loopback database');
  });
  it('captures added, removed and edited inputs including frontend and config, excluding secrets and generated artifacts', () => {
    const f = fixture();
    write(join(f.worker, 'src/service.ts'), 'before');
    write(join(f.worker, 'test/removed.test.ts'), 'old');
    write(join(f.worker, 'package-lock.json'), '{}');
    write(join(f.directory, 'view/admin-ts/src/Page.vue'), 'before');
    for (const name of ['.env.local', '.dev.vars', 'node_modules/lib.js', 'dist/build.js']) write(join(f.directory, 'view/admin-ts', name), 'secret-or-output');
    write(join(f.worker, 'unit-shard-results.json'), 'old report');
    const before = captureUnitInputs(f.worker);
    expect(before.files.map((file: { path: string }) => file.path)).toEqual(['../view/admin-ts/src/Page.vue', 'package-lock.json', 'src/service.ts', 'test/removed.test.ts']);
    write(join(f.worker, 'src/service.ts'), 'after');
    rmSync(join(f.worker, 'test/removed.test.ts'));
    write(join(f.worker, 'test/added.test.ts'), 'new');
    write(join(f.directory, 'view/admin-ts/src/Page.vue'), 'after');
    const after = captureUnitInputs(f.worker);
    expect(changedUnitInputs(before, after)).toEqual(['../view/admin-ts/src/Page.vue', 'src/service.ts', 'test/added.test.ts', 'test/removed.test.ts']);
    expect(after.sha256).not.toBe(before.sha256);
    expect(captureUnitInputs(f.worker)).toEqual(after);
  });
  it.each(['pass', 'failed', 'skip', 'todo', 'missing-file', 'changed-input', 'child-error', 'signal', 'missing-report', 'missing-progress', 'interrupted-progress', 'progress-count-mismatch'])(
    'accepts only complete passing unchanged execution (%s)', async mode => {
      const f = fixture();
      write(join(f.worker, 'src/service.ts'), 'source');
      const prepared = { shard: 1, inputs: captureUnitInputs(f.worker), partition: {
        files: ['test/sample.test.ts', 'test/second.test.ts'], shards: [['test/sample.test.ts'], ['test/second.test.ts']], digest: 'fixture-inventory' } };
      if (mode !== 'missing-progress') {
        const journal = progressReporter(f.worker, f.output, prepared);
        journal.onTestModuleEnd(progressModule(f.worker, 'test/sample.test.ts', mode === 'progress-count-mismatch' ? ['passed', 'passed'] : ['passed']));
        journal.onTestRunEnd([], [], mode === 'interrupted-progress' ? 'interrupted' : 'passed');
      }
      const result = { success: mode !== 'failed', numTotalTests: 1, numPassedTests: mode === 'skip' ? 0 : 1,
        numFailedTests: mode === 'failed' ? 1 : 0, numPendingTests: mode === 'skip' ? 1 : 0, numTodoTests: mode === 'todo' ? 1 : 0,
        testResults: mode === 'missing-file' ? [] : [{ name: resolve(root, 'test/sample.test.ts'), status: 'passed', assertionResults: [{ status: 'passed' }] }] };
      if (mode !== 'missing-report') write(join(f.output, 'unit-shard-results.json'), JSON.stringify(result));
      if (mode === 'changed-input') write(join(f.worker, 'src/service.ts'), 'changed');
      const execution = { status: mode === 'child-error' ? 1 : 0, signal: mode === 'signal' ? 'SIGTERM' : null };
      const report = await finishUnitGate(f.worker, f.output, prepared, execution);
      expect(report.accepted).toBe(mode === 'pass');
      expect(JSON.parse(readFileSync(join(f.output, 'unit-gate-result.json'), 'utf8'))).toEqual(report);
      if (mode === 'changed-input') expect(report.changedFiles).toEqual(['src/service.ts']);
    });
});
