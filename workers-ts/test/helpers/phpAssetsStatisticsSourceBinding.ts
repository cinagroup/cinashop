import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface PhpAssetsStatisticsSourceBinding extends RouteSourceFollowup {
  file: string;
  before_commit: string;
  after_commit: string;
  unchanged_pre_style_prefix_sha256: string;
  retained_historical_proofs: Array<{ file: string; sha256: string }>;
}
export const phpAssetsStatisticsSourceBinding = JSON.parse(readFileSync(resolve(import.meta.dirname,
  '../fixtures/php-assets-statistics-source-followup-20261024.json'), 'utf8')) as PhpAssetsStatisticsSourceBinding;
/** Peel only the complete, reviewed PR166 App style increment. Unknown source
 * bytes fail before entering the unchanged historical statistics/footer chain. */
export function reversePhpAssetsStatisticsSource(file: string, source: string): string {
  return file === phpAssetsStatisticsSourceBinding.file ? reverseRouteSourceFollowup(source, phpAssetsStatisticsSourceBinding) : source;
}
