import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLocalFinanceCachePath } from '../scripts/local-finance-cache-path.mjs';

const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/run-local-finance-postgres.mjs');

describe('local PostgreSQL runner cache boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cinashop-finance-runner-cache-'));
  const bin = join(directory, 'bin'), hook = join(directory, 'block-native-launch.mjs');
  mkdirSync(bin);
  for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    writeFileSync(join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`), 'Native launch must be blocked');
  }
  const sentinel = 'CACHE_ADMISSION_NATIVE_COMMAND_BOUNDARY';
  writeFileSync(hook, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = () => { throw new Error('${sentinel}'); };
syncBuiltinESMExports();
`);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  function admission(cache: string | undefined) {
    const env = { ...process.env };
    delete env.TEST_FINANCE_LOCAL_CACHE_ROOT;
    if (cache !== undefined) env.TEST_FINANCE_LOCAL_CACHE_ROOT = cache;
    const result = spawnSync(process.execPath,
      ['--import', pathToFileURL(hook).href, script, '--schema-maintenance', bin, 'audit:unit-shard-1'],
      { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    return result.stderr;
  }
  it.each(['', 'relative-cache'])('rejects nonabsolute override %j before native commands', cache => {
    const error = admission(cache);
    expect(error).toContain('TEST_FINANCE_LOCAL_CACHE_ROOT must name an absolute directory');
    expect(error).not.toContain(sentinel);
  });
  it('admits an absolute local override up to the intercepted native command', () => {
    expect(admission(directory)).toContain(sentinel);
  });
  it('keeps the original checkout cache default and explicitly rejects a Windows shared checkout', () => {
    const error = admission(undefined);
    if (process.platform === 'win32' && root.startsWith('\\\\')) {
      expect(error).toContain('Windows PostgreSQL cache cannot use a UNC path');
      expect(error).not.toContain(sentinel);
    } else expect(error).toContain(sentinel);
  });
  it.each(['\\\\server\\share\\cache', '//server/share/cache', '\\\\?\\UNC\\server\\share\\cache'])
    ('rejects Windows UNC override %j before native commands', cache => {
      expect(() => resolveLocalFinanceCachePath(cache, win32.resolve('C:/cinashop/workers-ts'), 'win32'))
        .toThrow('Windows PostgreSQL cache cannot use a UNC path');
      if (process.platform === 'win32') {
        const error = admission(cache);
        expect(error).toContain('Windows PostgreSQL cache cannot use a UNC path');
        expect(error).not.toContain(sentinel);
      }
    });
  it('rejects drive-relative and current-drive-rooted Windows overrides', () => {
    expect(() => resolveLocalFinanceCachePath('C:finance-cache', win32.resolve('C:/cinashop/workers-ts'), 'win32'))
      .toThrow('TEST_FINANCE_LOCAL_CACHE_ROOT must name an absolute directory');
    expect(() => resolveLocalFinanceCachePath(win32.sep + 'finance-cache', win32.resolve('C:/cinashop/workers-ts'), 'win32'))
      .toThrow('absolute local drive directory on Windows');
    if (process.platform === 'win32') {
      expect(admission('C:finance-cache')).toContain('TEST_FINANCE_LOCAL_CACHE_ROOT must name an absolute directory');
      const error = admission(win32.sep + 'finance-cache');
      expect(error).toContain('absolute local drive directory on Windows');
      expect(error).not.toContain(sentinel);
    }
  });
});

describe('local PostgreSQL runner command boundary', () => {
  it.each(['product-purchase-admission', 'product-purchase-authors', 'purchase-physical-origin'])('admits exact %s native file before binary validation', name => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `test/${name}-postgres.test.ts`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });

  it.each(['purchase-physical-origin-installation', 'purchase-physical-origin-runtime-upgrade'])('admits the exact %s commissioning suite', name => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `test/${name}.test.ts`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('admits only the exact integral purchase-limits native file in schema-maintenance mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/integral-purchase-limits-postgres.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
    expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each(['test/integral-purchase-limits-postgres.test.ts.extra', 'test/integral-purchase-limits-postgres.other.ts'])
    ('rejects a malformed integral purchase-limits native spelling %s before native binary validation', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });
  it('admits ordinary short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:ordinary-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:ordinary-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:ordinary-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:ordinary-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:ordinary-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid ordinary short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact ordinary short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/ordinary-short-sku-postgres.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/ordinary-short-sku-postgres.test.ts.extra', 'test/ordinary-short-sku-postgres.other.ts'])(
    'rejects malformed ordinary short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits repurchase short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:repurchase-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:repurchase-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:repurchase-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:repurchase-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:repurchase-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid repurchase short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact repurchase short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/customer-order-repurchase-short-sku-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/customer-order-repurchase-short-sku-native.test.ts.extra', 'test/customer-order-repurchase-short-sku-native.other.ts'])(
    'rejects malformed repurchase short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits presale short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:presale-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:presale-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:presale-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:presale-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:presale-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid presale short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact presale short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/presale-short-sku-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/presale-short-sku-native.test.ts.extra', 'test/presale-short-sku-native.other.ts'])(
    'rejects malformed presale short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits newcomer short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:newcomer-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:newcomer-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:newcomer-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:newcomer-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:newcomer-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid newcomer short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact newcomer short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/newcomer-short-sku-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/newcomer-short-sku-native.test.ts.extra', 'test/newcomer-short-sku-native.other.ts'])(
    'rejects malformed newcomer short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits seckill short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:seckill-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:seckill-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:seckill-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:seckill-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:seckill-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid seckill short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact seckill short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/seckill-short-sku-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/seckill-short-sku-native.test.ts.extra', 'test/seckill-short-sku-native.other.ts'])(
    'rejects malformed seckill short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits bargain short-SKU in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:bargain-short-sku-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:bargain-short-sku-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:bargain-short-sku-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:bargain-short-sku-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:bargain-short-sku-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid bargain short-SKU Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact bargain short-SKU native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/bargain-short-sku-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/bargain-short-sku-native.test.ts.extra', 'test/bargain-short-sku-native.other.ts'])(
    'rejects malformed bargain short-SKU native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it('admits bargain participation cancellation in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:bargain-participation-cancel-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:bargain-participation-cancel-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:bargain-participation-cancel-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:bargain-participation-cancel-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:bargain-participation-cancel-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid bargain participation cancellation Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits PC bargain invitations in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:pc-bargain-invitations-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:pc-bargain-invitations-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:pc-bargain-invitations-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:pc-bargain-invitations-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:pc-bargain-invitations-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid PC bargain invitations Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits bargain friend-help in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:bargain-friend-help-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:bargain-friend-help-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:bargain-friend-help-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:bargain-friend-help-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:bargain-friend-help-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid bargain friend-help Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits only the exact bargain friend-help native file before binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/bargain-friend-help-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/bargain-friend-help-native.test.ts.extra', 'test/bargain-friend-help-native.other.ts'])(
    'rejects malformed bargain friend-help native spelling %s before filesystem setup', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
    });

  it.each(['test/bargain-admin-sku.test.ts', 'test/bargain-admin-sku-postgres.test.ts',
    'test/bargain-cart-binding-concurrency-postgres.test.ts'])(
    'admits reviewed mature bargain fixture %s through exact maintenance admission', path => {
      const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
    });

  it('admits physical purchase origin in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:purchase-physical-origin-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:purchase-physical-origin-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:purchase-physical-origin-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:purchase-physical-origin-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:purchase-physical-origin-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid physical purchase origin Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });

  it('admits product purchase admission in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:product-purchase-admission-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:product-purchase-admission-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:product-purchase-admission-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:product-purchase-admission-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:product-purchase-admission-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid product purchase admission Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });

  it('admits integral purchase limits in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:integral-purchase-limits-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([
    { args: ['unused-bin', 'audit:integral-purchase-limits-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:integral-purchase-limits-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:integral-purchase-limits-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:integral-purchase-limits-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid integral purchase limits Browser admission $args before filesystem setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });

  it('admits the exact integral purchase-origin native file in schema-maintenance mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/integral-purchase-origin-postgres.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it('admits integral origin in-app acceptance without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:integral-purchase-origin-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:integral-purchase-origin-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:integral-purchase-origin-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:integral-purchase-origin-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:integral-purchase-origin-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid integral origin Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });

  it('admits only the exact customer order-repurchase native file in schema-maintenance mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/customer-order-repurchase-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/customer-order-repurchase-native.test.ts.extra', 'test/customer-order-repurchase-native.other.ts'])('rejects a malformed order-repurchase native spelling %s', path => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Only explicit unit test paths');
  });

  it('admits only the exact customer refund-quantities native file in schema-maintenance mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/customer-refund-quantities-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/customer-refund-quantities-native.test.ts.extra', 'test/customer-refund-quantities-native.other.ts'])('rejects a malformed refund-quantities native spelling %s', path => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Only explicit unit test paths');
  });
  it('admits only the exact new customer request-image native file in schema-maintenance mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'test/customer-refund-request-images-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('allowlist');
  });
  it.each(['test/customer-refund-request-images-native.test.ts.extra', 'test/customer-refund-request-images-native.other.ts'])('rejects a malformed request-image native spelling %s', path => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', path],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Only explicit unit test paths');
  });
  it('admits the exact customer order repurchase in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:customer-order-repurchase-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:customer-order-repurchase-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:customer-order-repurchase-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:customer-order-repurchase-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:customer-order-repurchase-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid customer order repurchase Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact refund application evidence in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:refund-application-evidence-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:refund-application-evidence-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:refund-application-evidence-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:refund-application-evidence-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:refund-application-evidence-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid refund application evidence Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier refund application review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-refund-application-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-refund-application-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-refund-application-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-refund-application-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-refund-application-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier refund application review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order virtual delivery review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-virtual-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-virtual-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-virtual-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-order-virtual-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-virtual-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order virtual delivery review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order gift identity in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-gift-identity-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-gift-identity-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-gift-identity-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-order-gift-identity-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-gift-identity-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order gift identity Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order promotions review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-promotions-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-promotions-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-promotions-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-order-promotions-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-promotions-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order promotions review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order invoice review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-invoice-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-invoice-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-invoice-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-order-invoice-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-invoice-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order invoice review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'review', 'unused-bin', 'audit:supplier-order-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier order filters in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-filters-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-filters-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-filters-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'filters', 'unused-bin', 'audit:supplier-order-filters-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-filters-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier order filters Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier distribution in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-distribution-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-distribution-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-distribution-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'distribution', 'unused-bin', 'audit:supplier-order-distribution-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-distribution-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier distribution Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier tracking in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-order-tracking-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-order-tracking-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-order-tracking-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'tracking', 'unused-bin', 'audit:supplier-order-tracking-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-order-tracking-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier tracking Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain(error);
  });
  it('admits the exact Supplier bill in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-bill-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-bill-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-bill-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-bill-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-bill-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier bill Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier bill export in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-bill-export-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-bill-export-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-bill-export-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-bill-export-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-bill-export-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier bill export Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier flow in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-flow-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-flow-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-flow-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-flow-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-flow-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier flow Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier extract in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-extract-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-extract-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-extract-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-extract-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-extract-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier extract Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier extract application in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-extract-application-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-extract-application-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-extract-application-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-extract-application-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-extract-application-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier extract application Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier finance accounts in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-finance-accounts-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-finance-accounts-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-finance-accounts-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-finance-accounts-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-finance-accounts-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier finance accounts Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier extract media in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-extract-media-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-extract-media-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-extract-media-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-extract-media-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-extract-media-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier extract media Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier extract application media in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-extract-application-media-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-extract-application-media-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-extract-application-media-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-extract-application-media-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-extract-application-media-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier extract application media Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product review in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-review-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-review-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-review-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-review-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-review-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product review Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product detail in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-detail-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-detail-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-detail-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-detail-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-detail-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product detail Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product schedule in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-schedule-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-schedule-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-schedule-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-schedule-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-schedule-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product schedule Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product brand in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-brand-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-brand-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-brand-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-brand-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-brand-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product brand Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product assurances in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-ensures-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-ensures-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-ensures-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-ensures-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-ensures-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product assurances Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product parameters in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-parameters-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-parameters-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-parameters-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-parameters-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-parameters-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product parameters Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product system form in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-system-form-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-system-form-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-system-form-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-system-form-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-system-form-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product system form Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier SKU batch in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-sku-batch-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-sku-batch-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-sku-batch-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-sku-batch-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-sku-batch-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier SKU batch Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier SKU batch native file with literal cases before native binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'seven fields', 'unused-bin', 'test/supplier-sku-batch-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('admits the exact Supplier product recommendation image in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-product-recommend-image-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-product-recommend-image-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-product-recommend-image-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-product-recommend-image-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-product-recommend-image-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product recommendation image Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product recommendation image native file with literal cases before native binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'recommendation image', 'unused-bin', 'test/supplier-product-recommend-image-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('admits the exact Supplier product unit directory in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-product-unit-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-product-unit-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-product-unit-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-product-unit-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-product-unit-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product unit directory Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product unit directory native file with literal cases before native binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'unit directory', 'unused-bin', 'test/supplier-product-unit-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('admits the exact Supplier product inline shipping editor in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-product-shipping-editor-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-product-shipping-editor-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-product-shipping-editor-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-product-shipping-editor-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-product-shipping-editor-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product inline shipping editor Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product inline shipping editor native file with literal cases before native binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'inline shipping editor', 'unused-bin', 'test/supplier-product-shipping-editor-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('admits the exact Supplier product inline specification editor in-app mode without external browser settings', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-product-rule-inline-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER'); expect(result.stderr).not.toContain('Only explicit');
  });
  it.each([
    { args: ['unused-bin', 'audit:supplier-product-rule-inline-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:supplier-product-rule-inline-browser', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', '--case', 'bill', 'unused-bin', 'audit:supplier-product-rule-inline-browser'], error: 'Literal cases apply only to explicit test files' },
    { args: ['--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-product-rule-inline-browser'], error: 'Verbose reporting applies only to explicit native test files' },
  ])('rejects invalid Supplier product inline specification editor Browser admission $args', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error); expect(result.stderr).not.toContain('ENOENT');
  });
  it('admits the exact Supplier product inline specification editor native file with literal cases before native binary validation', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'inline specification editor', 'unused-bin', 'test/supplier-product-rule-inline-native.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it.each([1, 2])('admits only the complete native shard %i maintenance alias', shard => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `audit:unit-shard-${shard}`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Only explicit');
  });
  it('admits the explicit in-app Browser host without external Playwright settings',()=>{
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin','audit:admin-offline-browser'],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT');expect(result.stderr).not.toContain('TEST_BROWSER');
  });
  it('admits the explicit Supplier settlement in-app host without external browser tooling', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-refund-settlement-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('TEST_BROWSER');
    expect(result.stderr).not.toContain('Only explicit'); expect(result.stderr).not.toContain('Schema maintenance accepts only');
  });
  it('rejects Supplier settlement Browser mode without explicit owned schema maintenance', () => {
    const result = spawnSync(process.execPath, [script, 'unused-bin', 'audit:supplier-refund-settlement-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
  });
  it('rejects mixing Supplier settlement Browser mode with a second test or mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', 'audit:supplier-refund-settlement-browser', 'test/price.test.ts'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Only explicit unit test paths are accepted'); expect(result.stderr).not.toContain('ENOENT');
  });
  it('rejects literal case filtering for interactive Supplier settlement Browser mode', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--case', 'joins Customer', 'unused-bin', 'audit:supplier-refund-settlement-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Literal cases apply only to explicit test files'); expect(result.stderr).not.toContain('ENOENT');
  });
  it('rejects native verbose mode for interactive Supplier settlement Browser acceptance', () => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', '--verbose-tests', 'unused-bin', 'audit:supplier-refund-settlement-browser'],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Verbose reporting applies only to explicit native test files'); expect(result.stderr).not.toContain('ENOENT');
  });
  it.each(['bargain-cart-participation-migration', 'bargain-supplier-visibility-concurrency-postgres', 'bargain-visibility-writers-concurrency-postgres', 'shipping-lifecycle-rules', 'store-order-create-scenario-postgres', 'checkout-pricing-fixture', 'checkout-marketing-scenarios-postgres', 'brokerage-paid-business-transactions', 'checkout-confirmation', 'checkout-confirmation-postgres', 'checkout-confirmation-rules', 'pc-checkout-form-postgres', 'checkout-pricing-service-runtime', 'checkout-pricing-config-authority', 'admin-config-batch-postgres', 'checkout-pricing-lock-registration', 'brokerage-paid-runtime-permissions', 'checkout-pricing-lock', 'offline-runtime-permissions', 'offline-order-registration', 'offline-order-installation', 'offline-order-payment-query', 'offline-order-query-recovery', 'offline-order-payment-dispatch', 'offline-order-payment-workerd', 'offline-order-http', 'admin-offline-order-read'])('explicitly admits %s before validating the test binary', name => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `test/${name}.test.ts`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only'); expect(result.stderr).toContain('ENOENT');
  });
  it.each([
    { args: ['--schema-maintenance', 'audit:admin-refund-browser'] }, { args: ['--schema-maintenance', 'audit:customer-order-browser'] },
    { args: ['--schema-maintenance', 'audit:admin-order-browser'] },
  ])('rejects browser output inside the repository before opening a database: $args', ({ args }) => {
    const command = args[0] === '--schema-maintenance'
      ? [script, '--schema-maintenance', 'unused-bin', args[1]] : [script, 'unused-bin', args[0]];
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: resolve(root, 'package.json'), TEST_BROWSER_EXECUTABLE: process.execPath, TEST_BROWSER_OUTPUT_DIR: root } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Browser output must be outside the repository');
  });
  it.each(['invoice-evidence-migration','refund-split-migration','refund-runtime-permissions','refund-read-generations','staff-refund-history','customer-order-generations','customer-order-deletion','admin-order-generations','supplier-order-generations','supplier-split-order-reads','supplier-operational-reads','checkout-member-lifecycle','order-member-economize','offline-order-quote','offline-order-admission','offline-order-balance','offline-order-payment-selection','offline-order-external-payment','offline-order-callback-pipeline','payment-reconciliation-membership','checkout-coupon-item-authority','checkout-coupon-relations-authority'])('explicitly admits the %s suite to maintenance mode before validating its binary', name => {
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin',`test/${name}.test.ts`],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only');
    expect(result.stderr).toContain('ENOENT');
  });
  it.each([
    { args: [], error: 'Usage:' },
    { args: ['unused-bin', 'audit:unit-shard-1'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-3'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-1', 'audit:unit-shard-2'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-1', '--testNamePattern=pass'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-2', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', '--config=production'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', 'test/../admin-refund-decision.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', 'test/nonexistent-local-finance-probe.test.ts'], error: 'Test does not exist:' },
    { args: ['--schema-maintenance','unused-bin','test/admin-refund-decision.test.ts'], error: 'Schema maintenance accepts only' },
    { args: ['unused-bin','--schema-maintenance','test/admin-refund-operation-migration.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin'], error: 'Usage:' },
    { args: ['unused-bin','audit:orm'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:orm','test/admin-refund-operation-migration.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:production'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-refund-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-refund-browser','test/admin-refund-operation-http.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-refund-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-refund-browser','test/admin-refund-operation-http.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:customer-order-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:customer-order-browser','test/customer-order-deletion.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:customer-order-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
    { args: ['unused-bin','audit:admin-order-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-offline-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-offline-browser','test/admin-offline-order-read.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-order-browser','test/admin-order-generations.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-order-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
  ])('rejects $args before runtime, port or cluster setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error);
  });
  it.each(['admin-legacy-system-log','admin-legacy-system-log-native','supplier-product-catalog',
    'admin-product-label','admin-product-label-http','admin-product-label-native','admin-product-label-permission',
    'public-product-label-icons','supplier-product-category-http','supplier-product-category-concurrency-postgres',
    'supplier-product-category-permission','legacy-share-private-scan','legacy-share-private-scan-native','wechat-follow-poster','wechat-follow-poster-native',
    'legacy-share-code','legacy-share-code-native',
    'admin-product-brand','admin-product-brand-http','admin-product-brand-native','admin-product-brand-permission',
    'supplier-product-batch-http','supplier-product-batch-concurrency-postgres','supplier-product-batch-permission',
    'legacy-share-registered-http','user-spread-poster-data','user-spread-poster-data-native','cart-computation-http',
    'admin-refund-operation-http','runtime-business-login','assisted-purchase-runtime-postgres','assisted-purchase-flow-postgres','admin-user-list-postgres','admin-runtime-login','presale-runtime-permissions','membership-pricing-policy','purchase-quota-refund-receipt-postgres','purchase-quota-payment-ledger-postgres','unpaid-mixed-order-cancellation-postgres','purchase-origin-evidence-postgres','purchase-origin-installation',
    'purchase-cancellation-evidence-postgres',
    'purchase-cancellation-installation','customer-cashier-abandon-postgres','customer-work-cash-refund-postgres',
    'finance-fixture-advisory-isolation','checkout-line-finance','checkout-coupon-template-authority','checkout-membership-boundary',
    'checkout-brokerage-boundary','checkout-brokerage-authority','checkout-brokerage-paid-authority','checkout-member-evidence',
    'checkout-catalog-management','checkout-mobile-product-concurrency','checkout-out-product-concurrency','checkout-sku-lifecycle-concurrency',
    'level-pricing-activation','pc-coupon-wallet-postgres','product-price-truncation','out-stock-candidate-boundary'])('admits the reviewed %s maintenance suite before binary validation',name=>{
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin',`test/${name}.test.ts`],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only');expect(result.stderr).toContain('ENOENT');
  });
});

describe('explicit category, Supplier label and employee isolated maintenance admission', () => {
  it.each(['admin-product-category-permission', 'admin-product-category', 'admin-product-category-http', 'admin-product-category-native', 'supplier-product-label-http', 'supplier-product-label-binding-http', 'supplier-product-label-native', 'division-staff-http', 'division-staff-method-http', 'division-staff-invite', 'division-staff-postgres'])('admits complete reviewed %s files before binary validation', name => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `test/${name}.test.ts`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only'); expect(result.stderr).toContain('ENOENT');
  });
});
