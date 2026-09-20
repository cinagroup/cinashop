import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readUnitProgress } from '../scripts/local-unit-progress.mjs';
import { progressModule, progressReporter } from './helpers/unitProgressFixture';
import { BaseSequencer, createVitest } from 'vitest/node';

const root = resolve(import.meta.dirname, '..'), owned: string[] = [];
function fixture(expected = ['case.test.js']) {
  const directory = mkdtempSync(join(tmpdir(), 'cinashop-unit-progress-')); owned.push(directory);
  const output = join(directory, 'output'); mkdirSync(output);
  const prepared = { shard: 1, inputs: { files: [], sha256: 'fixture-inputs' },
    partition: { files: expected, shards: [expected, []], digest: 'fixture-inventory' } };
  return { directory, output, prepared, journal: join(output, 'unit-progress.ndjson') };
}
afterEach(() => { for (const path of owned.splice(0)) {
  if (dirname(realpathSync(path)) !== realpathSync(tmpdir()) || !/^cinashop-unit-progress-[A-Za-z0-9]+$/.test(basename(path))) throw Error('Unsafe fixture cleanup');
  rmSync(path, { recursive: true });
} });

describe('complete-module unit diagnostic journal', () => {
  it('persists completed module assertions and binds them to the selected input/partition', () => {
    const f = fixture(); const reporter = progressReporter(f.directory, f.output, f.prepared);
    reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js', ['passed', 'passed']));
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: false, ended: false, completedModules: 1, observedAssertions: 2 });
    reporter.onTestRunEnd([], [], 'passed');
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: true, ended: true, partialTail: false,
      counts: { passed: 2, failed: 0, skipped: 0, pending: 0 }, missingFiles: [] });
  });
  it.each(['failed-test', 'skipped-test', 'pending-test', 'todo', 'empty', 'module-error', 'unhandled-error', 'interrupted', 'failed-end', 'missing-module'])(
    'never treats %s as complete acceptance', mode => {
      const f = fixture(mode === 'missing-module' ? ['case.test.js', 'missing.test.js'] : undefined);
      const reporter = progressReporter(f.directory, f.output, f.prepared);
      const state = mode === 'failed-test' ? 'failed' : mode === 'skipped-test' || mode === 'todo' ? 'skipped' : mode === 'pending-test' ? 'pending' : 'passed';
      reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js', mode === 'empty' ? [] : [state],
        mode === 'module-error' ? 'failed' : 'passed', mode === 'module-error' ? [Error('collection failed')] : [], mode === 'todo' ? 'todo' : 'run'));
      reporter.onTestRunEnd([], mode === 'unhandled-error' ? [Error('unhandled')] : [], mode === 'interrupted' ? 'interrupted' : mode === 'failed-end' ? 'failed' : 'passed');
      expect(readUnitProgress(f.output, f.prepared).complete).toBe(false);
    });
  it('retains complete module evidence but refuses an interrupted final record', () => {
    const f = fixture(); const reporter = progressReporter(f.directory, f.output, f.prepared);
    reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js')); reporter.onTestRunEnd([], [], 'passed');
    const lines = readFileSync(f.journal, 'utf8').trimEnd().split('\n');
    writeFileSync(f.journal, lines.slice(0, -1).join('\n') + '\n' + lines.at(-1)!.slice(0, -10));
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: false, partialTail: true, ended: false, completedModules: 1, observedAssertions: 1 });
  });
  it('retains started-but-unfinished module identity without counting it as completed', () => {
    const f = fixture(); const reporter = progressReporter(f.directory, f.output, f.prepared);
    reporter.onTestModuleStart(progressModule(f.directory, 'case.test.js')); reporter.onTestRunEnd([], [], 'interrupted');
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: false, completedModules: 0,
      observedAssertions: 0, unfinishedStartedFiles: ['case.test.js'], missingFiles: ['case.test.js'] });
  });
  it.each(['tamper', 'duplicate-record', 'wrong-input', 'wrong-partition', 'wrong-selection'])('rejects corrupted or mismatched evidence: %s', mode => {
    const f = fixture(); const reporter = progressReporter(f.directory, f.output, f.prepared);
    reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js')); reporter.onTestRunEnd([], [], 'passed');
    if (mode === 'tamper') writeFileSync(f.journal, readFileSync(f.journal, 'utf8').replace('case.test.js', 'evil.test.js'));
    if (mode === 'duplicate-record') appendFileSync(f.journal, readFileSync(f.journal, 'utf8').split('\n')[1] + '\n');
    if (mode === 'wrong-input') f.prepared.inputs.sha256 = 'other';
    if (mode === 'wrong-partition') f.prepared.partition.digest = 'other';
    if (mode === 'wrong-selection') f.prepared.partition.shards[0] = ['other.test.js'];
    expect(() => readUnitProgress(f.output, f.prepared)).toThrow();
  });
  it.each(['duplicate', 'unexpected'])('refuses a %s module instead of double-counting it', mode => {
    const f = fixture(); const reporter = progressReporter(f.directory, f.output, f.prepared);
    reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js'));
    try { expect(() => reporter.onTestModuleEnd(progressModule(f.directory, mode === 'duplicate' ? 'case.test.js' : 'other.test.js'))).toThrow('Unexpected or duplicate'); }
    finally { reporter.onTestRunEnd([], [], 'failed'); }
  });
  it('redacts the dedicated URL and password in diagnostic errors', () => {
    const f = fixture(), password = 'fixture-secret-password';
    const value = `postgresql://finance_test:${password}@127.0.0.1:59999/cinashop_finance_test`;
    const before = process.env.TEST_FINANCE_POSTGRES_URL;
    process.env.TEST_FINANCE_POSTGRES_URL = value;
    try {
      const reporter = progressReporter(f.directory, f.output, f.prepared);
      reporter.onTestModuleEnd(progressModule(f.directory, 'case.test.js', ['failed'], 'failed', [Error(`${value} ${password}`)]));
      reporter.onTestRunEnd([], [], 'failed');
      const raw = readFileSync(f.journal, 'utf8'); expect(raw).not.toContain(value); expect(raw).not.toContain(password); expect(raw).toContain('[redacted]');
    } finally { if (before === undefined) delete process.env.TEST_FINANCE_POSTGRES_URL; else process.env.TEST_FINANCE_POSTGRES_URL = before; }
  });
  it('does not overwrite an existing journal', () => {
    const f = fixture(); writeFileSync(f.journal, 'existing evidence');
    expect(() => progressReporter(f.directory, f.output, f.prepared)).toThrow('EEXIST');
    expect(readFileSync(f.journal, 'utf8')).toBe('existing evidence');
  });
  it('records real Vitest pass/failure/skip results without replacing the native JSON', () => {
    const f = fixture();
    writeFileSync(join(f.output, 'unit-gate-inputs.json'), JSON.stringify(f.prepared));
    writeFileSync(join(f.directory, 'package.json'), '{"type":"module"}');
    writeFileSync(join(f.directory, 'vitest.config.mjs'), 'export default {test:{globals:true,include:["case.test.js"],pool:"forks",maxWorkers:1}}');
    writeFileSync(join(f.directory, 'case.test.js'), 'it("passes",()=>expect(2).toBe(2)); it("fails",()=>expect(1).toBe(2)); it.skip("skips",()=>{});');
    const env = { ...process.env }, allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA']);
    for (const key of Object.keys(env)) if (!allowed.has(key.toUpperCase())) delete env[key];
    Object.assign(env, { CI: '1', CINASHOP_UNIT_GATE_OUTPUT_DIR: f.output });
    const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', f.directory,
      '--config', join(f.directory, 'vitest.config.mjs'), '--reporter=json', '--reporter=' + join(root, 'scripts/local-unit-progress.mjs'),
      '--outputFile.json=' + join(f.output, 'actual.json')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(run.error, run.stdout + run.stderr).toBeUndefined(); expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: false, ended: true, endReason: 'failed', completedModules: 1,
      counts: { passed: 1, failed: 1, skipped: 1, pending: 0 } });
    const actual = JSON.parse(readFileSync(join(f.output, 'actual.json'), 'utf8'));
    expect(actual).toMatchObject({ numPassedTests: 1, numFailedTests: 1, numPendingTests: 1 });
  }, 20000);
  it.each([1, 2])('validates the collected universe and completes only native shard %i', async shard => {
    const f = fixture(['alpha.test.js', 'beta.test.js']);
    f.prepared.shard = shard;
    const config = join(f.directory, 'vitest.config.mjs');
    writeFileSync(join(f.directory, 'package.json'), '{"type":"module"}');
    writeFileSync(config, 'export default {test:{globals:true,include:["*.test.js"],pool:"forks",maxWorkers:1}}');
    for (const file of f.prepared.partition.files) writeFileSync(join(f.directory, file), 'it("passes",()=>expect(2).toBe(2));');
    const ctx = await createVitest('test', { root: f.directory, config, watch: false, shard: `${shard}/2` });
    try {
      const selected = await new BaseSequencer(ctx).shard(await ctx.globTestSpecifications());
      const selectedFiles = selected.map(spec => basename(spec.moduleId));
      const otherFiles = f.prepared.partition.files.filter(file => !selectedFiles.includes(file));
      f.prepared.partition.shards = shard === 1 ? [selectedFiles, otherFiles] : [otherFiles, selectedFiles];
    } finally { await ctx.close(); }
    expect(f.prepared.partition.shards.map(files => files.length)).toEqual([1, 1]);
    writeFileSync(join(f.output, 'unit-gate-inputs.json'), JSON.stringify(f.prepared));
    const env = { ...process.env }, allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA']);
    for (const key of Object.keys(env)) if (!allowed.has(key.toUpperCase())) delete env[key];
    Object.assign(env, { CI: '1', CINASHOP_UNIT_GATE_OUTPUT_DIR: f.output });
    const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', f.directory,
      '--config', config, `--shard=${shard}/2`, '--reporter=json', '--reporter=' + join(root, 'scripts/local-unit-progress.mjs'),
      '--outputFile.json=' + join(f.output, 'actual.json')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(run.error, run.stdout + run.stderr).toBeUndefined(); expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readUnitProgress(f.output, f.prepared)).toMatchObject({ complete: true, completedModules: 1, observedAssertions: 1, missingFiles: [] });
    expect(JSON.parse(readFileSync(join(f.output, 'actual.json'), 'utf8'))).toMatchObject({ numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 });
  }, 20000);
});
