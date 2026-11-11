/** Historical source projection only. Production and runtime acceptance import
 * the real providers. No older proof file/hash, inventory or assertion is replaced. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isUnitDiscoverySource, projectUnitDiscoveryPredecessor } from './unitDiscoverySourceContinuity';
import { isOutLabelRunnerSource, projectOutLabelRunnerPredecessor } from './outProductLabelRunnerSourceContinuity';
import { projectPurchasedLabelRunnerPredecessor } from './purchasedLabelStorageRunnerSourceContinuity';
import { isPurchasedLabelAuthorSource, projectPurchasedLabelAuthorPredecessor } from './purchasedLabelAuthorSourceContinuity';

export const PROVIDER_TRANSPORT_PROOF_FILE = 'workers-ts/test/fixtures/provider-transport-source-continuity-20261109.json';
export const PROVIDER_TRANSPORT_PROOF_SHA = 'be895c2c4a72e33c120aadd7da13fb71eae93b9ff6ff37e495ee6b8fcf81d1b1';
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Row {
  file: string; kind: 'provider' | 'historical-reader' | 'current-contract' | 'validation-workflow'; current: Image; predecessor: Image;
  inverseEdits: Array<{ start: number; after: string[]; before: string[] }>;
  origin: { commit: string; path: string; gitBlobSha1: string };
}
interface Proof { schema: string; predecessorCommit: string; boundary: string; sources: Row[] }
const sha = (source: string | Uint8Array) => createHash('sha256').update(source).digest('hex');
const image = (source: string): Image => ({ bytes: Buffer.byteLength(source), sha256: sha(source),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(source) + '\0').update(source).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', PROVIDER_TRANSPORT_PROOF_FILE));
if (sha(raw) !== PROVIDER_TRANSPORT_PROOF_SHA) throw Error('Provider transport immutable proof differs');
export const providerTransportSourceContinuity = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = providerTransportSourceContinuity;
if (proof.schema !== 'provider-transport-source-continuity/v1' || proof.predecessorCommit !== '353ec0ed03a860eafbc850e9983da505a7ade748'
  || proof.sources.length !== 30 || new Set(proof.sources.map(row => row.file)).size !== 30
  || proof.sources.filter(row => row.kind === 'provider').length !== 12) throw Error('Provider transport source set differs');

// Peel the later discovery-only images before the unchanged older views. This
// reader is historical; runtime tests and production always import native code.
export const isProviderTransportSource = (file: string) => isPurchasedLabelAuthorSource(file) || isOutLabelRunnerSource(file) || isUnitDiscoverySource(file) || proof.sources.some(row => row.file === file);

/** A selected old image is refused, including an otherwise valid predecessor.
 * Every changed line must match exactly; the whole output must be fixed353. */
export function projectProviderTransportPredecessor(file: string, source: string): string {
  source = projectPurchasedLabelAuthorPredecessor(file, source);
  source = projectPurchasedLabelRunnerPredecessor(file, source);
  source = projectOutLabelRunnerPredecessor(file, source);
  source = projectUnitDiscoveryPredecessor(file, source);
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(image(source)) !== JSON.stringify(row.current)) throw Error('Provider transport complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Provider transport fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Provider transport exact inverse differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(image(previous)) !== JSON.stringify(row.predecessor)) throw Error('Provider transport complete predecessor differs');
  return previous;
}
