import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource} from './levelSourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from './migrationMergeCheckpointReport';
import type {RouteSourceFollowup} from './routeSourceIncrement';

const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// Only this new-layer pin is refreshed by the current batch's proof publisher.
const PROOF_SHA='9aea23c96f1e70cbfe3d4eae0b334f9e9abe3fff4d7d023da2a827d0eefa4261';
const raw=readFileSync(resolve(root,'workers-ts/audit/user-label-author-source-binding-20261026.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('User-label exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const userLabelSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;
};

/** Exact complete current image -> exact complete predecessor image. There is
 * no matching arbitrary call text, line normalization or partial reverse edit. */
export function reverseUserLabelSource(file:string,source:string,proof=userLabelSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;
 const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)
  throw Error('User-label complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;
 const name=target(file),proofs=[userLabelSourceBinding,levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseUserLabelSource(name,value);
 if(layer>=1)value=reverseLevelSource(name,value);if(layer>=2)value=reverseExpressSource(name,value);
 if(layer>=3)value=reversePlatformMenuSource(name,value);if(layer>=4)value=reverseAdminProfileSource(name,value);
 if(layer>=5)value=reverseErrorPagesSource(name,value);if(layer>=6)value=reverseBrowserLogSource(name,value);
 if(layer>=7)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readUserLabelPredecessor=reader(0),readLevelPredecessor=reader(1),readExpressPredecessor=reader(2),readPlatformMenuPredecessor=reader(3),readAdminProfilePredecessor=reader(4),readAdminProfileThenErrorPagesPredecessor=reader(5),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(6),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(7);
export {levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};

/** Build the real present inventory once, then verify every full archived
 * predecessor. Retired LabelList calls exist only in that archived report. */
export function buildUserLabelPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();
 if(sha(JSON.stringify(actual,null,2)+'\n')!==userLabelSourceBinding.current_report.sha256)throw Error('User-label current API inventory differs');
 const old=userLabelSourceBinding.previous_report;
 if(sha(old.raw_utf8)!==old.sha256||old.sha256!==levelSourceBinding.current_report.sha256)throw Error('User-label full predecessor API inventory differs');
 return JSON.parse(old.raw_utf8) as Report;
}
function archived(old:{sha256:string;raw_utf8:string},expected?:string):Report{
 if(sha(old.raw_utf8)!==old.sha256||expected!==undefined&&old.sha256!==expected)throw Error('Full predecessor API inventory differs');
 return JSON.parse(old.raw_utf8) as Report;
}
export function buildLevelPredecessorApiAuditReport(){buildUserLabelPredecessorApiAuditReport();return archived(levelSourceBinding.previous_report,expressSourceBinding.current_report.sha256);}
export function buildExpressPredecessorApiAuditReport(){buildLevelPredecessorApiAuditReport();return archived(expressSourceBinding.previous_report,platformMenuSourceBinding.current_report.sha256);}
export function buildPlatformMenuPredecessorApiAuditReport(){buildExpressPredecessorApiAuditReport();return archived(platformMenuSourceBinding.previous_report,adminProfileSourceBinding.current_report.sha256);}
export function buildAdminProfilePredecessorApiAuditReport(){buildPlatformMenuPredecessorApiAuditReport();return archived(adminProfileSourceBinding.previous_report);}
