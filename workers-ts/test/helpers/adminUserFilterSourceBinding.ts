import { reverseMigrationAuditSource, reverseMigrationAuditReport } from './migrationAuditFollowupSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

type JsonPath = string[];
type ReportOperation =
  | {kind:'replace';path:JsonPath;before:unknown;after:unknown}
  | {kind:'splice';path:JsonPath;index:number;before:unknown[];after:unknown[]}
  | {kind:'line-shift';path:JsonPath;index:number;count:number;delta:number;before_sha256:string;after_sha256:string};
interface FileProof { file:string;bytes:number;sha256:string }
export interface AdminUserFilterSourceBinding {
  schema:string;base_ref:string;
  sources:Array<RouteSourceFollowup & {file:string;before_ref:string;before_bytes:number;after_bytes:number}>;
  new_consumer_sources:FileProof[];preserved_files:FileProof[];
  api_report:{base_file:string;base_sha256:string;binding_chain:FileProof[];builder:FileProof;before_sha256:string;after_sha256:string;before_bytes:number;after_bytes:number;before_counts:Record<string,number>;after_counts:Record<string,number>;before_frontend_sources:number;after_frontend_sources:number;before_registered_routes:number;after_registered_routes:number;operations:ReportOperation[]};
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/admin-user-filter-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='54cfe137c143387ef7f0d14f098a7738317ef409e4a45ed299c60c98e3cff3de')throw Error('Admin user-filter fixture bytes differ');
export const adminUserFilterSourceBinding=JSON.parse(raw) as AdminUserFilterSourceBinding;
const sourceFiles=['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','view/admin-ts/src/pages/user/UserList.vue','view/admin-ts/src/api/order.ts','workers-ts/src/services/admin/AdminPermissionService.ts'];
function inventory(binding:AdminUserFilterSourceBinding){
  if(binding.schema!=='cinashop.admin-user-filter-source-binding.v1'||binding.base_ref!=='330625d39b3988eb37ee73d19fde8e51e14cf625'||binding.sources.length!==sourceFiles.length||binding.sources.some((row,index)=>row.file!==sourceFiles[index]||row.before_ref!==binding.base_ref)||sha(JSON.stringify(binding.sources))!=='96c00716d1d09815d7656e967ba1e900c74483882bf76b5b389624107f96e1de')throw Error('Admin user-filter exact ordered source/edit inventory differs');
}
/** Peel only reviewed complete source bytes; no route, permission or sibling drift is filtered. */
export function reverseAdminUserFilterSource(file:string,source:string,binding=adminUserFilterSourceBinding):string{
  inventory(binding);const entry=binding.sources.find(row=>row.file===file);if(!entry)return source;
  source=reverseMigrationAuditSource(file,source);
  if(Buffer.byteLength(source)!==entry.after_bytes)throw Error('Admin user-filter whole-source bytes differ');
  const previous=reverseRouteSourceFollowup(source,entry);
  if(Buffer.byteLength(previous)!==entry.before_bytes)throw Error('Admin user-filter predecessor bytes differ');return previous;
}
function child(value:unknown,key:string):unknown{
  if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('Admin user-filter exact report path missing');
  return (value as Record<string,unknown>)[key];
}
function at(value:unknown,path:JsonPath):unknown{for(const key of path)value=child(value,key);return value;}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function reconstruct<T>(input:T,reverse:boolean,binding:AdminUserFilterSourceBinding):T{
  inventory(binding);const proof=binding.api_report,pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
  if(reverse)input=reverseMigrationAuditReport(input);
  if(sha(JSON.stringify(proof))!=='3bf1f6af42892fd8c07da19dda19e3a7dbb07b90adac0a95f691014e0878f541')throw Error('Admin user-filter exact report delta inventory differs');
  const incoming=pretty(input);if(sha(incoming)!==(reverse?proof.after_sha256:proof.before_sha256)||Buffer.byteLength(incoming)!==(reverse?proof.after_bytes:proof.before_bytes))throw Error('Admin user-filter complete report input differs');
  const result=structuredClone(input);const operations=reverse?[...proof.operations].reverse():proof.operations;
  for(const operation of operations){
    if(operation.kind==='replace'){
      if(!operation.path.length)throw Error('Admin user-filter whole-report replacement forbidden');
      const parent=at(result,operation.path.slice(0,-1)),key=operation.path.at(-1)!;
      if(!equal(child(parent,key),reverse?operation.after:operation.before))throw Error('Admin user-filter exact report scalar differs');
      (parent as Record<string,unknown>)[key]=structuredClone(reverse?operation.before:operation.after);
    }else{
      const array=at(result,operation.path);if(!Array.isArray(array)||!Number.isSafeInteger(operation.index)||operation.index<0)throw Error('Admin user-filter report array boundary differs');
      if(operation.kind==='splice'){
        const from=reverse?operation.after:operation.before,to=reverse?operation.before:operation.after;
        if(operation.index>array.length||!equal(array.slice(operation.index,operation.index+from.length),from))throw Error('Admin user-filter exact report rows differ');
        array.splice(operation.index,from.length,...structuredClone(to));
      }else{
        if(!Number.isSafeInteger(operation.count)||operation.count<1||operation.index+operation.count>array.length||operation.delta!==2)throw Error('Admin user-filter line-shift boundary differs');
        const block=array.slice(operation.index,operation.index+operation.count);
        if(sha(JSON.stringify(block))!==(reverse?operation.after_sha256:operation.before_sha256))throw Error('Admin user-filter exact complete route block differs');
        const shifted=block.map((value:unknown)=>{const line=child(value,'line');if(typeof line!=='number'||!Number.isSafeInteger(line)||line<1)throw Error('Admin user-filter route line invalid');return{...(value as Record<string,unknown>),line:line+(reverse?-operation.delta:operation.delta)};});
        if(sha(JSON.stringify(shifted))!==(reverse?operation.before_sha256:operation.after_sha256))throw Error('Admin user-filter complete shifted route block differs');
        array.splice(operation.index,operation.count,...shifted);
      }
    }
  }
  const outgoing=pretty(result);if(sha(outgoing)!==(reverse?proof.before_sha256:proof.after_sha256)||Buffer.byteLength(outgoing)!==(reverse?proof.before_bytes:proof.after_bytes))throw Error('Admin user-filter complete report result differs');return result;
}
export const applyAdminUserFilterReport=<T>(before:T,binding=adminUserFilterSourceBinding):T=>reconstruct(before,false,binding);
export const reverseAdminUserFilterReport=<T>(after:T,binding=adminUserFilterSourceBinding):T=>reconstruct(after,true,binding);
