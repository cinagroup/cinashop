import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface ListAuthorSourceBinding {
  sources:Array<RouteSourceFollowup & {file:string}>;
  previous_report:{file:string;sha256:string};current_report:{file:string;sha256:string};
  report_reconstruction:{before_counts:unknown;after_counts:unknown;before_backend_sha256:string;after_backend_sha256:string;arrays:Record<string,{changes:Array<{index:number;before:Record<string,unknown>;after:Record<string,unknown>}>;additions:Array<{index:number;value:Record<string,unknown>}>}>};
}
export const listAuthorSourceBinding=JSON.parse(readFileSync(resolve(import.meta.dirname,'../../audit/diy-list-author-source-binding-20261023.json'),'utf8')) as ListAuthorSourceBinding;
/** Exact whole-source inverse runs before historical bindings; unreviewed bytes fail closed. */
export function reverseListAuthorSource(file:string,source:string,binding=listAuthorSourceBinding):string{const row=binding.sources.find(row=>row.file===file);return row?reverseRouteSourceFollowup(source.replace(/\r\n?/gu,'\n'),row):source;}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,null,2)+'\n').digest('hex');
/** Full predecessor and result hashes retain every historical call and resource. */
export function applyListAuthorReport<T>(before:T,binding=listAuthorSourceBinding):T{
  if(hash(before)!==binding.previous_report.sha256)throw Error('List API complete predecessor differs');
  const result=structuredClone(before) as Record<string,any>,p=binding.report_reconstruction;
  if(JSON.stringify(result.counts)!==JSON.stringify(p.before_counts)||result.backend.sha256!==p.before_backend_sha256)throw Error('List API predecessor metadata differs');
  const arrays:Record<string,Array<Record<string,unknown>>>={registered_routes:result.backend.registeredRoutes,root_route_sources:result.backend.rootRouteSources,frontend_sources:result.frontendSources,calls:result.calls};
  for(const[name,delta]of Object.entries(p.arrays)){const arr=arrays[name];if(!arr)throw Error('Unknown list report array');for(const c of delta.changes){if(JSON.stringify(arr[c.index])!==JSON.stringify(c.before))throw Error('List API predecessor row differs');arr[c.index]=structuredClone(c.after);}for(const a of delta.additions)arr.splice(a.index,0,structuredClone(a.value));}
  result.counts=structuredClone(p.after_counts);result.backend.sha256=p.after_backend_sha256;
  if(hash(result)!==binding.current_report.sha256)throw Error('List API complete reconstruction differs');return result as T;
}
