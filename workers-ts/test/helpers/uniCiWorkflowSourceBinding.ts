/** Explicit historical workflow readport. Runtime and current CI gate tests use
 * node:fs directly. Only the one frozen workflow maps through its two complete
 * reviewed predecessors; no other source, AST report or inventory is projected. */
import { createHash } from 'node:crypto';
import { readFileSync as readDiskFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNI_CI_WORKFLOW_FILE = '.github/workflows/workers-runtime-linux.yml';
export const UNI_CI_WORKFLOW_PROOF_FILE = 'workers-ts/test/fixtures/uni-ci-workflow-source-binding-20261102.json';
export const UNI_CI_WORKFLOW_PROOF_SHA = '72feefd0ae48a70f80edfc8c8124e880421754e50b45a496e9b284cc5023c1f0';
const root = resolve(import.meta.dirname, '../../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type ImageName = 'candidate' | 'parent' | 'merge';
interface Image { bytes: number; sha256: string; raw_utf8: string; origins: string[] }
interface InverseEdit { start: number; after: string[]; before: string[] }
interface InverseLayer { name: string; from: ImageName; to: ImageName; edits: InverseEdit[] }
export interface UniCiWorkflowProof {
  format_version: number; file: string; images: Record<ImageName, Image>;
  historical_change: { commit: string; parent_commit: string; same_image_at: string; changes: string[] };
  inverse_layers: InverseLayer[];
  legacy_fixture: { file: string; bytes: number; sha256: string };
  legacy_imports: Array<{ file: string; before: Image; before_import: string; after_import: string }>;
  boundary: string;
}
const parentCommit = '20f180ae24a88f40fe6d0a35c26d2cae0204ca01';
const b874Commit = 'b874c56accd2bfc12c13c3c2cd2652736df07d5e';
const b874Parent = '42756fe6946115fefdab1fe65fc36a30f210aba9';
const mergeCommit = '3d4780a6a5816934f7b82b31132c0111a5f5065d';
const images: Record<ImageName, Omit<Image, 'raw_utf8'>> = {
  candidate: { bytes: 19659, sha256: '30c49172a5fa6fa01a18131f344f614cf9e640b50fd59daa39209e54631aecce', origins: [] },
  parent: { bytes: 17030, sha256: 'fae6a6cf86ec9c020280565341781fa59b8a65796b6a6c8400585bf6e79f69f1', origins: [parentCommit, b874Commit] },
  merge: { bytes: 15950, sha256: '95be73a9c5199114841ff8266304bcc6bdf7c8355fb0bece2e249b43cfb69dbd', origins: [b874Parent, mergeCommit] },
};
const legacyImports = [
  { file: 'workers-ts/test/helpers/migrationMergeSourceBinding.ts', sha256: '4b3785f4313ad1cc0d6ca9de4233c2ed7ccd4c9715b01c34429201a013c96920',
    before: "import {readFileSync as diskReadFileSync} from 'node:fs';",
    after: "import {readUniCiHistoricalWorkflow as diskReadFileSync} from './uniCiWorkflowSourceBinding';" },
  { file: 'workers-ts/test/migration-merge-source-binding.test.ts', sha256: 'cf11373df2e7a3414083523a2f56985c6184c969c9b2d0af202cc6622636b8ec',
    before: "import {readFileSync} from 'node:fs';",
    after: "import {readUniCiHistoricalWorkflow as readFileSync} from './helpers/uniCiWorkflowSourceBinding';" },
];
function equal(value: unknown, expected: unknown, message: string) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw Error(message);
}
function verifyImage(image: Image, expected: Omit<Image, 'raw_utf8'>) {
  if (typeof image?.raw_utf8 !== 'string' || !Number.isSafeInteger(image.bytes)
    || image.bytes !== expected.bytes || image.sha256 !== expected.sha256
    || Buffer.byteLength(image.raw_utf8, 'utf8') !== image.bytes || sha(image.raw_utf8) !== image.sha256)
    throw Error('Uni CI complete workflow image differs');
  equal(image.origins, expected.origins, 'Uni CI immutable workflow origin differs');
}
function verifyProof(proof: UniCiWorkflowProof) {
  if (proof?.format_version !== 1 || proof.file !== UNI_CI_WORKFLOW_FILE) throw Error('Uni CI workflow proof scope differs');
  equal(Object.keys(proof.images).sort(), ['candidate', 'merge', 'parent'], 'Uni CI complete workflow images differ');
  for (const name of ['candidate', 'parent', 'merge'] as const) verifyImage(proof.images[name], images[name]);
  if (proof.historical_change.commit !== b874Commit || proof.historical_change.parent_commit !== b874Parent
    || proof.historical_change.same_image_at !== parentCommit) throw Error('Uni CI b874 history differs');
  if (!Array.isArray(proof.inverse_layers) || proof.inverse_layers.length !== 2) throw Error('Uni CI requires both exact inverse layers');
  equal(proof.inverse_layers.map(({ name, from, to }) => [name, from, to]), [
    ['uni-ci-partition', 'candidate', 'parent'], ['b874-post-merge-validation', 'parent', 'merge'],
  ], 'Uni CI inverse layer order differs');
  equal(proof.inverse_layers.map(layer => sha(JSON.stringify(layer))), [
    '0cb7201e570d4551bf748e6ffc8650602ece2c98cb1fd2f5e87160874ccac4f4',
    'b259c1d3ec8c0932f76ac9548ea128d4884065e26f34d2b8a57f4f06125df7db',
  ], 'Uni CI exact inverse layer differs');
  equal(proof.legacy_fixture, { file: 'workers-ts/test/fixtures/migration-merge-source-binding-20261030.json',
    bytes: 7185263, sha256: '11b657f6c1d223bcc730a21c604c4a89b61d379ac4145ea5b4938559db7ce4cb' }, 'Uni CI old merge proof differs');
  if (!Array.isArray(proof.legacy_imports) || proof.legacy_imports.length !== legacyImports.length) throw Error('Uni CI readport import scope differs');
  for (const [index, expected] of legacyImports.entries()) {
    const actual = proof.legacy_imports[index]!;
    if (actual.file !== expected.file || actual.before_import !== expected.before || actual.after_import !== expected.after
      || actual.before.raw_utf8.split(expected.before).length !== 2) throw Error('Uni CI historical import differs');
    verifyImage(actual.before, { bytes: Buffer.byteLength(actual.before.raw_utf8), sha256: expected.sha256, origins: [parentCommit] });
  }
}
function inverse(source: string, layer: InverseLayer, from: Image, to: Image) {
  if (source !== from.raw_utf8 || sha(source) !== from.sha256) throw Error('Uni CI current workflow source differs');
  if (!Array.isArray(layer.edits) || !layer.edits.length) throw Error('Uni CI inverse edits absent');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = lines.length;
  for (const edit of [...layer.edits].reverse()) {
    if (!Number.isSafeInteger(edit.start) || edit.start < 0 || !Array.isArray(edit.after) || !Array.isArray(edit.before)
      || !edit.after.every(line => typeof line === 'string') || !edit.before.every(line => typeof line === 'string')
      || !edit.after.length && !edit.before.length || edit.start + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Uni CI exact inverse edit differs');
    lines.splice(edit.start, edit.after.length, ...edit.before); boundary = edit.start;
  }
  const result = lines.join('');
  if (result !== to.raw_utf8 || Buffer.byteLength(result) !== to.bytes || sha(result) !== to.sha256)
    throw Error('Uni CI complete workflow predecessor differs');
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readDiskFileSync(resolve(root, UNI_CI_WORKFLOW_PROOF_FILE));
if (sha(raw) !== UNI_CI_WORKFLOW_PROOF_SHA) throw Error('Uni CI workflow exact proof bytes differ');
export const uniCiWorkflowSourceBinding = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) as UniCiWorkflowProof);

/** A known historical image is never accepted as a current-source fallback. */
export function projectUniCiWorkflowSource(file: string, source: string, view: 'parent' | 'merge' = 'merge', proof = uniCiWorkflowSourceBinding): string {
  if (file !== UNI_CI_WORKFLOW_FILE) return source;
  if (view !== 'parent' && view !== 'merge') throw Error('Uni CI historical view differs');
  verifyProof(proof);
  const parent = inverse(source, proof.inverse_layers[0]!, proof.images.candidate, proof.images.parent);
  const merged = inverse(parent, proof.inverse_layers[1]!, proof.images.parent, proof.images.merge);
  return view === 'parent' ? parent : merged;
}
// Verify the full stored two-layer derivation even before the first workflow read.
projectUniCiWorkflowSource(UNI_CI_WORKFLOW_FILE, uniCiWorkflowSourceBinding.images.candidate.raw_utf8);

export const readUniCiHistoricalWorkflow = ((file: Parameters<typeof readDiskFileSync>[0], options?: Parameters<typeof readDiskFileSync>[1]) => {
  const value = readDiskFileSync(file, options);
  if (typeof file === 'number') return value;
  const path = resolve(typeof file === 'string' ? file : 'href' in file ? fileURLToPath(file.href)
    : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file));
  const name = relative(root, path).replace(/\\/g, '/');
  if (name !== UNI_CI_WORKFLOW_FILE) return value;
  const current = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  const historical = projectUniCiWorkflowSource(name, current);
  return typeof value === 'string' ? historical : Buffer.from(historical, 'utf8');
}) as typeof readDiskFileSync;
