import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';
export interface CommerceAuthorSourceBinding {
 source:RouteSourceFollowup&{file:string};php_ref:string;
 formatting_source:RouteSourceFollowup&{file:string};
 promotion_grid_sources:Array<RouteSourceFollowup&{file:string;before_ref:string}>;
 previous_report:{sha256:string;base_file:string;base_sha256:string;predecessor_binding:string;predecessor_binding_sha256:string};
 current_report:{sha256:string;raw_capture:{sha256:string;bytes:number}};
 report_changes:Array<{array:'frontendSources'|'calls';index:number;before:Record<string,unknown>;after:Record<string,unknown>}>;
 consumer_sources:Array<{file:string;sha256:string}>;
 defaults_fixture:{file:string;sha256:string;top_level_keys:number};condition_fixture:{file:string;sha256:string;php_method_cases:number};
 assets:Array<{public_path:string;php_path:string;php_ref:string;sha256:string;bytes:number;admin_file:string;uni_file:string}>;
 default_bindings:Array<{path:Array<string|number>;source:string;literal:string|number;meaning:string}>;
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/diy-commerce-author-source-binding-20261025.json'),'utf8');
if(digest(raw)!=='b471408b7cdf102b057f1d2f6614d3fe53767ce07062fc9e6de2cdf5bc047e50')throw Error('Commerce source-binding fixture bytes differ');
export const commerceAuthorSourceBinding=JSON.parse(raw) as CommerceAuthorSourceBinding;
export function reverseCommerceAuthorSource(file:string,source:string,binding=commerceAuthorSourceBinding):string{return file===binding.source.file?reverseRouteSourceFollowup(source,binding.source):source;}
/** Exact three blank-line spaces only; the actual Vue compiler output is unchanged. */
export function reverseCommerceFormattingSource(file:string,source:string,binding=commerceAuthorSourceBinding):string{return file===binding.formatting_source.file?reverseRouteSourceFollowup(source,binding.formatting_source):source;}
/** Reverse only the reviewed two-column CSS repair, retaining each complete source byte boundary. */
export function reverseCommerceGridSource(file:string,source:string,binding=commerceAuthorSourceBinding):string {
 const entry=binding.promotion_grid_sources.find(row=>row.file===file);
 const previous=reverseCommerceFormattingSource(file,source,binding);return entry?reverseRouteSourceFollowup(previous,entry):previous;
}
function reconstruct<T>(input:T,reverse:boolean,binding:CommerceAuthorSourceBinding):T {
 const hash=(value:unknown)=>digest(JSON.stringify(value,null,2)+'\n');
 if(hash(input)!==(reverse?binding.current_report.sha256:binding.previous_report.sha256))throw Error('Commerce API complete input differs');
 if(binding.report_changes.length!==4)throw Error('Commerce API expected four exact existing row changes');
 const result=structuredClone(input) as unknown as {frontendSources:Array<Record<string,unknown>>;calls:Array<Record<string,unknown>>},seen=new Set<string>();
 for(const change of binding.report_changes){
  if(!['frontendSources','calls'].includes(change.array)||!Number.isSafeInteger(change.index)||change.index<0||seen.has(`${change.array}:${change.index}`))throw Error('Commerce API invalid or repeated row delta');
  const values=result[change.array],from=reverse?change.after:change.before,to=reverse?change.before:change.after;
  if(!Array.isArray(values)||JSON.stringify(values[change.index])!==JSON.stringify(from))throw Error('Commerce API exact input row differs');
  seen.add(`${change.array}:${change.index}`);values[change.index]=structuredClone(to);
 }
 if(hash(result)!==(reverse?binding.previous_report.sha256:binding.current_report.sha256))throw Error('Commerce API complete result differs');
 return result as unknown as T;
}
export const applyCommerceAuthorReport=<T>(before:T,binding=commerceAuthorSourceBinding):T=>reconstruct(before,false,binding);
export const reverseCommerceAuthorReport=<T>(after:T,binding=commerceAuthorSourceBinding):T=>reconstruct(after,true,binding);
