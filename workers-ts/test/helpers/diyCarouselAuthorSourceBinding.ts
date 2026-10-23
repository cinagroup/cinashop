import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface CarouselAuthorSourceBinding {
  sources:Array<RouteSourceFollowup & {file:string}>;
  previous_report:{file:string;sha256:string};current_report:{file:string;sha256:string};
  report_changes:Array<{array:'frontendSources'|'calls';index:number;before:Record<string,unknown>;after:Record<string,unknown>}>;
  counts_unchanged:unknown;
}
export const carouselAuthorSourceBinding=JSON.parse(readFileSync(resolve(import.meta.dirname,'../../audit/diy-carousel-author-source-binding-20261023.json'),'utf8')) as CarouselAuthorSourceBinding;
/** Peel only this complete source-bound increment, retaining older hashes and negatives. */
export function reverseCarouselAuthorSource(file:string,source:string,binding=carouselAuthorSourceBinding):string{const row=binding.sources.find(row=>row.file===file);return row?reverseRouteSourceFollowup(source.replace(/\r\n?/gu,'\n'),row):source;}
export function applyCarouselAuthorReport<T>(before:T,binding=carouselAuthorSourceBinding):T{
  const result=structuredClone(before) as Record<string,any>;
  if(JSON.stringify(result.counts)!==JSON.stringify(binding.counts_unchanged))throw Error('Carousel API counts predecessor differs');
  for(const change of binding.report_changes){if(!['frontendSources','calls'].includes(change.array)||JSON.stringify(result[change.array]?.[change.index])!==JSON.stringify(change.before))throw Error('Carousel API row predecessor differs');result[change.array][change.index]=structuredClone(change.after);}
  return result as T;
}
