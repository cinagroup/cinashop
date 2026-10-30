import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface CommunityAuthorSourceBinding {
  schema: string; php_ref: string;
  sources: Array<RouteSourceFollowup & {file: string; before_ref: string}>;
  previous_report: {sha256: string; base_file: string; base_sha256: string; binding_chain: Array<{file: string; sha256: string}>};
  current_report: {sha256: string; raw_capture: {sha256: string; bytes: number; serialization: string}; compact: {sha256: string; bytes: number}};
  report_changes: Array<{array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown>}>;
  consumer_sources: Array<{file: string; sha256: string}>;
  defaults_fixture: {file: string; sha256: string; top_level_keys: number};
  condition_fixture: {file: string; sha256: string; php_method_cases: number};
  php_sources: Array<{path: string; sha256: string; bytes: number}>;
  default_bindings: Array<{path: Array<string | number>; source: string; literal: string | number}>;
  assets: Array<{public_path: string; php_path: string; php_ref: string; sha256: string; bytes: number; admin_file: string; uni_file: string}>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/diy-community-author-source-binding-20261025.json'), 'utf8');
if (digest(raw) !== '536ddbfcf36f8860717b226712311fc6ff41a2feb95b753097a576e15cfdcb86') throw Error('Community source-binding fixture bytes differ');
export const communityAuthorSourceBinding = JSON.parse(raw) as CommunityAuthorSourceBinding;
const sourceFiles = ['view/admin-ts/src/pages/content/DiseList.vue', 'workers-ts/src/services/content/DiyEditorialMediaPolicy.ts', 'view/uniapp-ts/src/utils/diyEditorialMediaLease.ts'];
/** Only the three whole-source-pinned community additions precede the old inverses. */
export function reverseCommunityAuthorSource(file: string, source: string, binding = communityAuthorSourceBinding): string {
  if (binding.sources.length !== sourceFiles.length || new Set(binding.sources.map(row => row.file)).size !== sourceFiles.length || binding.sources.some(row => !sourceFiles.includes(row.file))) throw Error('Community exact source inventory differs');
  const entry = binding.sources.find(row => row.file === file);
  return entry ? reverseRouteSourceFollowup(source, entry) : source;
}
function reconstruct<T>(input: T, reverse: boolean, binding: CommunityAuthorSourceBinding): T {
  const hash = (value: unknown) => digest(JSON.stringify(value, null, 2) + '\n');
  if (hash(input) !== (reverse ? binding.current_report.sha256 : binding.previous_report.sha256)) throw Error('Community API complete input differs');
  if (binding.report_changes.length !== 4) throw Error('Community API expected four exact existing row changes');
  const result = structuredClone(input) as unknown as {frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>};
  const seen = new Set<string>();
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || !Number.isSafeInteger(change.index) || change.index < 0 || seen.has(`${change.array}:${change.index}`)) throw Error('Community API invalid or repeated row delta');
    const values = result[change.array], from = reverse ? change.after : change.before, to = reverse ? change.before : change.after;
    if (!Array.isArray(values) || JSON.stringify(values[change.index]) !== JSON.stringify(from)) throw Error('Community API exact input row differs');
    seen.add(`${change.array}:${change.index}`); values[change.index] = structuredClone(to);
  }
  if (hash(result) !== (reverse ? binding.previous_report.sha256 : binding.current_report.sha256)) throw Error('Community API complete result differs');
  return result as unknown as T;
}
export const applyCommunityAuthorReport = <T>(before: T, binding = communityAuthorSourceBinding): T => reconstruct(before, false, binding);
export const reverseCommunityAuthorReport = <T>(after: T, binding = communityAuthorSourceBinding): T => reconstruct(after, true, binding);
