import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { purchasedLabelOperationsImage, purchasedLabelOperationsProof as proof, projectPurchasedLabelOperationsPredecessor,
  PURCHASED_LABEL_OPERATIONS_PROOF_FILE, PURCHASED_LABEL_OPERATIONS_PROOF_SHA256 } from './helpers/purchasedLabelOperationsSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
describe('purchased label operations exact current source successor', () => {
  it('pins the complete proof and fixed six-source inventory without requiring another shallow CI Git object', () => {
    expect(createHash('sha256').update(readFileSync(resolve(root,PURCHASED_LABEL_OPERATIONS_PROOF_FILE))).digest('hex')).toBe(PURCHASED_LABEL_OPERATIONS_PROOF_SHA256);
    expect(proof.predecessorCommit).toBe('2e63c407db8b66baae76efbcb111f325417d1ad9');
    expect(proof.sources).toHaveLength(6); expect(Object.isFrozen(proof.sources[0]?.inverseEdits)).toBe(true);
    expect(projectPurchasedLabelOperationsPredecessor('unrelated.ts','physical bytes')).toBe('physical bytes');
  });
  for (const row of proof.sources) {
    it('checks all native bytes and exact 2e63 reconstruction for '+row.file, () => {
      const physical = readFileSync(resolve(root,row.file),'utf8');
      expect(purchasedLabelOperationsImage(physical)).toEqual(row.current);
      const previous = projectPurchasedLabelOperationsPredecessor(row.file,physical);
      expect(purchasedLabelOperationsImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      expect(readFileSync(resolve(root,row.file),'utf8')).toBe(physical);
    });
    it.each(['prefix','suffix','CRLF','same length','old complete image','duplicate complete image'])(
      'refuses %s of '+row.file, kind => {
        const physical = readFileSync(resolve(root,row.file),'utf8'), previous = projectPurchasedLabelOperationsPredecessor(row.file,physical);
        const changed = kind==='prefix' ? '// changed\n'+physical : kind==='suffix' ? physical+'\n' : kind==='CRLF' ? physical.replaceAll('\n','\r\n')
          : kind==='same length' ? 'X'+physical.slice(1) : kind==='old complete image' ? previous : physical+physical;
        expect(() => projectPurchasedLabelOperationsPredecessor(row.file,changed)).toThrow('complete current source differs');
      });
  }
  it('keeps native runner admissions and every original resource budget while rejecting a larger budget', () => {
    const file = 'workers-ts/scripts/run-local-finance-postgres.mjs', physical = readFileSync(resolve(root,file),'utf8');
    expect(physical.split("    'test/purchased-label-operations-native.test.ts',\n")).toHaveLength(3);
    const changed = physical.replace('? 25 : 10) * 60_000','? 25 : 11) * 60_000');
    expect(changed).not.toBe(physical); expect(() => projectPurchasedLabelOperationsPredecessor(file,changed)).toThrow();
  });
});
