import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parameterSourceBinding,reverseParameterSource,reverseParameterPredecessorPublication} from './parameterSourceBinding';
import {ruleSourceBinding,reverseRuleSource,reverseRulePredecessorPublication} from './ruleSourceBinding';
import {ensureSourceBinding,reverseEnsureSource} from './ensureSourceBinding';
import {unitSourceBinding,reverseUnitSource} from './unitSourceBinding';
import {groupSourceBinding,reverseGroupSource} from './groupSourceBinding';
import {deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource} from './deliverySourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from './migrationMergeCheckpointReport';
import type {RouteSourceFollowup} from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// This batch alone owns this pin. No predecessor proof/helper is rewritten.
const HOTWORD_PROOF_SHA='9db55d738908e60ec9f3850133470d5af79807465b46e443b44f92b84053c3d7';
const raw=readFileSync(resolve(root,'workers-ts/audit/product-hotword-author-source-binding-20261027.json'),'utf8');
if(sha(raw)!==HOTWORD_PROOF_SHA)throw Error('Hotword exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const hotwordSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string;git_blob:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;baseline:{file_count:number;sha256:string};
 predecessor_readports:string[];
 predecessor_publication:Array<{file:string;validation_sha256:string;accepted_sha256:string;validation_source:string;accepted_source:string;validation_origin:string;accepted_origin:string}>;
 predecessor_publication_origins:Record<string,{file:string;sha256:string;raw_utf8:string}>;
};
/** Parameter's final publication appended to its validation ledgers. Both images
 * are complete physical snapshots. Only these two precisely bound files map. */
export function reverseHotwordPredecessorPublication(file:string,source:string,proof=hotwordSourceBinding){
 const row=proof.predecessor_publication.find(item=>item.file===file);if(!row)return source;
 if(source!==row.accepted_source||sha(source)!==row.accepted_sha256||sha(row.validation_source)!==row.validation_sha256
  ||!source.startsWith(row.validation_source)||source===row.validation_source)throw Error('Hotword predecessor publication images differ');
 return row.validation_source;
}
/** One complete current file must match before an exact complete inverse is
 * returned; no call/string normalization or broad append trimming occurs. */
export function reverseHotwordSource(file:string,source:string,proof=hotwordSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)throw Error('Hotword complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;const name=target(file);
 const proofs=[hotwordSourceBinding,parameterSourceBinding,ruleSourceBinding,ensureSourceBinding,unitSourceBinding,groupSourceBinding,deliverySourceBinding,staffSourceBinding,storeSourceBinding,userLabelSourceBinding,levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!hotwordSourceBinding.predecessor_publication.some(row=>row.file===name)
  &&!(layer>=1&&parameterSourceBinding.predecessor_publication.some(row=>row.file===name))
  &&!(layer>=2&&ruleSourceBinding.predecessor_publication.some(row=>row.file===name))
  &&!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseHotwordSource(name,value);value=reverseHotwordPredecessorPublication(name,value);
 // Reader0 is Parameter's actual validation image, before its accepted ledger append.
 if(layer>=1){value=reverseParameterSource(name,value);value=reverseParameterPredecessorPublication(name,value);}
 if(layer>=2){value=reverseRuleSource(name,value);value=reverseRulePredecessorPublication(name,value);}
 if(layer>=3)value=reverseEnsureSource(name,value);
 if(layer>=4)value=reverseUnitSource(name,value);
 if(layer>=5)value=reverseGroupSource(name,value);
 if(layer>=6)value=reverseDeliverySource(name,value);
 if(layer>=7)value=reverseStaffSource(name,value);
 if(layer>=8)value=reverseStoreSource(name,value);
 if(layer>=9)value=reverseUserLabelSource(name,value);
 if(layer>=10)value=reverseLevelSource(name,value);
 if(layer>=11)value=reverseExpressSource(name,value);
 if(layer>=12)value=reversePlatformMenuSource(name,value);
 if(layer>=13)value=reverseAdminProfileSource(name,value);
 if(layer>=14)value=reverseErrorPagesSource(name,value);
 if(layer>=15)value=reverseBrowserLogSource(name,value);
 if(layer>=16)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readHotwordPredecessor=reader(0),readParameterPredecessor=reader(1),readRulePredecessor=reader(2),readEnsurePredecessor=reader(3),readUnitPredecessor=reader(4),readGroupPredecessor=reader(5),readDeliveryPredecessor=reader(6),readStaffPredecessor=reader(7),readStorePredecessor=reader(8),readUserLabelPredecessor=reader(9),readLevelPredecessor=reader(10),readExpressPredecessor=reader(11),readPlatformMenuPredecessor=reader(12),readAdminProfilePredecessor=reader(13),readAdminProfileThenErrorPagesPredecessor=reader(14),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(15),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(16);
export {parameterSourceBinding,reverseParameterSource,reverseParameterPredecessorPublication,ruleSourceBinding,reverseRuleSource,reverseRulePredecessorPublication,ensureSourceBinding,reverseEnsureSource,unitSourceBinding,reverseUnitSource,groupSourceBinding,reverseGroupSource,deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};
/** Evaluate the real present AST inventory first; only SHA-bound whole reports follow. */
export function buildHotwordPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(actual,null,2)+'\n')!==hotwordSourceBinding.current_report.sha256)throw Error('Hotword current API inventory differs');
 return archived(hotwordSourceBinding.previous_report,parameterSourceBinding.current_report.sha256);
}
export function buildParameterPredecessorApiAuditReport(){buildHotwordPredecessorApiAuditReport();return archived(parameterSourceBinding.previous_report,ruleSourceBinding.current_report.sha256);}
export function buildRulePredecessorApiAuditReport(){buildParameterPredecessorApiAuditReport();return archived(ruleSourceBinding.previous_report,ensureSourceBinding.current_report.sha256);}
export function buildEnsurePredecessorApiAuditReport(){buildRulePredecessorApiAuditReport();return archived(ensureSourceBinding.previous_report,unitSourceBinding.current_report.sha256);}
export function buildUnitPredecessorApiAuditReport(){buildEnsurePredecessorApiAuditReport();return archived(unitSourceBinding.previous_report,groupSourceBinding.current_report.sha256);}
export function buildGroupPredecessorApiAuditReport(){buildUnitPredecessorApiAuditReport();return archived(groupSourceBinding.previous_report,deliverySourceBinding.current_report.sha256);}
export function buildDeliveryPredecessorApiAuditReport(){buildGroupPredecessorApiAuditReport();return archived(deliverySourceBinding.previous_report,staffSourceBinding.current_report.sha256);}
export function buildStaffPredecessorApiAuditReport(){buildDeliveryPredecessorApiAuditReport();return archived(staffSourceBinding.previous_report,storeSourceBinding.current_report.sha256);}
export function buildStorePredecessorApiAuditReport(){buildStaffPredecessorApiAuditReport();return archived(storeSourceBinding.previous_report,userLabelSourceBinding.current_report.sha256);}
export function buildUserLabelPredecessorApiAuditReport(){buildStorePredecessorApiAuditReport();return archived(userLabelSourceBinding.previous_report,levelSourceBinding.current_report.sha256);}
export function buildLevelPredecessorApiAuditReport(){buildUserLabelPredecessorApiAuditReport();return archived(levelSourceBinding.previous_report,expressSourceBinding.current_report.sha256);}
export function buildExpressPredecessorApiAuditReport(){buildLevelPredecessorApiAuditReport();return archived(expressSourceBinding.previous_report,platformMenuSourceBinding.current_report.sha256);}
export function buildPlatformMenuPredecessorApiAuditReport(){buildExpressPredecessorApiAuditReport();return archived(platformMenuSourceBinding.previous_report,adminProfileSourceBinding.current_report.sha256);}
export function buildAdminProfilePredecessorApiAuditReport(){buildPlatformMenuPredecessorApiAuditReport();return archived(adminProfileSourceBinding.previous_report);}
function archived(old:{sha256:string;raw_utf8:string},expected?:string):Report{
 if(sha(old.raw_utf8)!==old.sha256||expected!==undefined&&old.sha256!==expected)throw Error('Full predecessor API inventory differs');return JSON.parse(old.raw_utf8) as Report;
}
