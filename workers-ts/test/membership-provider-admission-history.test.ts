import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const blob = (value: string) => createHash('sha1')
  .update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, 'fixtures/membership-provider-admission-history-20261105.json'), 'utf8');
if (sha(raw) !== '5d64651583015a1253d2a05c2a738cb5264a0c7c2d46aa0ff800f289696da9f4')
  throw Error('Membership provider admission history differs');
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Edit { beforeStart: number; afterStart: number; before: string[]; after: string[] }
const proof = JSON.parse(raw) as {
  format: number; baseCommit: string; archivedUnitFile: string;
  sources: Array<{ file: string; before: Image; current: Image; exactEdits: Edit[] }>;
  historicalOutcome: { cases: number; failed: number; passed: number; notReclassified: boolean;
    caseVerdicts: Array<{ fullName: string; status: string; leadingFailureMessages: string[] }> };
};
function whole(source: string, image: Image) {
  if (Buffer.byteLength(source) !== image.bytes || sha(source) !== image.sha256 || blob(source) !== image.gitBlobSha1)
    throw Error('Membership provider complete image differs');
}
function predecessor(row: typeof proof.sources[number], source: string) {
  whole(source, row.current);
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = lines.length;
  for (const edit of [...row.exactEdits].reverse()) {
    if (!Number.isSafeInteger(edit.afterStart) || edit.afterStart < 0
      || edit.afterStart + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.afterStart, edit.afterStart + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Membership provider exact inverse differs');
    lines.splice(edit.afterStart, edit.after.length, ...edit.before); boundary = edit.afterStart;
  }
  const before = lines.join(''); whole(before, row.before); return before;
}

// This preserves test-source history only. Every current service, signature
// verifier and HTTP/Queue consumer runs independently of this byte projection.
describe('membership provider trust-boundary acceptance preserves its prior vectors', () => {
  it('retains the complete original eighteen-case authority test and its failed baseline', () => {
    expect(proof.format).toBe(1);
    expect(proof.baseCommit).toBe('71fc0a2e3b42384b54d7cbd7be489d16543c51f3');
    const source = readFileSync(resolve(root, proof.archivedUnitFile), 'utf8');
    whole(source, proof.sources[0].before);
    expect(sha(source)).toBe('cd397d057a736384a1f8cd838165abbb64dfa4200c156b6dafdbcbdfde4f15b4');
    expect(proof.historicalOutcome).toMatchObject({ cases: 18, failed: 2, passed: 16, notReclassified: true });
    expect(proof.historicalOutcome.caseVerdicts).toHaveLength(18);
    expect(proof.historicalOutcome.caseVerdicts.filter(row => row.status === 'failed')).toHaveLength(2);
    expect(predecessor(proof.sources[0], readFileSync(resolve(root, proof.sources[0].file), 'utf8'))).toBe(source);
  });
  it('binds the exact negative-unit and genuine signed HTTP/Queue positive edits without changing runtime source', () => {
    expect(proof.sources.map(row => row.file)).toEqual([
      'workers-ts/test/paid-membership-config-authority.test.ts', 'workers-ts/test/membership-paid-notice-native.test.ts',
    ]);
    for (const row of proof.sources) predecessor(row, readFileSync(resolve(root, row.file), 'utf8'));
    const unit = readFileSync(resolve(root, proof.sources[0].file), 'utf8');
    expect(unit).toContain("'local-provider-evidence', 899)");
    expect(unit).toContain(".rejects.toThrow('本地付款不能伪装提供方已验证入账')");
    const native = readFileSync(resolve(root, proof.sources[1].file), 'utf8');
    expect(native).toContain("await closeNewAdmission(order,'weixin')");
    expect(native).toContain("await closeNewAdmission(order,'alipay')");
    expect(native).toContain("expect(await service.processMessage(message!)).toBe('completed')");
    expect(native).toContain('await cb.ingress()');
    expect(native).toContain('await admission.assertClosed()');
  });
  it.each(proof.sources.map(row => [row.file, row] as const))('rejects an unknown edit or CRLF image for %s', (_file, row) => {
    const source = readFileSync(resolve(root, row.file), 'utf8');
    expect(() => predecessor(row, source + '\n')).toThrow('complete image differs');
    expect(() => predecessor(row, source.replace(/\n/g, '\r\n'))).toThrow('complete image differs');
  });
});
