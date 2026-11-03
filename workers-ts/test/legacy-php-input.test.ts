import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { exposeVerifiedSibling, LEGACY_PHP_CONTRACT, verifyCompleteGitCheckout, verifyLegacyPhpInput } from '../scripts/verify-legacy-php-input';

const temporary = mkdtempSync(join(tmpdir(), 'legacy-php-input-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
function fixture() {
  const root = mkdtempSync(join(temporary, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Input fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Input fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'route'));
  writeFileSync(join(root, 'route/api.php'), '<?php\n// fixed fixture\n');
  writeFileSync(join(root, 'pages.json'), '{\r\n  "pages": []\r\n}\r\n');
  git('add', '--all'); git('commit', '--quiet', '-m', 'Fixed test input');
  const contract = { commit: git('rev-parse', 'HEAD').trim(), tree: git('rev-parse', 'HEAD^{tree}').trim(),
    files: 2, bytes: readFileSync(join(root, 'route/api.php')).length + readFileSync(join(root, 'pages.json')).length };
  return { root, git, contract };
}

describe('complete fixed legacy PHP input gate with real Git objects', () => {
  it('verifies every object and working byte, retaining the original line endings', () => {
    const { root, contract } = fixture();
    const before = readFileSync(join(root, 'pages.json'));
    expect(verifyCompleteGitCheckout(root, contract)).toMatchObject({ ...contract, completeGitObjects: true, exactWorkingTree: true });
    expect(readFileSync(join(root, 'pages.json'))).toEqual(before);
  });
  it('rejects a missing checkout and a source-only archive without Git', () => {
    expect(() => verifyLegacyPhpInput(join(temporary, 'missing'))).toThrow('checkout directory is missing');
    const archive = mkdtempSync(join(temporary, 'archive-'));
    writeFileSync(join(archive, 'api.php'), '<?php\n');
    expect(() => verifyLegacyPhpInput(archive)).toThrow();
  });
  it('keeps the CLI contract fixed and refuses a different genuine commit', () => {
    const { root } = fixture();
    expect(LEGACY_PHP_CONTRACT.commit).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(() => verifyLegacyPhpInput(root)).toThrow('HEAD differs from the fixed commit');
  });
  it('rejects an absent fixed object even when the source file remains present', () => {
    const { root, git, contract } = fixture();
    const oid = git('rev-parse', 'HEAD:route/api.php').trim();
    rmSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    expect(() => verifyCompleteGitCheckout(root, contract)).toThrow('provide the complete fixed checkout');
  });
  it('rejects a same-size corrupted object while its correctly hashed working file remains unchanged', () => {
    const { root, git, contract } = fixture();
    const oid = git('rev-parse', 'HEAD:route/api.php').trim();
    const path = join(root, '.git/objects', oid.slice(0, 2), oid.slice(2));
    const object = inflateSync(readFileSync(path)), before = readFileSync(join(root, 'route/api.php'));
    object[object.length - 2] = object[object.length - 2]! ^ 1;
    chmodSync(path, 0o600); // Only this newly created, owned fixture object.
    writeFileSync(path, deflateSync(object));
    expect(git('fsck', '--connectivity-only', '--no-reflogs', contract.commit)).toBe('');
    expect(git('cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--batch-all-objects').split('\n'))
      .toContain(`${oid} blob ${before.length}`);
    expect(readFileSync(join(root, 'route/api.php'))).toEqual(before);
    expect(() => verifyCompleteGitCheckout(root, contract)).toThrow('Git fsck failed');
  });
  it.each(['changed bytes', 'different line endings', 'missing file', 'extra ignored file', 'linked file', 'staged-only change'] as const)
  ('rejects incomplete or changed input: %s', kind => {
    const { root, git, contract } = fixture();
    if (kind === 'changed bytes') writeFileSync(join(root, 'route/api.php'), '<?php\n// drift\n');
    if (kind === 'different line endings') writeFileSync(join(root, 'pages.json'), readFileSync(join(root, 'pages.json'), 'utf8').replaceAll('\r\n', '\n'));
    if (kind === 'missing file') rmSync(join(root, 'route/api.php'));
    if (kind === 'extra ignored file') {
      writeFileSync(join(root, '.git/info/exclude'), 'ignored-extra\n'); writeFileSync(join(root, 'ignored-extra'), 'unreviewed');
    }
    if (kind === 'linked file') { rmSync(join(root, 'route/api.php')); symlinkSync('../pages.json', join(root, 'route/api.php')); }
    if (kind === 'staged-only change') {
      const before = readFileSync(join(root, 'route/api.php'));
      writeFileSync(join(root, 'route/api.php'), '<?php\n// staged drift\n'); git('add', 'route/api.php');
      writeFileSync(join(root, 'route/api.php'), before);
    }
    expect(() => verifyCompleteGitCheckout(root, contract)).toThrow();
  });
  it('creates a new sibling link and accepts only that same target on a repeated call', () => {
    const { root } = fixture(), sibling = join(temporary, 'new-sibling');
    expect(exposeVerifiedSibling(root, sibling)).toEqual({ created: true });
    expect(exposeVerifiedSibling(root, sibling)).toEqual({ created: false });
  });
  it('preserves a different existing checkout and a dangling sibling link', () => {
    const { root } = fixture(), occupied = mkdtempSync(join(temporary, 'occupied-'));
    const marker = join(occupied, 'local-work'); writeFileSync(marker, 'preserve');
    expect(() => exposeVerifiedSibling(root, occupied)).toThrow('already occupied');
    expect(readFileSync(marker, 'utf8')).toBe('preserve');
    const dangling = join(temporary, 'dangling'); symlinkSync(join(temporary, 'does-not-exist'), dangling);
    expect(() => exposeVerifiedSibling(root, dangling)).toThrow('dangling');
  });
});
