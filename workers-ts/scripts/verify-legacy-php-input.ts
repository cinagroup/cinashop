/** Read-only input gate. No PHP, dependency scripts, hooks or legacy bundles run. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GitCheckoutContract { commit: string; tree: string; files: number; bytes: number }
export const LEGACY_PHP_CONTRACT: Readonly<GitCheckoutContract> = Object.freeze({
  commit: '8ed2a5b139f9170dd11b0dff91803f2fd59e40a5',
  tree: 'f5ad9067cdacf1f14202ff450e434be970388fbc', files: 14664, bytes: 313865557,
});
const repositoryRoot = resolve(import.meta.dirname, '../..');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
const gitEnvironment = { ...process.env };
for (const key of Object.keys(gitEnvironment)) if (key.startsWith('GIT_')) delete gitEnvironment[key];
Object.assign(gitEnvironment, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
function git(root: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-C', root, ...args], {
      input, env: gitEnvironment, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { throw Error(`Legacy PHP input: Git ${args[0]} failed; provide the complete fixed checkout.`); }
}
function requireEqual(actual: unknown, expected: unknown, reason: string) {
  if (actual !== expected) throw Error(`Legacy PHP input: ${reason}.`);
}
function safePath(root: string, name: string) {
  if (!name || name.includes('\\') || name.includes('\0') || isAbsolute(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))
    throw Error('Legacy PHP input: unsafe tree path.');
  const file = resolve(root, name);
  requireEqual(realpathSync(file), file, `symlink or missing source path ${name}`);
  return file;
}

/** Also used with small real Git repositories to exercise failure paths. The CLI
 * always supplies the immutable contract above, never caller-provided pins. */
export function verifyCompleteGitCheckout(input: string, contract: Readonly<GitCheckoutContract> = LEGACY_PHP_CONTRACT) {
  let root: string;
  try { root = realpathSync(input); } catch { throw Error('Legacy PHP input: checkout directory is missing.'); }
  try {
    if (!lstatSync(resolve(root, '.git')).isDirectory()) throw Error('not a Git directory');
  } catch { throw Error('Legacy PHP input: a real checkout with its own .git directory is required.'); }
  requireEqual(decode(git(root, ['rev-parse', '--show-toplevel'])).trim(), root, 'checkout root differs');
  requireEqual(decode(git(root, ['rev-parse', '--verify', 'HEAD'])).trim(), contract.commit, 'HEAD differs from the fixed commit');
  requireEqual(decode(git(root, ['rev-parse', '--verify', `${contract.commit}^{tree}`])).trim(), contract.tree, 'root tree differs');
  // Detect missing objects even when matching files happen to exist on disk.
  // Connectivity/type/size checks alone accept a corrupted same-size loose blob.
  // Full fsck also verifies object content hashes before any source consumer runs.
  git(root, ['fsck', '--full', '--strict', '--no-reflogs', contract.commit]);
  const listing = git(root, ['ls-tree', '-r', '-z', '--full-tree', contract.commit]);
  const rows = decode(listing).split('\0').filter(Boolean).map(row => {
    const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match) throw Error('Legacy PHP input: unexpected file mode or tree entry.');
    return { oid: match[2]!, file: match[3]! };
  });
  requireEqual(rows.length, contract.files, 'complete tree file count differs');
  const objects = decode(git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    rows.map(row => row.oid).join('\n') + '\n')).trimEnd().split('\n');
  requireEqual(objects.length, rows.length, 'object inventory differs');
  let bytes = 0;
  const expectedPaths = new Set(rows.map(row => row.file));
  for (const [index, row] of rows.entries()) {
    const file = safePath(root, row.file), stat = lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o111) throw Error(`Legacy PHP input: unexpected working file mode ${row.file}.`);
    const raw = readFileSync(file);
    requireEqual(objects[index], `${row.oid} blob ${raw.length}`, `missing or different object ${row.file}`);
    const oid = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
    requireEqual(oid, row.oid, `working bytes differ from fixed Git blob ${row.file}`);
    bytes += raw.length;
  }
  requireEqual(bytes, contract.bytes, 'complete tree byte count differs');
  function walk(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), name + '/');
      else if (!entry.isFile() || !expectedPaths.delete(name)) throw Error(`Legacy PHP input: extra or linked working file ${name}.`);
    }
  }
  walk(root);
  requireEqual(expectedPaths.size, 0, 'working tree is incomplete');
  requireEqual(decode(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])), '', 'index or working tree is dirty');
  return { root, commit: contract.commit, tree: contract.tree, files: rows.length, bytes,
    treeListingSha256: sha(listing), completeGitObjects: true, exactWorkingTree: true };
}

function readPinnedJson(file: string, expected: string): unknown {
  const raw = readFileSync(resolve(repositoryRoot, file));
  requireEqual(sha(raw), expected, `historical proof differs ${file}`);
  return JSON.parse(decode(raw));
}
export function verifyLegacyPhpInput(input: string) {
  const checkout = verifyCompleteGitCheckout(input);
  const hotwords = readPinnedJson('workers-ts/audit/uni-search-hotwords-source-binding-20261025.json',
    'b1de5a72518df149aef05448139951153cf0ea60f2776df1e49dac6d4c0824d2') as {
    PHP_ref: string; PHP_sources: Array<{ file: string; sha256: string; bytes: number; lines: number }>;
    PHP_evidence: Array<{ source: string; start: number; end: number; fragment: string; fragment_sha256: string }>;
  };
  requireEqual(hotwords.PHP_ref, LEGACY_PHP_CONTRACT.commit, 'hotwords source ref differs');
  requireEqual(hotwords.PHP_sources.length, 11, 'hotwords original source count differs');
  requireEqual(hotwords.PHP_evidence.length, 15, 'hotwords fragment count differs');
  for (const row of hotwords.PHP_sources) {
    // This is the real fixed-ref Git read used by the existing historical test.
    const raw = git(checkout.root, ['show', `${LEGACY_PHP_CONTRACT.commit}:${row.file}`]);
    requireEqual(sha(raw), row.sha256, `historical original digest differs ${row.file}`);
    requireEqual(raw.length, row.bytes, `historical original size differs ${row.file}`);
    requireEqual(decode(raw).split('\n').length - (raw.at(-1) === 10 ? 1 : 0), row.lines, `historical line count differs ${row.file}`);
  }
  for (const row of hotwords.PHP_evidence) {
    const file = row.source.replace(/^PHP-raw\//u, '');
    const raw = decode(git(checkout.root, ['show', `${LEGACY_PHP_CONTRACT.commit}:${file}`])).replace(/\r\n?/gu, '\n');
    const fragment = raw.split(/(?<=\n)/u).slice(row.start - 1, row.end).join('');
    requireEqual(fragment, row.fragment, `historical fragment differs ${file}:${row.start}`);
    requireEqual(sha(fragment), row.fragment_sha256, `historical fragment digest differs ${file}:${row.start}`);
  }
  const route = readPinnedJson('workers-ts/audit/legacy-route-authority.json',
    'd3d8a19b4791c63a860fbb87b0948fed2df0b8bd320a5d09d9e753efedd8ed14') as {
    files: Record<string, { sha256: string; lineCount: number }>;
  };
  requireEqual(Object.keys(route.files).length, 26, 'route authority count differs');
  for (const [name, row] of Object.entries(route.files)) {
    if (!name.startsWith('cinashop-php/')) throw Error('Legacy PHP input: route authority scope differs.');
    const raw = readFileSync(safePath(checkout.root, name.slice('cinashop-php/'.length)));
    requireEqual(sha(raw), row.sha256, `route authority digest differs ${name}`);
    requireEqual(decode(raw).split('\n').length, row.lineCount, `route authority line count differs ${name}`);
  }
  requireEqual(sha(readFileSync(safePath(checkout.root, 'public/install/crmeb.sql'))),
    '0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a', 'schema authority digest differs');
  return { formatVersion: 1, ...checkout, hotwordsOriginals: 11, hotwordsFragments: 15,
    routeAuthorityFiles: 26, schemaAuthorityMatched: true, rawGitWorktreeUnmodified: true,
    legacyCodeExecuted: false, uniManualCrLfDerivativeSupplied: false };
}

/** Create a new sibling link, or accept exactly the same existing target. Never
 * remove, adopt or rewrite another checkout, including a dangling symlink. */
export function exposeVerifiedSibling(checkout: string, sibling: string) {
  const target = realpathSync(checkout);
  try {
    const stat = lstatSync(sibling);
    if ((stat.isSymbolicLink() || stat.isDirectory()) && realpathSync(sibling) === target) return { created: false };
    throw Error('Legacy PHP input: sibling path is already occupied; preserve it and use an isolated workspace.');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    // lstat succeeds for a dangling symlink; realpath ENOENT must not replace it.
    try { lstatSync(sibling); } catch (absent) {
      if (absent instanceof Error && 'code' in absent && absent.code === 'ENOENT') {
        symlinkSync(target, sibling, 'dir'); return { created: true };
      }
      throw absent;
    }
    throw Error('Legacy PHP input: sibling link is dangling; preserve it and use an isolated workspace.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--input' || !args[1]
      || args.length > 3 || args.length === 3 && args[2] !== '--link-sibling')
      throw Error('Usage: verify-legacy-php-input.ts --input PATH [--link-sibling]');
    const input = resolve(args[1]), receipt = verifyLegacyPhpInput(input);
    let siblingLinkCreated = false;
    if (args[2] === '--link-sibling') {
      requireEqual(relative(repositoryRoot, input).replaceAll('\\', '/'), '.cache/legacy-php-input', 'CI input location differs');
      siblingLinkCreated = exposeVerifiedSibling(receipt.root, resolve(repositoryRoot, '../cinashop-php')).created;
    }
    console.log(JSON.stringify({ ...receipt, siblingLinkCreated }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Legacy PHP input verification failed.');
    process.exitCode = 1;
  }
}
