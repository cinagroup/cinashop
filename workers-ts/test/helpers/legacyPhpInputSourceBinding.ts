/** One exact workflow predecessor for the new fixed PHP input steps. The older
 * two-layer proof and its assertions remain unchanged behind import-only wiring. */
import { createHash } from 'node:crypto';
import { readFileSync as readDiskFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_PHP_WORKFLOW_FILE = '.github/workflows/workers-runtime-linux.yml';
export const LEGACY_PHP_WORKFLOW_PROOF_FILE = 'workers-ts/test/fixtures/legacy-php-input-source-binding-20261103.json';
export const LEGACY_PHP_WORKFLOW_PROOF_SHA = 'e5427c63002e4def70c41cd63c5c1e06bc771d6a2dc7400622db972f98f13d47';
const root = resolve(import.meta.dirname, '../../..');
const predecessor = 'f2a848eb6b8375b292de33df2937e9c091673662';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
interface Image { bytes: number; sha256: string; raw_utf8: string; origins: string[] }
interface Edit { start: number; after: string[]; before: string[] }
export interface LegacyPhpWorkflowProof {
  format_version: number; file: string; predecessor_commit: string;
  images: { candidate: Image; predecessor: Image }; inverse_edits: Edit[];
  unchanged_proof: { file: string; sha256: string };
  legacy_imports: Array<{ file: string; before: Image; before_import: string; after_import: string }>;
  boundary: string;
}
const oldImports = [
  { file: 'workers-ts/test/helpers/uniCiWorkflowSourceBinding.ts', bytes: 9230,
    sha256: 'e7f5972dddaefba753ea2095ba8744ccac26218e22c9ed7084a0e4be89dab1b3',
    before: "import { readFileSync as readDiskFileSync } from 'node:fs';",
    after: "import { readLegacyPhpWorkflowPredecessor as readDiskFileSync } from './legacyPhpInputSourceBinding';" },
  { file: 'workers-ts/test/uni-ci-workflow-source-binding.test.ts', bytes: 8612,
    sha256: '6015d577e03a4eb9930cb957de307c99cd3e1d73c799e72435ebe13ed7282d5a',
    before: "import { readFileSync } from 'node:fs';",
    after: "import { readLegacyPhpWorkflowPredecessor as readFileSync } from './helpers/legacyPhpInputSourceBinding';" },
];
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(message);
}
function verifyImage(value: Image, bytes: number, digest: string, origins: string[]) {
  if (typeof value?.raw_utf8 !== 'string' || value.bytes !== bytes || value.sha256 !== digest
    || Buffer.byteLength(value.raw_utf8) !== bytes || sha(value.raw_utf8) !== digest)
    throw Error('Legacy PHP complete workflow image differs');
  equal(value.origins, origins, 'Legacy PHP workflow origin differs');
}
function verify(proof: LegacyPhpWorkflowProof) {
  if (proof.format_version !== 1 || proof.file !== LEGACY_PHP_WORKFLOW_FILE || proof.predecessor_commit !== predecessor)
    throw Error('Legacy PHP workflow proof scope differs');
  equal(Object.keys(proof.images).sort(), ['candidate', 'predecessor'], 'Legacy PHP workflow image scope differs');
  verifyImage(proof.images.candidate, 20868, '2dd8f68b57e6566fc19b02a7b8614f45501f5498c080f34a3f7b799f953f2c79', []);
  verifyImage(proof.images.predecessor, 19659, '30c49172a5fa6fa01a18131f344f614cf9e640b50fd59daa39209e54631aecce', [predecessor]);
  if (!Array.isArray(proof.inverse_edits) || proof.inverse_edits.length !== 5
    || sha(JSON.stringify(proof.inverse_edits)) !== 'ba84ed0576f18c52aaf14bd5c1a589019aed46a09759220453aa9188837c9f3b')
    throw Error('Legacy PHP exact inverse edits differ');
  equal(proof.unchanged_proof, { file: 'workers-ts/test/fixtures/uni-ci-workflow-source-binding-20261102.json',
    sha256: '72feefd0ae48a70f80edfc8c8124e880421754e50b45a496e9b284cc5023c1f0' }, 'Legacy PHP previous proof differs');
  if (!Array.isArray(proof.legacy_imports) || proof.legacy_imports.length !== oldImports.length)
    throw Error('Legacy PHP historical import scope differs');
  for (const [index, expected] of oldImports.entries()) {
    const value = proof.legacy_imports[index]!;
    if (value.file !== expected.file || value.before_import !== expected.before || value.after_import !== expected.after
      || value.before.raw_utf8.split(expected.before).length !== 2) throw Error('Legacy PHP historical import differs');
    verifyImage(value.before, expected.bytes, expected.sha256, [predecessor]);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const raw = readDiskFileSync(resolve(root, LEGACY_PHP_WORKFLOW_PROOF_FILE));
if (sha(raw) !== LEGACY_PHP_WORKFLOW_PROOF_SHA) throw Error('Legacy PHP exact workflow proof bytes differ');
export const legacyPhpWorkflowSourceBinding = freeze(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)) as LegacyPhpWorkflowProof);

export function projectLegacyPhpWorkflowPredecessor(file: string, source: string, proof = legacyPhpWorkflowSourceBinding) {
  if (file !== LEGACY_PHP_WORKFLOW_FILE) return source;
  verify(proof);
  if (source !== proof.images.candidate.raw_utf8 || sha(source) !== proof.images.candidate.sha256)
    throw Error('Legacy PHP current workflow source differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let boundary = lines.length;
  for (const edit of [...proof.inverse_edits].reverse()) {
    if (!Number.isSafeInteger(edit.start) || edit.start < 0 || !Array.isArray(edit.after) || !Array.isArray(edit.before)
      || edit.start + edit.after.length > boundary
      || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after))
      throw Error('Legacy PHP exact inverse source differs');
    lines.splice(edit.start, edit.after.length, ...edit.before); boundary = edit.start;
  }
  const result = lines.join('');
  if (result !== proof.images.predecessor.raw_utf8 || sha(result) !== proof.images.predecessor.sha256)
    throw Error('Legacy PHP complete workflow predecessor differs');
  return result;
}
projectLegacyPhpWorkflowPredecessor(LEGACY_PHP_WORKFLOW_FILE, legacyPhpWorkflowSourceBinding.images.candidate.raw_utf8);

export const readLegacyPhpWorkflowPredecessor = ((file: Parameters<typeof readDiskFileSync>[0], options?: Parameters<typeof readDiskFileSync>[1]) => {
  const value = readDiskFileSync(file, options);
  if (typeof file === 'number') return value;
  const path = resolve(typeof file === 'string' ? file : 'href' in file ? fileURLToPath(file.href)
    : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file));
  const name = relative(root, path).replace(/\\/g, '/');
  if (name !== LEGACY_PHP_WORKFLOW_FILE) return value;
  const current = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  const previous = projectLegacyPhpWorkflowPredecessor(name, current);
  return typeof value === 'string' ? previous : Buffer.from(previous);
}) as typeof readDiskFileSync;
