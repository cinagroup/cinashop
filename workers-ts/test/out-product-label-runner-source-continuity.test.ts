import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUT_LABEL_RUNNER_FILE as file, outLabelRunnerSourceContinuity as proof,
  projectOutLabelRunnerPredecessor } from './helpers/outProductLabelRunnerSourceContinuity';
import { projectPurchasedLabelRunnerPredecessor } from './helpers/purchasedLabelStorageRunnerSourceContinuity';
import { projectProviderTransportPredecessor } from './helpers/providerTransportSourceContinuity';
import { projectPurchasedLabelAuthorPredecessor } from './helpers/purchasedLabelAuthorSourceContinuity';
import { projectRechargeRefundPredecessor, readRechargeRefundPredecessorFile } from './helpers/rechargeRefundSourceContinuity';

const root = resolve(import.meta.dirname, '../..'), path = resolve(root, file);
const physical = readFileSync(path, 'utf8'), native = projectPurchasedLabelAuthorPredecessor(file, physical);
const current = projectPurchasedLabelRunnerPredecessor(file, native);
const before = execFileSync('git', ['cat-file', 'blob', proof.predecessorCommit + ':' + file], { cwd: root, encoding: 'utf8' });
const added = "    'test/out-product-labels-postgres.test.ts',\n";
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('Out label runner exact successor before unchanged historical proofs', () => {
  it('reverses only the explicit admission line to the full fixed Git original; native runner retains it', () => {
    expect(current.split(added)).toHaveLength(2); expect(current.replace(added, '')).toBe(before);
    expect(projectOutLabelRunnerPredecessor(file, current)).toBe(before);
    expect(projectProviderTransportPredecessor(file, physical)).toBe(before);
    expect(sha(current)).toBe(proof.current.sha256); expect(sha(before)).toBe(proof.predecessor.sha256);
    expect(Buffer.byteLength(current)).toBe(proof.current.bytes); expect(Buffer.byteLength(before)).toBe(proof.predecessor.bytes);
    expect(execFileSync('git', ['rev-parse', proof.predecessorCommit + ':' + file], { cwd: root, encoding: 'utf8' }).trim()).toBe(proof.predecessor.gitBlobSha1);
    expect(projectPurchasedLabelRunnerPredecessor(file, projectPurchasedLabelAuthorPredecessor(file, readFileSync(path, 'utf8')))).toBe(current); expect(Object.isFrozen(proof.current)).toBe(true);
  });
  it.each(['prefix', 'suffix', 'CRLF', 'same-size edit', 'old complete image', 'duplicate admission', 'different budget'])(
    'rejects unreviewed %s before the older reader can authorize it', kind => {
      const changed = kind === 'prefix' ? '// unknown\n' + current : kind === 'suffix' ? current + '\n'
        : kind === 'CRLF' ? current.replaceAll('\n', '\r\n') : kind === 'same-size edit' ? 'X' + current.slice(1)
        : kind === 'old complete image' ? before : kind === 'duplicate admission' ? current.replace(added, added + added)
        : current.replace('? 25 : 10) * 60_000', '? 25 : 11) * 60_000');
      expect(changed).not.toBe(current);
      expect(() => projectOutLabelRunnerPredecessor(file, changed)).toThrow('complete current source differs');
      expect(() => projectProviderTransportPredecessor(file, changed)).toThrow('complete current source differs');
    });
  it('feeds unchanged refund proofs through UTF8, Buffer, URL and byte paths while native descriptor reads remain current', () => {
    const expected = projectRechargeRefundPredecessor(file, before);
    expect(readRechargeRefundPredecessorFile(path, 'utf8')).toBe(expected);
    expect(readRechargeRefundPredecessorFile(path)).toEqual(Buffer.from(expected));
    expect(readRechargeRefundPredecessorFile(pathToFileURL(path), 'utf8')).toBe(expected);
    expect(readRechargeRefundPredecessorFile(Buffer.from(path), 'utf8')).toBe(expected);
    const fd = openSync(path, 'r');
    try { expect(readRechargeRefundPredecessorFile(fd, 'utf8')).toBe(physical); } finally { closeSync(fd); }
    expect(projectOutLabelRunnerPredecessor('unrelated.ts', current)).toBe(current);
  });
});
