import { peelReviewedAdminSourceTailIfPresent } from './reviewedAdminSourceTailBinding';
import { peelAdminLevelDefinitionReport } from './adminLevelDefinitionSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

type JsonPath = Array<string | number>;
export interface MigrationAuditSourceProof extends RouteSourceFollowup {
  file: string; before_ref: string; before_bytes: number; after_bytes: number;
}
export interface MigrationAuditFollowupSourceBinding {
  schema: string; base_ref: string; current_ref: string;
  sources: MigrationAuditSourceProof[]; harness_sources: MigrationAuditSourceProof[];
  api_report: {
    before_sha256: string; after_sha256: string; before_bytes: number; after_bytes: number;
    operations: Array<{ path: JsonPath; before: string | number; after: string | number }>;
    before_counts: Record<string, number>; after_counts: Record<string, number>;
    frontend_sources: number; registered_routes: number;
  };
  preserved_files: Array<{ file: string; bytes: number; sha256: string }>;
  boundary: string;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/migration-audit-followup-source-binding-20261026.json'), 'utf8');
if (sha(raw) !== '0ab82e48ec36dd39aaae6c00ee9ed7c4ae4a9850371e0d4d48c045846e6b1236') throw Error('Migration audit followup fixture bytes differ');
export const migrationAuditFollowupSourceBinding = JSON.parse(raw) as MigrationAuditFollowupSourceBinding;
const sourceFiles = ['workers-ts/src/routes/v1/index.ts', 'view/admin-ts/src/api/membership.ts'];
const harnessFiles = ['workers-ts/test/helpers/adminUserFilterSourceBinding.ts'];
function inventory(binding: MigrationAuditFollowupSourceBinding): void {
  if (binding.schema !== 'cinashop.migration-audit-followup-source-binding.v1'
    || binding.base_ref !== 'b3760bf8b10f58913afaeafc04ebb133f09de967'
    || binding.current_ref !== 'b7dcd8cfd27a73db2cd5128644fd9d286ea23d86'
    || binding.sources.length !== 2 || binding.harness_sources.length !== 1
    || binding.sources.some((row, index) => row.file !== sourceFiles[index] || row.before_ref !== binding.base_ref)
    || binding.harness_sources.some((row, index) => row.file !== harnessFiles[index] || row.before_ref !== binding.base_ref)
    || sha(JSON.stringify(binding.sources)) !== '3ccfa0aa3020c2dc5eaff646254e1a9cc2a6c8c926ab425ae409dafb632bc70a'
    || sha(JSON.stringify(binding.harness_sources)) !== 'a045fd6d317d8e9052c54d2410c01ebc09d4df854b35da5e48c1d9470fa4861a'
    || sha(JSON.stringify(binding.api_report)) !== 'ba530762eb5d132af23deb6afdd80007eb402f7cfccfb8d9c5f777a82ce7e374'
    || sha(JSON.stringify(binding.preserved_files)) !== '50fbd4ac7070ca9f51af8cf753f83f5cadd48d807ece1f90b2df9b4b1bb6fca5') {
    throw Error('Migration audit exact source/report/harness inventory differs');
  }
}
function reverseSource(file: string, source: string, entries: MigrationAuditSourceProof[]): string {
  const entry = entries.find(row => row.file === file);
  if (!entry) return source;
  if (Buffer.byteLength(source) !== entry.after_bytes) throw Error('Migration audit current whole-source bytes differ');
  const previous = reverseRouteSourceFollowup(source, entry);
  if (Buffer.byteLength(previous) !== entry.before_bytes) throw Error('Migration audit historical whole-source bytes differ');
  return previous;
}
/** Only the two reviewed production sources are peeled; every extra byte is rejected. */
export function reverseMigrationAuditSource(file: string, source: string, binding = migrationAuditFollowupSourceBinding): string {
  inventory(binding);
  return reverseSource(file, peelReviewedAdminSourceTailIfPresent(file, source), binding.sources);
}
/** Restore the exact older test-helper bytes without entering the production inverse recursively. */
export function reverseMigrationAuditHarnessSource(file: string, source: string, binding = migrationAuditFollowupSourceBinding): string {
  inventory(binding);
  return reverseSource(file, source, binding.harness_sources);
}
function member(value: unknown, key: string | number): unknown {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Migration audit exact report path missing');
  return (value as Record<string | number, unknown>)[key];
}
function at(value: unknown, path: JsonPath): unknown {
  for (const key of path) value = member(value, key);
  return value;
}
function reportBridge<T>(input: T, reverse: boolean, binding: MigrationAuditFollowupSourceBinding): T {
  inventory(binding);
  const proof = binding.api_report, pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  const incoming = pretty(input);
  if (sha(incoming) !== (reverse ? proof.after_sha256 : proof.before_sha256)
    || Buffer.byteLength(incoming) !== (reverse ? proof.after_bytes : proof.before_bytes)) throw Error('Migration audit complete report input differs');
  const result = structuredClone(input), operations = reverse ? [...proof.operations].reverse() : proof.operations;
  for (const operation of operations) {
    if (!operation.path.length) throw Error('Migration audit whole-report replacement forbidden');
    const parent = at(result, operation.path.slice(0, -1)), key = operation.path.at(-1)!;
    if (member(parent, key) !== (reverse ? operation.after : operation.before)) throw Error('Migration audit exact report scalar differs');
    (parent as Record<string | number, unknown>)[key] = reverse ? operation.before : operation.after;
  }
  const outgoing = pretty(result);
  if (sha(outgoing) !== (reverse ? proof.before_sha256 : proof.after_sha256)
    || Buffer.byteLength(outgoing) !== (reverse ? proof.before_bytes : proof.after_bytes)) throw Error('Migration audit complete report result differs');
  return result;
}
/** The old applyAdminUserFilterReport remains historical; this explicit bridge alone advances it. */
export const applyMigrationAuditReport = <T>(historical: T, binding = migrationAuditFollowupSourceBinding): T => reportBridge(historical, false, binding);
export const reverseMigrationAuditReport = <T>(current: T, binding = migrationAuditFollowupSourceBinding): T => reportBridge(peelAdminLevelDefinitionReport(current), true, binding);
