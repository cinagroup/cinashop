import {createHash} from 'node:crypto';
import {groupSourceBinding,reverseGroupSource} from './groupSourceBinding';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource} from './deliverySourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from '../../scripts/admin-frontend-api-audit';
import type {RouteSourceFollowup} from './routeSourceIncrement';

const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// Only this new-layer pin is refreshed by the current batch's proof publisher.
const PROOF_SHA='d51dd1d86b7462d3d5a0978fa1f4c81e8c8902c97ecfb61a6f85609a8b3763c0';
const raw=readFileSync(resolve(root,'workers-ts/audit/product-unit-author-source-binding-20261026.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('Unit exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const unitSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;baseline:{file_count:number;sha256:string};
 predecessor_readports:string[];
 permission_test_extension:{file:string;added_source:string;before_sha256:string;after_sha256:string;unchanged_case_count:number;applied:boolean};
};

/** Exact complete current image -> exact complete predecessor image. There is
 * no matching arbitrary call text, line normalization or partial reverse edit. */
export function reverseUnitSource(file:string,source:string,proof=unitSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;
 const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)
  throw Error('Unit complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;
 const name=target(file),proofs=[unitSourceBinding,groupSourceBinding,deliverySourceBinding,staffSourceBinding,storeSourceBinding,userLabelSourceBinding,levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseUnitSource(name,value);
 if(layer>=1)value=reverseGroupSource(name,value);
 if(layer>=2)value=reverseDeliverySource(name,value);if(layer>=3)value=reverseStaffSource(name,value);
 if(layer>=4)value=reverseStoreSource(name,value);if(layer>=5)value=reverseUserLabelSource(name,value);
 if(layer>=6)value=reverseLevelSource(name,value);if(layer>=7)value=reverseExpressSource(name,value);
 if(layer>=8)value=reversePlatformMenuSource(name,value);if(layer>=9)value=reverseAdminProfileSource(name,value);
 if(layer>=10)value=reverseErrorPagesSource(name,value);if(layer>=11)value=reverseBrowserLogSource(name,value);
 if(layer>=12)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readUnitPredecessor=reader(0),readGroupPredecessor=reader(1),readDeliveryPredecessor=reader(2),readStaffPredecessor=reader(3),readStorePredecessor=reader(4),readUserLabelPredecessor=reader(5),readLevelPredecessor=reader(6),readExpressPredecessor=reader(7),readPlatformMenuPredecessor=reader(8),readAdminProfilePredecessor=reader(9),readAdminProfileThenErrorPagesPredecessor=reader(10),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(11),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(12);
export {groupSourceBinding,reverseGroupSource,deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};

/** Build the real present inventory once, then verify each complete archived
 * predecessor. No call removal, URL rewriting or line normalization occurs. */
export function buildUnitPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();
 if(sha(JSON.stringify(actual,null,2)+'\n')!==unitSourceBinding.current_report.sha256)throw Error('Unit current API inventory differs');
 const old=unitSourceBinding.previous_report;
 if(sha(old.raw_utf8)!==old.sha256||old.sha256!==groupSourceBinding.current_report.sha256)throw Error('Unit full predecessor API inventory differs');
 return JSON.parse(old.raw_utf8) as Report;
}
export function buildGroupPredecessorApiAuditReport(){buildUnitPredecessorApiAuditReport();return archived(groupSourceBinding.previous_report,deliverySourceBinding.current_report.sha256);}
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
