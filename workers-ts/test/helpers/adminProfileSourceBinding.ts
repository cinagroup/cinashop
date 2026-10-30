import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorPagesSourceBinding, reverseErrorPagesSource } from './errorPagesSourceBinding';
import { browserLogSourceBinding, reverseBrowserLogSource } from './browserLogSourceBinding';
import { configClassSourceBinding, reverseConfigClassSource } from './configClassSourceBinding';
import { buildAdminFrontendApiAuditReport } from './migrationMergeCheckpointReport';
import type { RouteSourceFollowup } from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..'),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const PROOF_SHA='014557a014be467ac07bc9d57b57caa46f1e9544ea3b8b01c01887eee6b111f6';
const raw=readFileSync(resolve(root,'workers-ts/audit/admin-profile-source-binding-20261025.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('Admin profile exact proof bytes differ');
export const adminProfileSourceBinding=JSON.parse(raw) as {sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string;bytes:number}>;frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;raw_utf8:string;bytes:number}>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};boundaries:Record<string,string>};
export function reverseAdminProfileSource(file:string,source:string,proof=adminProfileSourceBinding){
 const entry=proof.sources.find(row=>row.file===file);if(!entry)return source;
 if(sha(source)!==entry.after_sha256 || entry.edits.length!==1)throw Error('Admin profile complete source differs');
 const edit=entry.edits[0]!;
 if(edit.after_line!==1 || edit.before_line!==1 || edit.after_source!==source || sha(edit.before_source)!==entry.before_sha256)throw Error('Admin profile exact predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;const name=target(file);
 if(!adminProfileSourceBinding.sources.some(row=>row.file===name) && !(layer>=1&&errorPagesSourceBinding.sources.some(row=>row.file===name)) && !(layer>=2&&browserLogSourceBinding.sources.some(row=>row.file===name)) && !(layer>=3&&configClassSourceBinding.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseAdminProfileSource(name,value);
 if(layer>=1)value=reverseErrorPagesSource(name,value);
 if(layer>=2)value=reverseBrowserLogSource(name,value);
 if(layer>=3)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:new TextEncoder().encode(value);
}
export const readAdminProfilePredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,0)) as typeof readFileSync;
export const readAdminProfileThenErrorPagesPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,1)) as typeof readFileSync;
export const readAdminProfileThenErrorPagesThenBrowserLogPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,2)) as typeof readFileSync;
export const readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,3)) as typeof readFileSync;
/** Verify the real current AST report first, then supply the exact historical
 * report to immutable predecessor assertions. No historical assertions change. */
export function buildAdminProfilePredecessorApiAuditReport(){
 const current=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(current,null,2)+'\n')!==adminProfileSourceBinding.current_report.sha256)throw Error('Admin profile real API inventory differs');
 const old=adminProfileSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256)throw Error('Admin profile historical API inventory differs');
 return JSON.parse(old.raw_utf8) as typeof current;
}
