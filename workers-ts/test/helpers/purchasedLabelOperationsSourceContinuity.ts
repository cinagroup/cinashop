/** Historical source views only. The complete current image is checked before
 * exact inverse edits expose 2e63 to the unchanged older proof chain. Production,
 * native SQL, Queue and HTTP acceptance always import the physical new source. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const PURCHASED_LABEL_OPERATIONS_PROOF_FILE = 'workers-ts/test/fixtures/purchased-label-operations-continuity-20261110.json';
export const PURCHASED_LABEL_OPERATIONS_PROOF_SHA256 = '60144df5fb7fe5d781e24ba935060434d23efce30c24d06841b85f16c40271de';
const files = [
  '.github/workflows/workers-runtime-linux.yml',
  'view/admin-ts/package.json',
  'view/admin-ts/src/pages/operations/OrderOutboxList.vue',
  'workers-ts/scripts/run-local-finance-postgres.mjs',
  'workers-ts/src/controllers/api/v1/AdminOrderOutboxController.ts',
  'workers-ts/src/services/order/PurchasedProductLabelTaskService.ts',
] as const;
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Row { file: string; current: Image; predecessor: Image;
  inverseEdits: Array<{ start: number; after: string[]; before: string[] }>;
  origin: { commit: string; path: string; gitBlobSha1: string } }
interface Proof { schema: string; predecessorCommit: string; sources: Row[] }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const purchasedLabelOperationsImage = (value: string): Image => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob '+Buffer.byteLength(value)+'\0').update(value).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', PURCHASED_LABEL_OPERATIONS_PROOF_FILE));
if (sha(raw) !== PURCHASED_LABEL_OPERATIONS_PROOF_SHA256) throw Error('Purchased label operations immutable proof differs');
export const purchasedLabelOperationsProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = purchasedLabelOperationsProof;
if (proof.schema !== 'purchased-label-operations-continuity/v1' || proof.predecessorCommit !== '2e63c407db8b66baae76efbcb111f325417d1ad9'
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('Purchased label operations fixed source set differs');
export const isPurchasedLabelOperationsSource = (file: string) => proof.sources.some(row => row.file === file);
export function projectPurchasedLabelOperationsPredecessor(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(purchasedLabelOperationsImage(source)) !== JSON.stringify(row.current))
    throw Error('Purchased label operations complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Purchased label operations fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || JSON.stringify(lines.slice(edit.start, edit.start+edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Purchased label operations exact inverse differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(purchasedLabelOperationsImage(previous)) !== JSON.stringify(row.predecessor)) throw Error('Purchased label operations complete predecessor differs');
  return previous;
}
