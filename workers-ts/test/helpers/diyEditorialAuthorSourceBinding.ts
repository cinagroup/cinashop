import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface EditorialAuthorSourceBinding {
  source: RouteSourceFollowup & { file: string };
  previous_report: { file: string; sha256: string };
  current_report: { file: string; sha256: string };
  counts_unchanged: unknown;
  backend_unchanged: boolean;
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/diy-editorial-author-source-binding-20261024.json'), 'utf8');
if (sha(raw) !== '8b43939285cfee0f58a464e2757ea335f116c53cfa42210c02e08681d6ad8579') throw Error('Editorial source/report binding bytes differ');
export const editorialAuthorSourceBinding = JSON.parse(raw) as EditorialAuthorSourceBinding;

/** Peel exactly this layer before applying unchanged follow/state historical inverses. */
export function reverseEditorialAuthorSource(file: string, source: string, binding = editorialAuthorSourceBinding): string {
  return file === binding.source.file ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), binding.source) : source;
}

/** Reconstruct the complete inventory using four exact reviewed row changes only. */
export function applyEditorialAuthorReport<T>(before: T, binding = editorialAuthorSourceBinding): T {
  const serialized = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  if (sha(serialized(before)) !== binding.previous_report.sha256) throw Error('Editorial API complete predecessor differs');
  const result = structuredClone(before) as unknown as {
    counts: unknown; backend: unknown; frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>>;
  };
  if (JSON.stringify(result.counts) !== JSON.stringify(binding.counts_unchanged) || binding.backend_unchanged !== true) throw Error('Editorial API predecessor metadata differs');
  for (const change of binding.report_changes) {
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(result[change.array]?.[change.index]) !== JSON.stringify(change.before)) throw Error('Editorial API exact predecessor row differs');
    result[change.array][change.index] = structuredClone(change.after);
  }
  if (JSON.stringify(result.backend) !== JSON.stringify((before as { backend?: unknown }).backend)) throw Error('Editorial API backend changed');
  if (sha(serialized(result)) !== binding.current_report.sha256) throw Error('Editorial API complete result differs');
  return result as unknown as T;
}
