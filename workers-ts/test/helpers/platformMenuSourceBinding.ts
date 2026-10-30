import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {adminProfileSourceBinding,reverseAdminProfileSource} from './adminProfileSourceBinding';
import {errorPagesSourceBinding,reverseErrorPagesSource} from './errorPagesSourceBinding';
import {browserLogSourceBinding,reverseBrowserLogSource} from './browserLogSourceBinding';
import {configClassSourceBinding,reverseConfigClassSource} from './configClassSourceBinding';
import {buildAdminFrontendApiAuditReport} from './migrationMergeCheckpointReport';
import type {RouteSourceFollowup} from './routeSourceIncrement';
const root=resolve(import.meta.dirname,'../../..'),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const PROOF_SHA='038ff45fc1a72a0fa79f0c956883a0a4dca7b19268d32aece8ecc2c59b9b9bce';
const raw=readFileSync(resolve(root,'workers-ts/audit/platform-menu-source-binding-20261025.json'),'utf8');
if(sha(raw)!==PROOF_SHA)throw Error('Platform menu exact proof bytes differ');
export const platformMenuSourceBinding=JSON.parse(raw) as {sources:Array<RouteSourceFollowup&{file:string}>;full_additions:Array<{file:string;sha256:string;bytes:number}>;PHP_ref:string;PHP_sources:Array<{file:string;sha256:string;bytes:number;raw_utf8:string}>;frozen_predecessor_evidence:Record<string,string>;observed_unchanged:Record<string,string>;current_report:{file:string;sha256:string};previous_report:{sha256:string;raw_utf8:string};boundaries:Record<string,string>};
export function reversePlatformMenuSource(file:string,source:string,proof=platformMenuSourceBinding){const row=proof.sources.find(r=>r.file===file);if(!row)return source;const edit=row.edits[0];if(sha(source)!==row.after_sha256||row.edits.length!==1||!edit||edit.after_line!==1||edit.before_line!==1||edit.after_source!==source||sha(edit.before_source)!==row.before_sha256)throw Error('Platform menu complete source or predecessor differs');return edit.before_source;}
function target(file:Exclude<Parameters<typeof readFileSync>[0],number>){return relative(root,resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file))).replace(/\\/gu,'/');}
function read(file:Parameters<typeof readFileSync>[0],options:Parameters<typeof readFileSync>[1],layer:number){const result=readFileSync(file,options);if(typeof file==='number')return result;const name=target(file),proofs=[platformMenuSourceBinding,adminProfileSourceBinding,errorPagesSourceBinding,browserLogSourceBinding,configClassSourceBinding];if(!proofs.slice(0,layer+1).some(p=>p.sources.some(r=>r.file===name)))return result;let value=typeof result==='string'?result:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result);value=reversePlatformMenuSource(name,value);if(layer>=1)value=reverseAdminProfileSource(name,value);if(layer>=2)value=reverseErrorPagesSource(name,value);if(layer>=3)value=reverseBrowserLogSource(name,value);if(layer>=4)value=reverseConfigClassSource(name,value);return typeof result==='string'?value:new TextEncoder().encode(value);}
const reader=(layer:number)=>((file:Parameters<typeof readFileSync>[0],options?:Parameters<typeof readFileSync>[1])=>read(file,options,layer)) as typeof readFileSync;
export const readPlatformMenuPredecessor=reader(0),readAdminProfilePredecessor=reader(1),readAdminProfileThenErrorPagesPredecessor=reader(2),readAdminProfileThenErrorPagesThenBrowserLogPredecessor=reader(3),readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor=reader(4);
export {adminProfileSourceBinding,reverseAdminProfileSource};
/** Real current AST first, then exact reviewed historical report bytes. */
export function buildPlatformMenuPredecessorApiAuditReport(){const actual=buildAdminFrontendApiAuditReport();if(sha(JSON.stringify(actual,null,2)+'\n')!==platformMenuSourceBinding.current_report.sha256)throw Error('Platform menu current API inventory differs');const old=platformMenuSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256||old.sha256!==adminProfileSourceBinding.current_report.sha256)throw Error('Platform menu full predecessor API inventory differs');return JSON.parse(old.raw_utf8) as typeof actual;}
export function buildAdminProfilePredecessorApiAuditReport(){buildPlatformMenuPredecessorApiAuditReport();const old=adminProfileSourceBinding.previous_report;if(sha(old.raw_utf8)!==old.sha256)throw Error('Admin profile exact predecessor API inventory differs');return JSON.parse(old.raw_utf8) as ReturnType<typeof buildAdminFrontendApiAuditReport>;}
