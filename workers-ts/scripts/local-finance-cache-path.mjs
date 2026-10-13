/** Pure path admission shared by the actual local PostgreSQL runner and its
 * host-independent Windows policy assertions. No filesystem/native operations
 * or CLI/environment platform override. Runtime callers use the current host. */
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

export function assertLocalFinanceCachePath(path, platform = process.platform) {
  if (platform !== 'win32') return;
  assert.ok(!path.startsWith('\\\\') && !path.startsWith('//'),
    'Windows PostgreSQL cache cannot use a UNC path; set TEST_FINANCE_LOCAL_CACHE_ROOT to an absolute local drive directory');
  assert.match(path, /^[a-z]:[\\/]/i,
    'TEST_FINANCE_LOCAL_CACHE_ROOT must name an absolute local drive directory on Windows');
}

export function resolveLocalFinanceCachePath(cacheOverride, workerRoot, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix;
  assert.ok(cacheOverride === undefined || (cacheOverride.length > 0 && paths.isAbsolute(cacheOverride)),
    'TEST_FINANCE_LOCAL_CACHE_ROOT must name an absolute directory');
  if (cacheOverride !== undefined) assertLocalFinanceCachePath(cacheOverride, platform);
  const cacheCandidate = paths.resolve(cacheOverride ?? paths.resolve(workerRoot, '../.cache'));
  assertLocalFinanceCachePath(cacheCandidate, platform);
  return cacheCandidate;
}
