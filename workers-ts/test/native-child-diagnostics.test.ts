import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { promisify } from 'node:util';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditNativeDiagnostics, assertWorkerInputPath, beginNativeDiagnostics, nativeDiagnosticCollector, nativeDiagnosticErrorCode, readNativeDiagnosticInput } from './helpers/nativeChildDiagnostics';
import { readDrizzleAuditReport } from './helpers/drizzleAuditReport';

const owned: string[] = [], workerRoot = resolve(import.meta.dirname, '..');
const metadata = { caseId: 'external-duplicate-index-retirement', mode: 'pglite' };
function fixture(begin = true) {
  const root = mkdtempSync(join(tmpdir(), 'cinashop-native-diagnostic-')); owned.push(root);
  const run = begin ? beginNativeDiagnostics(root) : null;
  const directory = run ? join(root, '.cache/native-child-diagnostics', `run-${run.runId}`) : null;
  const events: unknown[] = [];
  const collect = nativeDiagnosticCollector(root, { unavailable: event => events.push(event) });
  const result = { startTime: run?.startedAtUnixMs ?? Date.now(), testResults: [{ name: join(root, `test/${metadata.caseId}.test.ts`) }] };
  return { root, run, directory, events, collect, result };
}
function records(f: ReturnType<typeof fixture>): Array<Record<string, any>> {
  return readdirSync(f.directory!).filter(name => /^child-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(f.directory!, name), 'utf8')));
}
const options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] };
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of owned.splice(0)) {
    const exact = realpathSync(directory);
    if (dirname(exact) !== realpathSync(tmpdir()) || !/^cinashop-native-diagnostic-[A-Za-z0-9]+$/.test(basename(exact))) throw Error('Unsafe owned fixture');
    rmSync(exact, { recursive: true });
  }
});

describe('bounded parent-side native child evidence', () => {
  it('delegates identical executable/argv/options and preserves actual result/output identity', () => {
    const f = fixture(), args = ['-e', "process.stdout.write(process.env.SYNTHETIC_SECRET || '')"];
    const originalOptions = { ...options, env: { ...process.env, SYNTHETIC_SECRET: 'synthetic-secret-sentinel' } };
    let originalResult: SpawnSyncReturns<string> | undefined;
    const execute = vi.fn((executable: string, actualArgs: readonly string[], actualOptions: SpawnSyncOptionsWithStringEncoding) => {
      expect(executable).toBe(process.execPath); expect(actualArgs).toBe(args); expect(actualOptions).toBe(originalOptions);
      return originalResult = spawnSync(executable, actualArgs, actualOptions);
    });
    const collect = nativeDiagnosticCollector(f.root, { spawn: execute });
    const result = collect(process.execPath, args, originalOptions, metadata);
    expect(result).toBe(originalResult); expect(result.stdout).toBe('synthetic-secret-sentinel'); expect(execute).toHaveBeenCalledOnce();
    const [record] = records(f);
    expect(record).toMatchObject({ phase: 'returned', diagnosticComplete: true, deadlineMs: 5000, termination: { status: 0, signal: null, errorCode: null }, resourcesBefore: { child: null }, resourcesAfter: { child: null } });
    expect(record.termination.pid).toBeGreaterThan(0); expect(record.resourcesBefore.parent.pid).toBe(process.pid);
    expect(record.resourcesBefore.parent.memoryBytes.rss).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain('synthetic-secret-sentinel'); expect(JSON.stringify(record)).not.toContain('SYNTHETIC_SECRET');
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: true, records: 1 });
  });
  it('preserves real failed-to-start ENOENT identity and records a complete returned receipt', () => {
    const f = fixture(), executable = join(f.root, `missing-native-child-${randomUUID()}`), args: string[] = [];
    let originalResult: SpawnSyncReturns<string> | undefined;
    const execute = vi.fn((actualExecutable: string, actualArgs: readonly string[], actualOptions: SpawnSyncOptionsWithStringEncoding) => {
      expect(actualExecutable).toBe(executable); expect(actualArgs).toBe(args); expect(actualOptions).toBe(options);
      return originalResult = spawnSync(actualExecutable, actualArgs, actualOptions);
    });
    const collect = nativeDiagnosticCollector(f.root, { spawn: execute, unavailable: event => f.events.push(event) });
    const result = collect(executable, args, options, metadata);
    expect(execute).toHaveBeenCalledOnce(); expect(result).toBe(originalResult);
    expect(result.error).toBe(originalResult!.error); expect(result.output).toBe(originalResult!.output);
    expect(result.error).toMatchObject({ code: 'ENOENT' }); expect(result.status).toBeNull(); expect(result.signal).toBeNull(); expect(result.output).toBeNull();
    const saved = records(f); expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ phase: 'returned', diagnosticComplete: true, diagnosticErrorCode: null,
      termination: { pid: null, status: null, signal: null, errorCode: 'ENOENT' }, outputBytes: { stdout: 0, stderr: 0, report: null } });
    expect(f.events).toEqual([]); expect(JSON.stringify(saved)).not.toContain(executable);
    expect(() => readDrizzleAuditReport(result)).toThrow('did not exit successfully');
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: true, records: 1, incompleteRecords: 0, unavailableEvents: 0, failureCodes: [] });
  });
  it('preserves real nonzero exit and records termination without stdout/stderr/payload', () => {
    const f = fixture();
    const result = f.collect(process.execPath, ['-e', "process.stdout.write('synthetic-payload');process.stderr.write('synthetic-token');process.exit(7)"], options, metadata);
    expect(result.status).toBe(7); expect(result.stderr).toBe('synthetic-token');
    expect(records(f)[0]).toMatchObject({ termination: { status: 7, signal: null, errorCode: null }, outputBytes: { stdout: 17, stderr: 15, report: 0 } });
    expect(JSON.stringify(records(f))).not.toMatch(/synthetic-(payload|token)/);
    // Complete capture is not an assertion that the original child/test passed.
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: true });
  });
  it('records actual bounded timeout signal/code and keeps the original fail-closed report guard', () => {
    const f = fixture(), result = f.collect(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { ...options, timeout: 250 }, metadata);
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' }); expect(result.signal).toBe('SIGTERM'); expect(result.status).toBeNull();
    expect(records(f)[0]).toMatchObject({ deadlineMs: 250, termination: { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' } });
    expect(records(f)[0].elapsedMs).toBeGreaterThanOrEqual(250);
    expect(() => readDrizzleAuditReport(result)).toThrow('did not exit successfully');
  });
  it('preserves the actual preload fd3 transport, semantic stdout and report validation', () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (!['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA'].includes(key.toUpperCase())) delete env[key];
    const f = fixture(), result = f.collect(process.execPath,
      ['--require', join(workerRoot, 'test/helpers/drizzleCliAudit.cjs'), '-e', "process.stdout.write('semantic-probe')"],
      { ...options, cwd: workerRoot, env: { ...env, CI: '1', CINASHOP_DRIZZLE_AUDIT_REPORT_FD: '3' } }, metadata);
    expect(result.status).toBe(0); expect(result.stdout).toBe('semantic-probe'); expect(readDrizzleAuditReport(result).networkAttempts).toBe(0);
    expect(records(f)[0].outputBytes.report).toBeGreaterThan(0);
    expect(JSON.stringify(records(f))).not.toContain('semantic-probe');
  });
  it('separates simultaneous real children and safely publishes only their distinct validated records', async () => {
    const f = fixture();
    const source = join(f.root, 'parallel.ts');
    writeFileSync(source, `import { nativeDiagnosticCollector } from ${JSON.stringify(join(workerRoot, 'test/helpers/nativeChildDiagnostics.ts'))};
const collect = nativeDiagnosticCollector(${JSON.stringify(f.root)});
const result = collect(process.execPath, ['-e', 'setTimeout(()=>process.exit(' + process.argv[2] + '),200)'],
${JSON.stringify(options)}, ${JSON.stringify(metadata)}); console.log(JSON.stringify({status:result.status}));`);
    const children = await Promise.all([1, 2, 3].map(code => promisify(execFile)(process.execPath,
      [join(workerRoot, 'node_modules/tsx/dist/cli.mjs'), source, String(code)], { cwd: workerRoot, timeout: 10000, windowsHide: true })));
    expect(children.map(child => JSON.parse(child.stdout).status).sort()).toEqual([1, 2, 3]);
    const saved = records(f); expect(new Set(saved.map(record => record.invocationId)).size).toBe(3);
    expect(saved.map(record => record.termination.status).sort()).toEqual([1, 2, 3]);
    const audit = auditNativeDiagnostics(f.root, f.result, ''); expect(audit).toMatchObject({ complete: true, records: 3 });
    expect(new Set(saved.map(record => record.resourcesBefore.parent.pid)).size).toBe(3);
    expect(readdirSync(join(f.root, '.cache/native-child-diagnostics', `published-${f.run!.runId}`))).toHaveLength(5);
  });
  it('retains original thrown exception and cause while recording only a safe error code', () => {
    const f = fixture(), original = Object.assign(new Error('synthetic-secret-in-message', { cause: 'synthetic-secret-in-cause' }), { code: 'EINVAL' });
    const collect = nativeDiagnosticCollector(f.root, { spawn: (() => { throw original; }) as typeof spawnSync });
    let observed: unknown; try { collect(process.execPath, ['-e', ''], options, metadata); } catch (error) { observed = error; }
    expect(observed).toBe(original); expect((observed as Error).cause).toBe('synthetic-secret-in-cause');
    expect(records(f)[0]).toMatchObject({ phase: 'threw', termination: { errorCode: 'EINVAL', pid: null } });
    expect(JSON.stringify(records(f))).not.toMatch(/synthetic-secret/);
  });
  it('keeps a thrown exception with a broken code getter, even if diagnostic notification also fails', () => {
    const f = fixture(), original = new Error('original'); Object.defineProperty(original, 'code', { get() { throw Error('getter'); } });
    const collect = nativeDiagnosticCollector(f.root, { spawn: (() => { throw original; }) as typeof spawnSync, write: () => { throw Error('write'); }, unavailable: () => { throw Error('notification'); } });
    let observed: unknown; try { collect(process.execPath, ['-e', ''], options, metadata); } catch (error) { observed = error; }
    expect(observed).toBe(original);
  });
  it('does not turn a failed initial start write into a complete terminal receipt', () => {
    const f = fixture(); let calls = 0;
    const collect = nativeDiagnosticCollector(f.root, { unavailable: event => f.events.push(event), write: (file, value) => {
      if (++calls === 1) throw Object.assign(new Error('private path'), { code: 'EACCES' }); writeFileSync(file, value, { flag: 'wx' });
    } });
    expect(collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(records(f)[0]).toMatchObject({ phase: 'returned', diagnosticComplete: false, diagnosticErrorCode: 'EACCES', termination: { status: 7 } });
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: false, incompleteRecords: 1 });
  });
  it('retains started evidence and original exit when the completion write fails', () => {
    const f = fixture(); let calls = 0;
    const collect = nativeDiagnosticCollector(f.root, { unavailable: event => f.events.push(event), write: (file, value) => {
      if (++calls === 2) throw Object.assign(new Error('sensitive completion path'), { code: 'ENOSPC' }); writeFileSync(file, value, { flag: 'wx' });
    } });
    expect(collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(records(f)[0].phase).toBe('started'); expect(f.events).toEqual([expect.objectContaining({ diagnosticErrorCode: 'ENOSPC', termination: expect.objectContaining({ status: 7 }) })]);
    expect(JSON.stringify(f.events)).not.toContain('sensitive completion path');
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: false, incompleteRecords: 1 });
  });
  it('rejects a partly missing capture even when another receipt for the same case is good', () => {
    const f = fixture(); f.collect(process.execPath, ['-e', ''], options, metadata);
    const collect = nativeDiagnosticCollector(f.root, { unavailable: event => f.events.push(event), write: () => { throw Object.assign(new Error('secret'), { code: 'ENOSPC' }); } });
    expect(collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(records(f)).toHaveLength(1);
    const log = `NATIVE_CHILD_DIAGNOSTIC_UNAVAILABLE ${f.run!.runId} ${JSON.stringify(f.events[0])}`;
    expect(auditNativeDiagnostics(f.root, f.result, log)).toMatchObject({ complete: false, records: 1, unavailableEvents: 1 });
  });
  it('executes unchanged without a start manifest but cannot certify missing evidence', () => {
    const f = fixture(false); expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ runId: null, diagnosticErrorCode: 'ENOENT', termination: expect.objectContaining({ status: 7 }) })]);
    expect(auditNativeDiagnostics(f.root, f.result, 'NATIVE_CHILD_DIAGNOSTIC_UNAVAILABLE unknown')).toMatchObject({ complete: false });
  });
  it('a fresh run has its own budget and does not accept an old unit result or previous receipts', () => {
    const f = fixture(); f.collect(process.execPath, ['-e', ''], options, metadata);
    for (let index = 0; index < 260; index++) writeFileSync(join(f.directory!, `old-${index}.json`), '{}');
    const run = beginNativeDiagnostics(f.root), collect = nativeDiagnosticCollector(f.root);
    expect(collect(process.execPath, ['-e', ''], options, metadata).status).toBe(0);
    expect(auditNativeDiagnostics(f.root, { ...f.result, startTime: run.startedAtUnixMs - 1 }, '')).toMatchObject({ complete: false, expectedScopeKnown: false, failureCodes: ['DIAGNOSTIC_STALE_RUN'] });
  });
  it('preserves execution when the current run record count exceeds its bound', () => {
    const f = fixture(); for (let index = 0; index < 256; index++) writeFileSync(join(f.directory!, `child-${randomUUID()}.json`), '{}');
    expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ diagnosticErrorCode: 'DIAGNOSTIC_COUNT' })]);
  });
  it('preserves execution and rejects a run exceeding the total byte bound', () => {
    const f = fixture(); writeFileSync(join(f.directory!, `child-${randomUUID()}.json`), 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ diagnosticErrorCode: 'DIAGNOSTIC_SIZE' })]);
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: false });
  });
  it('rejects a cache junction/symlink without writing into its target or replacing the child exit', () => {
    const f = fixture(false), target = fixture(false); mkdirSync(join(f.root, '.cache')); symlinkSync(target.root, join(f.root, '.cache/native-child-diagnostics'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ diagnosticErrorCode: 'DIAGNOSTIC_PATH' })]); expect(readdirSync(target.root)).toEqual([]);
  });
  it('refuses path escape inputs and aliased unit results (Windows hardlink, POSIX symlink)', () => {
    const f = fixture(), target = fixture(false); writeFileSync(join(target.root, 'secret.json'), '{}');
    expect(() => assertWorkerInputPath(f.root, '../secret.json')).toThrow('DIAGNOSTIC_INPUT_PATH');
    if (process.platform === 'win32') linkSync(join(target.root, 'secret.json'), join(f.root, 'unit-shard-results.json'));
    else symlinkSync(join(target.root, 'secret.json'), join(f.root, 'unit-shard-results.json'));
    expect(() => readNativeDiagnosticInput(join(f.root, 'unit-shard-results.json'))).toThrow('DIAGNOSTIC_PATH');
  });
  it('refuses a malicious run ID without writing outside the approved run directory', () => {
    const f = fixture(); writeFileSync(join(f.root, '.cache/native-child-diagnostics/active.json'), JSON.stringify({ schemaVersion: 1, runId: '../../secret', startedAtUnixMs: Date.now() }));
    expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ diagnosticErrorCode: 'DIAGNOSTIC_RUN' })]); expect(records(f)).toEqual([]);
  });
  it('does not log caller-controlled case/operation strings, argv or env when metadata is rejected', () => {
    const f = fixture(); expect(f.collect(process.execPath, ['-e', 'process.exit(7)'], options, { caseId: 'synthetic-secret', mode: 'synthetic-token' }).status).toBe(7);
    expect(f.events).toEqual([expect.objectContaining({ caseId: 'unrecognized', mode: 'unrecognized', diagnosticErrorCode: 'DIAGNOSTIC_CASE' })]);
    expect(JSON.stringify(f.events)).not.toMatch(/synthetic-(secret|token)/);
  });
  it('maps a regex-shaped unknown uppercase error code to UNKNOWN without logging it', () => {
    const f = fixture(), original = Object.assign(new Error('synthetic-message'), { code: 'SYNTHETIC_UPPERCASE_SECRET' });
    const collect = nativeDiagnosticCollector(f.root, { spawn: (() => { throw original; }) as typeof spawnSync });
    expect(() => collect(process.execPath, ['-e', ''], options, metadata)).toThrow(original);
    expect(nativeDiagnosticErrorCode(original)).toBe('UNKNOWN');
    expect(records(f)[0]).toMatchObject({ termination: { errorCode: 'UNKNOWN' } });
    expect(JSON.stringify(records(f))).not.toContain('SYNTHETIC_UPPERCASE_SECRET');
  });
  it('preserves incomplete diagnostic records and manifest when final JSON and log are absent', () => {
    const f = fixture(); f.collect(process.execPath, ['-e', 'process.exit(7)'], options, metadata);
    const audit = auditNativeDiagnostics(f.root, undefined, undefined, [Object.assign(new Error('synthetic-secret-path'), { code: 'ENOENT' })]);
    expect(audit).toMatchObject({ complete: false, expectedScopeKnown: false, logInputKnown: false, records: 1 });
    const publication = join(f.root, '.cache/native-child-diagnostics', `published-${f.run!.runId}`);
    expect(readdirSync(publication)).toHaveLength(3); expect(readdirSync(publication)).toContain('manifest.json');
    expect(readFileSync(join(publication, 'audit.json'), 'utf8')).not.toContain('synthetic-secret-path');
  });
  it.each([
    ['unknown schema', (record: Record<string, any>) => { record.schemaVersion = 2; }],
    ['foreign run', (record: Record<string, any>) => { record.runId = randomUUID(); }],
    ['wrong invocation', (record: Record<string, any>) => { record.invocationId = randomUUID(); }],
    ['secret extra field', (record: Record<string, any>) => { record.environment = 'synthetic-secret'; }],
    ['command extra field', (record: Record<string, any>) => { record.argv = ['synthetic-token']; }],
    ['output extra field', (record: Record<string, any>) => { record.stdout = 'synthetic-payload'; }],
    ['fake child RSS', (record: Record<string, any>) => { record.resourcesAfter.child = { rss: 123 }; }],
    ['unknown operation', (record: Record<string, any>) => { record.mode = 'private-value'; }],
    ['unknown case', (record: Record<string, any>) => { record.caseId = 'private-value'; }],
    ['negative elapsed', (record: Record<string, any>) => { record.elapsedMs = -1; }],
    ['invalid signal', (record: Record<string, any>) => { record.termination.signal = 'synthetic-token'; }],
    ['invalid error code', (record: Record<string, any>) => { record.termination.errorCode = 'secret://credentials'; }],
    ['uppercase unknown error code', (record: Record<string, any>) => { record.termination.errorCode = 'SYNTHETIC_UPPERCASE_SECRET'; }],
    ['uppercase unknown signal', (record: Record<string, any>) => { record.termination.signal = 'SIGSYNTHETICSECRET'; }],
    ['infinite resource', (record: Record<string, any>) => { record.resourcesBefore.parent.memoryBytes.rss = Infinity; }],
    ['invalid complete flag', (record: Record<string, any>) => { record.diagnosticComplete = false; }],
  ])('rejects %s and never publishes unvalidated fields', (_name, mutate) => {
    const f = fixture(); f.collect(process.execPath, ['-e', ''], options, metadata);
    const [record] = records(f); mutate(record); writeFileSync(join(f.directory!, `child-${readdirSync(f.directory!).find(name => name.startsWith('child-'))!.slice(6)}`), JSON.stringify(record));
    const audit = auditNativeDiagnostics(f.root, f.result, ''); expect(audit.complete).toBe(false);
    const publication = join(f.root, '.cache/native-child-diagnostics', `published-${f.run!.runId}`);
    expect(readdirSync(publication)).toEqual(['audit.json', 'manifest.json']); expect(readFileSync(join(publication, 'audit.json'), 'utf8')).not.toMatch(/synthetic-|secret:\/\//);
  });
  it.each(['{', 'x'.repeat(16 * 1024 + 1)])('rejects invalid or oversized receipt bytes without publishing their content %#', raw => {
    const f = fixture(); writeFileSync(join(f.directory!, `child-${randomUUID()}.json`), raw);
    expect(auditNativeDiagnostics(f.root, f.result, '')).toMatchObject({ complete: false, records: 0 });
  });
  it('requires the operations of every actually executed core file and rejects unexecuted case records', () => {
    const f = fixture(); f.collect(process.execPath, ['-e', ''], options, metadata);
    expect(auditNativeDiagnostics(f.root, { ...f.result, testResults: [{ name: join(f.root, 'test/drizzle-generation.test.ts') }] }, '')).toMatchObject({ complete: false, records: 0 });
  });
  it('refuses stale publication reuse rather than calling a second audit a fresh proof', () => {
    const f = fixture(); f.collect(process.execPath, ['-e', ''], options, metadata);
    expect(auditNativeDiagnostics(f.root, f.result, '').complete).toBe(true);
    expect(() => auditNativeDiagnostics(f.root, f.result, '')).toThrow('DIAGNOSTIC_PUBLICATION_EXISTS');
  });
});
