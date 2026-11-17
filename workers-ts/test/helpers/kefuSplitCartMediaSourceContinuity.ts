/** Exact historical source views only. Production, native SQL/App and browser
 * acceptance use the physical current files, never this predecessor projection. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const KEFU_SPLIT_CART_MEDIA_PROOF_FILE = 'workers-ts/test/fixtures/kefu-split-cart-media-source-continuity-20261117.json';
export const KEFU_SPLIT_CART_MEDIA_PROOF_SHA256 = '9125ce13639d1bd18f5e02a349007a138212ce6646d3e197372ca867fa17dd2b';
export const KEFU_SPLIT_CART_MEDIA_PREDECESSOR = '54047ef6536840536ffb0632153223ba594e41d4';
export const KEFU_SPLIT_CART_MEDIA_SOURCES = [
  "workers-ts/scripts/run-local-finance-postgres.mjs",
  "workers-ts/src/services/kefu/KefuFulfillmentService.ts",
  "workers-ts/test/helpers/kefuOrderMediaSourceContinuity.ts",
  "workers-ts/test/kefu-order-media-source-continuity.test.ts"
] as const;
Object.freeze(KEFU_SPLIT_CART_MEDIA_SOURCES);
const files = KEFU_SPLIT_CART_MEDIA_SOURCES;
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Edit { start: number; after: string[]; before: string[]; anchorStart: number; anchor: string[] }
interface Row { file: string; current: Image; predecessor: Image; inverseEdits: Edit[];
  origin: { commit: string; path: string; gitBlobSha1: string } }
interface Proof { schema: string; predecessorCommit: string; boundary: string; sources: Row[] }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const kefuSplitCartMediaImage = (value: string): Image => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', KEFU_SPLIT_CART_MEDIA_PROOF_FILE));
if (sha(raw) !== KEFU_SPLIT_CART_MEDIA_PROOF_SHA256) throw Error('Kefu split-cart media immutable proof differs');
export const kefuSplitCartMediaProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = kefuSplitCartMediaProof;
if (proof.schema !== 'kefu-split-cart-media-source-continuity/v1' || proof.predecessorCommit !== KEFU_SPLIT_CART_MEDIA_PREDECESSOR
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('Kefu split-cart media fixed source set differs');
export const isKefuSplitCartMediaSource = (file: string) => (files as readonly string[]).includes(file);
const sameLines = (lines: string[], start: number, expected: string[]) => expected.every((line, offset) => lines[start + offset] === line);

/** Bind the complete real current image. Every old complete image, including
 * the valid fixed54047 predecessor, is refused as a current source. */
export function projectKefuSplitCartMediaPredecessor(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(kefuSplitCartMediaImage(source)) !== JSON.stringify(row.current))
    throw Error('Kefu split-cart media complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Kefu split-cart media fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || !sameLines(lines, edit.start, edit.after)
      || !Number.isSafeInteger(edit.anchorStart) || edit.anchorStart < 0 || edit.anchorStart > edit.start
      || edit.anchorStart + edit.anchor.length > lines.length || edit.anchorStart + edit.anchor.length < edit.start + edit.after.length
      || !edit.anchor.length || !sameLines(lines, edit.anchorStart, edit.anchor)) throw Error('Kefu split-cart media exact inverse differs');
    let matches = 0;
    for (let start = 0; start + edit.anchor.length <= lines.length; start++) if (sameLines(lines, start, edit.anchor)) matches++;
    if (matches !== 1) throw Error('Kefu split-cart media unique inverse anchor differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(kefuSplitCartMediaImage(previous)) !== JSON.stringify(row.predecessor)) throw Error('Kefu split-cart media complete predecessor differs');
  return previous;
}
