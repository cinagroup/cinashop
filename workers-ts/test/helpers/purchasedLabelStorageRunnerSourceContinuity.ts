/** Exact historical reader projection only. The native test runner executes
 * both new admissions and all existing limits; production never imports this. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const PURCHASED_LABEL_RUNNER_FILE = 'workers-ts/scripts/run-local-finance-postgres.mjs';
export const PURCHASED_LABEL_RUNNER_PROOF_FILE = 'workers-ts/test/fixtures/purchased-label-storage-runner-continuity-20261110.json';
export const PURCHASED_LABEL_RUNNER_PROOF_SHA256 = '946bffa54ae23fde86b310e92edf59ad3aa62f17e8ffc3835bdc15aa0629b026';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const image = (value: string) => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex') });
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Proof { schema: string; predecessorCommit: string; file: string; current: Image; predecessor: Image;
  inverseEdits: Array<{ start: number; after: string[]; before: string[] }> }
const raw = readFileSync(resolve(import.meta.dirname, '../../..', PURCHASED_LABEL_RUNNER_PROOF_FILE));
if (sha(raw) !== PURCHASED_LABEL_RUNNER_PROOF_SHA256) throw Error('Purchased label runner immutable proof differs');
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const c of Object.values(v)) freeze(c); Object.freeze(v); } return v;
}
export const purchasedLabelRunnerProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = purchasedLabelRunnerProof;
if (proof.schema !== 'purchased-label-storage-runner-continuity/v1' || proof.file !== PURCHASED_LABEL_RUNNER_FILE
  || proof.predecessorCommit !== 'fc568ece3558053f961188d4f6acb7cdf90ff1ad' || proof.inverseEdits.length !== 2)
  throw Error('Purchased label runner fixed source set differs');
export function projectPurchasedLabelRunnerPredecessor(file: string, source: string): string {
  if (file !== proof.file) return source;
  if (typeof source !== 'string' || JSON.stringify(image(source)) !== JSON.stringify(proof.current))
    throw Error('Purchased label runner complete current source differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const added = "    'test/purchased-product-label-storage-native.test.ts',\n";
  let last = -1;
  for (const e of proof.inverseEdits) {
    if (!Number.isSafeInteger(e.start) || e.start <= last || e.before.length !== 0 || e.after.length !== 1 || e.after[0] !== added
      || lines[e.start] !== added) throw Error('Purchased label runner exact inverse differs');
    last = e.start;
  }
  for (const e of [...proof.inverseEdits].reverse()) lines.splice(e.start, e.after.length);
  const previous = lines.join('');
  if (JSON.stringify(image(previous)) !== JSON.stringify(proof.predecessor)) throw Error('Purchased label runner complete predecessor differs');
  return previous;
}
