import { peelMessageCenterReportIfPresent } from './messageCenterSourceBinding';
import { peelReviewedAdminHistoricalSourceIfPresent, hasReviewedAdminHistoricalSource } from './reviewedAdminSourceTailBinding';
import { createHash } from 'node:crypto';
import { readMainMergePredecessor as readFileSync } from './migrationMergeSourceBinding';
import { relative, resolve, sep } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

type Path = Array<string | number>;
type Scalar = string | number | boolean | null;
interface Rule { target: string; coverage: string; queryAliases?: Readonly<Record<string, string>> }
interface Source extends RouteSourceFollowup {
  file: string; before_bytes: number; after_bytes: number; before_git_blob_sha1: string; after_git_blob_sha1: string;
}
type Operation = { kind: 'replace'; path: Path; before: Scalar; after: Scalar }
  | { kind: 'splice'; path: Path; index: number; before: unknown[]; after: unknown[] }
  | { kind: 'line-shift'; path: Path; index: number; count: number; delta: number; before_sha256: string; after_sha256: string };
interface RouteStage {
  name: string; before_ref: string; after_ref: string; sources: Source[];
  before_count: number; after_count: number; before_routes_sha256: string; after_routes_sha256: string;
  before_rules_sha256: string; after_rules_sha256: string; added_routes: string[];
  added_pages: Array<{ path: string; style: Record<string, string> }>;
  rule_edits: Array<{ key: string; before: Rule; after: Rule }>;
}
interface ReportStage {
  name: string; before_ref: string; after_ref: string; before_sha256: string; after_sha256: string;
  before_bytes: number; after_bytes: number; operations: Operation[];
  counts: Record<string, number>; frontend_sources: number; registered_routes: number;
}
export interface ReviewedRouteTailBinding {
  schema: string; base_ref: string; current_ref: string; route_stages: RouteStage[]; harness_sources: Source[];
  report_stages: ReportStage[]; current_extra_sources: Array<{ file: string; bytes: number; sha256: string }>;
  preserved_dated_fixtures: Array<{ file: string; bytes: number; sha256: string }>; boundary: string;
}
const root = resolve(import.meta.dirname, '../../..');
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const blob = (source: string) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/reviewed-route-tail-source-binding-20261028.json'), 'utf8');
if (sha(raw) !== '1fd855b397eb496e1d2accca18eeeb96b905d5e7f499657dc785310c2b246d6c') throw Error('Reviewed route tail fixture bytes differ');
export const reviewedRouteTailSourceBinding = JSON.parse(raw) as ReviewedRouteTailBinding;
function inventory(p: ReviewedRouteTailBinding): void {
  if (sha(JSON.stringify(p)) !== '26b5cdb426e775dca181822d21222293a160cad39abb74a7b2dbb8e172dcbeaa')
    throw Error('Reviewed route tail exact inventory differs');
}
function whole(source: string, proof: Source, before: boolean): boolean {
  return Buffer.byteLength(source) === (before ? proof.before_bytes : proof.after_bytes)
    && sha(source) === (before ? proof.before_sha256 : proof.after_sha256)
    && blob(source) === (before ? proof.before_git_blob_sha1 : proof.after_git_blob_sha1);
}
function inverse(source: string, proof: Source): string {
  if (!whole(source, proof, false)) throw Error('Reviewed route tail current whole source differs');
  const before = reverseRouteSourceFollowup(source, proof);
  if (!whole(before, proof, true)) throw Error('Reviewed route tail predecessor whole source differs');
  return before;
}
function sourceIfPresent(file: string, source: string, p: ReviewedRouteTailBinding): string {
  source = peelReviewedAdminHistoricalSourceIfPresent(file, source);
  const harness = p.harness_sources.find(row => row.file === file);
  if (harness && whole(source, harness, false)) return inverse(source, harness);
  for (const stage of [...p.route_stages].reverse()) {
    const proof = stage.sources.find(row => row.file === file);
    if (proof && whole(source, proof, false)) source = inverse(source, proof);
  }
  return source;
}
/** Unknown input is passed to the dated bridge, whose exact whole-state check
 * rejects it. A later registered route is never removed merely by its name. */
export function peelReviewedRouteTailSourceIfPresent(file: string, source: string, p = reviewedRouteTailSourceBinding): string {
  inventory(p); return sourceIfPresent(file, source, p);
}
export function reverseReviewedRouteTailSource(file: string, source: string, p = reviewedRouteTailSourceBinding): string {
  inventory(p); const before = sourceIfPresent(file, source, p);
  if (source === before) throw Error('Unknown complete reviewed route tail source'); return before;
}
export function peelReviewedRouteTailRegisteredRoutesIfPresent(current: ReadonlySet<string>, p = reviewedRouteTailSourceBinding): Set<string> {
  inventory(p); let result = new Set(current);
  for (const stage of [...p.route_stages].reverse()) {
    if (sha(JSON.stringify([...result].sort())) !== stage.after_routes_sha256) continue;
    if (result.size !== stage.after_count || stage.added_routes.some(route => !result.has(route))) throw Error('Reviewed route tail exact routes differ');
    for (const route of stage.added_routes) result.delete(route);
    if (result.size !== stage.before_count || sha(JSON.stringify([...result].sort())) !== stage.before_routes_sha256)
      throw Error('Reviewed route tail predecessor routes differ');
  }
  return result;
}
export function peelReviewedRouteTailLegacyRulesIfPresent<T extends Readonly<Record<string, Rule>>>(current: T, p = reviewedRouteTailSourceBinding): T {
  inventory(p); let result = current;
  for (const stage of [...p.route_stages].reverse()) {
    if (sha(JSON.stringify(result)) !== stage.after_rules_sha256) continue;
    const before: Record<string, Rule> = { ...result };
    for (const edit of stage.rule_edits) {
      if (!equal(before[edit.key], edit.after)) throw Error('Reviewed route tail exact alias differs');
      before[edit.key] = structuredClone(edit.before);
    }
    if (sha(JSON.stringify(before)) !== stage.before_rules_sha256) throw Error('Reviewed route tail predecessor aliases differ');
    result = before as T;
  }
  return result;
}
function member(value: unknown, key: string | number): unknown {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Error('Reviewed route tail exact report path missing');
  return (value as Record<string | number, unknown>)[key];
}
function at(value: unknown, path: Path): unknown { for (const key of path) value = member(value, key); return value; }
function reportStage<T>(input: T, stage: ReportStage, reverse: boolean): T {
  const text = pretty(input);
  if (sha(text) !== (reverse ? stage.after_sha256 : stage.before_sha256)
    || Buffer.byteLength(text) !== (reverse ? stage.after_bytes : stage.before_bytes)) throw Error('Reviewed route tail complete report input differs');
  const result = structuredClone(input);
  for (const operation of reverse ? [...stage.operations].reverse() : stage.operations) {
    if (!operation.path.length) throw Error('Reviewed route tail whole-report replacement forbidden');
    if (operation.kind === 'replace') {
      const parent = at(result, operation.path.slice(0, -1)), key = operation.path.at(-1)!;
      if (!equal(member(parent, key), reverse ? operation.after : operation.before)) throw Error('Reviewed route tail report scalar differs');
      (parent as Record<string | number, unknown>)[key] = reverse ? operation.before : operation.after;
    } else {
      const rows = at(result, operation.path), index = operation.index;
      if (!Array.isArray(rows) || !Number.isSafeInteger(index) || index < 0) throw Error('Reviewed route tail report array differs');
      if (operation.kind === 'splice') {
        const from = reverse ? operation.after : operation.before, to = reverse ? operation.before : operation.after;
        if (index + from.length > rows.length || !equal(rows.slice(index, index + from.length), from)) throw Error('Reviewed route tail exact report splice differs');
        rows.splice(index, from.length, ...structuredClone(to));
      } else {
        if (!Number.isSafeInteger(operation.count) || operation.count < 1 || index + operation.count > rows.length
          || !Number.isSafeInteger(operation.delta) || operation.delta === 0) throw Error('Reviewed route tail report line bounds differ');
        const subset = rows.slice(index, index + operation.count);
        if (sha(JSON.stringify(subset)) !== (reverse ? operation.after_sha256 : operation.before_sha256)) throw Error('Reviewed route tail report line source differs');
        for (const row of subset) {
          if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.line)) throw Error('Reviewed route tail report line is invalid');
          const value = row.line + (reverse ? -operation.delta : operation.delta);
          if (!Number.isSafeInteger(value) || value < 1) throw Error('Reviewed route tail report line result is invalid'); row.line = value;
        }
        if (sha(JSON.stringify(subset)) !== (reverse ? operation.before_sha256 : operation.after_sha256)) throw Error('Reviewed route tail report line result differs');
      }
    }
  }
  const output = pretty(result);
  if (sha(output) !== (reverse ? stage.before_sha256 : stage.after_sha256)
    || Buffer.byteLength(output) !== (reverse ? stage.before_bytes : stage.after_bytes)) throw Error('Reviewed route tail complete report result differs');
  return result;
}
export function peelReviewedRouteTailReportForHistoricalAudit<T>(input: T, p = reviewedRouteTailSourceBinding): T {
  inventory(p); let result = peelMessageCenterReportIfPresent(input);
  for (const stage of [...p.report_stages].reverse()) if (sha(pretty(result)) === stage.after_sha256) result = reportStage(result, stage, true);
  return result;
}
export function reverseReviewedRouteTailReport<T>(input: T, p = reviewedRouteTailSourceBinding): T {
  const result = peelReviewedRouteTailReportForHistoricalAudit(input, p);
  if (equal(input, result)) throw Error('Unknown complete reviewed route tail report'); return result;
}
export function applyReviewedRouteTailReport<T>(input: T, p = reviewedRouteTailSourceBinding): T {
  inventory(p); let result = input; for (const stage of p.report_stages) result = reportStage(result, stage, false); return result;
}
/** Test-only filesystem facade restores reviewed historical bytes, including
 * our five explicit harness edits. Raw live tests use native fs independently. */
export const readReviewedRouteTailHistoricalFile: typeof readFileSync = ((...args: unknown[]) => {
  const value = Reflect.apply(readFileSync, undefined, args) as string | Uint8Array, path = args[0];
  if (typeof path !== 'string') return value;
  const file = relative(root, resolve(path)).split(sep).join('/'), p = reviewedRouteTailSourceBinding;
  if (![...p.harness_sources, ...p.route_stages.flatMap(stage => stage.sources)].some(row => row.file === file) && !hasReviewedAdminHistoricalSource(file)) return value;
  const encoding = typeof args[1] === 'string' ? args[1] : (args[1] as { encoding?: string } | undefined)?.encoding;
  if (encoding && encoding !== 'utf8' && encoding !== 'utf-8') throw Error('Reviewed route tail reader requires exact UTF8 or Buffer');
  const before = peelReviewedRouteTailSourceIfPresent(file, typeof value === 'string' ? value : new TextDecoder().decode(value));
  return typeof value === 'string' ? before : Buffer.from(before, 'utf8');
}) as typeof readFileSync;
