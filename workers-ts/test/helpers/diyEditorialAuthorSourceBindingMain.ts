import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface EditorialAuthorSourceBinding {
  source: RouteSourceFollowup & {file:string};
  previous_report: {file:string;sha256:string};
  current_report: {generator:string;sha256:string;serialization:string;raw_capture:{sha256:string;bytes:number;serialization:string}};
  report_changes: Array<{array:'frontendSources'|'calls';index:number;before:Record<string,unknown>;after:Record<string,unknown>}>;
  consumer_sources: Array<{file:string;sha256:string}>;
  defaults_fixture: {file:string;sha256:string};
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/diy-editorial-author-source-binding-20261024.json'),'utf8');
if(digest(raw)!=='0493954cc32eb582ba5944cc7e803ef7e043d030d0455b5ccb63999a2744d2e9')throw Error('Editorial source-binding fixture bytes differ');
export const editorialAuthorSourceBinding=JSON.parse(raw) as EditorialAuthorSourceBinding;
/** Peel only the complete reviewed parent integration before dated source inverses. */
export function reverseEditorialAuthorSource(file:string,source:string,binding=editorialAuthorSourceBinding):string {
  return file===binding.source.file?reverseRouteSourceFollowup(source,binding.source):source;
}
/** Preserve the complete preceding report; only four exact existing rows may change. */
export function applyEditorialAuthorReport<T>(before:T,binding=editorialAuthorSourceBinding):T {
  const hash=(value:unknown)=>digest(JSON.stringify(value,null,2)+'\n');
  if(hash(before)!==binding.previous_report.sha256)throw Error('Editorial API complete predecessor differs');
  const result=structuredClone(before) as unknown as {frontendSources:Array<Record<string,unknown>>;calls:Array<Record<string,unknown>>};
  const seen=new Set<string>();
  for(const change of binding.report_changes){
    if(!['frontendSources','calls'].includes(change.array)||!Number.isSafeInteger(change.index)||change.index<0||seen.has(`${change.array}:${change.index}`))throw Error('Editorial API invalid or repeated row delta');
    const values=result[change.array];
    if(!Array.isArray(values)||JSON.stringify(values[change.index])!==JSON.stringify(change.before))throw Error('Editorial API exact predecessor row differs');
    seen.add(`${change.array}:${change.index}`);values[change.index]=structuredClone(change.after);
  }
  if(hash(result)!==binding.current_report.sha256)throw Error('Editorial API complete result differs');
  return result as unknown as T;
}
