import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configClassSourceBinding, reverseConfigClassSource } from './configClassSourceBinding';
import { browserLogSourceBinding, reverseBrowserLogSource } from './browserLogSourceBinding';
import type { RouteSourceFollowup } from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(root,'workers-ts/audit/error-pages-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='f8c903e9d3516cb4d5662e794a37224a2c2b5684712ccdded4d626a151c9ed06')throw Error('Error pages exact source binding bytes differ');
export const errorPagesSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string}>;
 observed_unchanged:Record<string,string>;frozen_predecessor_evidence:Record<string,string>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;lines:number;raw_utf8:string}>;
 PHP_evidence:Array<{source:string;start:number;end:number;fragment:string;fragment_sha256:string}>;
 current_report:{file:string;sha256:string};boundaries:Record<string,string>;
};
function reverseExact(source:string,entry:RouteSourceFollowup){
 if(sha(source)!==entry.after_sha256)throw Error('Error pages current source differs');
 for(const edit of entry.edits)if(!edit.after_source||source.split(edit.after_source).length!==2||source.slice(0,source.indexOf(edit.after_source)).split('\n').length!==edit.after_line)throw Error('Error pages exact body differs');
 let previous=source;
 for(const edit of entry.edits)previous=previous.replace(edit.after_source,()=>edit.before_source);
 if(sha(previous)!==entry.before_sha256)throw Error('Error pages predecessor source differs');
 for(const edit of entry.edits)if(edit.before_source&&(previous.split(edit.before_source).length!==2||previous.slice(0,previous.indexOf(edit.before_source)).split('\n').length!==edit.before_line))throw Error('Error pages predecessor location differs');
 return previous;
}
export function reverseErrorPagesSource(file:string,source:string,binding=errorPagesSourceBinding){const entry=binding.sources.find(row=>row.file===file);return entry?reverseExact(source,entry):source;}
function targetFile(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function readBefore(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const value=readFileSync(file,options);if(typeof file==='number')return value;const target=targetFile(file);
 if(!errorPagesSourceBinding.sources.some(row=>row.file===target)&&!(layer>0&&browserLogSourceBinding.sources.some(row=>row.file===target))&&!(layer>1&&configClassSourceBinding.sources.some(row=>row.file===target)))return value;
 const text=typeof value==='string'?value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);
 const outer=reverseErrorPagesSource(target,text),previous=layer>0?reverseBrowserLogSource(target,outer):outer,result=layer>1?reverseConfigClassSource(target,previous):previous;
 return typeof value==='string'?result:new TextEncoder().encode(result);
}
/** Each layer accepts complete SHA-pinned source; older helpers and proofs stay immutable. */
export const readErrorPagesPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>readBefore(file,options,0)) as typeof readFileSync;
export const readErrorPagesThenBrowserLogPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>readBefore(file,options,1)) as typeof readFileSync;
export const readErrorPagesThenBrowserLogThenConfigClassPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>readBefore(file,options,2)) as typeof readFileSync;
