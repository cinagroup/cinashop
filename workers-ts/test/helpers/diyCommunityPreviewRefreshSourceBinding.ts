import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup,type RouteSourceFollowup } from './routeSourceIncrement';
export interface CommunityPreviewRefreshSourceBinding {
 schema:string;base_ref:string;
 sources:Array<RouteSourceFollowup&{file:string;before_ref:string;before_bytes:number;after_bytes:number}>;
 preserved_files:Array<{file:string;bytes:number;sha256:string}>;
 unchanged_dependency_sources:Array<{file:string;bytes:number;sha256:string}>;
 api_report:{base_file:string;base_sha256:string;binding_chain:Array<{file:string;sha256:string}>;before_sha256:string;after_sha256:string;compact_sha256:string;pretty_bytes:number;compact_bytes:number;changes:unknown[];call_sites:number;path_variants:number;frontend_sources:number};
}
const sha=(source:string)=>createHash('sha256').update(source).digest('hex'),raw=readFileSync(resolve(import.meta.dirname,'../fixtures/diy-community-preview-refresh-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='03a598b2543c08939b1d37b6f182de5573f27d62abf349a83f0222f33fe25d13')throw Error('Community preview-refresh source-binding fixture bytes differ');
export const communityPreviewRefreshSourceBinding=JSON.parse(raw) as CommunityPreviewRefreshSourceBinding;
function inventory(binding:CommunityPreviewRefreshSourceBinding){
 if(binding.schema!=='cinashop.diy-community-preview-refresh-source-binding.v1'||binding.base_ref!=='6dd4db7a4fccb574134a7a19f64386c22f09e73c'||binding.sources.length!==1||binding.sources[0]?.file!=='view/admin-ts/src/components/content/DiyCommunityEditor.vue'||binding.sources[0].before_ref!==binding.base_ref||sha(JSON.stringify(binding.sources))!=='15346d3c78d40e4c83fed714be762bec569dd211ddb545f18b3e5a564874b9cf')throw Error('Community preview-refresh sealed exact single-source/edit inventory differs');
}
/** Strip only the reviewed complete-source-pinned three-line timer replacement. */
export function reverseCommunityPreviewRefreshSource(file:string,source:string,binding=communityPreviewRefreshSourceBinding):string{
 inventory(binding);const entry=binding.sources.find(row=>row.file===file);if(!entry)return source;
 if(Buffer.byteLength(source)!==entry.after_bytes)throw Error('Community preview-refresh current whole-source bytes differ');
 const previous=reverseRouteSourceFollowup(source,entry);
 if(Buffer.byteLength(previous)!==entry.before_bytes)throw Error('Community preview-refresh predecessor whole-source bytes differ');
 return previous;
}
/** The complete report is unchanged; no filtering or row exemption is allowed. */
export function assertCommunityPreviewRefreshReport<T>(report:T,binding=communityPreviewRefreshSourceBinding):T{
 const proof=binding.api_report;
 if(sha(JSON.stringify(proof))!=='64a97bd626b9730fd1815fdf8e099b33b89a8727fbfa0558c73d0205a1c0c408'||proof.changes.length!==0||proof.before_sha256!==proof.after_sha256||sha(JSON.stringify(report,null,2)+'\n')!==proof.after_sha256)throw Error('Community preview-refresh complete unchanged API report differs');
 return report;
}
