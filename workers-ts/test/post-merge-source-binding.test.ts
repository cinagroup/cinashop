import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { readMembershipContinuityHistoricalFile as readFileSync } from './helpers/membershipContractSourceContinuity';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POST_MERGE_SOURCE_PROOF_FILE, POST_MERGE_SOURCE_PROOF_SHA, postMergeSourceBinding as proof,
  projectPostMergeSource, readPostMergeHistoricalSource } from './helpers/postMergeSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('complete post-merge source continuity before immutable historical readers', () => {
  it('pins the complete proof and only the four reviewed source images', () => {
    expect(sha(readFileSync(resolve(root, POST_MERGE_SOURCE_PROOF_FILE)))).toBe(POST_MERGE_SOURCE_PROOF_SHA);
    expect(proof.sources.map(row => row.file)).toEqual([
      'view/uniapp-ts/package.json', 'view/uniapp-ts/src/pages.json', 'workers-ts/src/routes/v1/index.ts', 'workers-ts/package.json',
    ]);
    expect(proof.sources.map(row => row.inverse_edits.length)).toEqual([5, 1, 3, 1]);
    expect(proof.reviewed_history.map(row => row.commit)).toEqual([
      'b874c56accd2bfc12c13c3c2cd2652736df07d5e', 'a8a57da7ceda6957baca2e810dfe3ef7cf01fcdc',
      'fc7d61e369a0f7bed5b1b6a55731a178e9638d46', 'fdefefe73fe68e87cb7e810b7a81e5d5b55329a8',
      '26a43cc7142c3cfde10fa559db25c85f809e8acc', '20f180ae24a88f40fe6d0a35c26d2cae0204ca01',
    ]);
  });
  for (const row of proof.sources) {
    it(`verifies the full actual current source and derives the full original merge: ${row.file}`, () => {
      const actual = readFileSync(resolve(root, row.file), 'utf8');
      expect(actual).toBe(row.current.raw_utf8);
      expect(sha(actual)).toBe(row.current.sha256);
      const before = projectPostMergeSource(row.file, actual);
      expect(before).toBe(row.predecessor.raw_utf8);
      expect(sha(before)).toBe(row.predecessor.sha256);
    });
    it(`supports actual string, URL and byte-path reads with text and Buffer results: ${row.file}`, () => {
      const file = resolve(root, row.file);
      for (const path of [file, pathToFileURL(file), Buffer.from(file)]) {
        expect(readPostMergeHistoricalSource(path, 'utf8')).toBe(row.predecessor.raw_utf8);
        expect(readPostMergeHistoricalSource(path)).toEqual(Buffer.from(row.predecessor.raw_utf8));
      }
    });
    it(`rejects a changed suffix, prefix and old-image fallback: ${row.file}`, () => {
      for (const changed of [row.current.raw_utf8 + '\n// drift\n', '// drift\n' + row.current.raw_utf8, row.predecessor.raw_utf8])
        expect(() => projectPostMergeSource(row.file, changed)).toThrow('Post-merge current source differs');
    });
  }
  it('retains all three existing immutable proof files byte-for-byte', () => {
    for (const row of proof.unchanged_proofs) {
      const actual = readFileSync(resolve(root, row.file));
      expect(actual.length).toBe(row.bytes); expect(sha(actual)).toBe(row.sha256);
    }
  });
  it('changes only the exact import line in the prior PHP-input reader', () => {
    const row = proof.legacy_import, lines = readFileSync(resolve(root, row.file), 'utf8').match(/[^\n]*\n|[^\n]+$/g)!;
    expect(lines[row.line]).toBe(row.after_import + '\n');
    lines[row.line] = row.before_import + '\n';
    expect(lines.join('')).toBe(row.before.raw_utf8);
    expect(sha(lines.join(''))).toBe(row.before.sha256);
  });
  it('leaves unrelated sources and file-descriptor reads on the real filesystem', () => {
    const file = resolve(root, 'workers-ts/tsconfig.json');
    expect(readPostMergeHistoricalSource(file)).toEqual(readFileSync(file));
    expect(projectPostMergeSource('unrelated.ts', 'real bytes')).toBe('real bytes');
    const fd = openSync(resolve(root, proof.sources[0]!.file), 'r');
    try { expect(readPostMergeHistoricalSource(fd, 'utf8')).toBe(proof.sources[0]!.current.raw_utf8); }
    finally { closeSync(fd); }
    expect(() => readPostMergeHistoricalSource(resolve(root, '.missing-post-merge-source'))).toThrow();
  });
  it.each(['current', 'predecessor', 'edit', 'scope', 'origin', 'history', 'import'])(
    'rejects a forged %s contract rather than accepting a replacement proof', kind => {
      const changed = structuredClone(proof), row = changed.sources[0]!;
      if (kind === 'current') row.current.raw_utf8 += '\n';
      if (kind === 'predecessor') row.predecessor.sha256 = '0'.repeat(64);
      if (kind === 'edit') row.inverse_edits[0]!.start++;
      if (kind === 'scope') row.file += '.other';
      if (kind === 'origin') row.current.origins[0] = '0'.repeat(40);
      if (kind === 'history') changed.reviewed_history.pop();
      if (kind === 'import') changed.legacy_import.line++;
      expect(() => projectPostMergeSource(proof.sources[0]!.file, proof.sources[0]!.current.raw_utf8, changed))
        .toThrow('Post-merge complete source proof differs');
    });
});
