import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import {checkpointMergePredecessorExecFileSync as execFileSync} from './helpers/migrationMergeSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchHotwordsSourceBinding as proof, reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
const root = resolve(import.meta.dirname, '../..');
const read = (f: string) => readFileSync(resolve(root, f), 'utf8').replace(/\r\n?/gu, '\n');
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

describe('search hotwords exact incremental evidence', () => {
  for (const row of proof.sources) {
    it(`binds the complete predecessor and current source: ${row.file}`, () => {
      expect(sha(read(row.file))).toBe(row.after_sha256);
      expect(sha(reverseSearchHotwordsSource(row.file, read(row.file)))).toBe(row.before_sha256);
    });
    it(`rejects an unreviewed current suffix: ${row.file}`, () => {
      expect(() => reverseSearchHotwordsSource(row.file, read(row.file) + '\n// drift\n')).toThrow();
    });
    it(`rejects a forged predecessor: ${row.file}`, () => {
      const changed = structuredClone(proof); changed.sources.find(r => r.file === row.file)!.before_sha256 = '0'.repeat(64);
      expect(() => reverseSearchHotwordsSource(row.file, read(row.file), changed)).toThrow();
    });
  }
  for (const row of proof.full_additions) it(`pins complete new source: ${row.file}`, () => expect(sha(read(row.file))).toBe(row.sha256));
  for (const [file, expected] of Object.entries(proof.observed_unchanged)) it(`retains existing business source: ${file}`, () => expect(sha(readFileSync(resolve(root, file)))).toBe(expected));
  for (const [file, expected] of Object.entries(proof.frozen_predecessor_evidence)) it(`retains frozen evidence/helper/CI: ${file}`, () => expect(sha(readFileSync(resolve(root, file)))).toBe(expected));
  for (const row of proof.PHP_sources) it(`verifies fixed PHP original bytes: ${row.file}`, () => {
    const raw = execFileSync('git', ['show', `${proof.PHP_ref}:${row.file}`], {cwd: resolve(root, '../cinashop-php'), maxBuffer: 4 * 1024 * 1024});
    expect(sha(raw)).toBe(row.sha256); expect(raw.length).toBe(row.bytes);
    expect(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw).split('\n').length - (raw.at(-1) === 10 ? 1 : 0)).toBe(row.lines);
  });
  for (const row of proof.PHP_evidence) it(`retains exact PHP behavior fragment: ${row.source}:${row.start}`, () => {
    const file = row.source.replace(/^PHP-raw\//u, '');
    const raw = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(execFileSync('git', ['show', `${proof.PHP_ref}:${file}`], {cwd: resolve(root, '../cinashop-php'), maxBuffer: 4 * 1024 * 1024})).replace(/\r\n?/gu, '\n');
    const slice = raw.split(/(?<=\n)/u).slice(row.start - 1, row.end).join('');
    expect(slice).toBe(row.fragment); expect(sha(slice)).toBe(row.fragment_sha256);
  });
  it('registers both runtime suites in the existing toolchain/CI path and retains the existing API inventory', () => {
    const scripts = JSON.parse(read('view/uniapp-ts/package.json')).scripts;
    expect(scripts['test:toolchain']).toContain('scripts/search-hotwords-data-runtime.test.cjs scripts/search-hotwords-page-runtime.test.cjs');
    expect(read('.github/workflows/workers-runtime-linux.yml')).toContain('npm run test:toolchain');
    expect(read('workers-ts/package.json')).toContain('vitest run');
    expect(proof.boundaries.identity).toContain('guest uid0');
    expect(proof.boundaries.scope).toContain('still open');
    expect(reverseSearchHotwordsSource('unrelated.ts', 'unchanged')).toBe('unchanged');
  });
});
