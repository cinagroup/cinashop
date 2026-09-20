/** Diagnostic journal, never a replacement for the final native JSON report. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const initialHash = '0'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const states = new Set(['passed', 'failed', 'skipped', 'pending']);
const fileName = 'unit-progress.ndjson';

export default class LocalUnitProgress {
  onInit(ctx) {
    const directory = process.env.CINASHOP_UNIT_GATE_OUTPUT_DIR;
    assert.ok(directory && isAbsolute(directory) && statSync(directory).isDirectory(), 'Missing explicit unit diagnostic directory');
    this.directory = realpathSync(directory); this.root = ctx.config.root;
    const prepared = JSON.parse(readFileSync(join(this.directory, 'unit-gate-inputs.json'), 'utf8'));
    assert.ok(prepared.shard === 1 || prepared.shard === 2);
    this.inventory = prepared.partition.files;
    this.expected = prepared.partition.shards[prepared.shard - 1];
    assert.ok(this.expected.length > 0 && new Set(this.expected).size === this.expected.length
      && this.expected.every(file => this.inventory.includes(file)));
    this.previous = initialHash; this.sequence = 0; this.finished = new Set(); this.started = new Set();
    this.secrets = [process.env.TEST_FINANCE_POSTGRES_URL].filter(Boolean);
    if (this.secrets.length) this.secrets.push(decodeURIComponent(new URL(this.secrets[0]).password));
    this.fd = openSync(join(this.directory, fileName), 'wx', 0o600);
    try {
      this.append({ kind: 'header', version: 1, shard: prepared.shard, pid: process.pid,
        inventorySha256: prepared.partition.digest, inputSha256: prepared.inputs.sha256, expected: this.expected });
    } catch (error) { closeSync(this.fd); this.fd = undefined; throw error; }
  }
  append(entry) {
    assert.ok(this.fd !== undefined, 'Unit diagnostic journal is closed');
    const body = { sequence: this.sequence, previousHash: this.previous, entry };
    const sha256 = digest(JSON.stringify(body));
    const bytes = Buffer.from(JSON.stringify({ ...body, sha256 }) + '\n');
    assert.ok(bytes.length <= 16 * 1024 * 1024, 'Unit diagnostic record exceeds its byte limit');
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
      assert.ok(written > 0); offset += written;
    }
    fsyncSync(this.fd); this.previous = sha256; this.sequence++;
  }
  id(moduleId) { return relative(this.root, moduleId).replaceAll('\\', '/'); }
  text(value) {
    let text = String(value ?? '');
    for (const secret of this.secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return { text: text.slice(0, 8192), truncated: text.length > 8192 };
  }
  errors(errors = []) { return errors.map(error => ({ message: this.text(error?.message ?? error), stack: this.text(error?.stack) })); }
  onTestRunStart(specifications) {
    // Vitest 4 announces the collected universe before BaseSequencer.shard.
    // Actual selected modules are checked individually at module end below.
    assert.deepEqual(specifications.map(spec => this.id(spec.moduleId)).sort(), [...this.inventory].sort(),
      'Unit diagnostic collected inventory differs from native universe');
  }
  onTestModuleStart(module) {
    const file = this.id(module.moduleId);
    assert.ok(this.expected.includes(file) && !this.started.has(file) && !this.finished.has(file), 'Unexpected or duplicate unit diagnostic start');
    this.append({ kind: 'module-start', file, at: Date.now() }); this.started.add(file);
  }
  onTestModuleEnd(module) {
    const file = this.id(module.moduleId);
    assert.ok(this.expected.includes(file) && !this.finished.has(file), 'Unexpected or duplicate unit diagnostic module');
    const assertions = [...module.children.allTests()].map(test => ({ id: test.id, name: this.text(test.fullName),
      mode: test.options.mode, state: test.result().state, errors: this.errors(test.result().errors) }));
    const diagnostic = module.diagnostic();
    const timings = Object.fromEntries(['duration', 'collectDuration', 'prepareDuration', 'setupDuration', 'environmentSetupDuration']
      .map(key => [key, diagnostic[key]]));
    assert.ok(Object.values(timings).every(value => Number.isFinite(value) && value >= 0));
    this.append({ kind: 'module', file, state: module.state(), timings, errors: this.errors(module.errors()), assertions });
    this.finished.add(file);
  }
  onTestRunEnd(_modules, errors, reason) {
    try { this.append({ kind: 'end', reason, errors: this.errors(errors) }); }
    finally { if (this.fd !== undefined) closeSync(this.fd); this.fd = undefined; }
  }
}

/** Completed records survive termination; an unfinished tail is explicitly
 * incomplete. Every retained record is chained and checked against this run. */
export function readUnitProgress(directory, prepared) {
  const path = join(directory, fileName);
  assert.ok(statSync(path).size <= 64 * 1024 * 1024, 'Unit diagnostic journal exceeds its byte limit');
  const raw = readFileSync(path, 'utf8'), lines = raw.split('\n');
  const partialTail = lines.pop() !== '';
  let previous = initialHash, header, end;
  const modules = new Map(), started = new Set();
  for (const [sequence, line] of lines.entries()) {
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ['entry', 'previousHash', 'sequence', 'sha256']);
    assert.equal(record.sequence, sequence); assert.equal(record.previousHash, previous);
    assert.equal(record.sha256, digest(JSON.stringify({ sequence, previousHash: previous, entry: record.entry })));
    previous = record.sha256;
    const entry = record.entry;
    if (!header) {
      assert.equal(entry.kind, 'header'); assert.equal(entry.version, 1); assert.equal(entry.shard, prepared.shard);
      assert.equal(entry.inventorySha256, prepared.partition.digest); assert.equal(entry.inputSha256, prepared.inputs.sha256);
      assert.deepEqual(entry.expected, prepared.partition.shards[prepared.shard - 1]); header = entry; continue;
    }
    assert.ok(!end, 'Unit diagnostic data appeared after its end record');
    if (entry.kind === 'end') { assert.ok(['passed', 'failed', 'interrupted'].includes(entry.reason)); assert.ok(Array.isArray(entry.errors)); end = entry; continue; }
    if (entry.kind === 'module-start') {
      assert.ok(header.expected.includes(entry.file) && !started.has(entry.file) && !modules.has(entry.file)
        && Number.isFinite(entry.at), 'Unexpected or duplicate unit diagnostic start');
      started.add(entry.file); continue;
    }
    assert.equal(entry.kind, 'module');
    assert.ok(header.expected.includes(entry.file) && !modules.has(entry.file), 'Unexpected or duplicate unit diagnostic file');
    assert.ok(states.has(entry.state) && Array.isArray(entry.assertions) && Array.isArray(entry.errors));
    assert.deepEqual(Object.keys(entry.timings).sort(), ['collectDuration', 'duration', 'environmentSetupDuration', 'prepareDuration', 'setupDuration']);
    assert.ok(Object.values(entry.timings).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(new Set(entry.assertions.map(test => test.id)).size, entry.assertions.length);
    for (const test of entry.assertions) assert.ok(typeof test.id === 'string' && test.id.length > 0
      && states.has(test.state) && ['run','only','skip','todo'].includes(test.mode));
    modules.set(entry.file, entry);
  }
  assert.ok(header, 'Missing complete unit diagnostic header');
  const assertions = [...modules.values()].flatMap(module => module.assertions);
  const counts = Object.fromEntries([...states].map(state => [state, assertions.filter(test => test.state === state).length]));
  const complete = !partialTail && end?.reason === 'passed' && end.errors.length === 0 && modules.size === header.expected.length
    && [...modules.values()].every(module => module.state === 'passed' && module.errors.length === 0 && module.assertions.length > 0)
    && assertions.every(test => test.state === 'passed' && test.mode !== 'todo');
  return { complete, partialTail, ended: Boolean(end), endReason: end?.reason, completedModules: modules.size,
    expectedModules: header.expected.length, observedAssertions: assertions.length, counts,
    missingFiles: header.expected.filter(file => !modules.has(file)),
    unfinishedStartedFiles: [...started].filter(file => !modules.has(file)),
    failedFiles: [...modules.values()].filter(module => module.state !== 'passed' || module.assertions.some(test => test.state !== 'passed')).map(module => module.file),
    journalSha256: previous };
}
