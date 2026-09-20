/** Full local CI-partition verification. No database provisioning or credentials
 * here; the dedicated runner owns its new loopback cluster and private output. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readUnitProgress } from './local-unit-progress.mjs';

const ignoredDirectories = new Set(['node_modules', '.git', '.cache', '.wrangler', 'dist', 'coverage', 'test-results', 'playwright-report', '.firecrawl']);
const secretFile = name => /^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/.test(name);
const hash = value => createHash('sha256').update(value).digest('hex');
const checkShard = shard => assert.ok(shard === 1 || shard === 2, 'Only native unit shard 1 or 2 is accepted');

export function captureUnitInputs(workerRoot) {
  const root = resolve(workerRoot);
  const paths = new Set();
  const add = path => paths.add(resolve(path));
  const walk = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name) || secretFile(entry.name)) continue;
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Unit input symlinks require explicit review');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path);
    }
  };
  for (const directory of ['src', 'test', 'scripts', 'migrations', '../view', '../.github']) walk(resolve(root, directory));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:[cm]?[jt]s|jsonc?|toml)$/.test(entry.name)
      && !/^(?:unit-|.*results|.*report)/.test(entry.name) && !secretFile(entry.name)) add(join(root, entry.name));
  }
  for (const name of ['MIGRATION_CHECKLIST.md', '.gitattributes', '.gitignore', '.gitleaks.toml']) {
    const path = resolve(root, '..', name); if (existsSync(path)) add(path);
  }
  const files = [...paths].map(path => ({ path: relative(root, path).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { files, sha256: hash(JSON.stringify(files)) };
}

export function changedUnitInputs(before, after) {
  const previous = new Map(before.files.map(file => [file.path, file.sha256]));
  const current = new Map(after.files.map(file => [file.path, file.sha256]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .filter(path => previous.get(path) !== current.get(path)).sort();
}

export function unitGateArguments(shard, outputDirectory) {
  checkShard(shard);
  return ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', `--shard=${shard}/2`,
    '--maxWorkers=2', '--reporter=default', '--reporter=json', '--reporter=./scripts/local-unit-progress.mjs',
    `--outputFile.json=${join(outputDirectory, 'unit-shard-results.json')}`];
}

/** Do not let a full test run inherit production URLs/tokens, NODE_OPTIONS or
 * arbitrary TEST_* overrides from the user's environment. OS paths are needed
 * by native children; the dedicated loopback URL is supplied separately. */
export function unitGateEnvironment(parent, connectionString, outputDirectory) {
  const database = new URL(connectionString);
  assert.ok(database.protocol === 'postgresql:' && database.hostname === '127.0.0.1'
    && database.port && database.username === 'finance_test' && database.password
    && database.pathname === '/cinashop_finance_test' && !database.search && !database.hash,
  'Full unit gate requires the dedicated loopback database');
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL']);
  const environment = Object.fromEntries(Object.entries(parent).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
  if (parent.MINIFLARE_WORKERD_PATH) environment.MINIFLARE_WORKERD_PATH = parent.MINIFLARE_WORKERD_PATH;
  return { ...environment, CI: 'true', NODE_ENV: 'test', TEST_FINANCE_POSTGRES_URL: connectionString,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(outputDirectory, 'wrangler.log'),
    CINASHOP_UNIT_GATE_OUTPUT_DIR: outputDirectory };
}

export async function prepareUnitGate(workerRoot, outputDirectory, shard) {
  checkShard(shard);
  const { inspectUnitPartition } = await import('./audit-unit-shards.mjs');
  const partition = await inspectUnitPartition();
  const inputs = captureUnitInputs(workerRoot);
  const prepared = { shard, platform: process.platform, nodeVersion: process.version,
    inputScope: 'Worker src/test/scripts/migrations and root configs; view sources excluding build/dependency/cache directories; .github and root checklist/git policy. Secret env files, installed dependencies, external PHP checkout and Worker docs/audit are not frozen.',
    partition, inputs };
  writeFileSync(join(outputDirectory, 'unit-gate-inputs.json'), JSON.stringify(prepared, null, 2), { flag: 'wx', mode: 0o600 });
  return prepared;
}

export async function finishUnitGate(workerRoot, outputDirectory, prepared, execution) {
  const { verifyExecutedShard } = await import('./audit-unit-shards.mjs');
  const after = captureUnitInputs(workerRoot);
  const changedFiles = changedUnitInputs(prepared.inputs, after);
  let acceptance;
  let verificationError;
  let counts;
  let progress;
  let progressError;
  try { progress = readUnitProgress(outputDirectory, prepared); }
  catch (error) { progressError = error instanceof Error ? error.message.slice(0, 500) : 'Unit progress verification failed'; }
  try {
    const result = JSON.parse(readFileSync(join(outputDirectory, 'unit-shard-results.json'), 'utf8'));
    counts = { total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests,
      skipped: result.numPendingTests, todo: result.numTodoTests, executedFiles: result.testResults?.length };
    acceptance = verifyExecutedShard(prepared.partition, prepared.shard, result);
  } catch (error) { verificationError = error instanceof Error ? error.message.slice(0, 500) : 'Unit result verification failed'; }
  const progressMatchesFinalJson = Boolean(counts) && progress?.observedAssertions === counts.total
    && progress?.counts.passed === counts.passed && progress?.completedModules === counts.executedFiles;
  const child = { status: execution.status, signal: execution.signal ?? null, errorCode: execution.error?.code ?? null };
  const report = { shard: prepared.shard, accepted: Boolean(acceptance) && progress?.complete === true && progressMatchesFinalJson && changedFiles.length === 0
      && child.status === 0 && child.signal === null && child.errorCode === null && !execution.error,
    execution: child,
    inputFiles: prepared.inputs.files.length, inputSha256Before: prepared.inputs.sha256, inputSha256After: after.sha256,
    changedFiles, counts, acceptance, verificationError, progress, progressError, progressMatchesFinalJson };
  writeFileSync(join(outputDirectory, 'unit-gate-result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}
