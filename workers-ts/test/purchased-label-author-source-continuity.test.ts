import { projectPurchasedLabelOperationsPredecessor } from './helpers/purchasedLabelOperationsSourceContinuity';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { purchasedLabelAuthorImage, purchasedLabelAuthorProof as proof, projectPurchasedLabelAuthorPredecessor,
  PURCHASED_LABEL_AUTHOR_PROOF_FILE, PURCHASED_LABEL_AUTHOR_PROOF_SHA256 } from './helpers/purchasedLabelAuthorSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const priorSource = (file:string) => projectPurchasedLabelOperationsPredecessor(file,readFileSync(resolve(root,file),'utf8'));
describe('purchased label author exact current source successor', () => {
  it('pins the complete proof and fixed thirteen-source inventory without requiring another shallow CI Git object', () => {
    expect(createHash('sha256').update(readFileSync(resolve(root,PURCHASED_LABEL_AUTHOR_PROOF_FILE))).digest('hex')).toBe(PURCHASED_LABEL_AUTHOR_PROOF_SHA256);
    expect(proof.predecessorCommit).toBe('dd9b2f8e065f7f5bcb1ab472c2ecc194becb5b63');
    expect(proof.sources).toHaveLength(13); expect(Object.isFrozen(proof.sources[0]?.inverseEdits)).toBe(true);
    expect(projectPurchasedLabelAuthorPredecessor('unrelated.ts','physical bytes')).toBe('physical bytes');
  });
  for (const row of proof.sources) {
    it('checks all native bytes and exact dd9 reconstruction for '+row.file, () => {
      const physical = priorSource(row.file);
      expect(purchasedLabelAuthorImage(physical)).toEqual(row.current);
      const previous = projectPurchasedLabelAuthorPredecessor(row.file,physical);
      expect(purchasedLabelAuthorImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      expect(priorSource(row.file)).toBe(physical);
    });
    it.each(['prefix','suffix','CRLF','same length','old complete image','duplicate complete image'])(
      'refuses %s of '+row.file, kind => {
        const physical = priorSource(row.file), previous = projectPurchasedLabelAuthorPredecessor(row.file,physical);
        const changed = kind==='prefix' ? '// changed\n'+physical : kind==='suffix' ? physical+'\n' : kind==='CRLF' ? physical.replaceAll('\n','\r\n')
          : kind==='same length' ? 'X'+physical.slice(1) : kind==='old complete image' ? previous : physical+physical;
        expect(() => projectPurchasedLabelAuthorPredecessor(row.file,changed)).toThrow('complete current source differs');
      });
  }
  it('keeps native runner admissions and every original resource budget while rejecting a larger budget', () => {
    const file = 'workers-ts/scripts/run-local-finance-postgres.mjs', physical = priorSource(file);
    expect(physical.split("    'test/purchased-product-label-author-native.test.ts',\n")).toHaveLength(3);
    const changed = physical.replace('? 25 : 10) * 60_000','? 25 : 11) * 60_000');
    expect(changed).not.toBe(physical); expect(() => projectPurchasedLabelAuthorPredecessor(file,changed)).toThrow();
  });
});
