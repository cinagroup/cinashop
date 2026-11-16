import { projectFirstOrderAuthorityPredecessor } from './helpers/firstOrderAuthoritySourceContinuity';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PRODUCT_ESTIMATE_PREDECESSOR, PUBLIC_PRODUCT_ESTIMATE_PROOF_FILE, PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256,
  publicProductEstimateImage, publicProductEstimateProof as proof, isPublicProductEstimateSource,
  projectPublicProductEstimatePredecessor } from './helpers/publicProductEstimateSourceContinuity';
import { isProviderTransportSource, projectProviderTransportFromPublicProductEstimateView as projectProviderTransportPredecessor, providerTransportSourceContinuity } from './helpers/providerTransportSourceContinuity';
import { projectPurchasedLabelOperationsPredecessor } from './helpers/purchasedLabelOperationsSourceContinuity';
import { projectPurchasedLabelAuthorPredecessor } from './helpers/purchasedLabelAuthorSourceContinuity';
import { projectPurchasedLabelRunnerPredecessor } from './helpers/purchasedLabelStorageRunnerSourceContinuity';
import { projectOutLabelRunnerPredecessor } from './helpers/outProductLabelRunnerSourceContinuity';
import { projectUnitDiscoveryPredecessor } from './helpers/unitDiscoverySourceContinuity';
import { readRechargeRefundPredecessorFile } from './helpers/rechargeRefundSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const physical = (file: string) => readFileSync(resolve(root, file), 'utf8');
// These original fifty assertions check the explicit fixed9743 view. The new
// first-order continuity suite separately binds every real physical current byte.
const atPublicProductEstimate9743 = (file: string) => projectFirstOrderAuthorityPredecessor(file, physical(file));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources = [
  'view/uniapp-ts/scripts/product-coupons-runtime.test.cjs',
  'view/uniapp-ts/scripts/product-detail-design-runtime.test.cjs',
  'view/uniapp-ts/scripts/product-sku-runtime.test.cjs',
  'view/uniapp-ts/src/pages/goods/detail.vue',
  'workers-ts/package.json',
  'workers-ts/scripts/run-local-finance-postgres.mjs',
  'workers-ts/src/controllers/api/v1/ProductController.ts',
  'workers-ts/src/middleware/auth.ts',
  'workers-ts/src/routes/v1/index.ts',
  'workers-ts/src/services/activity/ActivityService.ts',
  'workers-ts/src/services/activity/MembershipCouponService.ts',
  'workers-ts/src/services/activity/OrderCouponService.ts',
  'workers-ts/src/services/activity/StoreNewcomerService.ts',
  'workers-ts/src/services/order/CartComputationService.ts',
  'workers-ts/test/admin-marketing-frontend-parity.test.ts',
  'workers-ts/test/coupon-issue-migration.test.ts',
  'workers-ts/test/helpers/providerTransportSourceContinuity.ts',
  'workers-ts/test/local-finance-postgres-runner.test.ts',
  'workers-ts/test/out-product-label-runner-source-continuity.test.ts',
  'workers-ts/test/product-coupon-migration.test.ts',
  'workers-ts/test/purchased-label-author-source-continuity.test.ts',
  'workers-ts/test/purchased-label-operations-source-continuity.test.ts',
  'workers-ts/test/purchased-label-storage-runner-source-continuity.test.ts',
];
const priorRejections = new Map([
  ['workers-ts/scripts/run-local-finance-postgres.mjs', 'Purchased label operations complete current source differs'],
  ['workers-ts/src/routes/v1/index.ts', 'Purchased label author complete current source differs'],
]);
function previousProviderView(file: string, a915: string) {
  return projectUnitDiscoveryPredecessor(file, projectOutLabelRunnerPredecessor(file,
    projectPurchasedLabelRunnerPredecessor(file, projectPurchasedLabelAuthorPredecessor(file,
      projectPurchasedLabelOperationsPredecessor(file, a915)))));
}
function historicalOutcome(read: () => string) {
  try { return { source: read(), error: null }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { source: null, error: { name: error.name, message: error.message } };
  }
}

describe('public product estimate exact successor before unchanged historical source proofs', () => {
  it('pins the entire immutable fixture, twenty-three-source inventory and fixed a915 origin without fetching Git objects in shallow CI', () => {
    expect(sha(readFileSync(resolve(root, PUBLIC_PRODUCT_ESTIMATE_PROOF_FILE)))).toBe(PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256);
    expect(proof.schema).toBe('public-product-estimate-source-continuity/v1');
    expect(proof.predecessorCommit).toBe('a9157320e351cfeb5ecdb50817e45ecf3ede4a06');
    expect(PUBLIC_PRODUCT_ESTIMATE_PREDECESSOR).toBe(proof.predecessorCommit);
    expect(proof.sources.map(row => row.file)).toEqual(sources); expect(new Set(sources).size).toBe(23);
    expect(proof.sources.every(row => isPublicProductEstimateSource(row.file) && isProviderTransportSource(row.file))).toBe(true);
    expect(providerTransportSourceContinuity.sources.every(row => !sources.includes(row.file))).toBe(true);
  });
  for (const row of proof.sources) {
    it('binds every native byte and reconstructs the complete fixed Git image for ' + row.file, () => {
      const native = physical(row.file), current = atPublicProductEstimate9743(row.file); expect(publicProductEstimateImage(current)).toEqual(row.current);
      const previous = projectPublicProductEstimatePredecessor(row.file, current);
      expect(previous).not.toBe(current); expect(publicProductEstimateImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      // Two dated leaves already reject the fixed a915 source. Preserve these
      // finite exact rejections; every other path must still return exact bytes.
      const rejection = priorRejections.get(row.file);
      if (rejection) {
        const expected = { source: null, error: { name: 'Error', message: rejection } };
        expect(historicalOutcome(() => previousProviderView(row.file, previous))).toEqual(expected);
        expect(historicalOutcome(() => projectProviderTransportPredecessor(row.file, current))).toEqual(expected);
      } else expect(projectProviderTransportPredecessor(row.file, current)).toBe(previousProviderView(row.file, previous));
      expect(physical(row.file)).toBe(native); expect(atPublicProductEstimate9743(row.file)).toBe(current);
    });
    it('rejects whole-image drift and all predecessor/duplicate input forms for ' + row.file, () => {
      const current = atPublicProductEstimate9743(row.file), previous = projectPublicProductEstimatePredecessor(row.file, current);
      const changed = ['// unknown\n' + current, current + '\n// unknown\n', current.replaceAll('\n', '\r\n'),
        'X' + current.slice(1), previous, current + current, '', current.slice(0, -1)];
      for (const input of changed) {
        expect(input).not.toBe(current);
        expect(() => projectPublicProductEstimatePredecessor(row.file, input)).toThrow('complete current source differs');
        expect(() => projectProviderTransportPredecessor(row.file, input)).toThrow('complete current source differs');
      }
    });
  }
  it('keeps finite selectors literal and leaves unknown/new files in their real current form', () => {
    for (const file of ['unrelated.ts', '/workers-ts/src/middleware/auth.ts', 'workers-ts/src/middleware/../middleware/auth.ts',
      'workers-ts\\src\\middleware\\auth.ts', 'workers-ts/src/middleware/auth.ts.extra',
      'workers-ts/src/services/product/PublicProductEstimateService.ts', 'workers-ts/src/services/activity/PublicCouponEstimateService.ts',
      'workers-ts/test/browser/public-product-estimate.acceptance.ts']) {
      expect(isPublicProductEstimateSource(file)).toBe(false);
      const bytes = file.startsWith('workers-ts/src/services/') || file.startsWith('workers-ts/test/browser/') ? physical(file) : 'native bytes\0\r\n';
      expect(projectPublicProductEstimatePredecessor(file, bytes)).toBe(bytes);
    }
  });
  it('feeds Activity and ProductController through the existing historical read port while native source stays unchanged', () => {
    for (const file of ['workers-ts/src/services/activity/ActivityService.ts', 'workers-ts/src/controllers/api/v1/ProductController.ts']) {
      const current = physical(file), before = projectPublicProductEstimatePredecessor(file, atPublicProductEstimate9743(file));
      expect(readRechargeRefundPredecessorFile(resolve(root, file), 'utf8')).toBe(before);
      expect(readRechargeRefundPredecessorFile(resolve(root, file))).toEqual(Buffer.from(before));
      expect(physical(file)).toBe(current);
    }
  });
  it('makes the fixture and all exact inverse metadata deeply immutable', () => {
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.sources)).toBe(true);
    for (const row of proof.sources) {
      expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.origin)).toBe(true);
      expect(Object.isFrozen(row.current)).toBe(true); expect(Object.isFrozen(row.predecessor)).toBe(true);
      expect(Object.isFrozen(row.inverseEdits)).toBe(true); expect(row.inverseEdits.length).toBeGreaterThan(0);
      for (const edit of row.inverseEdits) {
        expect(Object.isFrozen(edit)).toBe(true); expect(Object.isFrozen(edit.after)).toBe(true);
        expect(Object.isFrozen(edit.before)).toBe(true); expect(Object.isFrozen(edit.anchor)).toBe(true);
        expect(Reflect.set(edit, 'start', edit.start + 1)).toBe(false);
        expect(Reflect.set(edit.anchor, '0', 'unreviewed\n')).toBe(false);
      }
      expect(Reflect.set(row.current, 'sha256', row.predecessor.sha256)).toBe(false);
      expect(Reflect.set(row.origin, 'commit', 'unknown')).toBe(false);
      expect(publicProductEstimateImage(projectPublicProductEstimatePredecessor(row.file, atPublicProductEstimate9743(row.file)))).toEqual(row.predecessor);
    }
    expect(sha(readFileSync(resolve(root, PUBLIC_PRODUCT_ESTIMATE_PROOF_FILE)))).toBe(PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256);
  });
});
