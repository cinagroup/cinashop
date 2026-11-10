/** Exact historical views only. Current scheduling and its native acceptance
 * use real configuration and source, never this predecessor projection. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const UNIT_DISCOVERY_PROOF_FILE = 'workers-ts/test/fixtures/unit-discovery-source-continuity-20261109.json';
export const UNIT_DISCOVERY_PROOF_SHA = '68974165ff71c032f833bca3e5bd4711918b408b970ca4c2d6214cebebed1f4c';
interface Image { bytes: number; sha256: string; gitBlobSha1: string }
interface Row {
  file: string; current: Image; predecessor: Image;
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
const raw = readFileSync(resolve(import.meta.dirname, '../../..', UNIT_DISCOVERY_PROOF_FILE));
if (sha(raw) !== UNIT_DISCOVERY_PROOF_SHA) throw Error('Unit discovery immutable proof differs');
export const unitDiscoverySourceContinuity = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)) as Proof);
const proof = unitDiscoverySourceContinuity;
const files = ['workers-ts/scripts/fixedRoleTestFiles.ts', 'workers-ts/test/fixed-role-test-scheduling.test.ts', 'workers-ts/vitest.config.ts'];
if (proof.schema !== 'unit-discovery-source-continuity/v1' || proof.predecessorCommit !== '353ec0ed03a860eafbc850e9983da505a7ade748'
  || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files)) throw Error('Unit discovery source set differs');
export const isUnitDiscoverySource = (file: string) => files.includes(file);

export function projectUnitDiscoveryPredecessor(file: string, source: string): string {
  const row = proof.sources.find(item => item.file === file);
  if (!row) return source;
  if (typeof source !== 'string' || JSON.stringify(image(source)) !== JSON.stringify(row.current)) throw Error('Unit discovery complete current source differs');
  if (row.origin.commit !== proof.predecessorCommit || row.origin.path !== file || row.origin.gitBlobSha1 !== row.predecessor.gitBlobSha1)
    throw Error('Unit discovery fixed origin differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = 0;
  for (const edit of row.inverseEdits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start + edit.after.length > lines.length
      || !edit.after.length && !edit.before.length || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Unit discovery exact inverse differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...row.inverseEdits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (JSON.stringify(image(previous)) !== JSON.stringify(row.predecessor)) throw Error('Unit discovery complete predecessor differs');
  return previous;
}
