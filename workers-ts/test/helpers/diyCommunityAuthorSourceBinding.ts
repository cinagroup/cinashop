import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface CommunityAuthorSourceBinding {
  sources: Array<RouteSourceFollowup & { file: string }>;
  previous_report: { file: string; sha256: string };
  current_report: { file: string; sha256: string };
  counts_unchanged: unknown;
  backend_unchanged: boolean;
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/diy-community-author-source-binding-20261024.json'), 'utf8');
if (sha(raw) !== 'dc461dd1511ddad0148e9831d84bbff99f323426fe0ba1045381a7456ddc1633') throw Error('Community source/report binding bytes differ');
export const communityAuthorSourceBinding = JSON.parse(raw) as CommunityAuthorSourceBinding;

/** Peel only the exact pinned community increment before unchanged dated proofs. */
export function reverseCommunityAuthorSource(file: string, source: string, binding = communityAuthorSourceBinding): string {
  const entry = binding.sources.find(row => row.file === file);
  return entry ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), entry) : source;
}

/** The Axios inventory changes only two source hashes and three existing call lines.
 * Explicit anonymous fetch previews reuse existing routes outside this inventory. */
export function applyCommunityAuthorReport<T>(before: T, binding = communityAuthorSourceBinding): T {
  const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (sha(serialized(before)) !== binding.previous_report.sha256) throw Error('Community API complete predecessor differs');
  const result = structuredClone(before) as unknown as {
    counts: unknown; backend: unknown; frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>;
  };
  if (JSON.stringify(result.counts) !== JSON.stringify(binding.counts_unchanged) || binding.backend_unchanged !== true) throw Error('Community API predecessor metadata differs');
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(result[change.array]?.[change.index]) !== JSON.stringify(change.before)) throw Error('Community API exact predecessor row differs');
    result[change.array][change.index] = structuredClone(change.after);
  }
  if (JSON.stringify(result.backend) !== JSON.stringify((before as { backend?: unknown }).backend)) throw Error('Community API backend changed');
  if (sha(serialized(result)) !== binding.current_report.sha256) throw Error('Community API complete result differs');
  return result as unknown as T;
}
