import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface CommerceImagePreviewSourceBinding {
  schema: string;
  base_ref: string;
  sources: Array<RouteSourceFollowup & {file: string; before_ref: string; before_bytes: number; after_bytes: number}>;
  preserved_files: Array<{file: string; sha256: string; bytes: number}>;
  runtime_helper_sources: Array<{file: string; sha256: string; bytes: number}>;
  api_report: {base_file: string; base_sha256: string; binding_chain: Array<{file: string; sha256: string}>; before_sha256: string; after_sha256: string; compact_sha256: string; pretty_bytes: number; compact_bytes: number; changes: unknown[]; call_sites: number; path_variants: number; frontend_sources: number};
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const raw = readFileSync(resolve(import.meta.dirname, '../fixtures/diy-commerce-image-preview-source-binding-20261025.json'), 'utf8');
if (sha(raw) !== 'eda1c988387de9bec1d9cfde372388efd40f7a75f7b948f142d530c1eca4c693') throw Error('Commerce image-preview source-binding fixture bytes differ');
export const commerceImagePreviewSourceBinding = JSON.parse(raw) as CommerceImagePreviewSourceBinding;
const inventory = [
  ['view/admin-ts/src/utils/diyCommerceProjection.ts', 6],
  ['view/admin-ts/src/utils/diyCommerceData.ts', 3],
] as const;
const beforeImport = "import { editorialPreviewUrl as safeDiyImageUrl } from './diyEditorialEditor';";
const afterImport = "import { presentationPreviewUrl as safeDiyImageUrl } from './diyPresentationEditor';";
function sourceInventory(binding: CommerceImagePreviewSourceBinding) {
  if (binding.schema !== 'cinashop.diy-commerce-image-preview-source-binding.v1' || binding.base_ref !== 'f111330091fdda222496d575c7215a02a41e6d0e' || binding.sources.length !== inventory.length) throw Error('Commerce image-preview exact source inventory differs');
  for (const [index, [file, line]] of inventory.entries()) {
    const entry = binding.sources[index];
    if (!entry || entry.file !== file || entry.before_ref !== binding.base_ref || entry.edits.length !== 1) throw Error('Commerce image-preview ordered source inventory differs');
    const edit = entry.edits[0]!;
    if (edit.before_source !== beforeImport || edit.after_source !== afterImport || edit.before_line !== line || edit.after_line !== line) throw Error('Commerce image-preview expected one exact sanitizer import');
  }
}
/** Reverse only the two complete-source-pinned display adapters, before older consumer gates. */
export function reverseCommerceImagePreviewSource(file: string, source: string, binding = commerceImagePreviewSourceBinding): string {
  sourceInventory(binding);
  const entry = binding.sources.find(row => row.file === file);
  if (!entry) return source;
  if (Buffer.byteLength(source) !== entry.after_bytes) throw Error('Commerce image-preview complete source byte length differs');
  const previous = reverseRouteSourceFollowup(source, entry);
  if (Buffer.byteLength(previous) !== entry.before_bytes) throw Error('Commerce image-preview predecessor byte length differs');
  return previous;
}
/** This display-only correction adds no report delta and never filters an API/source row. */
export function assertCommerceImagePreviewReport<T>(report: T, binding = commerceImagePreviewSourceBinding): T {
  const proof = binding.api_report;
  if (proof.changes.length !== 0 || proof.before_sha256 !== proof.after_sha256 || sha(JSON.stringify(report, null, 2) + '\n') !== proof.after_sha256) throw Error('Commerce image-preview complete unchanged API report differs');
  return report;
}
