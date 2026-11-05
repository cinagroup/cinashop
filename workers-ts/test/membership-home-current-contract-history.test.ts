import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const blob = (value: string | Uint8Array) => createHash('sha1')
  .update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, 'fixtures/membership-home-current-contract-history-20261104.json'));
const PIN = '8794e0649a8406f309f504ba3aa16c6e1de0f85618703bf959deca73ef05ca17';
if (sha(raw) !== PIN) throw Error('Membership current-contract proof bytes differ');
const binding = JSON.parse(new TextDecoder().decode(raw)) as {
  archivedFile: string; currentFile: string; bytes: number; sha256: string; gitBlobSha1: string;
  current: { bytes: number; sha256: string; gitBlobSha1: string };
  historicalOutcome: { cases: number; failed: number; passed: number; notReclassified: boolean };
  exactEdits: Array<{ beforeStart: number; afterStart: number; before: string[]; after: string[] }>;
  nativeAllowlist: { file: string; before: { bytes: number; sha256: string; gitBlobSha1: string };
    after: { bytes: number; sha256: string; gitBlobSha1: string }; beforeLiteral: string; afterLiteral: string; occurrences: number };
};
const historical = readFileSync(resolve(root, binding.archivedFile));
const current = readFileSync(resolve(root, binding.currentFile), 'utf8');
function whole(value: string | Uint8Array, image: { bytes: number; sha256: string; gitBlobSha1: string }) {
  if (Buffer.byteLength(value) !== image.bytes || sha(value) !== image.sha256 || blob(value) !== image.gitBlobSha1)
    throw Error('Membership exact complete source differs');
}
// Evidence projection only. No fs shim wraps a current test, service or route.
function predecessor(value: string) {
  whole(value, binding.current);
  const lines = value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = lines.length;
  for (const edit of [...binding.exactEdits].reverse()) {
    if (!Number.isSafeInteger(edit.afterStart) || edit.afterStart < 0 || edit.afterStart + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.afterStart, edit.afterStart + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Membership exact current-contract inverse differs');
    lines.splice(edit.afterStart, edit.after.length, ...edit.before); boundary = edit.afterStart;
  }
  const previous = lines.join(''); whole(previous, binding); return previous;
}

describe('membership current acceptance preserves the original failed source vector', () => {
  it('retains complete immutable 4e8 historical bytes and the combined 90-case failed outcome without reclassifying it', () => {
    expect(sha(historical)).toBe('99cf31be6f20879485cbf502d8530bfc8278d3875bbf1658bb56a50df1521121');
    whole(historical, binding);
    expect(binding.historicalOutcome).toMatchObject({ cases: 90, failed: 5, passed: 85, notReclassified: true });
    expect(predecessor(current)).toBe(new TextDecoder().decode(historical));
  });
  it('admits only the two explicit setup edits and one changed App contract block', () => {
    expect(binding.exactEdits).toHaveLength(4);
    expect(binding.exactEdits.map(edit => edit.before.join(''))).toEqual([
      '',
      expect.stringContaining('f=await membershipHomeFixture();network='),
      expect.stringContaining("it('selects the actual App profile"),
      expect.stringContaining("expect(invalid.msg).toBe('非法渠道')"),
    ]);
    expect(current).toContain("expect(supported.msg).toBe('原生App支付账号目录尚未就绪')");
    expect(current).not.toContain("expect(invalid.msg).toBe('非法渠道')");
  });
  it.each(['newline', 'CRLF', 'unknown change'] as const)('rejects %s instead of accepting a historical hash fallback', kind => {
    const value = kind === 'newline' ? current + '\n' : kind === 'CRLF' ? current.replace(/\n/g, '\r\n')
      : current.replace('余额不足', 'changed-denial');
    expect(() => predecessor(value)).toThrow('exact complete source differs');
  });
  it('keeps the native runner change to the one new file in its two existing sets', () => {
    const entry = binding.nativeAllowlist, actual = readFileSync(resolve(root, entry.file), 'utf8');
    whole(actual, entry.after);
    expect(actual.split(entry.afterLiteral)).toHaveLength(entry.occurrences + 1);
    whole(actual.replaceAll(entry.afterLiteral, entry.beforeLiteral), entry.before);
  });
  it('does not rewrite the earlier source-binding fixtures or their drift/CRLF proof inputs', () => {
    expect(sha(readFileSync(resolve(import.meta.dirname, 'fixtures/membership-card-activation-source-binding-20261026.json'))))
      .toBe('66383437d4f55f432b11211d4f85e31ce2fe713a291988e70c273d913bb8f09c');
    expect(sha(readFileSync(resolve(import.meta.dirname, 'fixtures/membership-rights-source-binding-20261026.json'))))
      .toBe('9d00ae1986e1669e7c19d5ba87642018e9f5debbafb5e0a07bd25f1ebcbba5ab');
  });
});
