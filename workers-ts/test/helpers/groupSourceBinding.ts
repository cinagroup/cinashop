import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource} from './deliverySourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from './migrationMergeCheckpointReport';
import type {RouteSourceFollowup} from './routeSourceIncrement';

const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// Only this new-layer pin is refreshed by the current batch's proof publisher.
const PROOF_SHA='3e4a3ec3fc684dc585d552247a0f5150302b7c38ce507fdd770c3de0bf64d777';
const raw=readFileSync(resolve(root,'workers-ts/audit/user-group-author-source-binding-20261026.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('Group exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const groupSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;baseline:{file_count:number;sha256:string};
 permission_test_extension:{file:string;added_source:string;before_sha256:string;after_sha256:string;unchanged_case_count:number};
 frontend_test_maintenance:{file:string;case_count:number;counts_as_new:false;cases:Array<{title:string;purpose:string;before_sha256:string;after_sha256:string;negative_mappings:Array<{before:string;after:string}>}>};
};

/** Exact complete current image -> exact complete predecessor image. There is
 * no matching arbitrary call text, line normalization or partial reverse edit. */
export function reverseGroupSource(file:string,source:string,proof=groupSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;
 const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)
  throw Error('Group complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;
 const name=target(file),proofs=[groupSourceBinding,deliverySourceBinding,staffSourceBinding,storeSourceBinding,userLabelSourceBinding,levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseGroupSource(name,value);
 if(layer>=1)value=reverseDeliverySource(name,value);if(layer>=2)value=reverseStaffSource(name,value);
 if(layer>=3)value=reverseStoreSource(name,value);if(layer>=4)value=reverseUserLabelSource(name,value);
 if(layer>=5)value=reverseLevelSource(name,value);if(layer>=6)value=reverseExpressSource(name,value);
 if(layer>=7)value=reversePlatformMenuSource(name,value);if(layer>=8)value=reverseAdminProfileSource(name,value);
 if(layer>=9)value=reverseErrorPagesSource(name,value);if(layer>=10)value=reverseBrowserLogSource(name,value);
 if(layer>=11)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readGroupPredecessor=reader(0),readDeliveryPredecessor=reader(1),readStaffPredecessor=reader(2),readStorePredecessor=reader(3),readUserLabelPredecessor=reader(4),readLevelPredecessor=reader(5),readExpressPredecessor=reader(6),readPlatformMenuPredecessor=reader(7),readAdminProfilePredecessor=reader(8),readAdminProfileThenErrorPagesPredecessor=reader(9),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(10),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(11);
export {deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};

/** Build the real present inventory once, then verify each complete archived
 * predecessor. No call removal, URL rewriting or line normalization occurs. */
export function buildGroupPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();
 if(sha(JSON.stringify(actual,null,2)+'\n')!==groupSourceBinding.current_report.sha256)throw Error('Group current API inventory differs');
 const old=groupSourceBinding.previous_report;
 if(sha(old.raw_utf8)!==old.sha256||old.sha256!==deliverySourceBinding.current_report.sha256)throw Error('Group full predecessor API inventory differs');
 return JSON.parse(old.raw_utf8) as Report;
}
export function buildDeliveryPredecessorApiAuditReport(){buildGroupPredecessorApiAuditReport();return archived(deliverySourceBinding.previous_report,staffSourceBinding.current_report.sha256);}
function archived(old:{sha256:string;raw_utf8:string},expected?:string):Report{
 if(sha(old.raw_utf8)!==old.sha256||expected!==undefined&&old.sha256!==expected)throw Error('Full predecessor API inventory differs');
 return JSON.parse(old.raw_utf8) as Report;
}
export function buildStaffPredecessorApiAuditReport(){buildDeliveryPredecessorApiAuditReport();return archived(staffSourceBinding.previous_report,storeSourceBinding.current_report.sha256);}
export function buildStorePredecessorApiAuditReport(){buildStaffPredecessorApiAuditReport();return archived(storeSourceBinding.previous_report,userLabelSourceBinding.current_report.sha256);}
export function buildUserLabelPredecessorApiAuditReport(){buildStorePredecessorApiAuditReport();return archived(userLabelSourceBinding.previous_report,levelSourceBinding.current_report.sha256);}
export function buildLevelPredecessorApiAuditReport(){buildUserLabelPredecessorApiAuditReport();return archived(levelSourceBinding.previous_report,expressSourceBinding.current_report.sha256);}
export function buildExpressPredecessorApiAuditReport(){buildLevelPredecessorApiAuditReport();return archived(expressSourceBinding.previous_report,platformMenuSourceBinding.current_report.sha256);}
export function buildPlatformMenuPredecessorApiAuditReport(){buildExpressPredecessorApiAuditReport();return archived(platformMenuSourceBinding.previous_report,adminProfileSourceBinding.current_report.sha256);}
export function buildAdminProfilePredecessorApiAuditReport(){buildPlatformMenuPredecessorApiAuditReport();return archived(adminProfileSourceBinding.previous_report);}
