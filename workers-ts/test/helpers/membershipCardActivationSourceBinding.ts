import { createHash } from 'node:crypto';
import { readMembershipCouponsHistoricalFile as readFileSync, peelMembershipCouponsSourceIfPresent, peelMembershipCouponsLegacyRulesIfPresent } from './membershipCouponsSourceBinding';
import { relative, resolve, sep } from 'node:path';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './routeSourceIncrement';

interface SourceProof extends RouteSourceFollowup {
  file:string;before_ref:string;before_bytes:number;after_bytes:number;
  before_git_blob_sha1:string;after_git_blob_sha1:string;
}
interface LegacyRule {target:string;coverage:string;queryAliases?:Readonly<Record<string,string>>}
export interface MembershipCardActivationSourceBinding {
  schema:string;base_ref:string;php_ref:string;sources:SourceProof[];harness_sources:SourceProof[];
  production_patch:{sha256:string;bytes:number;unified_diff:string};
  manifest:{file:string;count:number;route:string;before_style:Record<string,string>;after_style:Record<string,string>;routes_sha256:string};
  navigation:{key:string;before_rule:LegacyRule;after_rule:LegacyRule;before_rules_sha256:string;after_rules_sha256:string;registered_routes_sha256:string};
  admin_api_report:{sha256:string;bytes:number;calls:number;variants:number};
  preserved_files:Array<{file:string;sha256:string;bytes:number}>;boundary:string;
}
const root=resolve(import.meta.dirname,'../../..');
const sha=(source:string)=>createHash('sha256').update(source).digest('hex');
const blob=(source:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/membership-card-activation-source-binding-20261026.json'),'utf8');
if(sha(raw)!=='66383437d4f55f432b11211d4f85e31ce2fe713a291988e70c273d913bb8f09c')throw Error('Membership card activation immutable fixture differs');
export const membershipCardActivationSourceBinding=JSON.parse(raw) as MembershipCardActivationSourceBinding;
function inventory(binding:MembershipCardActivationSourceBinding):void {
  if(sha(JSON.stringify(binding))!=='19b5412fb31ecd369e6ef7596ae28aae5b17455e83e538155b1895767c595eef')throw Error('Membership card activation exact inventory differs');
}
function entryFor(file:string,entries:SourceProof[]):SourceProof|undefined{return entries.find(row=>row.file===file);}
function whole(source:string,entry:SourceProof,before:boolean):boolean {
  return Buffer.byteLength(source)===(before?entry.before_bytes:entry.after_bytes)
    &&sha(source)===(before?entry.before_sha256:entry.after_sha256)
    &&blob(source)===(before?entry.before_git_blob_sha1:entry.after_git_blob_sha1);
}
function reverse(file:string,source:string,entries:SourceProof[]):string {
  const entry=entryFor(file,entries);if(!entry)return source;
  if(!whole(source,entry,false))throw Error('Membership card activation complete current source differs');
  const previous=reverseRouteSourceFollowup(source,entry);
  if(!whole(previous,entry,true))throw Error('Membership card activation complete predecessor source differs');
  return previous;
}
export function reverseMembershipCardActivationSource(file:string,source:string,binding=membershipCardActivationSourceBinding):string {
  inventory(binding);return reverse(file,peelMembershipCouponsSourceIfPresent(file,source),binding.sources);
}
export function reverseMembershipCardActivationHarnessSource(file:string,source:string,binding=membershipCardActivationSourceBinding):string {
  inventory(binding);return reverse(file,source,binding.harness_sources);
}
/** Only these two exact complete states reach the immutable membership-rights bridge. */
export function peelMembershipCardActivationSource(file:string,source:string,binding=membershipCardActivationSourceBinding):string {
  inventory(binding);source=peelMembershipCouponsSourceIfPresent(file,source);const entry=entryFor(file,binding.sources);if(!entry)return source;
  return whole(source,entry,true)?source:reverse(file,source,binding.sources);
}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function reverseMembershipCardActivationLegacyRules<T extends Readonly<Record<string,LegacyRule>>>(current:T,binding=membershipCardActivationSourceBinding):T {
  inventory(binding);const p=binding.navigation;current=peelMembershipCouponsLegacyRulesIfPresent(current);
  if(sha(JSON.stringify(current))!==p.after_rules_sha256||!equal(current[p.key],p.after_rule))throw Error('Membership card activation complete current rules differ');
  const previous={...current,[p.key]:structuredClone(p.before_rule)} as T;
  if(sha(JSON.stringify(previous))!==p.before_rules_sha256)throw Error('Membership card activation complete predecessor rules differ');
  return previous;
}
export function peelMembershipCardActivationLegacyRules<T extends Readonly<Record<string,LegacyRule>>>(current:T,binding=membershipCardActivationSourceBinding):T {
  inventory(binding);const p=binding.navigation;current=peelMembershipCouponsLegacyRulesIfPresent(current);
  if(sha(JSON.stringify(current))===p.before_rules_sha256&&equal(current[p.key],p.before_rule))return current;
  return reverseMembershipCardActivationLegacyRules(current,binding);
}
/** Historical test reads retain native Buffer/UTF8 behavior; live proof reads actual bytes. */
export const readMembershipCardActivationHistoricalFile:typeof readFileSync=((...args:unknown[])=>{
  const value=Reflect.apply(readFileSync,undefined,args) as string|Uint8Array,path=args[0];if(typeof path!=='string')return value;
  const file=relative(root,resolve(path)).split(sep).join('/');if(!membershipCardActivationSourceBinding.sources.some(row=>row.file===file))return value;
  const encoding=typeof args[1]==='string'?args[1]:(args[1] as {encoding?:string}|undefined)?.encoding;
  if(encoding&&encoding!=='utf8'&&encoding!=='utf-8')throw Error('Membership card activation historical reader requires exact UTF8 or Buffer');
  const previous=peelMembershipCardActivationSource(file,typeof value==='string'?value:new TextDecoder().decode(value));
  return typeof value==='string'?previous:Buffer.from(previous,'utf8');
}) as typeof readFileSync;
