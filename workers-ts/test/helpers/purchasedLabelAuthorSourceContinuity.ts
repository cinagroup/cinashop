/** Historical source views only. The complete current image is checked before
 * exact inverse edits expose dd9 to the unchanged older proof chain. Production,
 * native SQL, Queue and HTTP acceptance always import the physical new source. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const PURCHASED_LABEL_AUTHOR_PROOF_FILE = 'workers-ts/test/fixtures/purchased-label-author-continuity-20261110.json';
export const PURCHASED_LABEL_AUTHOR_PROOF_SHA256 = 'ecc4a0945f00150af49582f54eb87f0a0a695e761817c1d299d67bdccbf1fcd8';
const files = [
  'workers-ts/scripts/run-local-finance-postgres.mjs',
  'workers-ts/src/controllers/api/v1/AdminOrderOutboxController.ts',
  'workers-ts/src/env.ts',
  'workers-ts/src/index.ts',
  'workers-ts/src/migrations/auditRuntimeBusinessPrivileges.ts',
  'workers-ts/src/migrations/customerRuntimeGiftPeers.ts',
  'workers-ts/src/migrations/purchasedProductLabelStorage.ts',
  'workers-ts/src/routes/v1/index.ts',
  'workers-ts/src/services/activity/StoreDiscountService.ts',
  'workers-ts/src/services/admin/AdminPermissionService.ts',
  'workers-ts/src/services/order/OrderOutboxService.ts',
  'workers-ts/src/services/order/OrderPaidOutboxQueueConsumer.ts',
  'workers-ts/src/services/order/OrderQueueDeadLetterService.ts',
] as const;
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Row { file: string; current: Image; predecessor: Image;
  inverseEdits: Array<{ start: number; after: string[]; before: string[] }>;
  origin: { commit: string; path: string; gitBlobSha1: string } }
interface Proof { schema: string; predecessorCommit: string; sources: Row[] }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const purchasedLabelAuthorImage = (value: string): Image => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob '+Buffer.byteLength(value)+'\0').update(value).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', PURCHASED_LABEL_AUTHOR_PROOF_FILE));
if (sha(raw) !== PURCHASED_LABEL_AUTHOR_PROOF_SHA256) throw Error('Purchased label author immutable proof differs');
export const purchasedLabelAuthorProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = purchasedLabelAuthorProof;
if (proof.schema !== 'purchased-label-author-continuity/v1' || proof.predecessorCommit !== 'dd9b2f8e065f7f5bcb1ab472c2ecc194becb5b63'
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('Purchased label author fixed source set differs');
export const isPurchasedLabelAuthorSource = (file: string) => proof.sources.some(row => row.file === file);
export function projectPurchasedLabelAuthorPredecessor(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(purchasedLabelAuthorImage(source)) !== JSON.stringify(row.current))
    throw Error('Purchased label author complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Purchased label author fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || JSON.stringify(lines.slice(edit.start, edit.start+edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Purchased label author exact inverse differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(purchasedLabelAuthorImage(previous)) !== JSON.stringify(row.predecessor)) throw Error('Purchased label author complete predecessor differs');
  return previous;
}
