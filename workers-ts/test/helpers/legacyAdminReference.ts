import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const reference = resolve(import.meta.dirname, '../fixtures/php-admin-source');
export const LEGACY_ADMIN_REFERENCE_MANIFEST_SHA256 = '37f92dc583760178baee821a3a079ffe105b74fe5ebe5de37add79c3605c51e8';
interface ReferenceManifest {
  schema: number; source_repository: string; source_commit: string;
  files: Array<{ path: string; source: string; bytes: number; sha256: string; git_blob: string }>;
}
/** Execute the genuine, reviewed PHP-era SPA inputs in every environment.
 * The manifest and exact file inventory are pinned, with no sibling-directory
 * fallback that could make local and CI tests exercise different consumers. */
export function assertLegacyAdminReferenceSnapshot(base = reference): string {
  const bytes = readFileSync(join(base, 'manifest.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== LEGACY_ADMIN_REFERENCE_MANIFEST_SHA256)
    throw Error('Legacy Admin reference manifest differs from the reviewed source snapshot');
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ReferenceManifest;
  const root = join(base, 'src'), actual: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Legacy Admin reference cannot contain symbolic links');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) actual.push(relative(root, file).split(sep).join('/'));
      else throw Error('Legacy Admin reference requires regular source files');
    }
  }
  visit(root);
  const expected = manifest.files.map(file => file.path).sort();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw Error('Legacy Admin reference source inventory differs');
  for (const entry of manifest.files) {
    const file = join(root, entry.path), stat = lstatSync(file), source = readFileSync(file);
    if (!stat.isFile() || stat.size !== entry.bytes || createHash('sha256').update(source).digest('hex') !== entry.sha256)
      throw Error(`Legacy Admin reference source differs: ${entry.path}`);
  }
  return root;
}
export const legacyAdminReferenceRoot = () => assertLegacyAdminReferenceSnapshot();
