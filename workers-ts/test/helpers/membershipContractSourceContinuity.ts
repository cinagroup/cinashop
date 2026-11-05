/** Closed historical views for dated proofs. Runtime and current acceptance
 * keep reading the actual implementation. This leaf imports no older reader:
 * post-merge/merge/route adapters depend on it, never the other way around. */
import { createHash } from 'node:crypto';
import { readFileSync as readDiskFileSync, readdirSync, lstatSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEMBERSHIP_SOURCE_CONTINUITY_FILE = 'workers-ts/test/fixtures/membership-contract-source-continuity-20261104.json';
export const MEMBERSHIP_SOURCE_CONTINUITY_SHA = 'e789b6ee0349439223c54ddde8341464537189d70a9487a138c1149ef13d0f58';
const canonicalSha = '9ca2b57e7884981d0bcbdd90fb2a0fb5e77d32c5eb72a41af8dedc60c4e1fb00';
const root = resolve(import.meta.dirname, '../../..');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const blob = (value: string) => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex');
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);

export interface MembershipHistoryImage {
  bytes: number; sha256: string; gitBlobSha1: string;
}
export interface MembershipHistoryEdit {
  start: number; after: string[]; before: string[];
  anchorStart: number; anchor: string[];
}
interface Origin { commit: string; path: string; gitBlobSha1: string }
export interface MembershipHistorySource {
  file: string; current: MembershipHistoryImage; historical: MembershipHistoryImage;
  inverseEdits: MembershipHistoryEdit[];
  historicalOrigin: Origin;
  gitEvolution: {
    baseCommit: string; baseImage: MembershipHistoryImage; currentEqualsBase: boolean;
    localDeltaInverseEdits: MembershipHistoryEdit[]; committedPathHistory: string[];
  };
}
interface Wiring {
  file: string; current: MembershipHistoryImage; historical: MembershipHistoryImage;
  inverseEdits: MembershipHistoryEdit[]; historicalOrigin: Origin;
}
export interface MembershipContractSourceContinuityProof {
  schema: string; baseCommit: string; mergeCommit: string; postMergeCommit: string;
  boundary: string; sourceViewPolicy: string;
  sources: MembershipHistorySource[]; wiring: Wiring[];
  routeSet: {
    file: string; addedRoute: string; introducingCommit: string;
    current: { count: number; sortedJsonSha256: string };
    historical: { count: number; sortedJsonSha256: string };
  };
  report: {
    current: MembershipHistoryImage; historical: MembershipHistoryImage;
    inverseEdits: MembershipHistoryEdit[]; historicalOrigin: Origin;
    actualGenerationProof: { sha256: string; reportSha256: string; builderInputCount: number };
    inputFiles: Array<{ file: string; bytes: number; sha256: string }>;
  };
  preservedProofs: Array<{ file: string; bytes: number; sha256: string }>;
  originalFourSourceTests: Array<{ file: string; bytes: number; sha256: string; gitBlobSha1: string }>;
}

function same(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(message);
}
function whole(source: string, image: MembershipHistoryImage): boolean {
  return Buffer.byteLength(source) === image.bytes && sha(source) === image.sha256 && blob(source) === image.gitBlobSha1;
}
function image(value: MembershipHistoryImage): void {
  if (!Number.isSafeInteger(value?.bytes) || value.bytes < 1 || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !/^[a-f0-9]{40}$/.test(value.gitBlobSha1)) throw Error('Membership continuity image metadata differs');
}
function inverse(source: string, current: MembershipHistoryImage, historical: MembershipHistoryImage,
  edits: MembershipHistoryEdit[]): string {
  if (!whole(source, current)) throw Error('Membership continuity complete current source differs');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (!Array.isArray(edits) || !edits.length) throw Error('Membership continuity exact inverse edits absent');
  let boundary = 0;
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.start) || edit.start < boundary || edit.start < 0
      || !Array.isArray(edit.after) || !Array.isArray(edit.before)
      || !edit.after.every(line => typeof line === 'string') || !edit.before.every(line => typeof line === 'string')
      || !edit.after.length && !edit.before.length || edit.start + edit.after.length > lines.length
      || !Number.isSafeInteger(edit.anchorStart) || edit.anchorStart < 0 || !Array.isArray(edit.anchor) || !edit.anchor.length
      || !edit.anchor.every(line => typeof line === 'string')
      || edit.anchorStart > edit.start || edit.anchorStart + edit.anchor.length < edit.start + edit.after.length
      || edit.anchorStart + edit.anchor.length > lines.length
      || JSON.stringify(lines.slice(edit.start, edit.start + edit.after.length)) !== JSON.stringify(edit.after)
      || JSON.stringify(lines.slice(edit.anchorStart, edit.anchorStart + edit.anchor.length)) !== JSON.stringify(edit.anchor)
      || source.split(edit.anchor.join('')).length !== 2)
      throw Error('Membership continuity exact literal/range/unique anchor differs');
    boundary = edit.start + edit.after.length;
  }
  for (const edit of [...edits].reverse()) lines.splice(edit.start, edit.after.length, ...edit.before);
  const previous = lines.join('');
  if (!whole(previous, historical)) throw Error('Membership continuity complete historical source differs');
  return previous;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const raw = readDiskFileSync(resolve(root, MEMBERSHIP_SOURCE_CONTINUITY_FILE));
if (sha(raw) !== MEMBERSHIP_SOURCE_CONTINUITY_SHA) throw Error('Membership continuity immutable proof bytes differ');
export const membershipContractSourceContinuity = freeze(JSON.parse(decode(raw)) as MembershipContractSourceContinuityProof);
function verify(proof: MembershipContractSourceContinuityProof): void {
  if (proof !== membershipContractSourceContinuity && sha(JSON.stringify(proof)) !== canonicalSha)
    throw Error('Membership continuity complete proof differs');
}
function initialInventory(): void {
  const p = membershipContractSourceContinuity;
  if (sha(JSON.stringify(p)) !== canonicalSha || p.schema !== 'membership-contract-source-continuity/v1'
    || p.baseCommit !== '71fc0a2e3b42384b54d7cbd7be489d16543c51f3'
    || p.mergeCommit !== '3d4780a6a5816934f7b82b31132c0111a5f5065d'
    || p.postMergeCommit !== '53f212ddf1a1025c19642c92be795d5c245af483'
    || p.sources.length !== 43 || new Set(p.sources.map(row => row.file)).size !== 43
    || p.wiring.length !== 4 || new Set(p.wiring.map(row => row.file)).size !== 4)
    throw Error('Membership continuity complete scope differs');
  for (const row of [...p.sources, ...p.wiring]) {
    image(row.current); image(row.historical);
    if (row.current.sha256 === row.historical.sha256 || !row.inverseEdits.length
      || !/^[a-f0-9]{40}$/.test(row.historicalOrigin.commit)
      || row.historicalOrigin.path !== row.file || row.historicalOrigin.gitBlobSha1 !== row.historical.gitBlobSha1)
      throw Error('Membership continuity historical origin differs');
  }
  for (const row of p.sources) {
    const origin = row.gitEvolution; image(origin.baseImage);
    if (origin.baseCommit !== p.baseCommit || typeof origin.currentEqualsBase !== 'boolean'
      || !origin.committedPathHistory.every(commit => /^[a-f0-9]{40}$/.test(commit))
      || origin.currentEqualsBase && (JSON.stringify(row.current) !== JSON.stringify(origin.baseImage) || origin.localDeltaInverseEdits.length !== 0)
      || !origin.currentEqualsBase && origin.localDeltaInverseEdits.length === 0)
      throw Error('Membership continuity committed/local source origin differs');
  }
  image(p.report.current); image(p.report.historical);
  if (p.report.historicalOrigin.commit !== p.mergeCommit
    || p.report.historicalOrigin.path !== 'workers-ts/audit/admin-frontend-api-contracts.json'
    || p.report.historicalOrigin.gitBlobSha1 !== p.report.historical.gitBlobSha1
    || p.report.actualGenerationProof.reportSha256 !== p.report.current.sha256)
    throw Error('Membership continuity actual report origin differs');
  same(p.routeSet, {
    file: 'view/uniapp-ts/src/config/navigation.ts', addedRoute: '/pages/merchant/assignedOrders',
    introducingCommit: '64bfb958e3ae27216036cb028c2c1a4e1a58386d',
    current: { count: 154, sortedJsonSha256: '0eb0c11ffa0f17b74ee2b39289e6eac0c17893fd36bbfc49871330bdc9e374fc' },
    historical: { count: 153, sortedJsonSha256: 'a8d191b7feac8ebcc09c57812bf6010c580372cf275abc1d7c24f257891ecaad' },
  }, 'Membership continuity complete registered route metadata differs');
}
initialInventory();

/** The caller must present the full current image; an old image is never a
 * substitute. Every resulting predecessor is validated in full as well. */
export function projectMembershipHistoricalSource(file: string, source: string,
  proof = membershipContractSourceContinuity): string {
  verify(proof);
  const sourceRow = proof.sources.find(row => row.file === file);
  const row = sourceRow ?? proof.wiring.find(row => row.file === file);
  if (sourceRow && !sourceRow.gitEvolution.currentEqualsBase)
    inverse(source, sourceRow.current, sourceRow.gitEvolution.baseImage, sourceRow.gitEvolution.localDeltaInverseEdits);
  return row ? inverse(source, row.current, row.historical, row.inverseEdits) : source;
}
/** Older closed adapters may already hold their own valid historical image.
 * Only the exact new image is peeled here; all other inputs continue to those
 * adapters' unchanged whole-image checks, never an arbitrary hash fallback. */
export function peelMembershipHistoricalSourceIfPresent(file: string, source: string): string {
  const row = [...membershipContractSourceContinuity.sources, ...membershipContractSourceContinuity.wiring].find(row => row.file === file);
  return row && whole(source, row.current) ? projectMembershipHistoricalSource(file, source) : source;
}
function setHash(current: ReadonlySet<string>): string {
  return sha(JSON.stringify([...current].sort()));
}
export function projectMembershipHistoricalRoutes(current: ReadonlySet<string>, proof = membershipContractSourceContinuity): Set<string> {
  verify(proof); const p = proof.routeSet;
  if (current.size !== p.current.count || setHash(current) !== p.current.sortedJsonSha256 || !current.has(p.addedRoute))
    throw Error('Membership continuity complete current registered routes differ');
  const previous = new Set(current); previous.delete(p.addedRoute);
  if (previous.size !== p.historical.count || setHash(previous) !== p.historical.sortedJsonSha256)
    throw Error('Membership continuity complete historical registered routes differ');
  return previous;
}
export function peelMembershipHistoricalRoutesIfPresent(current: ReadonlySet<string>): Set<string> {
  const p = membershipContractSourceContinuity.routeSet;
  return current.size === p.current.count && setHash(current) === p.current.sortedJsonSha256
    ? projectMembershipHistoricalRoutes(current) : new Set(current);
}
/** Rebuild the actual AST report first. This only changes its historical view
 * after the complete actual report is verified; no metadata is ignored. */
export function assertMembershipReportInputInventory(files: ReadonlyArray<string>, proof = membershipContractSourceContinuity): void {
  verify(proof);
  same([...files].sort(), proof.report.inputFiles.map(row => row.file), 'Membership continuity complete actual report input inventory differs');
}
function assertReportInputFiles(proof: MembershipContractSourceContinuityProof): void {
  const files = ['workers-ts/scripts/admin-frontend-api-audit.ts', 'workers-ts/src/app.ts',
    'workers-ts/src/routes/adminapi.ts', 'workers-ts/src/routes/index.ts', 'workers-ts/src/routes/v1/index.ts'];
  // Match the original generation envelope: all TS/Vue files in both roots.
  // Its329 bound files include321 builder inputs and8 supplemental page models.
  function visit(directory: string): void {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const file = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('Membership continuity actual report input link differs');
      if (entry.isDirectory()) visit(file);
      else if (/\.(ts|vue)$/i.test(entry.name)) files.push(file);
    }
  }
  visit('view/admin-ts/src/api'); visit('view/admin-ts/src/pages');
  assertMembershipReportInputInventory(files, proof);
  for (const row of proof.report.inputFiles) {
    const file = resolve(root, row.file);
    if (!lstatSync(file).isFile()) throw Error('Membership continuity actual report input is not regular');
    const bytes = readDiskFileSync(file);
    if (bytes.byteLength !== row.bytes || sha(bytes) !== row.sha256)
      throw Error('Membership continuity actual report raw input differs');
  }
}
export function projectMembershipHistoricalReport<T>(current: T, proof = membershipContractSourceContinuity): T {
  verify(proof); assertReportInputFiles(proof);
  return JSON.parse(inverse(JSON.stringify(current, null, 2) + '\n', proof.report.current,
    proof.report.historical, proof.report.inverseEdits)) as T;
}

/** Historical reads preserve real UTF8/Buffer, URL/byte paths, file descriptor
 * bypass and unrelated files. The actual runtime never imports this reader. */
export const readMembershipContinuityHistoricalFile = ((file: Parameters<typeof readDiskFileSync>[0], options?: Parameters<typeof readDiskFileSync>[1]) => {
  const value = readDiskFileSync(file, options);
  if (typeof file === 'number') return value;
  const path = resolve(typeof file === 'string' ? file : 'href' in file ? fileURLToPath(file.href) : decode(file));
  const name = relative(root, path).replace(/\\/g, '/');
  if (![...membershipContractSourceContinuity.sources, ...membershipContractSourceContinuity.wiring].some(row => row.file === name)) return value;
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding && encoding !== 'utf8' && encoding !== 'utf-8') throw Error('Membership continuity historical reader requires exact UTF8 or bytes');
  const previous = projectMembershipHistoricalSource(name, typeof value === 'string' ? value : decode(value));
  return typeof value === 'string' ? previous : Buffer.from(previous, 'utf8');
}) as typeof readDiskFileSync;
