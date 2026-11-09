/** Exact post-merge source views for historical proofs. The current runtime and
 * direct filesystem readers continue to use the real package/page/route files. */
import { createHash } from 'node:crypto';
import { readMembershipContinuityHistoricalFile as readDiskFileSync } from './rechargeRefundSourceContinuity';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
export const POST_MERGE_SOURCE_PROOF_FILE = 'workers-ts/test/fixtures/post-merge-source-binding-20261103.json';
export const POST_MERGE_SOURCE_PROOF_SHA = '6b3f91d5ce47d8f49184637f5f7277e38ad0dcfbc9f9840545db80e5d4581187';
const canonicalSha = '963bc278e2f4e9bffc9c72720977b8e9804b38a1febb9c3d712e0464e9fac43b';
const currentCommit = '53f212ddf1a1025c19642c92be795d5c245af483';
const predecessorCommit = '3d4780a6a5816934f7b82b31132c0111a5f5065d';
const files = ['view/uniapp-ts/package.json', 'view/uniapp-ts/src/pages.json', 'workers-ts/src/routes/v1/index.ts', 'workers-ts/package.json'];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
interface Image { bytes: number; sha256: string; raw_utf8: string; origins: string[] }
interface Edit { start: number; after: string[]; before: string[] }
export interface PostMergeSourceProof {
  format_version: number; current_commit: string; predecessor_commit: string;
  sources: Array<{ file: string; current: Image; predecessor: Image; inverse_edits: Edit[] }>;
  reviewed_history: Array<{ commit: string; parent_commit: string; subject: string;
    sources: Array<{ file: string; before_sha256: string; after_sha256: string }> }>;
  unchanged_proofs: Array<{ file: string; bytes: number; sha256: string }>;
  legacy_import: { file: string; before: Image; line: number; before_import: string; after_import: string };
  boundary: string;
}
function image(value: Image, origin: string) {
  if (typeof value?.raw_utf8 !== 'string' || Buffer.byteLength(value.raw_utf8) !== value.bytes
    || sha(value.raw_utf8) !== value.sha256 || JSON.stringify(value.origins) !== JSON.stringify([origin]))
    throw Error('Post-merge complete source image differs');
}
function verify(proof: PostMergeSourceProof) {
  // Pins the entire reviewed history, source images, edit lists and import-only
  // wiring. A caller-supplied cloned proof cannot invent a new accepted digest.
  if (sha(JSON.stringify(proof)) !== canonicalSha || proof.format_version !== 1
    || proof.current_commit !== currentCommit || proof.predecessor_commit !== predecessorCommit
    || JSON.stringify(proof.sources.map(row => row.file)) !== JSON.stringify(files))
    throw Error('Post-merge complete source proof differs');
  for (const row of proof.sources) { image(row.current, currentCommit); image(row.predecessor, predecessorCommit); }
  image(proof.legacy_import.before, currentCommit);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readDiskFileSync(resolve(root, POST_MERGE_SOURCE_PROOF_FILE));
if (sha(raw) !== POST_MERGE_SOURCE_PROOF_SHA) throw Error('Post-merge exact source proof bytes differ');
export const postMergeSourceBinding = freeze(JSON.parse(decode(raw)) as PostMergeSourceProof);

/** Never accepts an older image as a current-source fallback. Every exact edit
 * is reversed from the matching full live source before the full merge returns. */
export function projectPostMergeSource(file: string, source: string, proof = postMergeSourceBinding) {
  if (!files.includes(file)) return source;
  verify(proof);
  const row = proof.sources.find(item => item.file === file)!;
  if (source !== row.current.raw_utf8 || sha(source) !== row.current.sha256)
    throw Error(`Post-merge current source differs: ${file}`);
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = lines.length;
  for (const edit of [...row.inverse_edits].reverse()) {
    if (!Number.isSafeInteger(edit.start) || edit.start < 0 || !Array.isArray(edit.after) || !Array.isArray(edit.before)
      || !edit.after.every(line => typeof line === 'string') || !edit.before.every(line => typeof line === 'string')
      || !edit.after.length && !edit.before.length || edit.start + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Post-merge exact inverse source differs');
    lines.splice(edit.start, edit.after.length, ...edit.before); boundary = edit.start;
  }
  const before = lines.join('');
  if (before !== row.predecessor.raw_utf8 || sha(before) !== row.predecessor.sha256
    || Buffer.byteLength(before) !== row.predecessor.bytes) throw Error('Post-merge complete predecessor differs');
  return before;
}
for (const row of postMergeSourceBinding.sources) projectPostMergeSource(row.file, row.current.raw_utf8);

export const readPostMergeHistoricalSource = ((file: Parameters<typeof readDiskFileSync>[0], options?: Parameters<typeof readDiskFileSync>[1]) => {
  const value = readDiskFileSync(file, options);
  if (typeof file === 'number') return value;
  const path = resolve(typeof file === 'string' ? file : 'href' in file ? fileURLToPath(file.href) : decode(file));
  const name = relative(root, path).replace(/\\/g, '/');
  if (!files.includes(name)) return value;
  const previous = projectPostMergeSource(name, typeof value === 'string' ? value : decode(value));
  return typeof value === 'string' ? previous : Buffer.from(previous, 'utf8');
}) as typeof readDiskFileSync;
