import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertLegacyAdminReferenceSnapshot, legacyAdminReferenceRoot } from './helpers/legacyAdminReference';

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function copy() {
  const base = mkdtempSync(join(tmpdir(), 'cinashop-legacy-admin-reference-')); owned.push(base);
  cpSync(resolve(import.meta.dirname, 'fixtures/php-admin-source'), base, { recursive: true }); return base;
}
it('uses the same pinned genuine PHP-era request, API and component inputs without a sibling checkout', () => {
  const root = legacyAdminReferenceRoot();
  expect(root).toBe(resolve(import.meta.dirname, 'fixtures/php-admin-source/src'));
  const manifest = JSON.parse(readFileSync(join(dirname(root), 'manifest.json'), 'utf8'));
  expect(manifest.source_commit).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
  expect(manifest.files).toHaveLength(11);
  expect(assertLegacyAdminReferenceSnapshot(copy())).not.toBe(root);
});
it('refuses changed request behavior instead of silently testing an altered reference', () => {
  const base = copy(), file = join(base, 'src/plugins/request/index.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace('request', 'unsafe_request'));
  expect(() => assertLegacyAdminReferenceSnapshot(base)).toThrow('source differs');
});
it.each(['missing', 'extra', 'symlink'] as const)('refuses %s source inventory before executing old consumers', kind => {
  const base = copy(), file = join(base, 'src/api/product.js');
  if (kind === 'extra') writeFileSync(join(base, 'src/unreviewed.js'), 'export default {};');
  else { rmSync(file); if (kind === 'symlink') symlinkSync(join(base, 'src/api/common.js'), file); }
  expect(() => assertLegacyAdminReferenceSnapshot(base)).toThrow(kind === 'symlink' ? 'symbolic links' : 'inventory differs');
});
it('refuses an edited manifest even when its replacement hashes match changed files', () => {
  const base = copy(), file = join(base, 'manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.source_commit = '0'.repeat(40); writeFileSync(file, JSON.stringify(manifest));
  expect(() => assertLegacyAdminReferenceSnapshot(base)).toThrow('manifest differs');
});
it('refuses a missing snapshot instead of fetching or finding a different local checkout', () => {
  const base = copy(); rmSync(join(base, 'manifest.json'));
  expect(() => assertLegacyAdminReferenceSnapshot(base)).toThrow();
});
