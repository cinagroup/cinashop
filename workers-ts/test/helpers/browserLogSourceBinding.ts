import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configClassSourceBinding, reverseConfigClassSource } from './configClassSourceBinding';
import type { RouteSourceFollowup } from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(root,'workers-ts/audit/browser-log-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='89328bcd0d6d8492613bb66c28dd799dad92ad703683989d11c9286d2c7a9f16')throw Error('Browser log exact source binding bytes differ');
export const browserLogSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string}>;
 observed_unchanged:Record<string,string>;frozen_predecessor_evidence:Record<string,string>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;lines:number;raw_utf8:string}>;
 PHP_evidence:Array<{source:string;start:number;end:number;fragment:string;fragment_sha256:string}>;
 current_report:{file:string;sha256:string};boundaries:Record<string,string>;
};
function reverseExact(source:string,entry:RouteSourceFollowup){
 if(sha(source)!==entry.after_sha256)throw Error('Browser log current source differs');
 for(const edit of entry.edits)if(!edit.after_source||source.split(edit.after_source).length!==2||source.slice(0,source.indexOf(edit.after_source)).split('\n').length!==edit.after_line)throw Error('Browser log exact body differs');
 let previous=source;
 for(const edit of entry.edits)previous=previous.replace(edit.after_source,()=>edit.before_source);
 if(sha(previous)!==entry.before_sha256)throw Error('Browser log predecessor source differs');
 for(const edit of entry.edits)if(edit.before_source&&(previous.split(edit.before_source).length!==2||previous.slice(0,previous.indexOf(edit.before_source)).split('\n').length!==edit.before_line))throw Error('Browser log predecessor location differs');
 return previous;
}
export function reverseBrowserLogSource(file:string,source:string,binding=browserLogSourceBinding){const entry=binding.sources.find(row=>row.file===file);return entry?reverseExact(source,entry):source;}
function targetFile(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function readBefore(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],configClass:boolean){
 const value=readFileSync(file,options);if(typeof file==='number')return value;const target=targetFile(file);
 if(!browserLogSourceBinding.sources.some(row=>row.file===target)&&(!configClass||!configClassSourceBinding.sources.some(row=>row.file===target)))return value;
 const text=typeof value==='string'?value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);
 const previous=reverseBrowserLogSource(target,text),result=configClass?reverseConfigClassSource(target,previous):previous;
 return typeof value==='string'?result:new TextEncoder().encode(result);
}
/** Compose only complete SHA-pinned outer layers; older readers and proofs stay byte-identical. */
export const readBrowserLogPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>readBefore(file,options,false)) as typeof readFileSync;
export const readBrowserLogThenConfigClassPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>readBefore(file,options,true)) as typeof readFileSync;
