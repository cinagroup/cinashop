import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource} from './expressSourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from './migrationMergeCheckpointReport';
import type {RouteSourceFollowup} from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..'),sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// The publisher updates only this new-layer pin after complete proof generation.
const PROOF_SHA='b7bb59cd7162f559537ab69d05aa6475217c1cf7117201078357db692ad7a974';
const raw=readFileSync(resolve(root,'workers-ts/audit/level-author-source-binding-20261026.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('Level exact proof bytes differ');
export const levelSourceBinding=JSON.parse(raw) as {sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};boundaries:Record<string,string>};

/** No generalized edit search or fallback: a modified file must be the exact
 * complete current byte image, with one exact complete predecessor image. */
export function reverseLevelSource(file:string,source:string,proof=levelSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;
 const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)throw Error('Level complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;
 const name=target(file),proofs=[levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseLevelSource(name,value);if(layer>=1)value=reverseExpressSource(name,value);if(layer>=2)value=reversePlatformMenuSource(name,value);if(layer>=3)value=reverseAdminProfileSource(name,value);if(layer>=4)value=reverseErrorPagesSource(name,value);if(layer>=5)value=reverseBrowserLogSource(name,value);if(layer>=6)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readLevelPredecessor=reader(0),readExpressPredecessor=reader(1),readPlatformMenuPredecessor=reader(2),readAdminProfilePredecessor=reader(3),readAdminProfileThenErrorPagesPredecessor=reader(4),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(5),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(6);
export {expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};
/** Always rebuild the real current AST first, then verify every complete
 * archived report in the chain. Old builders/helpers are never monkey-patched. */
export function buildLevelPredecessorApiAuditReport(){const actual=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(actual,null,2)+'\n')!==levelSourceBinding.current_report.sha256)throw Error('Level current API inventory differs');const old=levelSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256||old.sha256!==expressSourceBinding.current_report.sha256)throw Error('Level full predecessor API inventory differs');return JSON.parse(old.raw_utf8) as typeof actual;}
export function buildExpressPredecessorApiAuditReport(){buildLevelPredecessorApiAuditReport();const old=expressSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256||old.sha256!==platformMenuSourceBinding.current_report.sha256)throw Error('Express full predecessor API inventory differs');return JSON.parse(old.raw_utf8) as ReturnType<typeof buildAdminFrontendApiAuditReport>;}
export function buildPlatformMenuPredecessorApiAuditReport(){buildExpressPredecessorApiAuditReport();const old=platformMenuSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256||old.sha256!==adminProfileSourceBinding.current_report.sha256)throw Error('Platform menu full predecessor API inventory differs');return JSON.parse(old.raw_utf8) as ReturnType<typeof buildAdminFrontendApiAuditReport>;}
export function buildAdminProfilePredecessorApiAuditReport(){buildPlatformMenuPredecessorApiAuditReport();const old=adminProfileSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256)throw Error('Profile predecessor inventory differs');return JSON.parse(old.raw_utf8) as ReturnType<typeof buildAdminFrontendApiAuditReport>;}
