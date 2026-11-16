import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REF = '41f4d25ae1daab3067f5ea745d30cabd77c93b80';

/** Test source provisioning is separate from business HTTP execution. An
 * existing override is never removed. Without one, use the immutable object
 * already in this clone, fetching that exact commit from origin only when a
 * shallow clone lacks it. Never fetch or change the fixed legacy PHP input. */
export async function couponLegacyRuntimeSource() {
  const supplied = process.env.TEST_COUPON_LEGACY_WORKTREE;
  if (supplied) return { root: resolve(supplied), release: async () => {}, fetched: false, supplied: true };
  const workers = process.cwd();
  const git = (...args: string[]) => run('git', args, { cwd: workers, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const parent = await mkdtemp(join(tmpdir(), 'cinashop-coupon-legacy-'));
  const root = join(parent, 'worktree');
  let registered = false, fetched = false;
  const release = async () => {
    if (registered) {
      await git('worktree', 'remove', '--force', root);
      registered = false;
    }
    await rm(parent, { recursive: true, force: true });
  };
  try {
    try { await git('cat-file', '-e', `${REF}^{commit}`); }
    catch {
      await git('fetch', '--no-tags', '--depth=1', 'origin', REF);
      fetched = true;
      await git('cat-file', '-e', `${REF}^{commit}`);
    }
    await git('worktree', 'add', '--detach', root, REF);
    registered = true;
    await symlink(await realpath(join(workers, 'node_modules')), join(root, 'workers-ts/node_modules'), 'dir');
    return { root, release, fetched, supplied: false };
  } catch {
    await release();
    // Git output can include a credential-bearing remote URL. Keep failures
    // explicit without forwarding that output into test logs or artifacts.
    throw Error('Unable to prepare the fixed TypeScript coupon comparison checkout');
  }
}
