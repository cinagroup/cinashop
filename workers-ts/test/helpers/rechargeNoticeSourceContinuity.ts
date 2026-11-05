/** A closed 7e41 historical view for dated proofs only. Actual runtime, payment
 * tests and this successor's direct disk checks retain the new recharge code.
 * The old membership leaf and every older proof remain byte-identical. */
import {createHash} from 'node:crypto';
import {readFileSync as readNativeFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as old from './membershipContractSourceContinuity';
export * from './membershipContractSourceContinuity';
const root=resolve(import.meta.dirname,'../../..');
export const RECHARGE_SOURCE_PROOF_FILE='workers-ts/test/fixtures/recharge-notice-source-continuity-20261105.json';
export const RECHARGE_SOURCE_PROOF_SHA='ce930c5917bebc96bc9faac7b831a053d473299c5f8b293a8ac339797f68c934';
const canonicalSha='f74eff3b9493b0b7b0e410c48c24d5a78f355659ba2c2d24d9827e09e8bdcf09';
const files=[
 'workers-ts/src/models/schema/order_outbox.ts',
 'workers-ts/src/services/payment/PaymentCallbackEventService.ts',
 'workers-ts/src/services/payment/PaymentReconciliationService.ts',
 'workers-ts/src/services/payment/RechargePaymentService.ts',
 'workers-ts/src/models/schema/notification_delivery.ts',
 'workers-ts/scripts/run-local-finance-postgres.mjs',
 'view/uniapp-ts/scripts/d3-advisory-gate.baseline.json',
 'view/uniapp-ts/scripts/d3-advisory-gate.test.cjs',
 'view/uniapp-ts/scripts/d3-transitive-chain-audit.md',
 'workers-ts/src/services/wechat/WechatNotificationProvider.ts',
 'workers-ts/test/helpers/postMergeSourceBinding.ts',
 'workers-ts/test/helpers/reviewedRouteTailSourceBinding.ts',
 'workers-ts/test/helpers/migrationMergeMainReport.ts',
 'workers-ts/test/post-merge-source-binding.test.ts',
 'workers-ts/test/membership-contract-source-continuity.test.ts',
];
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const blob=(v:string)=>createHash('sha1').update('blob '+Buffer.byteLength(v)+'\0').update(v).digest('hex');
const decode=(v:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(v);
export interface RechargeHistoryImage{bytes:number;sha256:string;gitBlobSha1:string}
export interface RechargeHistoryEdit{start:number;after:string[];before:string[];anchorStart:number;anchor:string[]}
export interface RechargeHistoryRow{file:string;kind:'business'|'delivery-payload-schema'|'validation-runner'|'committed-advisory-review'|'delivery-provider-type'|'historical-reader-wiring';current:RechargeHistoryImage;predecessor:RechargeHistoryImage;inverseEdits:RechargeHistoryEdit[];origin:{commit:string;path:string;gitBlobSha1:string};committedCurrentOrigin?:{commit:string;path:string;gitBlobSha1:string}}
export interface RechargeHistoryProof{schema:string;predecessorCommit:string;integrationBaseCommit:string;boundary:string;sources:RechargeHistoryRow[];preserved:Array<{file:string;bytes:number;sha256:string}>}
const whole=(s:string,i:RechargeHistoryImage)=>Buffer.byteLength(s)===i.bytes&&sha(s)===i.sha256&&blob(s)===i.gitBlobSha1;
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
const raw=readNativeFileSync(resolve(root,RECHARGE_SOURCE_PROOF_FILE));
if(sha(raw)!==RECHARGE_SOURCE_PROOF_SHA)throw Error('Recharge continuity immutable proof differs');
export const rechargeNoticeSourceContinuity=freeze(JSON.parse(decode(raw)) as RechargeHistoryProof);
function verify(p:RechargeHistoryProof):void{
 if(sha(JSON.stringify(p))!==canonicalSha||p.schema!=='recharge-notice-source-continuity/v1'||p.predecessorCommit!=='7e41a20eb64c99491847fab136a5890721689654'
 ||p.integrationBaseCommit!=='0ecb7405a541722244c9a2acb4f109ce492db340'||JSON.stringify(p.sources.map(r=>r.file))!==JSON.stringify(files))throw Error('Recharge continuity complete proof differs');
 for(const [i,r] of p.sources.entries()){
  if(r.kind!==(i<4?'business':i===4?'delivery-payload-schema':i===5?'validation-runner':i<9?'committed-advisory-review':i===9?'delivery-provider-type':'historical-reader-wiring')||r.origin.commit!==p.predecessorCommit||r.origin.path!==r.file||r.origin.gitBlobSha1!==r.predecessor.gitBlobSha1
   ||!r.inverseEdits.length||r.current.sha256===r.predecessor.sha256)throw Error('Recharge continuity source origin differs');
  if(r.kind==='committed-advisory-review'&&(!r.committedCurrentOrigin||r.committedCurrentOrigin.commit!==p.integrationBaseCommit||r.committedCurrentOrigin.path!==r.file||r.committedCurrentOrigin.gitBlobSha1!==r.current.gitBlobSha1)
   ||r.kind!=='committed-advisory-review'&&r.committedCurrentOrigin!==undefined)throw Error('Recharge continuity committed input origin differs');
  for(const image of [r.current,r.predecessor])if(!Number.isSafeInteger(image.bytes)||image.bytes<1||!/^[a-f0-9]{64}$/.test(image.sha256)||!/^[a-f0-9]{40}$/.test(image.gitBlobSha1))throw Error('Recharge continuity image metadata differs');
 }
}
verify(rechargeNoticeSourceContinuity);
/** Requires one complete physical current image. Old bytes and unknown edits
 * cannot satisfy this successor, even if the older leaf once accepted them. */
export function projectRechargeNoticePredecessor(file:string,source:string,p=rechargeNoticeSourceContinuity):string{
 verify(p);const row=p.sources.find(r=>r.file===file);if(!row)return source;
 if(!whole(source,row.current))throw Error('Recharge continuity complete current source differs');
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];let boundary=0;
 for(const e of row.inverseEdits){
  if(!Number.isSafeInteger(e.start)||e.start<boundary||e.start<0||!Array.isArray(e.after)||!Array.isArray(e.before)
   ||!e.after.every(x=>typeof x==='string')||!e.before.every(x=>typeof x==='string')||!e.after.length&&!e.before.length
   ||e.start+e.after.length>lines.length||!Number.isSafeInteger(e.anchorStart)||e.anchorStart<0||e.anchorStart>e.start
   ||!Array.isArray(e.anchor)||!e.anchor.length||!e.anchor.every(x=>typeof x==='string')||e.anchorStart+e.anchor.length<e.start+e.after.length||e.anchorStart+e.anchor.length>lines.length
   ||JSON.stringify(lines.slice(e.start,e.start+e.after.length))!==JSON.stringify(e.after)||JSON.stringify(lines.slice(e.anchorStart,e.anchorStart+e.anchor.length))!==JSON.stringify(e.anchor)
   ||source.split(e.anchor.join('')).length!==2)throw Error('Recharge continuity exact literal/range/anchor differs');
  boundary=e.start+e.after.length;
 }
 for(const e of [...row.inverseEdits].reverse())lines.splice(e.start,e.after.length,...e.before);
 const previous=lines.join('');if(!whole(previous,row.predecessor))throw Error('Recharge continuity complete predecessor differs');return previous;
}
/** Older closed adapters can hold already-derived historical images. This
 * only peels an exact current image; their own unchanged checks follow it. */
function peel(file:string,source:string):string{
 const row=rechargeNoticeSourceContinuity.sources.find(r=>r.file===file);
 return row&&whole(source,row.current)?projectRechargeNoticePredecessor(file,source):source;
}
export function projectMembershipHistoricalSource(file:string,source:string,p=old.membershipContractSourceContinuity):string{
 return old.projectMembershipHistoricalSource(file,projectRechargeNoticePredecessor(file,source),p);
}
export function peelMembershipHistoricalSourceIfPresent(file:string,source:string):string{
 return old.peelMembershipHistoricalSourceIfPresent(file,peel(file,source));
}
type NativePath=Parameters<typeof readNativeFileSync>[0];type NativeOptions=Parameters<typeof readNativeFileSync>[1];
function read(file:NativePath,options:NativeOptions,older:boolean):ReturnType<typeof readNativeFileSync>{
 const value=readNativeFileSync(file,options);if(typeof file==='number')return value;
 const absolute=resolve(typeof file==='string'?file:'href'in file?fileURLToPath(file.href):decode(file));const name=relative(root,absolute).replace(/\\/g,'/');
 const selected=files.includes(name),encoding=typeof options==='string'?options:options?.encoding;
 if(selected&&encoding&&encoding!=='utf8'&&encoding!=='utf-8')throw Error('Recharge historical reader requires exact UTF8 or bytes');
 if(!selected)return older?old.readMembershipContinuityHistoricalFile(file,options):value;
 const previous=projectRechargeNoticePredecessor(name,typeof value==='string'?value:decode(value));
 const output=older?old.projectMembershipHistoricalSource(name,previous):previous;
 return typeof value==='string'?output:Buffer.from(output,'utf8');
}
export const readRechargeNoticePredecessorFile=((f:NativePath,o?:NativeOptions)=>read(f,o,false)) as typeof readNativeFileSync;
export const readMembershipContinuityHistoricalFile=((f:NativePath,o?:NativeOptions)=>read(f,o,true)) as typeof readNativeFileSync;
