import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '8.29.0';
const REVIEWED_COMMIT = 'd715da71abf6ce6f3dba6f2ee1b57e143744ebe3';
const REVIEWED_COUNT = 276;
const REVIEWED_IGNORE_SHA256 = '748d24df34557a5a66f244c6fc2dcebecc79d309254b6001f702ba7ecf11f531';
const FROZEN_PATH = 'workers-ts/audit/wechat-app-author-source-binding-20261028.json';
const CANARIES = [
  { rule: 'generic-api-key', field: 'api_key' },
  { rule: 'jwt', field: 'access_token' },
  { rule: 'private-key', field: 'private_key' },
];

class CanaryFailure extends Error {}
function requireCondition(condition, message) {
  if (!condition) throw new CanaryFailure(message);
}

// Never relay scanner output or report fields: even an unexpected scanner
// failure must not put generated authentication material into CI logs.
function execute(binary, args, options) {
  const result = spawnSync(binary, args, { ...options, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  requireCondition(!result.error && result.signal === null, 'A canary subprocess failed or exceeded its deadline');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 2 && args[0] === '--binary' && args[1],
    'Usage: node workers-ts/scripts/verify-gitleaks-reviewed-findings.mjs --binary /absolute/path/to/gitleaks');
  requireCondition(isAbsolute(args[1]), 'An explicit absolute Gitleaks binary path is required');
  const binary = await realpath(args[1]);
  const ignore = await readFile(join(REPOSITORY, '.gitleaksignore'));
  requireCondition(createHash('sha256').update(ignore).digest('hex') === REVIEWED_IGNORE_SHA256,
    'The reviewed fingerprint set changed; review its evidence and update this canary deliberately');
  const fingerprints = ignore.toString('utf8').trimEnd().split('\n');
  requireCondition(fingerprints.length === REVIEWED_COUNT && new Set(fingerprints).size === REVIEWED_COUNT,
    'The reviewed fingerprint count or uniqueness changed');
  for (const fingerprint of fingerprints) {
    requireCondition(new RegExp(`^${REVIEWED_COMMIT}:[^:\\r\\n]+:(generic-api-key|jwt|private-key):[1-9][0-9]*$`).test(fingerprint),
      'Only reviewed immutable commit:path:rule:line fingerprints are accepted');
  }

  const temporary = await mkdtemp(join(tmpdir(), 'cinashop-gitleaks-canary-'));
  const ownedTemporary = await realpath(temporary);
  requireCondition(ownedTemporary !== await realpath(REPOSITORY), 'The canary must not target the working repository');
  try {
    // Isolate Git from caller-provided worktree/index/config overrides. All Git
    // mutations below run only inside the newly owned temporary repository.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = join(ownedTemporary, 'empty-gitconfig');
    await writeFile(environment.GIT_CONFIG_GLOBAL, '');
    const options = { cwd: ownedTemporary, env: environment };
    const version = execute(binary, ['version'], options);
    requireCondition(version.status === 0 && version.stdout.trim() === VERSION, 'The canary requires checksum-pinned Gitleaks 8.29.0');
    const git = (command) => {
      const result = execute('git', ['-c', 'core.hooksPath=/dev/null', ...command], options);
      requireCondition(result.status === 0, 'Temporary canary Git setup failed');
    };
    git(['init', '--quiet', '--initial-branch=canary', '.']);
    await copyFile(join(REPOSITORY, '.gitleaks.toml'), join(ownedTemporary, '.gitleaks.toml'));
    await copyFile(join(REPOSITORY, '.gitleaksignore'), join(ownedTemporary, '.gitleaksignore'));
    await mkdir(dirname(join(ownedTemporary, FROZEN_PATH)), { recursive: true });

    // All values are newly generated for this disposable repository. Nothing
    // is a hard-coded credential, and no canary value is sent to a provider.
    const apiKey = randomBytes(32).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iss: 'gitleaks-canary.invalid', iat: now, exp: now + 3600, jti: randomUUID() })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const jwt = `${unsigned}.${createHmac('sha256', randomBytes(32)).update(unsigned).digest('base64url')}`;
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const source = `${JSON.stringify({ api_key: apiKey, access_token: jwt, private_key: privateKey }, null, 2)}\n`;
    const lines = source.split('\n');
    const expectedCanaries = CANARIES.map(({ rule, field }) => {
      const line = lines.findIndex(value => value.startsWith(`  "${field}": `)) + 1;
      requireCondition(line > 0, 'A generated canary field has no unambiguous source line');
      return { rule, line };
    });
    await writeFile(join(ownedTemporary, FROZEN_PATH), source);
    git(['add', '--', '.gitleaks.toml', '.gitleaksignore', FROZEN_PATH]);
    git(['-c', 'user.name=Gitleaks canary', '-c', 'user.email=gitleaks-canary@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Disposable generated scanner canaries']);

    const reportPath = join(ownedTemporary, 'canary-report.json');
    const scan = execute(binary, ['git', '--redact=100', '--no-banner',
      '--config', join(ownedTemporary, '.gitleaks.toml'),
      '--gitleaks-ignore-path', join(ownedTemporary, '.gitleaksignore'),
      '--report-format', 'json', '--report-path', reportPath], options);
    requireCondition(scan.status === 1, 'The real scanner did not return its findings exit code for new canaries');
    let findings;
    try { findings = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch { throw new CanaryFailure('The real scanner did not produce a readable JSON report'); }
    requireCondition(Array.isArray(findings), 'The real scanner report is not a findings array');
    for (const { rule, line } of expectedCanaries) {
      const matches = findings.filter(finding => finding.File === FROZEN_PATH
        && finding.RuleID === rule && finding.StartLine === line);
      requireCondition(matches.length > 0, `Historical fingerprints suppressed or failed to detect the generated ${rule} canary`);
      requireCondition(matches.every(finding => typeof finding.Fingerprint === 'string'
        && !fingerprints.includes(finding.Fingerprint)), 'A new canary unexpectedly reused a historical fingerprint');
    }
    console.log(`Gitleaks ${VERSION}: all 3 generated canary rules detected in the frozen JSON path; ${REVIEWED_COUNT} exact historical fingerprints retained.`);
  } finally {
    // This path is created by this invocation, never supplied by the caller.
    await rm(ownedTemporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof CanaryFailure ? error.message : 'Reviewed-finding canary failed; scanner output and generated values were withheld.');
  process.exitCode = 1;
});
