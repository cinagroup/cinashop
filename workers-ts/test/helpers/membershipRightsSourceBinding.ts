import { peelReviewedRouteTailReportForHistoricalAudit } from './reviewedRouteTailSourceBinding';
import { peelMembershipCouponsRegisteredRoutesIfPresent } from './membershipCouponsSourceBinding';
import { peelMembershipCardActivationSource, peelMembershipCardActivationLegacyRules } from './membershipCardActivationSourceBinding';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

type JsonPath = Array<string | number>;
interface SourceProof extends RouteSourceFollowup {
  file:string;before_ref:string;before_exists:boolean;before_bytes:number;after_bytes:number;
  before_git_blob_sha1:string;after_git_blob_sha1:string;
}
type ReportOperation =
  | {kind:'replace';path:JsonPath;before:string|number;after:string|number}
  | {kind:'splice';path:JsonPath;index:number;before:unknown[];after:unknown[]};
interface LegacyRule {target:string;coverage:string;queryAliases?:Readonly<Record<string,string>>}
export interface MembershipRightsSourceBinding {
  schema:string;base_ref:string;php_ref:string;sources:SourceProof[];harness_sources:SourceProof[];
  production_patch:{sha256:string;bytes:number;unified_diff:string};
  api_report:{before_sha256:string;after_sha256:string;before_bytes:number;after_bytes:number;operations:ReportOperation[]};
  navigation:{route:string;before_count:number;after_count:number;before_routes_sha256:string;after_routes_sha256:string;
    key:string;before_rule:LegacyRule;after_rule:LegacyRule;before_rules_sha256:string;after_rules_sha256:string};
  preserved_files:Array<{file:string;sha256:string;bytes:number}>;boundary:string;
}
const root=resolve(import.meta.dirname,'../../..');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/membership-rights-source-binding-20261026.json'),'utf8');
if(sha(raw)!=='9d00ae1986e1669e7c19d5ba87642018e9f5debbafb5e0a07bd25f1ebcbba5ab')throw Error('Membership rights fixture bytes differ');
export const membershipRightsSourceBinding=JSON.parse(raw) as MembershipRightsSourceBinding;
function inventory(binding:MembershipRightsSourceBinding):void {
  if(sha(JSON.stringify(binding))!=='ef039af7f898ce46a2658bda725178f2b7dbdae400324e6affd8e5d30e7d5331')throw Error('Membership rights exact source/report/harness inventory differs');
}
const blob=(source:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
function reverseSource(file:string,source:string,entries:SourceProof[]):string {
  const entry=entries.find(row=>row.file===file);if(!entry)return source;
  if(Buffer.byteLength(source)!==entry.after_bytes||blob(source)!==entry.after_git_blob_sha1)throw Error('Membership rights current whole source differs');
  const previous=reverseRouteSourceFollowup(source,entry);
  if(Buffer.byteLength(previous)!==entry.before_bytes||blob(previous)!==entry.before_git_blob_sha1)throw Error('Membership rights predecessor whole source differs');
  return previous;
}
/** Restore only the independently captured whole predecessor, including an absent new API module. */
export function reverseMembershipRightsSource(file:string,source:string,binding=membershipRightsSourceBinding):string {
  inventory(binding);return reverseSource(file,peelMembershipCardActivationSource(file,source),binding.sources);
}
export function reverseMembershipRightsHarnessSource(file:string,source:string,binding=membershipRightsSourceBinding):string {
  inventory(binding);return reverseSource(file,source,binding.harness_sources);
}
export function reverseMembershipRightsManifest(source:string,binding=membershipRightsSourceBinding):string {
  return reverseMembershipRightsSource('view/uniapp-ts/src/pages.json',source,binding);
}
function member(value:unknown,key:string|number):unknown {
  if(!value||typeof value!=='object'||!Object.hasOwn(value,key))throw Error('Membership rights exact report path missing');
  return(value as Record<string|number,unknown>)[key];
}
function at(value:unknown,path:JsonPath):unknown {for(const key of path)value=member(value,key);return value;}
const pretty=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function reportBridge<T>(input:T,reverse:boolean,binding:MembershipRightsSourceBinding):T {
  inventory(binding);if(reverse)input=peelReviewedRouteTailReportForHistoricalAudit(input);const p=binding.api_report,incoming=pretty(input);
  if(sha(incoming)!==(reverse?p.after_sha256:p.before_sha256)||Buffer.byteLength(incoming)!==(reverse?p.after_bytes:p.before_bytes))throw Error('Membership rights complete report input differs');
  const result=structuredClone(input),operations=reverse?[...p.operations].reverse():p.operations;
  for(const operation of operations){
    if(!operation.path.length)throw Error('Membership rights whole-report replacement forbidden');
    if(operation.kind==='replace'){
      const parent=at(result,operation.path.slice(0,-1)),key=operation.path.at(-1)!;
      if(member(parent,key)!==(reverse?operation.after:operation.before))throw Error('Membership rights exact report scalar differs');
      (parent as Record<string|number,unknown>)[key]=reverse?operation.before:operation.after;
    }else{
      const values=at(result,operation.path),from=reverse?operation.after:operation.before,to=reverse?operation.before:operation.after;
      if(!Array.isArray(values)||!Number.isSafeInteger(operation.index)||operation.index<0||operation.index+from.length>values.length||!equal(values.slice(operation.index,operation.index+from.length),from))throw Error('Membership rights exact report splice differs');
      values.splice(operation.index,from.length,...structuredClone(to));
    }
  }
  const outgoing=pretty(result);
  if(sha(outgoing)!==(reverse?p.before_sha256:p.after_sha256)||Buffer.byteLength(outgoing)!==(reverse?p.before_bytes:p.after_bytes))throw Error('Membership rights complete report result differs');
  return result;
}
export const applyMembershipRightsReport=<T>(historical:T,binding=membershipRightsSourceBinding):T=>reportBridge(historical,false,binding);
export const reverseMembershipRightsReport=<T>(current:T,binding=membershipRightsSourceBinding):T=>reportBridge(current,true,binding);
/** An old apply operation still emits its original exact result. Only these two complete states are accepted. */
export function peelMembershipRightsReport<T>(input:T,binding=membershipRightsSourceBinding):T {
  inventory(binding);input=peelReviewedRouteTailReportForHistoricalAudit(input);const p=binding.api_report,incoming=pretty(input);
  if(sha(incoming)===p.before_sha256&&Buffer.byteLength(incoming)===p.before_bytes)return input;
  return reverseMembershipRightsReport(input,binding);
}
export function reverseMembershipRightsRegisteredRoutes(current:ReadonlySet<string>,binding=membershipRightsSourceBinding):Set<string> {
  inventory(binding);const p=binding.navigation;current=peelMembershipCouponsRegisteredRoutesIfPresent(current);
  if(current.size!==p.after_count||sha(JSON.stringify([...current].sort()))!==p.after_routes_sha256||!current.has(p.route))throw Error('Membership rights complete current registered routes differ');
  const previous=new Set(current);previous.delete(p.route);
  if(previous.size!==p.before_count||sha(JSON.stringify([...previous].sort()))!==p.before_routes_sha256)throw Error('Membership rights complete predecessor registered routes differ');
  return previous;
}
export function reverseMembershipRightsLegacyRules<T extends Readonly<Record<string,LegacyRule>>>(current:T,binding=membershipRightsSourceBinding):T {
  inventory(binding);const p=binding.navigation;
  current=peelMembershipCardActivationLegacyRules(current);
  if(sha(JSON.stringify(current))!==p.after_rules_sha256||!equal(current[p.key],p.after_rule))throw Error('Membership rights complete current legacy rules differ');
  const previous={...current,[p.key]:structuredClone(p.before_rule)} as T;
  if(sha(JSON.stringify(previous))!==p.before_rules_sha256)throw Error('Membership rights complete predecessor legacy rules differ');
  return previous;
}
/** Only legacy test readers use this adapter. The new increment test reads actual current bytes independently. */
export const readMembershipRightsHistoricalFile:typeof readFileSync=((...args:unknown[])=>{
  const value=Reflect.apply(readFileSync,undefined,args) as string|Uint8Array,path=args[0];
  // Every historical harness supplies a filesystem path string; preserve other
  // native fs overloads without mixing browser and Node URL/Buffer types.
  if(typeof path!=='string')return value;
  const file=relative(root,resolve(path)).split(sep).join('/');
  if(!membershipRightsSourceBinding.sources.some(row=>row.file===file))return value;
  const encoding=typeof args[1]==='string'?args[1]:(args[1] as {encoding?:string}|undefined)?.encoding;
  if(encoding&&encoding!=='utf8'&&encoding!=='utf-8')throw Error('Membership rights historical reader requires exact UTF8 or Buffer input');
  const previous=reverseMembershipRightsSource(file,typeof value==='string'?value:new TextDecoder().decode(value));
  return typeof value==='string'?previous:Buffer.from(previous,'utf8');
}) as typeof readFileSync;
