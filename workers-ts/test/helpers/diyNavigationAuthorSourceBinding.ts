import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
const workerRoot = resolve(import.meta.dirname, '../..');
export interface NavigationAuthorSourceBinding { sources: Array<RouteSourceFollowup & { file: string }>; previous_report: { file: string; sha256: string }; current_report: { file: string; sha256: string }; report_reconstruction: {
  before_counts: unknown; after_counts: unknown; before_backend_sha256: string; after_backend_sha256: string;
  arrays: Record<string, { changes: Array<{ index: number; key: string; before: Record<string, unknown>; after: Record<string, unknown> }>; additions: Array<{ index: number; value: Record<string, unknown> }> }>;
} }
export const navigationAuthorSourceBinding = JSON.parse(readFileSync(resolve(workerRoot, 'audit/diy-navigation-author-source-binding-20261023.json'), 'utf8')) as NavigationAuthorSourceBinding;
/** Peel exactly this reviewed increment before older whole-source proofs. */
export function reverseNavigationAuthorSource(file: string, source: string, binding = navigationAuthorSourceBinding): string {
  const row = binding.sources.find(row => row.file === file);
  return row ? reverseRouteSourceFollowup(source.replace(/\r\n?/g, '\n'), row) : source;
}
function equal(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error('Navigation report predecessor or exact delta differs'); }
/** Reconstruct additive current inventory; no old route/call is discarded. */
export function applyNavigationAuthorReport<T>(before: T, binding = navigationAuthorSourceBinding): T {
  const result = structuredClone(before) as Record<string, any>, proof = binding.report_reconstruction;
  equal(result.counts, proof.before_counts); equal(result.backend.sha256, proof.before_backend_sha256);
  const arrays: Record<string, Array<Record<string, unknown>>> = { registered_routes: result.backend.registeredRoutes, root_route_sources: result.backend.rootRouteSources, frontend_sources: result.frontendSources, calls: result.calls };
  const key = (row: Record<string, unknown>) => row.file || ['source', 'method', 'path', 'handler'].map(k => String(row[k] ?? '')).join('|');
  for (const [name, delta] of Object.entries(proof.arrays)) {
    const array = arrays[name]; if (!array) throw Error('Unknown navigation report array');
    for (const change of delta.changes) {
      const row = array[change.index]; if (!row) throw Error('Missing navigation report predecessor row'); equal(key(row), change.key);
      for (const [field, value] of Object.entries(change.before)) equal(row[field], value);
      Object.assign(row, change.after);
    }
    for (const addition of delta.additions) array.splice(addition.index, 0, structuredClone(addition.value));
  }
  result.counts = structuredClone(proof.after_counts); result.backend.sha256 = proof.after_backend_sha256;
  return result as T;
}
