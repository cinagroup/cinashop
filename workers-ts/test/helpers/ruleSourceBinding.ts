import {createHash} from 'node:crypto';
import {ensureSourceBinding,reverseEnsureSource} from './ensureSourceBinding';
import {unitSourceBinding,reverseUnitSource} from './unitSourceBinding';
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
const RULE_PROOF_SHA='392bc3bcf6f9598b2a6651c8454a92d349ee07dda5a3025fb253f55d3d5985c1';
const raw=readFileSync(resolve(root,'workers-ts/audit/product-rule-author-source-binding-20261026.json'),'utf8');
if(sha(raw)!==RULE_PROOF_SHA)throw Error('Rule exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const ruleSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;baseline:{file_count:number;sha256:string};
 predecessor_readports:string[];
 predecessor_publication:Array<{file:string;validation_sha256:string;accepted_sha256:string;validation_source:string;accepted_source:string}>;
};

/** The predecessor's accepted ledgers contain its later publication append.
 * Bind both complete images before reading its immutable validation contract. */
export function reverseRulePredecessorPublication(file:string,source:string,proof=ruleSourceBinding){
 const row=proof.predecessor_publication.find(item=>item.file===file);if(!row)return source;
 if(source!==row.accepted_source||sha(source)!==row.accepted_sha256||sha(row.validation_source)!==row.validation_sha256
  ||!source.startsWith(row.validation_source)||source===row.validation_source)throw Error('Rule predecessor publication images differ');
 return row.validation_source;
}

/** Exact complete current image -> exact complete predecessor image. There is
 * no matching arbitrary call text, line normalization or partial reverse edit. */
export function reverseRuleSource(file:string,source:string,proof=ruleSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;
 const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)
  throw Error('Rule complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 const result=readFileSync(file,options);if(typeof file==='number')return result;
 const name=target(file),proofs=[ruleSourceBinding,ensureSourceBinding,unitSourceBinding,groupSourceBinding,deliverySourceBinding,staffSourceBinding,storeSourceBinding,userLabelSourceBinding,levelSourceBinding,expressSourceBinding,platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];
 if(!ruleSourceBinding.predecessor_publication.some(row=>row.file===name)&&!proofs.slice(0,layer+1).some(proof=>proof.sources.some(row=>row.file===name)))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 value=reverseRuleSource(name,value);
 value=reverseRulePredecessorPublication(name,value);
 if(layer>=1)value=reverseEnsureSource(name,value);
 if(layer>=2)value=reverseUnitSource(name,value);
 if(layer>=3)value=reverseGroupSource(name,value);
 if(layer>=4)value=reverseDeliverySource(name,value);if(layer>=5)value=reverseStaffSource(name,value);
 if(layer>=6)value=reverseStoreSource(name,value);if(layer>=7)value=reverseUserLabelSource(name,value);
 if(layer>=8)value=reverseLevelSource(name,value);if(layer>=9)value=reverseExpressSource(name,value);
 if(layer>=10)value=reversePlatformMenuSource(name,value);if(layer>=11)value=reverseAdminProfileSource(name,value);
 if(layer>=12)value=reverseErrorPagesSource(name,value);if(layer>=13)value=reverseBrowserLogSource(name,value);
 if(layer>=14)value=reverseConfigClassSource(name,value);
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readRulePredecessor=reader(0),readEnsurePredecessor=reader(1),readUnitPredecessor=reader(2),readGroupPredecessor=reader(3),readDeliveryPredecessor=reader(4),readStaffPredecessor=reader(5),readStorePredecessor=reader(6),readUserLabelPredecessor=reader(7),readLevelPredecessor=reader(8),readExpressPredecessor=reader(9),readPlatformMenuPredecessor=reader(10),readAdminProfilePredecessor=reader(11),readAdminProfileThenErrorPagesPredecessor=reader(12),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(13),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(14);
export {ensureSourceBinding,reverseEnsureSource,unitSourceBinding,reverseUnitSource,groupSourceBinding,reverseGroupSource,deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};

/** Build the real present inventory once, then verify each complete archived
 * predecessor. No call removal, URL rewriting or line normalization occurs. */
export function buildRulePredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();
 if(sha(JSON.stringify(actual,null,2)+'\n')!==ruleSourceBinding.current_report.sha256)throw Error('Rule current API inventory differs');
 return archived(ruleSourceBinding.previous_report,ensureSourceBinding.current_report.sha256);
}
export function buildEnsurePredecessorApiAuditReport(){buildRulePredecessorApiAuditReport();return archived(ensureSourceBinding.previous_report,unitSourceBinding.current_report.sha256);}
export function buildUnitPredecessorApiAuditReport(){buildEnsurePredecessorApiAuditReport();return archived(unitSourceBinding.previous_report,groupSourceBinding.current_report.sha256);}
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
