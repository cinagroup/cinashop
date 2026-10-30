import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface PointsAuthorSourceBinding {
  sources: Array<RouteSourceFollowup & { file: string }>;
  previous_report: { file: string; sha256: string };
  current_report: { file: string; sha256: string };
  counts_unchanged: unknown;
  backend_unchanged: boolean;
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/diy-points-author-source-binding-20261025.json'), 'utf8');
if (sha(raw) !== 'cedec475e804f04130567dbf77cf860b8f2eef14847465f629e45f13e7952e7b') throw Error('Points source/report binding bytes differ');
export const pointsAuthorSourceBinding = JSON.parse(raw) as PointsAuthorSourceBinding;

/** Peel only this exact increment before unchanged coupon/promotion/community/editorial/follow proofs. */
export function reversePointsAuthorSource(file: string, source: string, binding = pointsAuthorSourceBinding): string {
  const entry = binding.sources.find(row => row.file === file);
  return entry ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), entry) : source;
}

/** No new audited Axios call or registered route. Guest previews reuse existing
 * anonymous GET /api/store_integral/list outside this inventory. No exchange, cart or order action. */
export function applyPointsAuthorReport<T>(before: T, binding = pointsAuthorSourceBinding): T {
  const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (sha(serialized(before)) !== binding.previous_report.sha256) throw Error('Points API complete predecessor differs');
  const result = structuredClone(before) as unknown as {
    counts: unknown; backend: unknown; frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>;
  };
  if (JSON.stringify(result.counts) !== JSON.stringify(binding.counts_unchanged) || binding.backend_unchanged !== true) throw Error('Points API predecessor metadata differs');
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(result[change.array]?.[change.index]) !== JSON.stringify(change.before)) throw Error('Points API exact predecessor row differs');
    result[change.array][change.index] = structuredClone(change.after);
  }
  if (JSON.stringify(result.backend) !== JSON.stringify((before as { backend?: unknown }).backend)) throw Error('Points API backend changed');
  if (sha(serialized(result)) !== binding.current_report.sha256) throw Error('Points API complete result differs');
  return result as unknown as T;
}
