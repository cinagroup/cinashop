import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RouteSourceFollowup } from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(root,'workers-ts/audit/config-class-author-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='6c208914768010f36feee20b1d493aa5150cd2e33ea501c35d375a91c192e922')throw Error('Config class exact source binding bytes differ');
export const configClassSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string}>;
 observed_unchanged:Record<string,string>;
 frozen_predecessor_evidence:Record<string,string>;
 PHP_ref:string;
 PHP_sources:Array<{file:string;sha256:string;bytes:number;lines:number;raw_utf8:string}>;
 PHP_evidence:Array<{source:string;start:number;end:number;fragment:string;fragment_sha256:string}>;
 previous_report:{file:string;sha256:string};current_report:{file:string;sha256:string};
 boundaries:Record<string,string>;
};
function reverseExact(source:string,entry:RouteSourceFollowup){
 if(sha(source)!==entry.after_sha256)throw Error('Config class current source differs');
 for(const edit of entry.edits)if(!edit.after_source||source.split(edit.after_source).length!==2||source.slice(0,source.indexOf(edit.after_source)).split('\n').length!==edit.after_line)throw Error('Config class exact insertion differs');
 let previous=source;
 // A function replacement keeps literal $&, $` and $' in archived code intact.
 for(const edit of entry.edits)previous=previous.replace(edit.after_source,()=>edit.before_source);
 if(sha(previous)!==entry.before_sha256)throw Error('Config class predecessor source differs');
 for(const edit of entry.edits)if(edit.before_source&&(previous.split(edit.before_source).length!==2||previous.slice(0,previous.indexOf(edit.before_source)).split('\n').length!==edit.before_line))throw Error('Config class exact predecessor location differs');
 return previous;
}
/** Exact outer layer only. Older helpers, assertions and dated JSON stay intact. */
export function reverseConfigClassSource(file:string,source:string,binding=configClassSourceBinding){
 const entry=binding.sources.find(row=>row.file===file);
 return entry?reverseExact(source.replace(/\r\n?/gu,'\n'),entry):source;
}
/** Historical readers receive only the whole-file-pinned predecessor. Binary
 * and unrelated inputs retain the original fs result and encoding contract. */
export const readConfigClassPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>{
 const value=readFileSync(file,options);
 if(typeof file==='number')return value;
 const absolute=resolve(typeof file==='string'?file:'href' in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file));
 const target=relative(root,absolute).replace(/\\/gu,'/');
 if(!configClassSourceBinding.sources.some(row=>row.file===target))return value;
 const text=typeof value==='string'?value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);
 const previous=reverseConfigClassSource(target,text);
 return typeof value==='string'?previous:new TextEncoder().encode(previous);
}) as typeof readFileSync;
export function applyConfigClassReport<T>(before:T,binding=configClassSourceBinding):T{
 const entry=binding.sources.find(row=>row.file===binding.current_report.file);
 if(!entry||entry.edits.length!==1||sha(JSON.stringify(before,null,2)+'\n')!==binding.previous_report.sha256||entry.before_sha256!==binding.previous_report.sha256||entry.after_sha256!==binding.current_report.sha256)throw Error('Config class API exact predecessor differs');
 const edit=entry.edits[0]!;
 if(JSON.stringify(JSON.parse(edit.before_source))!==JSON.stringify(before)||reverseExact(edit.after_source,entry)!==edit.before_source)throw Error('Config class complete report increment differs');
 return JSON.parse(edit.after_source) as T;
}

export function beforeConfigClassReport<T>(current:T,binding=configClassSourceBinding):T{
 const raw=JSON.stringify(current,null,2)+'\n';
 if(sha(raw)!==binding.current_report.sha256)throw Error('Config class API complete current report differs');
 return JSON.parse(reverseConfigClassSource(binding.current_report.file,raw,binding)) as T;
}
