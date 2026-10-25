import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

export interface CommercePreviewExpirySourceBinding {
  schema: string;
  base_ref: string;
  sources: Array<RouteSourceFollowup & {file:string;before_ref:string;before_bytes:number;after_bytes:number}>;
  preserved_files: Array<{file:string;bytes:number;sha256:string}>;
  unchanged_dependency_sources: Array<{file:string;bytes:number;sha256:string}>;
  api_report: {base_file:string;base_sha256:string;binding_chain:Array<{file:string;sha256:string}>;before_sha256:string;after_sha256:string;compact_sha256:string;pretty_bytes:number;compact_bytes:number;changes:unknown[];call_sites:number;path_variants:number;frontend_sources:number};
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/diy-commerce-preview-expiry-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='dab8be850b69f60557be4121786847f4910bad9ca82940863815500550424295')throw Error('Commerce preview-expiry source-binding fixture bytes differ');
export const commercePreviewExpirySourceBinding=JSON.parse(raw) as CommercePreviewExpirySourceBinding;
const files=['view/admin-ts/src/components/content/DiyCommerceEditor.vue','view/admin-ts/src/api/diyCommerceAuthor.ts'];
function sourceInventory(binding:CommercePreviewExpirySourceBinding){
  if(binding.schema!=='cinashop.diy-commerce-preview-expiry-source-binding.v1'||binding.base_ref!=='74cb1125611ea266e165bbeb59e387605d31808d'||binding.sources.length!==2||binding.sources.some((row,index)=>row.file!==files[index]||row.before_ref!==binding.base_ref)||sha(JSON.stringify(binding.sources))!=='e9f14fb57f3e6bbca85d0dc45f1f2005292a7866923d81e7b7d1bdce5a39d553')throw Error('Commerce preview-expiry exact ordered source/edit inventory differs');
}
/** Strip only the exact reviewed timer/deadline addition before the dated Commerce consumer gate. */
export function reverseCommercePreviewExpirySource(file:string,source:string,binding=commercePreviewExpirySourceBinding):string{
  sourceInventory(binding);const entry=binding.sources.find(row=>row.file===file);if(!entry)return source;
  if(Buffer.byteLength(source)!==entry.after_bytes)throw Error('Commerce preview-expiry whole-source byte length differs');
  const previous=reverseRouteSourceFollowup(source,entry);
  if(Buffer.byteLength(previous)!==entry.before_bytes)throw Error('Commerce preview-expiry predecessor byte length differs');
  return previous;
}
/** No filtering and no fabricated row delta: the complete real API report must remain identical. */
export function assertCommercePreviewExpiryReport<T>(report:T,binding=commercePreviewExpirySourceBinding):T{
  const proof=binding.api_report;
  if(sha(JSON.stringify(proof))!=='64a97bd626b9730fd1815fdf8e099b33b89a8727fbfa0558c73d0205a1c0c408'||proof.changes.length!==0||proof.before_sha256!==proof.after_sha256||sha(JSON.stringify(report,null,2)+'\n')!==proof.after_sha256)throw Error('Commerce preview-expiry complete unchanged API report differs');
  return report;
}
