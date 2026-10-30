import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../../audit/uni-search-hotwords-source-binding-20261025.json'), 'utf8');
if (sha(raw) !== 'b1de5a72518df149aef05448139951153cf0ea60f2776df1e49dac6d4c0824d2') throw Error('Search hotwords source binding bytes differ');
export const searchHotwordsSourceBinding = JSON.parse(raw) as {
  sources: Array<RouteSourceFollowup & {file: string}>;
  full_additions: Array<{file: string; sha256: string}>;
  observed_unchanged: Record<string, string>;
  frozen_predecessor_evidence: Record<string, string>;
  PHP_ref: string;
  PHP_sources: Array<{file: string; sha256: string; bytes: number; lines: number}>;
  PHP_evidence: Array<{source: string; start: number; end: number; fragment: string; fragment_sha256: string}>;
  boundaries: Record<string, string>;
};
/** Peel only the exact current increment; unchanged historical proof functions
 * still check their own full-source hashes and all original negative fixtures. */
export function reverseSearchHotwordsSource(file: string, source: string, binding = searchHotwordsSourceBinding): string {
  const entry = binding.sources.find(row => row.file === file);
  return entry ? reverseRouteSourceFollowup(source.replace(/\r\n?/gu, '\n'), entry) : source;
}
