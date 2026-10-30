import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface FollowAuthorSourceBinding {
  source: RouteSourceFollowup & { file: string };
  previous_report: { file: string; sha256: string };
  current_report: { file: string; sha256: string };
  counts_unchanged: unknown;
  backend_unchanged: boolean;
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/diy-follow-author-source-binding-20261024.json'), 'utf8');
if (sha(raw) !== '7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8') throw Error('Follow source/report binding bytes differ');
export const followAuthorSourceBinding = JSON.parse(raw) as FollowAuthorSourceBinding;

/** Peel this exact source layer before the existing state-author inverse. */
export function reverseFollowAuthorSource(file: string, source: string, binding = followAuthorSourceBinding): string {
  return file === binding.source.file ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), binding.source) : source;
}

/** Retain the complete state-author report; change only four pinned rows. */
export function applyFollowAuthorReport<T>(before: T, binding = followAuthorSourceBinding): T {
  const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (sha(serialized(before)) !== binding.previous_report.sha256) throw Error('Follow API complete predecessor differs');
  const result = structuredClone(before) as unknown as {
    counts: unknown; backend: unknown; frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>;
  };
  if (JSON.stringify(result.counts) !== JSON.stringify(binding.counts_unchanged) || binding.backend_unchanged !== true) throw Error('Follow API predecessor metadata differs');
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(result[change.array]?.[change.index]) !== JSON.stringify(change.before)) throw Error('Follow API exact predecessor row differs');
    result[change.array][change.index] = structuredClone(change.after);
  }
  if (JSON.stringify(result.backend) !== JSON.stringify((before as { backend?: unknown }).backend)) throw Error('Follow API backend changed');
  if (sha(serialized(result)) !== binding.current_report.sha256) throw Error('Follow API complete result differs');
  return result as unknown as T;
}
