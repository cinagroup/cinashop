/** Exact historical views only. Production, SQL/App and Browser acceptance use
 * the physical current files, never this predecessor projection. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const FIRST_ORDER_AUTHORITY_PROOF_FILE = 'workers-ts/test/fixtures/first-order-authority-source-continuity-20261116.json';
export const FIRST_ORDER_AUTHORITY_PROOF_SHA256 = '97fab9c318a99855eaea69dc2bad115eb0c4ae32898d0f4bbbd7768464d1bfd2';
export const FIRST_ORDER_AUTHORITY_PREDECESSOR = '9743df508e94eaafa2c724b62f8e181311b981fe';
export const FIRST_ORDER_AUTHORITY_SOURCES = [
  "workers-ts/scripts/run-local-finance-postgres.mjs",
  "workers-ts/src/services/activity/StoreNewcomerService.ts",
  "workers-ts/src/services/admin/AdminAssistedOrderService.ts",
  "workers-ts/src/services/order/CartComputationService.ts",
  "workers-ts/src/services/order/CheckoutPricingSources.ts",
  "workers-ts/src/services/order/StoreCartService.ts",
  "workers-ts/src/services/order/StoreOrderCreateService.ts",
  "workers-ts/test/assisted-purchase-runtime-cases.ts",
  "workers-ts/test/checkout-confirmation.test.ts",
  "workers-ts/test/checkout-pricing-config-authority.test.ts",
  "workers-ts/test/helpers/pcCheckoutQuoteFixture.ts",
  "workers-ts/test/helpers/pcCouponFixture.ts",
  "workers-ts/test/helpers/providerTransportSourceContinuity.ts",
  "workers-ts/test/integration/FirstOrderDiscountPostgresScenario.ts",
  "workers-ts/test/membership-pricing-policy.test.ts",
  "workers-ts/test/newcomer-migration.test.ts",
  "workers-ts/test/newcomer-purchase-postgres.test.ts",
  "workers-ts/test/order-coupon-picker.test.ts",
  "workers-ts/test/out-product-label-runner-source-continuity.test.ts",
  "workers-ts/test/pc-coupon-wallet-postgres.test.ts",
  "workers-ts/test/pc-order-coupon-postgres.test.ts",
  "workers-ts/test/presale-checkout-postgres.test.ts",
  "workers-ts/test/public-product-estimate-source-continuity.test.ts",
  "workers-ts/test/purchased-label-author-source-continuity.test.ts",
  "workers-ts/test/purchased-label-operations-source-continuity.test.ts",
  "workers-ts/test/purchased-label-storage-runner-source-continuity.test.ts"
] as const;
Object.freeze(FIRST_ORDER_AUTHORITY_SOURCES);
const files = FIRST_ORDER_AUTHORITY_SOURCES;
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Edit { start: number; after: string[]; before: string[]; anchorStart: number; anchor: string[] }
interface Row { file: string; current: Image; predecessor: Image; inverseEdits: Edit[];
  origin: { commit: string; path: string; gitBlobSha1: string } }
interface Proof { schema: string; predecessorCommit: string; boundary: string; sources: Row[] }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const firstOrderAuthorityImage = (value: string): Image => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', FIRST_ORDER_AUTHORITY_PROOF_FILE));
if (sha(raw) !== FIRST_ORDER_AUTHORITY_PROOF_SHA256) throw Error('First-order authority immutable proof differs');
export const firstOrderAuthorityProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = firstOrderAuthorityProof;
if (proof.schema !== 'first-order-authority-source-continuity/v1' || proof.predecessorCommit !== FIRST_ORDER_AUTHORITY_PREDECESSOR
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('First-order authority fixed source set differs');
export const isFirstOrderAuthoritySource = (file: string) => (files as readonly string[]).includes(file);
const sameLines = (lines: string[], start: number, expected: string[]) => expected.every((line, offset) => lines[start + offset] === line);

/** Every selected complete current image must match. An old full image, even
 * the valid fixed9743 predecessor, is refused as a current input. */
export function projectFirstOrderAuthorityPredecessor(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(firstOrderAuthorityImage(source)) !== JSON.stringify(row.current))
    throw Error('First-order authority complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('First-order authority fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || !sameLines(lines, edit.start, edit.after)
      || !Number.isSafeInteger(edit.anchorStart) || edit.anchorStart < 0 || edit.anchorStart > edit.start
      || edit.anchorStart + edit.anchor.length > lines.length || edit.anchorStart + edit.anchor.length < edit.start + edit.after.length
      || !edit.anchor.length || !sameLines(lines, edit.anchorStart, edit.anchor)) throw Error('First-order authority exact inverse differs');
    let matches = 0;
    for (let start = 0; start + edit.anchor.length <= lines.length; start++) if (sameLines(lines, start, edit.anchor)) matches++;
    if (matches !== 1) throw Error('First-order authority unique inverse anchor differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(firstOrderAuthorityImage(previous)) !== JSON.stringify(row.predecessor)) throw Error('First-order authority complete predecessor differs');
  return previous;
}
