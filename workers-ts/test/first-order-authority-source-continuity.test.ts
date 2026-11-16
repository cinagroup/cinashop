import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_ORDER_AUTHORITY_PREDECESSOR, FIRST_ORDER_AUTHORITY_PROOF_FILE, FIRST_ORDER_AUTHORITY_PROOF_SHA256,
  FIRST_ORDER_AUTHORITY_SOURCES, firstOrderAuthorityImage, firstOrderAuthorityProof as proof,
  isFirstOrderAuthoritySource, projectFirstOrderAuthorityPredecessor } from './helpers/firstOrderAuthoritySourceContinuity';
import { isProviderTransportSource, projectProviderTransportPredecessor,
  projectProviderTransportFromPublicProductEstimateView } from './helpers/providerTransportSourceContinuity';
import { PUBLIC_PRODUCT_ESTIMATE_PROOF_FILE, PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256 } from './helpers/publicProductEstimateSourceContinuity';
const root = resolve(import.meta.dirname, '../..');
const physical = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sources = [
  'workers-ts/scripts/run-local-finance-postgres.mjs',
  'workers-ts/src/services/activity/StoreNewcomerService.ts',
  'workers-ts/src/services/admin/AdminAssistedOrderService.ts',
  'workers-ts/src/services/order/CartComputationService.ts',
  'workers-ts/src/services/order/CheckoutPricingSources.ts',
  'workers-ts/src/services/order/StoreCartService.ts',
  'workers-ts/src/services/order/StoreOrderCreateService.ts',
  'workers-ts/test/assisted-purchase-runtime-cases.ts',
  'workers-ts/test/checkout-confirmation.test.ts',
  'workers-ts/test/checkout-pricing-config-authority.test.ts',
  'workers-ts/test/helpers/pcCheckoutQuoteFixture.ts',
  'workers-ts/test/helpers/pcCouponFixture.ts',
  'workers-ts/test/helpers/providerTransportSourceContinuity.ts',
  'workers-ts/test/integration/FirstOrderDiscountPostgresScenario.ts',
  'workers-ts/test/membership-pricing-policy.test.ts',
  'workers-ts/test/newcomer-migration.test.ts',
  'workers-ts/test/newcomer-purchase-postgres.test.ts',
  'workers-ts/test/order-coupon-picker.test.ts',
  'workers-ts/test/out-product-label-runner-source-continuity.test.ts',
  'workers-ts/test/pc-coupon-wallet-postgres.test.ts',
  'workers-ts/test/pc-order-coupon-postgres.test.ts',
  'workers-ts/test/presale-checkout-postgres.test.ts',
  'workers-ts/test/public-product-estimate-source-continuity.test.ts',
  'workers-ts/test/purchased-label-author-source-continuity.test.ts',
  'workers-ts/test/purchased-label-operations-source-continuity.test.ts',
  'workers-ts/test/purchased-label-storage-runner-source-continuity.test.ts',
];

describe('first-order SQL authority exact current source before fixed9743 historical views', () => {
  it('pins the entire immutable proof, twenty-six-source literal inventory and complete fixed9743 origins', () => {
    expect(sha(readFileSync(resolve(root, FIRST_ORDER_AUTHORITY_PROOF_FILE)))).toBe(FIRST_ORDER_AUTHORITY_PROOF_SHA256);
    expect(proof.schema).toBe('first-order-authority-source-continuity/v1');
    expect(proof.predecessorCommit).toBe('9743df508e94eaafa2c724b62f8e181311b981fe');
    expect(FIRST_ORDER_AUTHORITY_PREDECESSOR).toBe(proof.predecessorCommit);
    expect(FIRST_ORDER_AUTHORITY_SOURCES).toEqual(sources);
    expect(proof.sources.map(row => row.file)).toEqual(sources);
    expect(new Set(sources).size).toBe(26);
    expect(Object.isFrozen(FIRST_ORDER_AUTHORITY_SOURCES)).toBe(true);
    expect(Reflect.set(FIRST_ORDER_AUTHORITY_SOURCES, '0', 'unknown')).toBe(false);
    expect(sources.every(file => isFirstOrderAuthoritySource(file) && isProviderTransportSource(file))).toBe(true);
  });
  for (const row of proof.sources) {
    it('binds every physical current byte and reconstructs the fixed9743 Git image for ' + row.file, () => {
      const current = physical(row.file);
      expect(firstOrderAuthorityImage(current)).toEqual(row.current);
      const previous = projectFirstOrderAuthorityPredecessor(row.file, current);
      expect(previous).not.toBe(current);
      expect(firstOrderAuthorityImage(previous)).toEqual(row.predecessor);
      expect(row.origin).toEqual({ commit: proof.predecessorCommit, path: row.file, gitBlobSha1: row.predecessor.gitBlobSha1 });
      if (row.file === 'workers-ts/scripts/run-local-finance-postgres.mjs') {
        // This literal full-image rejection is already present in fixed9743.
        // It remains a failed historical collection, never a passing fallback.
        const message = 'Purchased label operations complete current source differs';
        expect(() => projectProviderTransportFromPublicProductEstimateView(row.file, previous)).toThrow(message);
        expect(() => projectProviderTransportPredecessor(row.file, current)).toThrow(message);
      } else {
        const fixedView = projectProviderTransportFromPublicProductEstimateView(row.file, previous);
        expect(projectProviderTransportPredecessor(row.file, current)).toBe(fixedView);
      }
      expect(physical(row.file)).toBe(current);
    });
    it('rejects tampering, duplicate forms and every old complete image as current for ' + row.file, () => {
      const current = physical(row.file), previous = projectFirstOrderAuthorityPredecessor(row.file, current);
      const invalid = ['// unknown\n' + current, current + '\n// unknown\n', current.replaceAll('\n', '\r\n'),
        'X' + current.slice(1), previous, current + current, '', current.slice(0, -1)];
      for (const input of invalid) {
        expect(input).not.toBe(current);
        expect(() => projectFirstOrderAuthorityPredecessor(row.file, input)).toThrow('complete current source differs');
        expect(() => projectProviderTransportPredecessor(row.file, input)).toThrow('complete current source differs');
      }
    });
  }
  it('keeps selectors literal and passes unrelated or new sources through in their real current form', () => {
    for (const file of ['unrelated.ts', '/workers-ts/src/services/activity/StoreNewcomerService.ts',
      'workers-ts/src/services/activity/../activity/StoreNewcomerService.ts', 'workers-ts\\src\\services\\activity\\StoreNewcomerService.ts',
      'workers-ts/src/services/activity/StoreNewcomerService.ts.extra',
      'workers-ts/test/first-order-sql-authority.test.ts', 'workers-ts/test/first-order-authority-source-continuity.test.ts',
      'workers-ts/test/helpers/firstOrderAuthoritySourceContinuity.ts']) {
      expect(isFirstOrderAuthoritySource(file)).toBe(false);
      const bytes = file.startsWith('workers-ts/test/') ? physical(file) : 'literal unknown bytes\0\r\n';
      expect(projectFirstOrderAuthorityPredecessor(file, bytes)).toBe(bytes);
    }
  });
  it('retains the complete old public-product proof and its helper without replacing old fixture bytes or hashes', () => {
    expect(PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256).toBe('bb78b85fe23a3ede3dbe57a97d13665a3c1367ad1a1803394d28fdbbc97388b2');
    expect(sha(readFileSync(resolve(root, PUBLIC_PRODUCT_ESTIMATE_PROOF_FILE)))).toBe(PUBLIC_PRODUCT_ESTIMATE_PROOF_SHA256);
    expect(sha(physical('workers-ts/test/helpers/publicProductEstimateSourceContinuity.ts')))
      .toBe('bc927b71a0e451b45737521e4ee7f4708b10a727594bdbc25a91c30b7f798407');
  });
  it('makes every complete image, fixed origin and unique-anchor inverse deeply immutable', () => {
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.sources)).toBe(true);
    for (const row of proof.sources) {
      expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.current)).toBe(true);
      expect(Object.isFrozen(row.predecessor)).toBe(true); expect(Object.isFrozen(row.origin)).toBe(true);
      expect(Object.isFrozen(row.inverseEdits)).toBe(true); expect(row.inverseEdits.length).toBeGreaterThan(0);
      for (const edit of row.inverseEdits) {
        expect(Object.isFrozen(edit)).toBe(true); expect(Object.isFrozen(edit.after)).toBe(true);
        expect(Object.isFrozen(edit.before)).toBe(true); expect(Object.isFrozen(edit.anchor)).toBe(true);
        expect(Reflect.set(edit, 'start', edit.start + 1)).toBe(false);
        expect(Reflect.set(edit.anchor, '0', 'unreviewed\n')).toBe(false);
      }
      expect(Reflect.set(row.current, 'sha256', row.predecessor.sha256)).toBe(false);
      expect(Reflect.set(row.origin, 'commit', 'unknown')).toBe(false);
      expect(firstOrderAuthorityImage(projectFirstOrderAuthorityPredecessor(row.file, physical(row.file)))).toEqual(row.predecessor);
    }
    expect(sha(readFileSync(resolve(root, FIRST_ORDER_AUTHORITY_PROOF_FILE)))).toBe(FIRST_ORDER_AUTHORITY_PROOF_SHA256);
  });
});
