import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface LiveBroadcastAuthorSourceBinding {
  sources: Array<RouteSourceFollowup & { file: string }>;
  previous_report: { file: string; sha256: string };
  current_report: { file: string; sha256: string };
  counts_unchanged: unknown;
  backend_unchanged: boolean;
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/diy-live-broadcast-author-source-binding-20261025.json'), 'utf8');
if (sha(raw) !== '5851245158af821c0ec139aceb66b20494770a319cd20e0b079dff0cb8acece7') throw Error('LiveBroadcast source/report binding bytes differ');
export const liveBroadcastAuthorSourceBinding = JSON.parse(raw) as LiveBroadcastAuthorSourceBinding;

/** Peel only this exact increment before unchanged seckill/bargain/combination/presale/points/coupon/promotion/community/editorial/follow proofs. */
export function reverseLiveBroadcastAuthorSource(file: string, source: string, binding = liveBroadcastAuthorSourceBinding): string {
  const entry = binding.sources.find(row => row.file === file);
  return entry ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), entry) : source;
}

/** No new audited Axios call or registered route. Guest previews reuse existing
 * anonymous GET /api/wechat/live outside this inventory. No purchase, cart or order action. */
export function applyLiveBroadcastAuthorReport<T>(before: T, binding = liveBroadcastAuthorSourceBinding): T {
  const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (sha(serialized(before)) !== binding.previous_report.sha256) throw Error('LiveBroadcast API complete predecessor differs');
  const result = structuredClone(before) as unknown as {
    counts: unknown; backend: unknown; frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>;
  };
  if (JSON.stringify(result.counts) !== JSON.stringify(binding.counts_unchanged) || binding.backend_unchanged !== true) throw Error('LiveBroadcast API predecessor metadata differs');
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(result[change.array]?.[change.index]) !== JSON.stringify(change.before)) throw Error('LiveBroadcast API exact predecessor row differs');
    result[change.array][change.index] = structuredClone(change.after);
  }
  if (JSON.stringify(result.backend) !== JSON.stringify((before as { backend?: unknown }).backend)) throw Error('LiveBroadcast API backend changed');
  if (sha(serialized(result)) !== binding.current_report.sha256) throw Error('LiveBroadcast API complete result differs');
  return result as unknown as T;
}
