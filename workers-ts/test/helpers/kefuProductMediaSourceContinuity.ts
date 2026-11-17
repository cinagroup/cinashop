/** Exact historical source views only. Production, native SQL/App and browser
 * acceptance use the physical current files, never this predecessor projection. */
import { createHash } from 'node:crypto';
import { projectKefuOrderMediaPredecessor } from './kefuOrderMediaSourceContinuity';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const KEFU_PRODUCT_MEDIA_PROOF_FILE = 'workers-ts/test/fixtures/kefu-product-media-source-continuity-20261116.json';
export const KEFU_PRODUCT_MEDIA_PROOF_SHA256 = '05bd3e48df227081194a13eee8c3c8737a8ebae048b443aaee56f7a095aa6918';
export const KEFU_PRODUCT_MEDIA_PREDECESSOR = '9d1d455e844e01efc389646bb8ed43963134f7f7';
export const KEFU_PRODUCT_MEDIA_SOURCES = [
  "view/kefu-ts/src/styles/main.css",
  "workers-ts/scripts/run-local-finance-postgres.mjs",
  "workers-ts/src/controllers/kefu/KefuController.ts",
  "workers-ts/src/services/kefu/KefuProductService.ts",
  "workers-ts/src/services/kefu/KefuTouristService.ts",
  "workers-ts/test/first-order-authority-source-continuity.test.ts",
  "workers-ts/test/helpers/providerTransportSourceContinuity.ts",
  "workers-ts/test/out-product-label-runner-source-continuity.test.ts",
  "workers-ts/test/public-product-estimate-source-continuity.test.ts",
  "workers-ts/test/purchased-label-author-source-continuity.test.ts",
  "workers-ts/test/purchased-label-operations-source-continuity.test.ts",
  "workers-ts/test/purchased-label-storage-runner-source-continuity.test.ts"
] as const;
Object.freeze(KEFU_PRODUCT_MEDIA_SOURCES);
const files = KEFU_PRODUCT_MEDIA_SOURCES;
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Edit { start: number; after: string[]; before: string[]; anchorStart: number; anchor: string[] }
interface Row { file: string; current: Image; predecessor: Image; inverseEdits: Edit[];
  origin: { commit: string; path: string; gitBlobSha1: string } }
interface Proof { schema: string; predecessorCommit: string; boundary: string; sources: Row[] }
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const kefuProductMediaImage = (value: string): Image => ({ bytes: Buffer.byteLength(value), sha256: sha(value),
  gitBlobSha1: createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex') });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readFileSync(resolve(import.meta.dirname, '../../..', KEFU_PRODUCT_MEDIA_PROOF_FILE));
if (sha(raw) !== KEFU_PRODUCT_MEDIA_PROOF_SHA256) throw Error('Kefu product media immutable proof differs');
export const kefuProductMediaProof = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = kefuProductMediaProof;
if (proof.schema !== 'kefu-product-media-source-continuity/v1' || proof.predecessorCommit !== KEFU_PRODUCT_MEDIA_PREDECESSOR
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('Kefu product media fixed source set differs');
export const isKefuProductMediaSource = (file: string) => (files as readonly string[]).includes(file);
const sameLines = (lines: string[], start: number, expected: string[]) => expected.every((line, offset) => lines[start + offset] === line);

/** Bind the complete real current image. Every old complete image, including
 * the valid fixed9d predecessor, is refused as a current source. */
export function projectKefuProductMediaPredecessor(file: string, source: string): string {
  return projectKefuProductMediaFromOrder4428View(file, projectKefuOrderMediaPredecessor(file, source));
}

/** Explicit verified fixed4428 view only. Physical readers use the current
 * entry point above so the later historical-order layer is checked first. */
export function projectKefuProductMediaFromOrder4428View(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(kefuProductMediaImage(source)) !== JSON.stringify(row.current))
    throw Error('Kefu product media complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Kefu product media fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || !sameLines(lines, edit.start, edit.after)
      || !Number.isSafeInteger(edit.anchorStart) || edit.anchorStart < 0 || edit.anchorStart > edit.start
      || edit.anchorStart + edit.anchor.length > lines.length || edit.anchorStart + edit.anchor.length < edit.start + edit.after.length
      || !edit.anchor.length || !sameLines(lines, edit.anchorStart, edit.anchor)) throw Error('Kefu product media exact inverse differs');
    let matches = 0;
    for (let start = 0; start + edit.anchor.length <= lines.length; start++) if (sameLines(lines, start, edit.anchor)) matches++;
    if (matches !== 1) throw Error('Kefu product media unique inverse anchor differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(kefuProductMediaImage(previous)) !== JSON.stringify(row.predecessor)) throw Error('Kefu product media complete predecessor differs');
  return previous;
}
