import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {productLabelAuthorSourceBinding,reverseProductLabelAuthorSource,reverseProductLabelAuthorPredecessorPublication} from './productLabelAuthorSourceBinding';
import {hotwordSourceBinding,reverseHotwordSource,reverseHotwordPredecessorPublication} from './hotwordSourceBinding';
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
import {supplierProductLabelRuntimeSourceBinding,reverseSupplierProductLabelRuntimeSource,reverseSupplierProductLabelRuntimePredecessorPublication} from './supplierProductLabelRuntimeSourceBinding';
import {bargainRecordsSourceBinding,reverseBargainRecordsSource,reverseBargainRecordsPredecessorPublication,bargainRecordsPredecessorExecFileSync} from './bargainRecordsSourceBinding';
import {wechatMenuAuthorSourceBinding,reverseWechatMenuAuthorSource,reverseWechatMenuAuthorPredecessorPublication,wechatMenuAuthorPredecessorExecFileSync} from './wechatMenuAuthorSourceBinding';
import {wechatBaseAuthorSourceBinding,reverseWechatBaseAuthorSource,reverseWechatBaseAuthorPredecessorPublication,wechatBaseAuthorPredecessorExecFileSync} from './wechatBaseAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// This new layer alone owns its proof pin. Final publication follows actual runtime gates.
const WECHAT_OPEN_AUTHOR_PROOF_SHA='fe4fc0b33f35c07dc4d93934841d17195462c60206301237c5564b5dc3d6344f';
const raw=readFileSync(resolve(root,'workers-ts/audit/wechat-open-author-source-binding-20261027.json'),'utf8');
if(sha(raw)!==WECHAT_OPEN_AUTHOR_PROOF_SHA)throw Error('Wechat open author exact proof bytes differ');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
export const wechatOpenAuthorSourceBinding=JSON.parse(raw) as {
 sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string;git_blob:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};
 retired_api_calls:Report['calls'];boundaries:Record<string,string>;baseline:{file_count:number;sha256:string};
 predecessor_readports:string[];
 predecessor_publication:Array<{file:string;validation_sha256:string;accepted_sha256:string;validation_source:string;accepted_source:string;validation_origin:string;accepted_origin:string}>;
 predecessor_publication_origins:Record<string,{file:string;sha256:string;raw_utf8:string}>;
};
/** Complete accepted Wechat base publication maps to its validation image.
 * Both full byte images have five physical manifest/receipt origin records. */
export function reverseWechatOpenAuthorPredecessorPublication(file:string,source:string,proof=wechatOpenAuthorSourceBinding){
 const row=proof.predecessor_publication.find(item=>item.file===file);if(!row)return source;
 if(source!==row.accepted_source||sha(source)!==row.accepted_sha256||sha(row.validation_source)!==row.validation_sha256
  ||!source.startsWith(row.validation_source)||source===row.validation_source)throw Error('Wechat open author predecessor publication images differ');
 return row.validation_source;
}
/** A whole current file must match exactly before its complete predecessor returns. */
export function reverseWechatOpenAuthorSource(file:string,source:string,proof=wechatOpenAuthorSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)throw Error('Wechat open author complete source or predecessor differs');
 return edit.before_source;
}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 if(typeof file==='number')return readFileSync(file,options);const name=target(file);
 // Exact immutable physical views: Base331 -> Menu329 -> Bargain327 -> Supplier321.
 if(name.startsWith('view/admin-ts/dist/')){
  const view=layer===0?wechatOpenAuthorSourceBinding:layer===1?wechatBaseAuthorSourceBinding:layer===2?wechatMenuAuthorSourceBinding:bargainRecordsSourceBinding;
  const archived=(view as typeof view&{predecessor_generated_outputs:Array<{path:string;origin:string;bytes:number;sha256:string}>}).predecessor_generated_outputs.find(row=>row.path===name);
  if(!archived)throw Error('Unexpected predecessor generated member');
  const bytes=readFileSync(archived.origin);if(bytes.byteLength!==archived.bytes||sha(bytes)!==archived.sha256)throw Error('Exact physical predecessor generated bytes differ');
  return readFileSync(archived.origin,options);
 }
 const result=readFileSync(file,options);
 const transforms:Array<{proof:{sources:Array<{file:string}>;predecessor_publication?:Array<{file:string}>};reverse:(file:string,value:string)=>string;publication?:(file:string,value:string)=>string}>=[
  {proof:wechatOpenAuthorSourceBinding,reverse:reverseWechatOpenAuthorSource,publication:reverseWechatOpenAuthorPredecessorPublication},
  {proof:wechatBaseAuthorSourceBinding,reverse:reverseWechatBaseAuthorSource,publication:reverseWechatBaseAuthorPredecessorPublication},
  {proof:wechatMenuAuthorSourceBinding,reverse:reverseWechatMenuAuthorSource,publication:reverseWechatMenuAuthorPredecessorPublication},
  {proof:bargainRecordsSourceBinding,reverse:reverseBargainRecordsSource,publication:reverseBargainRecordsPredecessorPublication},
  {proof:supplierProductLabelRuntimeSourceBinding,reverse:reverseSupplierProductLabelRuntimeSource,publication:reverseSupplierProductLabelRuntimePredecessorPublication},
  {proof:productLabelAuthorSourceBinding,reverse:reverseProductLabelAuthorSource,publication:reverseProductLabelAuthorPredecessorPublication},
  {proof:hotwordSourceBinding,reverse:reverseHotwordSource,publication:reverseHotwordPredecessorPublication},
  {proof:parameterSourceBinding,reverse:reverseParameterSource,publication:reverseParameterPredecessorPublication},
  {proof:ruleSourceBinding,reverse:reverseRuleSource,publication:reverseRulePredecessorPublication},
  {proof:ensureSourceBinding,reverse:reverseEnsureSource},
  {proof:unitSourceBinding,reverse:reverseUnitSource},
  {proof:groupSourceBinding,reverse:reverseGroupSource},
  {proof:deliverySourceBinding,reverse:reverseDeliverySource},
  {proof:staffSourceBinding,reverse:reverseStaffSource},
  {proof:storeSourceBinding,reverse:reverseStoreSource},
  {proof:userLabelSourceBinding,reverse:reverseUserLabelSource},
  {proof:levelSourceBinding,reverse:reverseLevelSource},
  {proof:expressSourceBinding,reverse:reverseExpressSource},
  {proof:platformMenuSourceBinding,reverse:reversePlatformMenuSource},
  {proof:adminProfileSourceBinding,reverse:reverseAdminProfileSource},
  {proof:errorPagesSourceBinding,reverse:reverseErrorPagesSource},
  {proof:browserLogSourceBinding,reverse:reverseBrowserLogSource},
  {proof:configClassSourceBinding,reverse:reverseConfigClassSource},
 ];
 const active=transforms.slice(0,layer+1);if(!active.some(row=>row.proof.sources.some(item=>item.file===name)||Boolean(row.proof.predecessor_publication?.some(item=>item.file===name))))return result;
 let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);
 for(const row of active){value=row.reverse(name,value);if('publication'in row&&row.publication)value=row.publication(name,value);}
 return typeof result==='string'?value:Buffer.from(value,'utf8');
}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readWechatOpenAuthorPredecessor=reader(0),readWechatBaseAuthorPredecessor=reader(1),readWechatMenuAuthorPredecessor=reader(2),readBargainRecordsPredecessor=reader(3),readSupplierProductLabelRuntimePredecessor=reader(4),readProductLabelAuthorPredecessor=reader(5),readHotwordPredecessor=reader(6),readParameterPredecessor=reader(7),readRulePredecessor=reader(8),readEnsurePredecessor=reader(9),readUnitPredecessor=reader(10),readGroupPredecessor=reader(11),readDeliveryPredecessor=reader(12),readStaffPredecessor=reader(13),readStorePredecessor=reader(14),readUserLabelPredecessor=reader(15),readLevelPredecessor=reader(16),readExpressPredecessor=reader(17),readPlatformMenuPredecessor=reader(18),readAdminProfilePredecessor=reader(19),readAdminProfileThenErrorPagesPredecessor=reader(20),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(21),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(22);
export {wechatBaseAuthorSourceBinding,reverseWechatBaseAuthorSource,reverseWechatBaseAuthorPredecessorPublication,wechatBaseAuthorPredecessorExecFileSync,wechatMenuAuthorSourceBinding,reverseWechatMenuAuthorSource,reverseWechatMenuAuthorPredecessorPublication,wechatMenuAuthorPredecessorExecFileSync,bargainRecordsSourceBinding,reverseBargainRecordsSource,reverseBargainRecordsPredecessorPublication,bargainRecordsPredecessorExecFileSync,supplierProductLabelRuntimeSourceBinding,reverseSupplierProductLabelRuntimeSource,reverseSupplierProductLabelRuntimePredecessorPublication,productLabelAuthorSourceBinding,reverseProductLabelAuthorSource,reverseProductLabelAuthorPredecessorPublication,hotwordSourceBinding,reverseHotwordSource,reverseHotwordPredecessorPublication,parameterSourceBinding,reverseParameterSource,reverseParameterPredecessorPublication,ruleSourceBinding,reverseRuleSource,reverseRulePredecessorPublication,ensureSourceBinding,reverseEnsureSource,unitSourceBinding,reverseUnitSource,groupSourceBinding,reverseGroupSource,deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};
/** Always run the real current AST inventory before traversing archived full reports. */
export function buildWechatOpenAuthorPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(actual,null,2)+'\n')!==wechatOpenAuthorSourceBinding.current_report.sha256)throw Error('Wechat open author current API inventory differs');
 return archived(wechatOpenAuthorSourceBinding.previous_report,wechatBaseAuthorSourceBinding.current_report.sha256);
}
export function buildWechatBaseAuthorPredecessorApiAuditReport(){buildWechatOpenAuthorPredecessorApiAuditReport();return archived(wechatBaseAuthorSourceBinding.previous_report,wechatMenuAuthorSourceBinding.current_report.sha256);}
export function buildWechatMenuAuthorPredecessorApiAuditReport(){buildWechatBaseAuthorPredecessorApiAuditReport();return archived(wechatMenuAuthorSourceBinding.previous_report,bargainRecordsSourceBinding.current_report.sha256);}
export function buildBargainRecordsPredecessorApiAuditReport(){buildWechatMenuAuthorPredecessorApiAuditReport();return archived(bargainRecordsSourceBinding.previous_report,supplierProductLabelRuntimeSourceBinding.current_report.sha256);}
export function buildSupplierProductLabelRuntimePredecessorApiAuditReport(){buildBargainRecordsPredecessorApiAuditReport();return archived(supplierProductLabelRuntimeSourceBinding.previous_report,productLabelAuthorSourceBinding.current_report.sha256);}
export function buildProductLabelAuthorPredecessorApiAuditReport(){buildSupplierProductLabelRuntimePredecessorApiAuditReport();return archived(productLabelAuthorSourceBinding.previous_report,hotwordSourceBinding.current_report.sha256);}
export function buildHotwordPredecessorApiAuditReport(){buildProductLabelAuthorPredecessorApiAuditReport();return archived(hotwordSourceBinding.previous_report,parameterSourceBinding.current_report.sha256);}
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

export function wechatOpenAuthorPredecessorExecFileSync(command:string,args:string[],options:{cwd:string;encoding:string}){
 if(command!=='git'||JSON.stringify(args)!==JSON.stringify(['ls-files','-co','--exclude-standard','-z'])||resolve(options.cwd)!==root||options.encoding!=='utf8')throw Error('Unexpected predecessor inventory command');
 const proof=wechatOpenAuthorSourceBinding as typeof wechatOpenAuthorSourceBinding&{baseline_manifest:{raw_utf8:string}};
 if(sha(proof.baseline_manifest.raw_utf8)!==proof.baseline.sha256)throw Error('Wechat open author predecessor inventory differs');
 return (JSON.parse(proof.baseline_manifest.raw_utf8)as Array<{path:string}>).map(row=>row.path).join('\0')+'\0';
}
