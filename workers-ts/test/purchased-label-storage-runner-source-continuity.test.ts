import { projectPurchasedLabelOperationsPredecessor } from './helpers/purchasedLabelOperationsSourceContinuity';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURCHASED_LABEL_RUNNER_FILE as file, projectPurchasedLabelRunnerPredecessor,
  purchasedLabelRunnerProof as proof } from './helpers/purchasedLabelStorageRunnerSourceContinuity';
import { projectOutLabelRunnerPredecessor } from './helpers/outProductLabelRunnerSourceContinuity';
import { projectProviderTransportPredecessor } from './helpers/providerTransportSourceContinuity';
import { projectPurchasedLabelAuthorPredecessor } from './helpers/purchasedLabelAuthorSourceContinuity';
const root = resolve(import.meta.dirname, '../..'), physical = readFileSync(resolve(root, file), 'utf8');
const native = projectPurchasedLabelAuthorPredecessor(file, projectPurchasedLabelOperationsPredecessor(file, physical));
const admission = "    'test/purchased-product-label-storage-native.test.ts',\n";
// Fixed Git image metadata was independently checked against fc568ece locally.
// No new shallow-CI commit supply dependency is introduced by this successor.
const predecessor = native.replaceAll(admission, '');
describe('purchased-label storage runner explicit successor', () => {
  it('reverses exactly the two literal admissions before every unchanged older reader', () => {
    expect(native.split(admission)).toHaveLength(3);
    expect(Buffer.byteLength(predecessor)).toBe(proof.predecessor.bytes);
    expect(createHash('sha256').update(predecessor).digest('hex')).toBe(proof.predecessor.sha256);
    expect(createHash('sha1').update('blob '+Buffer.byteLength(predecessor)+'\0').update(predecessor).digest('hex')).toBe(proof.predecessor.gitBlobSha1);
    expect(projectPurchasedLabelRunnerPredecessor(file, native)).toBe(predecessor);
    expect(projectProviderTransportPredecessor(file, physical)).toBe(projectOutLabelRunnerPredecessor(file, predecessor));
    expect(readFileSync(resolve(root, file), 'utf8')).toBe(physical);
    expect(Object.isFrozen(proof.inverseEdits)).toBe(true);
    expect(projectPurchasedLabelRunnerPredecessor('unrelated.ts', 'untouched')).toBe('untouched');
  });
  it.each(['old image', 'prefix', 'suffix', 'CRLF', 'same length', 'duplicate admission', 'one missing admission', 'increased budget'])(
    'rejects %s against the complete current image', kind => {
      const changed = kind === 'old image' ? predecessor : kind === 'prefix' ? '// surprise\n'+native
        : kind === 'suffix' ? native+'\n' : kind === 'CRLF' ? native.replaceAll('\n', '\r\n')
        : kind === 'same length' ? 'X'+native.slice(1) : kind === 'duplicate admission' ? native.replace(admission, admission+admission)
        : kind === 'one missing admission' ? native.replace(admission, '') : native.replace('? 25 : 10) * 60_000', '? 25 : 11) * 60_000');
      expect(changed).not.toBe(native);
      expect(() => projectPurchasedLabelRunnerPredecessor(file, changed)).toThrow('complete current source differs');
      expect(() => projectProviderTransportPredecessor(file, changed)).toThrow('complete current source differs');
    });
});
