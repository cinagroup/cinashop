import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {readCheckpointAcceptedAuthorView as readFileSync} from './migrationMergeSourceBinding';
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
import {wechatOpenAuthorSourceBinding,reverseWechatOpenAuthorSource,reverseWechatOpenAuthorPredecessorPublication,wechatOpenAuthorPredecessorExecFileSync} from './wechatOpenAuthorSourceBinding';
import {isDeepStrictEqual} from 'node:util';
import {pcBaseAuthorSourceBinding,reversePcBaseAuthorSource,reversePcBaseAuthorPredecessorPublication} from './pcBaseAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
type Report=ReturnType<typeof buildAdminFrontendApiAuditReport>;
type Member={path:string;bytes:number;sha256:string};
type Origin={file:string;bytes?:number;sha256:string;raw_utf8:string};
type Publication={file:string;validation_sha256:string;accepted_sha256:string;validation_source:string;accepted_source:string;validation_origin:string;accepted_origin:string};
type Relocation={logical_origin:string;original_sha256:string;physical_origin:string;bytes:number;sha256:string;archive_file:string;archive_sha256:string;archive_member:string};
export interface WechatAppAuthorProof {
 sources:Array<RouteSourceFollowup&{file:string}>;
 full_additions:Array<{file:string;sha256:string;bytes:number}>;
 PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string;git_blob:string}>;
 frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;
 current_report:{file:string;sha256:string};previous_report:Origin;
 new_api_calls:Report['calls'];retired_api_calls:Report['calls'];boundaries:Record<string,string>;
 baseline:{file_count:number;sha256:string};baseline_manifest:Origin;
 predecessor_readports:string[];predecessor_receipt:Origin;predecessor_source_report:Origin;
 predecessor_publication:Publication[];predecessor_publication_origins:Record<string,Origin>;
 predecessor_generated_outputs:Array<Member&{origin:string}>;
 physical_origin_relocations:Relocation[];
 controlled_source_manifest:Member[];publication_outputs_excluded:string[];generated_outputs_excluded_prefixes:string[];
 // Runtime, source, browser and receipt fields are published only after actual
 // gates; the preparation JSON deliberately leaves every future value null.
}
// This is the one own pin. Preparation is intentionally not an executable proof.
const WECHAT_APP_AUTHOR_PROOF_SHA='2b7be99b30a9e637f93656e89cea53e7fde7c36c9c19dd626ec5b4259a323c8d';
const raw=readFileSync(resolve(root,'workers-ts/audit/wechat-app-author-source-binding-20261028.json'),'utf8');
if(sha(raw)!==WECHAT_APP_AUTHOR_PROOF_SHA)throw Error('Wechat App author exact proof bytes differ');
export const wechatAppAuthorSourceBinding=JSON.parse(raw) as WechatAppAuthorProof;
export {pcBaseAuthorSourceBinding,reversePcBaseAuthorSource,reversePcBaseAuthorPredecessorPublication};
/** A changed whole current source must match the complete pinned image before
 * the complete accepted PC image returns. No line/substring fallback. */
export function reverseWechatAppAuthorSource(file:string,source:string,proof=wechatAppAuthorSourceBinding){
 const row=proof.sources.find(item=>item.file===file);if(!row)return source;const edit=row.edits[0];
 if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1
  ||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)throw Error('Wechat App complete source or predecessor differs');
 return edit.before_source;
}
/** Existing accepted PC append maps to its actual validation image before the
 * immutable PC helper's accepted Open append inverse is applied. */
export function reverseWechatAppAuthorPredecessorPublication(file:string,source:string,proof=wechatAppAuthorSourceBinding){
 const row=proof.predecessor_publication.find(item=>item.file===file);if(!row)return source;
 if(source!==row.accepted_source||sha(source)!==row.accepted_sha256||sha(row.validation_source)!==row.validation_sha256
  ||!source.startsWith(row.validation_source)||source===row.validation_source)throw Error('Wechat App predecessor publication images differ');
 return row.validation_source;
}
function path(file:Exclude<Parameters<typeof readFileSync>[0],number>){return resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file));}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,path(file)).replace(/\\/gu,'/');}
/** Explicit logical-origin relocation after the host reboot. The historical
 * /tmp file need not exist. Only its listed sealed archive member is read; the
 * original logical path/hash remain visible in the new proof. */
function physical(file:Exclude<Parameters<typeof readFileSync>[0],number>){
 const logical=path(file),rows=wechatAppAuthorSourceBinding.physical_origin_relocations.filter(row=>row.logical_origin===logical);
 if(!rows.length)return file;if(rows.length!==1)throw Error('Ambiguous historical origin relocation');const row=rows[0]!;
 if(row.original_sha256!==row.sha256||!Number.isSafeInteger(row.bytes)||row.bytes<0
  ||resolve(row.physical_origin)!==resolve(row.archive_file,'..',row.archive_member)
  ||row.archive_member.startsWith('/')||row.archive_member.split('/').includes('..'))throw Error('Historical origin relocation contract differs');
 const archive=readFileSync(row.archive_file);if(sha(archive)!==row.archive_sha256)throw Error('Historical sealed archive manifest differs');
 const document=JSON.parse(readFileSync(row.archive_file,'utf8')) as {files?:Member[]}|Member[];
 const members=Array.isArray(document)?document:document.files;
 if(!Array.isArray(members)||!members.some(item=>item.path===row.archive_member&&item.bytes===row.bytes&&item.sha256===row.sha256))throw Error('Historical member contract differs');
 if(lstatSync(row.physical_origin).isSymbolicLink()||!lstatSync(row.physical_origin).isFile()||realpathSync(row.physical_origin)!==resolve(row.physical_origin))throw Error('Historical member is not its exact physical regular file');
 const bytes=readFileSync(row.physical_origin);if(bytes.byteLength!==row.bytes||sha(bytes)!==row.sha256)throw Error('Historical physical member bytes differ');
 return row.physical_origin;
}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){
 if(typeof file==='number')return readFileSync(file,options);const name=target(file);
 const generated=['view/admin-ts/dist/','view/uniapp-ts/dist/','view/pc-ts/dist/','view/kefu-ts/dist/'];
 if(generated.some(prefix=>name.startsWith(prefix))){
  // App's immediate predecessor is the real accepted PC physical distribution:
  // Admin335 + Uni1762 + PC104 + Kefu13 =2214. Uni stays this separate actual PC
  // observation at deeper views; it is never inserted into Open's449 table.
  const uni=name.startsWith('view/uniapp-ts/dist/');
  const view=layer===0||uni?wechatAppAuthorSourceBinding:
   !name.startsWith('view/admin-ts/dist/')||layer===1?pcBaseAuthorSourceBinding:
   layer===2?wechatOpenAuthorSourceBinding:layer===3?wechatBaseAuthorSourceBinding:layer===4?wechatMenuAuthorSourceBinding:bargainRecordsSourceBinding;
  const archived=(view as typeof view&{predecessor_generated_outputs:Array<Member&{origin:string}>}).predecessor_generated_outputs.find(row=>row.path===name);
  if(!archived)throw Error('Unexpected predecessor generated member');
  const origin=physical(archived.origin),bytes=readFileSync(origin);
  if(bytes.byteLength!==archived.bytes||sha(bytes)!==archived.sha256)throw Error('Exact physical predecessor generated bytes differ');
  return readFileSync(origin,options);
 }
 const result=readFileSync(physical(file),options);
 const transforms:Array<{proof:{sources:Array<{file:string}>;predecessor_publication?:Array<{file:string}>};reverse:(file:string,value:string)=>string;publication?:(file:string,value:string)=>string}>=[
  {proof:wechatAppAuthorSourceBinding,reverse:reverseWechatAppAuthorSource,publication:reverseWechatAppAuthorPredecessorPublication},
  {proof:pcBaseAuthorSourceBinding,reverse:reversePcBaseAuthorSource,publication:reversePcBaseAuthorPredecessorPublication},
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
export const readWechatAppAuthorPredecessor=reader(0),readPcBaseAuthorPredecessor=reader(1),readWechatOpenAuthorPredecessor=reader(2),readWechatBaseAuthorPredecessor=reader(3),readWechatMenuAuthorPredecessor=reader(4),readBargainRecordsPredecessor=reader(5),readSupplierProductLabelRuntimePredecessor=reader(6),readProductLabelAuthorPredecessor=reader(7),readHotwordPredecessor=reader(8),readParameterPredecessor=reader(9),readRulePredecessor=reader(10),readEnsurePredecessor=reader(11),readUnitPredecessor=reader(12),readGroupPredecessor=reader(13),readDeliveryPredecessor=reader(14),readStaffPredecessor=reader(15),readStorePredecessor=reader(16),readUserLabelPredecessor=reader(17),readLevelPredecessor=reader(18),readExpressPredecessor=reader(19),readPlatformMenuPredecessor=reader(20),readAdminProfilePredecessor=reader(21),readAdminProfileThenErrorPagesPredecessor=reader(22),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(23),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(24);
export {wechatOpenAuthorSourceBinding,reverseWechatOpenAuthorSource,reverseWechatOpenAuthorPredecessorPublication,wechatOpenAuthorPredecessorExecFileSync,wechatBaseAuthorSourceBinding,reverseWechatBaseAuthorSource,reverseWechatBaseAuthorPredecessorPublication,wechatBaseAuthorPredecessorExecFileSync,wechatMenuAuthorSourceBinding,reverseWechatMenuAuthorSource,reverseWechatMenuAuthorPredecessorPublication,wechatMenuAuthorPredecessorExecFileSync,bargainRecordsSourceBinding,reverseBargainRecordsSource,reverseBargainRecordsPredecessorPublication,bargainRecordsPredecessorExecFileSync,supplierProductLabelRuntimeSourceBinding,reverseSupplierProductLabelRuntimeSource,reverseSupplierProductLabelRuntimePredecessorPublication,productLabelAuthorSourceBinding,reverseProductLabelAuthorSource,reverseProductLabelAuthorPredecessorPublication,hotwordSourceBinding,reverseHotwordSource,reverseHotwordPredecessorPublication,parameterSourceBinding,reverseParameterSource,reverseParameterPredecessorPublication,ruleSourceBinding,reverseRuleSource,reverseRulePredecessorPublication,ensureSourceBinding,reverseEnsureSource,unitSourceBinding,reverseUnitSource,groupSourceBinding,reverseGroupSource,deliverySourceBinding,reverseDeliverySource,staffSourceBinding,reverseStaffSource,storeSourceBinding,reverseStoreSource,userLabelSourceBinding,reverseUserLabelSource,levelSourceBinding,reverseLevelSource,expressSourceBinding,reverseExpressSource,platformMenuSourceBinding,reversePlatformMenuSource,adminProfileSourceBinding,reverseAdminProfileSource};
/** The current real AST must match the new whole report before any archived
 * view is returned. Derive new counts from that actual AST, never an expectation. */
export function buildWechatAppAuthorPredecessorApiAuditReport(){
 const actual=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(actual,null,2)+'\n')!==wechatAppAuthorSourceBinding.current_report.sha256)throw Error('Wechat App current API inventory differs');
 const previous=archived(wechatAppAuthorSourceBinding.previous_report,pcBaseAuthorSourceBinding.current_report.sha256);
 if(previous.calls.length!==855||previous.counts.callSites!==817||previous.counts.pathVariants!==855
  ||actual.counts.pathVariants!==actual.calls.length||actual.counts.unregistered!==0||actual.counts.unresolved!==0
  ||wechatAppAuthorSourceBinding.retired_api_calls.length!==0
  ||previous.calls.some(old=>!actual.calls.some(call=>isDeepStrictEqual(call,old))))throw Error('Whole accepted PC API inventory is not preserved');
 const added=actual.calls.filter(call=>!previous.calls.some(old=>isDeepStrictEqual(call,old)));
 if(!added.length||!isDeepStrictEqual(added,wechatAppAuthorSourceBinding.new_api_calls)||added.some(call=>!call.registered||call.availability!=='executable'))throw Error('Wechat App exact added API objects differ');
 return previous;
}
export function buildPcBaseAuthorPredecessorApiAuditReport(){
 buildWechatAppAuthorPredecessorApiAuditReport();return archived(pcBaseAuthorSourceBinding.previous_report,wechatOpenAuthorSourceBinding.current_report.sha256);
}
export function buildWechatOpenAuthorPredecessorApiAuditReport(){buildPcBaseAuthorPredecessorApiAuditReport();return archived(wechatOpenAuthorSourceBinding.previous_report,wechatBaseAuthorSourceBinding.current_report.sha256);}
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

export function pcBaseAuthorPredecessorExecFileSync(command:string,args:string[],options:{cwd:string;encoding:string}){
 if(command!=='git'||JSON.stringify(args)!==JSON.stringify(['ls-files','-co','--exclude-standard','-z'])||resolve(options.cwd)!==root||options.encoding!=='utf8')throw Error('Unexpected predecessor inventory command');
 const proof=pcBaseAuthorSourceBinding as typeof pcBaseAuthorSourceBinding&{baseline_manifest:{raw_utf8:string}};
 if(sha(proof.baseline_manifest.raw_utf8)!==proof.baseline.sha256)throw Error('PC base author predecessor inventory differs');
 return (JSON.parse(proof.baseline_manifest.raw_utf8)as Array<{path:string}>).map(row=>row.path).join('\0')+'\0';
}

export function wechatAppAuthorPredecessorExecFileSync(command:string,args:string[],options:{cwd:string;encoding:string}){
 if(command!=='git'||JSON.stringify(args)!==JSON.stringify(['ls-files','-co','--exclude-standard','-z'])||resolve(options.cwd)!==root||options.encoding!=='utf8')throw Error('Unexpected App predecessor inventory command');
 const proof=wechatAppAuthorSourceBinding;
 if(proof.baseline.file_count!==10037||sha(proof.baseline_manifest.raw_utf8)!==proof.baseline.sha256)throw Error('Wechat App predecessor inventory differs');
 const members=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[];
 if(members.length!==10037||new Set(members.map(row=>row.path)).size!==members.length)throw Error('Wechat App predecessor inventory cardinality differs');
 return members.map(row=>row.path).join('\0')+'\0';
}
