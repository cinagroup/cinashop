/** Parent-side evidence only. Never changes a child's arguments/options, report
 * transport, exit result, exception, deadline or the caller's business assertions. */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

export const nativeDiagnosticCases = {
  'check-state-alignment': ['cjs', 'esm'], 'column-default-alignment': ['cjs', 'esm'],
  'drizzle-generation': ['generate', 'export'], 'drizzle-not-valid': ['cjs', 'esm', 'generate', 'export'],
  'drizzle-pg-order-patch': ['cjs', 'esm'], 'drizzle-sequence-state': ['cjs', 'esm', 'generate', 'export'],
  'external-duplicate-index-retirement': ['pglite'], 'foreign-key-name-alignment': ['cjs', 'esm'],
  'kefu-sequence-alignment': ['cjs', 'esm'], 'missing-constraint-alignment': ['cjs', 'esm'],
} as const;
type CaseId = keyof typeof nativeDiagnosticCases;
interface Metadata { caseId: string; mode: string }
interface Run { schemaVersion: 1; runId: string; startedAtUnixMs: number }
interface Termination { pid: number | null; status: number | null; signal: string | null; errorCode: string | null }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 16 * 1024, MAX_RECORDS = 256, MAX_RUN_BYTES = 8 * 1024 * 1024;
const memoryKeys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'] as const;
const usageKeys = ['userCPUTime', 'systemCPUTime', 'maxRSS', 'minorPageFault', 'majorPageFault', 'voluntaryContextSwitches', 'involuntaryContextSwitches'] as const;
const errorCodes = new Set(['UNKNOWN', 'E2BIG', 'EACCES', 'EAGAIN', 'EBADF', 'EBUSY', 'ECANCELED', 'ECHILD', 'EEXIST', 'EFAULT', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'ENOSYS', 'ENOTSUP', 'EPERM', 'EPIPE', 'EROFS', 'ESRCH', 'ETIMEDOUT',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'DIAGNOSTIC_UNAVAILABLE', 'DIAGNOSTIC_SHAPE', 'DIAGNOSTIC_NUMBER', 'DIAGNOSTIC_CHILD_RESOURCE', 'DIAGNOSTIC_RUN', 'DIAGNOSTIC_CASE', 'DIAGNOSTIC_IDENTITY', 'DIAGNOSTIC_TIME', 'DIAGNOSTIC_STATUS', 'DIAGNOSTIC_SIGNAL', 'DIAGNOSTIC_ERROR_CODE', 'DIAGNOSTIC_COMPLETENESS', 'DIAGNOSTIC_PATH', 'DIAGNOSTIC_SIZE', 'DIAGNOSTIC_JSON', 'DIAGNOSTIC_COUNT', 'DIAGNOSTIC_DEADLINE', 'DIAGNOSTIC_UNIT_RESULT', 'DIAGNOSTIC_UNIT_LOG', 'DIAGNOSTIC_STALE_RUN', 'DIAGNOSTIC_FILENAME', 'DIAGNOSTIC_RUN_SCOPE', 'DIAGNOSTIC_MISSING_CASE', 'DIAGNOSTIC_INCOMPLETE', 'DIAGNOSTIC_UNAVAILABLE_EVENT', 'DIAGNOSTIC_PUBLICATION_EXISTS', 'DIAGNOSTIC_INPUT_PATH', 'DIAGNOSTIC_ARGUMENTS']);
const signals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGIOT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGSTKFLT', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGPOLL', 'SIGPWR', 'SIGSYS', 'SIGUNUSED']);
signals.add('UNKNOWN'); // Fixed projection for an unrecognized signal, never its raw value.
interface Resources {
  parent: { pid: number; memoryBytes: Record<typeof memoryKeys[number], number>; resourceUsage: Record<typeof usageKeys[number], number> };
  host: { logicalCpuCount: number; totalMemoryBytes: number; freeMemoryBytes: number };
  child: null;
}
interface RecordData {
  schemaVersion: 1; runId: string; invocationId: string; caseId: CaseId; mode: string;
  phase: 'started' | 'returned' | 'threw'; startedAtUnixMs: number; deadlineMs: number;
  resourcesBefore: Resources;
  finishedAtUnixMs?: number; elapsedMs?: number; resourcesAfter?: Resources; termination?: Termination;
  outputBytes?: { stdout: number; stderr: number; report: number | null };
  diagnosticComplete?: boolean; diagnosticErrorCode?: string | null;
}
export interface DiagnosticHooks {
  spawn?: (executable: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
  write?: (file: string, value: string, replacing: boolean) => void;
  unavailable?: (event: { runId: string | null; caseId: string; mode: string; diagnosticErrorCode: string; termination: Termination | null }) => void;
}

function reject(code: string): never { throw Object.assign(new Error(code), { code }); }
export function nativeDiagnosticErrorCode(error: unknown): string {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && errorCodes.has(code) ? code : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
const codeOf = nativeDiagnosticErrorCode;
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')) reject('DIAGNOSTIC_SHAPE');
}
function finite(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) reject('DIAGNOSTIC_NUMBER');
}
function integer(value: unknown): asserts value is number { finite(value); if (!Number.isSafeInteger(value)) reject('DIAGNOSTIC_NUMBER'); }
function safeMetadata(value: Metadata): asserts value is Metadata & { caseId: CaseId } {
  if (!Object.hasOwn(nativeDiagnosticCases, value.caseId)
      || !(nativeDiagnosticCases[value.caseId as CaseId] as readonly string[]).includes(value.mode)) reject('DIAGNOSTIC_CASE');
}
function resources(): Resources {
  const memory = process.memoryUsage(), usage = process.resourceUsage();
  return { parent: { pid: process.pid,
    memoryBytes: Object.fromEntries(memoryKeys.map(key => [key, memory[key]])) as Resources['parent']['memoryBytes'],
    resourceUsage: Object.fromEntries(usageKeys.map(key => [key, usage[key]])) as Resources['parent']['resourceUsage'] },
    host: { logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() }, child: null };
}
function validateResources(value: unknown): void {
  exactKeys(value, ['parent', 'host', 'child']); if (value.child !== null) reject('DIAGNOSTIC_CHILD_RESOURCE');
  exactKeys(value.parent, ['pid', 'memoryBytes', 'resourceUsage']); integer(value.parent.pid);
  exactKeys(value.parent.memoryBytes, [...memoryKeys]); for (const number of Object.values(value.parent.memoryBytes)) integer(number);
  exactKeys(value.parent.resourceUsage, [...usageKeys]); for (const number of Object.values(value.parent.resourceUsage)) integer(number);
  exactKeys(value.host, ['logicalCpuCount', 'totalMemoryBytes', 'freeMemoryBytes']); for (const number of Object.values(value.host)) integer(number);
}
function validateRun(value: unknown): asserts value is Run {
  exactKeys(value, ['schemaVersion', 'runId', 'startedAtUnixMs']);
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || !uuid.test(value.runId)) reject('DIAGNOSTIC_RUN');
  integer(value.startedAtUnixMs);
}
function validateRecord(input: unknown): asserts input is RecordData {
  if (!input || typeof input !== 'object' || !('phase' in input)) reject('DIAGNOSTIC_SHAPE');
  const value = input as Record<string, unknown>;
  const terminal = value.phase === 'returned' || value.phase === 'threw';
  exactKeys(value, ['schemaVersion', 'runId', 'invocationId', 'caseId', 'mode', 'phase', 'startedAtUnixMs', 'deadlineMs', 'resourcesBefore',
    ...(terminal ? ['finishedAtUnixMs', 'elapsedMs', 'resourcesAfter', 'termination', 'outputBytes', 'diagnosticComplete', 'diagnosticErrorCode'] : [])]);
  if (value.schemaVersion !== 1 || typeof value.runId !== 'string' || !uuid.test(value.runId)
      || typeof value.invocationId !== 'string' || !uuid.test(value.invocationId) || (!terminal && value.phase !== 'started')) reject('DIAGNOSTIC_IDENTITY');
  if (typeof value.caseId !== 'string' || typeof value.mode !== 'string') reject('DIAGNOSTIC_CASE');
  safeMetadata({ caseId: value.caseId, mode: value.mode }); integer(value.startedAtUnixMs); integer(value.deadlineMs);
  validateResources(value.resourcesBefore);
  if (!terminal) return;
  integer(value.finishedAtUnixMs); finite(value.elapsedMs); validateResources(value.resourcesAfter);
  if (value.finishedAtUnixMs < value.startedAtUnixMs) reject('DIAGNOSTIC_TIME');
  exactKeys(value.termination, ['pid', 'status', 'signal', 'errorCode']);
  if (value.termination.pid !== null) integer(value.termination.pid);
  if (value.termination.status !== null && (typeof value.termination.status !== 'number' || !Number.isSafeInteger(value.termination.status))) reject('DIAGNOSTIC_STATUS');
  if (value.termination.signal !== null && (typeof value.termination.signal !== 'string' || !signals.has(value.termination.signal))) reject('DIAGNOSTIC_SIGNAL');
  for (const code of [value.termination.errorCode, value.diagnosticErrorCode]) if (code !== null && (typeof code !== 'string' || !errorCodes.has(code))) reject('DIAGNOSTIC_ERROR_CODE');
  if (typeof value.diagnosticComplete !== 'boolean' || value.diagnosticComplete !== (value.diagnosticErrorCode === null)) reject('DIAGNOSTIC_COMPLETENESS');
  exactKeys(value.outputBytes, ['stdout', 'stderr', 'report']); integer(value.outputBytes.stdout); integer(value.outputBytes.stderr);
  if (value.outputBytes.report !== null) integer(value.outputBytes.report);
}

function directory(workerRoot: string): string {
  const base = realpathSync(workerRoot), cache = join(base, '.cache'), root = join(cache, 'native-child-diagnostics');
  for (const file of [cache, root]) {
    if (!existsSync(file)) mkdirSync(file, { mode: 0o700 });
    const stat = lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file) reject('DIAGNOSTIC_PATH');
  }
  return root;
}
function regular(file: string): void { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) reject('DIAGNOSTIC_PATH'); }
function boundedJson(file: string, maximum = MAX_RECORD_BYTES): unknown {
  try { return JSON.parse(boundedText(file, maximum)); } catch (error) {
    if (error instanceof SyntaxError) reject('DIAGNOSTIC_JSON'); throw error;
  }
}
function boundedText(file: string, maximum: number): string {
  regular(file); const before = lstatSync(file); if (before.size > maximum) reject('DIAGNOSTIC_SIZE');
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev) reject('DIAGNOSTIC_PATH');
    if (after.size > maximum) reject('DIAGNOSTIC_SIZE');
    const bytes = Buffer.alloc(maximum + 1); let length = 0, read = 0;
    do { read = readSync(descriptor, bytes, length, bytes.length - length, null); length += read; } while (read && length < bytes.length);
    if (length > maximum) reject('DIAGNOSTIC_SIZE'); return bytes.subarray(0, length).toString('utf8');
  } finally { closeSync(descriptor); }
}
function writeRecord(file: string, value: string, replacing: boolean): void {
  if (Buffer.byteLength(value) > MAX_RECORD_BYTES) reject('DIAGNOSTIC_SIZE');
  if (replacing) regular(file);
  const temporary = replacing ? file.replace(/\.json$/, '.next.json') : file;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, value); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  if (replacing) renameSync(temporary, file);
}
function runDirectory(root: string, run: Run): string {
  const target = join(root, `run-${run.runId}`), stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(target) !== target) reject('DIAGNOSTIC_PATH');
  const manifest = boundedJson(join(target, 'manifest.json')); validateRun(manifest);
  if (JSON.stringify(manifest) !== JSON.stringify(run)) reject('DIAGNOSTIC_RUN');
  return target;
}
function currentRun(root: string): Run { const value = boundedJson(join(root, 'active.json')); validateRun(value); return value; }
function sizeBudget(target: string, adding = false): void {
  const entries = readdirSync(target);
  if (entries.length > MAX_RECORDS + 1 || (adding && entries.length >= MAX_RECORDS + 1)) reject('DIAGNOSTIC_COUNT');
  let size = 0;
  for (const entry of entries) { const file = join(target, entry); regular(file); size += lstatSync(file).size; }
  if (size > MAX_RUN_BYTES) reject('DIAGNOSTIC_SIZE');
}
function unavailable(event: Parameters<NonNullable<DiagnosticHooks['unavailable']>>[0]): void {
  // Only fixed identifiers and projected termination fields; never stringify Error.
  process.stderr.write(`NATIVE_CHILD_DIAGNOSTIC_UNAVAILABLE ${event.runId ?? 'unknown'} ${JSON.stringify(event)}\n`);
}
function termination(result: SpawnSyncReturns<string>): Termination {
  return { pid: Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null,
    status: result.status, signal: result.signal === null ? null : signals.has(result.signal) ? result.signal : 'UNKNOWN', errorCode: result.error ? codeOf(result.error) : null };
}

/** Begin once immediately before a test command. Old runs have separate budgets;
 * shards run in separate CI filesystems, so neither old receipts nor retries are
 * counted against the current run. An audit must bind to this fresh manifest. */
export function beginNativeDiagnostics(workerRoot: string): Run {
  const root = directory(workerRoot), run: Run = { schemaVersion: 1, runId: randomUUID(), startedAtUnixMs: Date.now() };
  const target = join(root, `run-${run.runId}`); mkdirSync(target, { mode: 0o700 });
  const bytes = JSON.stringify(run) + '\n'; writeRecord(join(target, 'manifest.json'), bytes, false);
  const temporary = join(root, `active-${run.runId}.json`); writeRecord(temporary, bytes, false);
  const active = join(root, 'active.json'); if (existsSync(active)) regular(active);
  renameSync(temporary, active); return run;
}

export function nativeDiagnosticCollector(workerRoot: string, hooks: DiagnosticHooks = {}) {
  const execute = hooks.spawn ?? spawnSync, write = hooks.write ?? writeRecord, notify = hooks.unavailable ?? unavailable;
  return (executable: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding, metadata: Metadata): SpawnSyncReturns<string> => {
    let run: Run | undefined, record: RecordData | undefined, file: string | undefined, diagnosticErrorCode: string | null = null;
    try {
      safeMetadata(metadata); integer(options.timeout); if (!options.timeout) reject('DIAGNOSTIC_DEADLINE');
      const root = directory(workerRoot); run = currentRun(root); const target = runDirectory(root, run); sizeBudget(target, true);
      record = { schemaVersion: 1, runId: run.runId, invocationId: randomUUID(), caseId: metadata.caseId, mode: metadata.mode,
        phase: 'started', startedAtUnixMs: Date.now(), deadlineMs: options.timeout, resourcesBefore: resources() };
      file = join(target, `child-${record.invocationId}.json`); write(file, JSON.stringify(record) + '\n', false);
    } catch (error) { diagnosticErrorCode = codeOf(error); }
    const started = performance.now();
    let result: SpawnSyncReturns<string>;
    try { result = execute(executable, args, options); }
    catch (originalError) {
      finish(null, originalError);
      throw originalError; // Preserve the original exception identity and cause.
    }
    finish(result); return result; // Preserve result/error/output objects exactly.

    function finish(result: SpawnSyncReturns<string> | null, originalError?: unknown): void {
      const projected = result ? termination(result) : { pid: null, status: null, signal: null, errorCode: codeOf(originalError) };
      try {
        if (record && file) {
          const terminal: RecordData = { ...record, phase: result ? 'returned' : 'threw', finishedAtUnixMs: Date.now(), elapsedMs: performance.now() - started,
            resourcesAfter: resources(), termination: projected,
            outputBytes: { stdout: result ? Buffer.byteLength(result.stdout ?? '') : 0, stderr: result ? Buffer.byteLength(result.stderr ?? '') : 0,
              report: result && Array.isArray(result.output) && typeof result.output[3] === 'string' ? Buffer.byteLength(result.output[3]) : null },
            diagnosticComplete: diagnosticErrorCode === null, diagnosticErrorCode };
          validateRecord(terminal);
          // A failed start is not converted into a complete receipt by a later write.
          write(file, JSON.stringify(terminal) + '\n', diagnosticErrorCode === null);
        }
      } catch (error) { diagnosticErrorCode = codeOf(error); }
      if (diagnosticErrorCode !== null) {
        const known = Object.hasOwn(nativeDiagnosticCases, metadata.caseId), modes = known ? nativeDiagnosticCases[metadata.caseId as CaseId] as readonly string[] : [];
        try { notify({ runId: run?.runId ?? null, caseId: known ? metadata.caseId : 'unrecognized', mode: modes.includes(metadata.mode) ? metadata.mode : 'unrecognized', diagnosticErrorCode, termination: projected }); }
        catch { /* Evidence failure cannot replace or suppress the original child result. The strict audit still requires receipts and a complete log. */ }
      }
    }
  };
}
const collector = nativeDiagnosticCollector(resolve(import.meta.dirname, '../..'));
export const spawnNativeDiagnostic = collector;

export interface NativeDiagnosticAudit { schemaVersion: 1; runId: string | null; complete: boolean; expectedScopeKnown: boolean; logInputKnown: boolean; expectedCases: string[]; records: number; incompleteRecords: number; unavailableEvents: number; failureCodes: string[] }
/** Strictly project only validated records into the upload directory. Invalid
 * files/extra fields are never copied, even when the original test run failed. */
export function auditNativeDiagnostics(workerRoot: string, unitResult: unknown, unitLog: string | undefined, inputErrors: unknown[] = []): NativeDiagnosticAudit {
  const report: NativeDiagnosticAudit = { schemaVersion: 1, runId: null, complete: false, expectedScopeKnown: false, logInputKnown: typeof unitLog === 'string', expectedCases: [], records: 0, incompleteRecords: 0, unavailableEvents: 0, failureCodes: inputErrors.map(codeOf) };
  const safe: RecordData[] = [];
  let root: string | undefined, run: Run | undefined;
  try {
    root = directory(workerRoot); run = currentRun(root); report.runId = run.runId;
    const target = runDirectory(root, run); sizeBudget(target);
    let unitStart = run.startedAtUnixMs;
    try {
      if (!unitResult || typeof unitResult !== 'object' || !('startTime' in unitResult) || !('testResults' in unitResult)
          || !Array.isArray(unitResult.testResults)) reject('DIAGNOSTIC_UNIT_RESULT');
      integer(unitResult.startTime); if (unitResult.startTime < run.startedAtUnixMs) reject('DIAGNOSTIC_STALE_RUN');
      for (const test of unitResult.testResults) {
        if (!test || typeof test.name !== 'string') reject('DIAGNOSTIC_UNIT_RESULT');
        const name = relative(realpathSync(workerRoot), test.name).replaceAll('\\', '/');
        const found = Object.keys(nativeDiagnosticCases).find(id => name === `test/${id}.test.ts`);
        if (found) report.expectedCases.push(found);
      }
      if (new Set(report.expectedCases).size !== report.expectedCases.length) reject('DIAGNOSTIC_UNIT_RESULT');
      report.expectedCases.sort(); report.expectedScopeKnown = true; unitStart = unitResult.startTime;
    } catch (error) { report.expectedCases = []; report.failureCodes.push(codeOf(error)); }
    if (!report.logInputKnown) report.failureCodes.push('DIAGNOSTIC_UNIT_LOG');
    const entries = readdirSync(target).filter(name => name !== 'manifest.json');
    const seen = new Set<string>();
    for (const name of entries) {
      try {
        if (!/^child-[a-f0-9-]{36}\.json$/.test(name)) reject('DIAGNOSTIC_FILENAME');
        const record = boundedJson(join(target, name)); validateRecord(record);
        if (record.runId !== run.runId || name !== `child-${record.invocationId}.json` || seen.has(record.invocationId)) reject('DIAGNOSTIC_IDENTITY');
        seen.add(record.invocationId);
        if (record.startedAtUnixMs < unitStart || (report.expectedScopeKnown && !report.expectedCases.includes(record.caseId))) reject('DIAGNOSTIC_RUN_SCOPE');
        safe.push(record); report.records++;
        if (record.phase === 'started' || !record.diagnosticComplete) report.incompleteRecords++;
      } catch (error) { report.failureCodes.push(codeOf(error)); }
    }
    for (const caseId of report.expectedCases) {
      for (const mode of nativeDiagnosticCases[caseId as CaseId]) if (!safe.some(record => record.caseId === caseId && record.mode === mode)) report.failureCodes.push('DIAGNOSTIC_MISSING_CASE');
    }
    report.unavailableEvents = (unitLog ?? '').split(`NATIVE_CHILD_DIAGNOSTIC_UNAVAILABLE ${run.runId}`).length - 1
      + (unitLog ?? '').split('NATIVE_CHILD_DIAGNOSTIC_UNAVAILABLE unknown').length - 1;
    if (report.incompleteRecords) report.failureCodes.push('DIAGNOSTIC_INCOMPLETE');
    if (report.unavailableEvents) report.failureCodes.push('DIAGNOSTIC_UNAVAILABLE_EVENT');
    report.complete = report.failureCodes.length === 0;
  } catch (error) { report.failureCodes.push(codeOf(error)); }
  report.failureCodes = [...new Set(report.failureCodes)].sort();
  if (root) {
    const publication = join(root, `published-${run?.runId ?? `unavailable-${randomUUID()}`}`);
    if (!existsSync(publication)) mkdirSync(publication, { mode: 0o700 });
    if (lstatSync(publication).isSymbolicLink() || !lstatSync(publication).isDirectory() || realpathSync(publication) !== publication) reject('DIAGNOSTIC_PATH');
    // Fresh publication only; no stale files can be accepted by a repeated audit.
    if (readdirSync(publication).length) reject('DIAGNOSTIC_PUBLICATION_EXISTS');
    for (const record of safe) writeRecord(join(publication, `child-${record.invocationId}.json`), JSON.stringify(record) + '\n', false);
    if (run) writeRecord(join(publication, 'manifest.json'), JSON.stringify(run) + '\n', false);
    writeRecord(join(publication, 'audit.json'), JSON.stringify(report) + '\n', false);
  }
  return report;
}

export function readNativeDiagnosticInput(file: string): unknown { return boundedJson(file, 32 * 1024 * 1024); }
export function readNativeDiagnosticLog(file: string): string {
  // The log is inspected only for our fixed unavailable-event token; no contents
  // are returned in an artifact or error. Existing Vitest log retention is separate.
  return boundedText(file, 64 * 1024 * 1024);
}
export function assertWorkerInputPath(workerRoot: string, file: string): string {
  const target = resolve(workerRoot, file), base = realpathSync(workerRoot);
  if (!target.startsWith(base + sep) || dirname(target) !== base) reject('DIAGNOSTIC_INPUT_PATH');
  return target;
}
