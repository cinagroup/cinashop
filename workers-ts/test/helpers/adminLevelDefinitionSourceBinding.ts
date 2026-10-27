import { peelMembershipRightsReport } from './membershipRightsSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

type JsonPath = Array<string | number>;
interface SourceProof extends RouteSourceFollowup {
  file: string; before_ref: string; before_bytes: number; after_bytes: number;
  before_git_blob_sha1: string; after_git_blob_sha1: string;
}
type ReportOperation =
  | { kind: 'replace'; path: JsonPath; before: string | number; after: string | number }
  | { kind: 'splice'; path: JsonPath; index: number; before: unknown[]; after: unknown[] };
export interface AdminLevelDefinitionSourceBinding {
  schema: string; base_ref: string; level_ref: string; current_ref: string; php_ref: string;
  sources: SourceProof[]; harness_sources: SourceProof[];
  production_patch: { before_ref: string; after_ref: string; sha256: string; bytes: number; unified_diff: string };
  api_report: { before_sha256: string; after_sha256: string; before_bytes: number; after_bytes: number; operations: ReportOperation[] };
  preserved_files: Array<{ file: string; sha256: string; bytes: number }>;
  boundary: string;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/admin-level-definition-source-binding-20261026.json'), 'utf8');
if (sha(raw) !== '745e8dcb2a924a02d825bf0cc67e2db517a0ec181d343a3f6828c50c6869c431') throw Error('Admin level-definition fixture bytes differ');
export const adminLevelDefinitionSourceBinding = JSON.parse(raw) as AdminLevelDefinitionSourceBinding;
function inventory(binding: AdminLevelDefinitionSourceBinding): void {
  if (sha(JSON.stringify(binding)) !== '4857278f5e51c3092df38b6f338b12704ff8aa82913e4f6ee76035b17682883b') {
    throw Error('Admin level-definition exact source/report/harness inventory differs');
  }
}
const blob = (source: string) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
function reverseSource(file: string, source: string, entries: SourceProof[]): string {
  const entry = entries.find(row => row.file === file);
  if (!entry) return source;
  if (Buffer.byteLength(source) !== entry.after_bytes || blob(source) !== entry.after_git_blob_sha1) throw Error('Admin level-definition current whole source differs');
  const previous = reverseRouteSourceFollowup(source, entry);
  if (Buffer.byteLength(previous) !== entry.before_bytes || blob(previous) !== entry.before_git_blob_sha1) throw Error('Admin level-definition predecessor whole source differs');
  return previous;
}
/** Only the actual ordinary-level API and delegated controller edits can be peeled. */
export function reverseAdminLevelDefinitionSource(file: string, source: string, binding = adminLevelDefinitionSourceBinding): string {
  inventory(binding); return reverseSource(file, source, binding.sources);
}
/** Preserve the complete predecessor of each of the three explicit test adapters. */
export function reverseAdminLevelDefinitionHarnessSource(file: string, source: string, binding = adminLevelDefinitionSourceBinding): string {
  inventory(binding); return reverseSource(file, source, binding.harness_sources);
}
function member(value: unknown, key: string | number): unknown {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Admin level-definition exact report path missing');
  return (value as Record<string | number, unknown>)[key];
}
function at(value: unknown, path: JsonPath): unknown {
  for (const key of path) value = member(value, key);
  return value;
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function reportBridge<T>(input: T, reverse: boolean, binding: AdminLevelDefinitionSourceBinding): T {
  inventory(binding);
  const p = binding.api_report, incoming = pretty(input);
  if (sha(incoming) !== (reverse ? p.after_sha256 : p.before_sha256)
    || Buffer.byteLength(incoming) !== (reverse ? p.after_bytes : p.before_bytes)) throw Error('Admin level-definition complete report input differs');
  const result = structuredClone(input), operations = reverse ? [...p.operations].reverse() : p.operations;
  for (const operation of operations) {
    if (!operation.path.length) throw Error('Admin level-definition whole-report replacement forbidden');
    if (operation.kind === 'replace') {
      const parent = at(result, operation.path.slice(0, -1)), key = operation.path.at(-1)!;
      if (member(parent, key) !== (reverse ? operation.after : operation.before)) throw Error('Admin level-definition exact report scalar differs');
      (parent as Record<string | number, unknown>)[key] = reverse ? operation.before : operation.after;
    } else {
      const values = at(result, operation.path), from = reverse ? operation.after : operation.before, to = reverse ? operation.before : operation.after;
      if (!Array.isArray(values) || !Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index + from.length > values.length
        || !equal(values.slice(operation.index, operation.index + from.length), from)) throw Error('Admin level-definition exact report splice differs');
      values.splice(operation.index, from.length, ...structuredClone(to));
    }
  }
  const outgoing = pretty(result);
  if (sha(outgoing) !== (reverse ? p.before_sha256 : p.after_sha256)
    || Buffer.byteLength(outgoing) !== (reverse ? p.before_bytes : p.after_bytes)) throw Error('Admin level-definition complete report result differs');
  return result;
}
export const applyAdminLevelDefinitionReport = <T>(historical: T, binding = adminLevelDefinitionSourceBinding): T => reportBridge(historical, false, binding);
export const reverseAdminLevelDefinitionReport = <T>(current: T, binding = adminLevelDefinitionSourceBinding): T => reportBridge(peelMembershipRightsReport(current), true, binding);
/** The historical migration API still accepts its one exact original result;
 * current live input must match the independently captured complete level report. */
export function peelAdminLevelDefinitionReport<T>(input: T, binding = adminLevelDefinitionSourceBinding): T {
  inventory(binding);
  const incoming = pretty(input), p = binding.api_report;
  if (sha(incoming) === p.before_sha256 && Buffer.byteLength(incoming) === p.before_bytes) return input;
  return reverseAdminLevelDefinitionReport(input, binding);
}
