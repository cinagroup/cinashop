/** Dated source views only. One native read is projected through unchanged
 * pure recharge/member leaves; production and current acceptance stay native.
 * No postMerge/route/report imports, inventory filtering or runtime authority. */
import {createHash} from 'node:crypto';
import {readFileSync as readNativeFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import {types} from 'node:util';
import * as old from './rechargeNoticeSourceContinuity';
import {isProviderTransportSource,projectProviderTransportPredecessor} from './providerTransportSourceContinuity';
export * from './rechargeNoticeSourceContinuity';

const root=resolve(import.meta.dirname,'../../..');
export const RECHARGE_REFUND_SOURCE_PROOF_FILE='workers-ts/test/fixtures/recharge-refund-notice-consumer-source-continuity-20261109.json';
export const RECHARGE_REFUND_SOURCE_PROOF_SHA='dc74c4abd38298c3feed1afa7a1578d57e2f753360115538e5716e4f68257532';
const canonicalSha='f70d2547783ba2fa8e20854c0050d1b4aec1f0f796daa19ceb341ac020ef023a';
const priorProofFile='workers-ts/test/fixtures/recharge-refund-callback-http-source-continuity-20261109.json';
const priorProofSha='702d22cb0c986a0aa43bd77951f61ca19e296be4a7cef39ddb888b76908ae3a9';
const files:readonly string[]=[
 "workers-ts/scripts/run-local-finance-postgres.mjs",
 "workers-ts/src/env.ts",
 "workers-ts/src/index.ts",
 "workers-ts/src/migrations/auditCustomerFinancialRuntimePrivileges.ts",
 "workers-ts/src/migrations/auditRuntimeBusinessPrivileges.ts",
 "workers-ts/src/migrations/checkoutPricingLock.ts",
 "workers-ts/src/migrations/customerFinancialRoutineRefund.ts",
 "workers-ts/src/migrations/customerRuntimeGiftPeers.ts",
 "workers-ts/src/migrations/membershipPaidNotice.ts",
 "workers-ts/src/migrations/paidNotice.ts",
 "workers-ts/src/migrations/rechargePaidNotice.ts",
 "workers-ts/src/migrations/refundSuccessNotice.ts",
 "workers-ts/src/migrations/reviewedRuntimePricingCapabilities.ts",
 "workers-ts/src/migrations/routineRefund.ts",
 "workers-ts/src/migrations/routineRefundActorAddon.ts",
 "workers-ts/src/migrations/routineVirtualShippingSubjects.ts",
 "workers-ts/src/migrations/supplierOrderPriceRevision.ts",
 "workers-ts/src/migrations/upgradeCustomerFinancialRoutineRefund.ts",
 "workers-ts/src/migrations/writeoffNotice.ts",
 "workers-ts/src/models/schema/order_outbox.ts",
 "workers-ts/src/models/schema/user_center.ts",
 "workers-ts/src/services/admin/AdminPermissionService.ts",
 "workers-ts/src/services/order/OrderOutboxService.ts",
 "workers-ts/src/services/order/RechargePaidNoticeSource.ts",
 "workers-ts/src/services/payment/RoutineApprovedPaymentAccount.ts",
 "workers-ts/src/services/wechat/WechatPayService.ts",
 ".github/workflows/workers-runtime-linux.yml",
 "workers-ts/test/ci-gate-capacity.test.ts",
 "workers-ts/src/routes/v1/index.ts",
 "workers-ts/src/services/order/OrderNotificationDeliveryService.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionNoticeKinds.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionRechargeRequest.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionDeliveryNotice.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionDispatch.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionRequestEvidenceCodec.ts",
 "workers-ts/scripts/routine-notification-continuation.ts",
 "workers-ts/src/services/order/OrderQueueDeadLetterService.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionAccessToken.ts",
 "workers-ts/src/services/wechat/RoutineSubscriptionProvider.ts",
 "workers-ts/test/helpers/postMergeSourceBinding.ts",
 "workers-ts/test/helpers/reviewedRouteTailSourceBinding.ts",
 "workers-ts/test/post-merge-source-binding.test.ts",
 "workers-ts/test/membership-contract-source-continuity.test.ts",
 "workers-ts/test/recharge-notice-source-continuity.test.ts",
 "workers-ts/test/reviewed-admin-source-tail-binding.test.ts",
 "workers-ts/test/legacy-php-input-source-binding.test.ts"
];
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const blob=(v:string)=>createHash('sha1').update('blob '+Buffer.byteLength(v)+'\0').update(v).digest('hex');
const decode=(v:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(v);
export interface RechargeRefundHistoryImage{bytes:number;sha256:string;gitBlobSha1:string}
export interface RechargeRefundHistoryEdit{start:number;after:string[];before:string[];anchorStart:number;anchor:string[]}
interface Origin{commit:string;path:string;gitBlobSha1:string}
export interface RechargeRefundHistoryRow{
 file:string;kind:'feature-source'|'historical-reader-wiring';current:RechargeRefundHistoryImage;
 predecessor:RechargeRefundHistoryImage;inverseEdits:RechargeRefundHistoryEdit[];origin:Origin;
}
export interface RechargeRefundHistoryProof{
 schema:string;predecessorCommit:string;boundary:string;sources:RechargeRefundHistoryRow[];
 priorProof:{file:string;sha256:string;updatedSources:string[]};
 preserved:Array<RechargeRefundHistoryImage&{file:string;origin:Origin}>;
 inventoryDebt:{status:string;legacyProof:string;legacyExpectedCount:number;fixedBaseCount:number;
  preExistingBaseAdditions:string[];preExistingBaseMissing:string[];impactInventoryArtifactSha256:string};
 inputProvenance:Array<{file:string;sha256:string;source:string;acceptedByThisProof:boolean}>;
 checkoutTypeBridge:{file:string;impactObservationSha256:string;selectedSource30dSha256:string;onlyNewLiteral:string;runtimeAcceptance:boolean};
}
const whole=(source:string,image:RechargeRefundHistoryImage)=>Buffer.byteLength(source)===image.bytes
 &&sha(source)===image.sha256&&blob(source)===image.gitBlobSha1;
function freeze<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
/** Capture data descriptors before hashing or traversing metadata. No caller
 * toJSON/getter/proxy trap runs, and later validation uses only this copy.
 * Limits are per invocation, not cached authority or a reusable ready object. */
function captureProof(input:unknown):RechargeRefundHistoryProof{
 let nodes=0,bytes=0;const active=new Set<object>();
 const fail=():never=>{throw Error('Refund continuity complete proof differs');};
 const addBytes=(text:string)=>{bytes+=Buffer.byteLength(text,'utf8');if(bytes>1048576)return fail();};
 const visit=(value:unknown,depth:number):unknown=>{
  if(++nodes>65536||depth>24)return fail();
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))return fail();return value;}
  if(typeof value==='string'){addBytes(value);return value;}
  if(!value||typeof value!=='object'||types.isProxy(value)||active.has(value))return fail();
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)return fail();
  if(array){const length=Object.getOwnPropertyDescriptor(value,'length');
   if(!length||!('value'in length)||!Number.isSafeInteger(length.value)||length.value<0||length.value>16384)return fail();}
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string')||!array&&keys.length>128)return fail();
  active.add(value);
  try{
   if(array){
    const length=Object.getOwnPropertyDescriptor(value,'length')!.value as number;
    if(keys.length!==length+1)return fail();
    const result:unknown[]=[];
    for(let index=0;index<length;index++){
     const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
     if(!descriptor?.enumerable||!('value'in descriptor))return fail();result.push(visit(descriptor.value,depth+1));
    }
    return result;
   }
   const result:Record<string,unknown>=Object.create(null);
   for(const key of keys as string[]){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(key==='toJSON'||!descriptor?.enumerable||!('value'in descriptor))return fail();
    addBytes(key);result[key]=visit(descriptor.value,depth+1);
   }
   return result;
  }finally{active.delete(value);}
 };
 return visit(input,0)as RechargeRefundHistoryProof;
}
function verify(input:RechargeRefundHistoryProof):RechargeRefundHistoryProof{
 const proof=captureProof(input);
 if(sha(JSON.stringify(proof))!==canonicalSha||proof.schema!=='recharge-refund-source-continuity/v10'
  ||proof.priorProof.file!==priorProofFile||proof.priorProof.sha256!==priorProofSha
  ||proof.predecessorCommit!=='78240b7801a617ed5b1c1e444860228c066311b8'
  ||JSON.stringify(proof.sources.map(row=>row.file))!==JSON.stringify(files))throw Error('Refund continuity complete proof differs');
 for(const [index,row]of proof.sources.entries()){
  if(row.kind!==(index<40?'feature-source':'historical-reader-wiring')||row.origin.commit!==proof.predecessorCommit
   ||row.origin.path!==row.file||row.origin.gitBlobSha1!==row.predecessor.gitBlobSha1||!row.inverseEdits.length
   ||row.current.sha256===row.predecessor.sha256)throw Error('Refund continuity source origin differs');
  for(const image of[row.current,row.predecessor])if(!Number.isSafeInteger(image.bytes)||image.bytes<1
   ||!/^[a-f0-9]{64}$/.test(image.sha256)||!/^[a-f0-9]{40}$/.test(image.gitBlobSha1))throw Error('Refund continuity image metadata differs');
 }
 return proof;
}
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-source-continuity-20261108.json')))!=='ba9345a4e12e60f260966d068e38de9b1d93a98ba59f78f4fc942f81242ee79c')throw Error('Refund v1 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-query-source-continuity-20261108.json')))!=='f9fd32f0fb94085336b4144abc5ee43f8f7e887e764ffe66f641c926404cc44e')throw Error('Refund v2 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-http-source-continuity-20261108.json')))!=='adf570f96a4283154cac18141208fe71d6b9699a926262769ed987a2ff36f0d0')throw Error('Refund v3 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-recovery-source-continuity-20261108.json')))!=='5173c5c64c4781e93830195d9c7517d07fee813b6261be57df72d4aa066dd473')throw Error('Refund v4 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-callback-source-continuity-20261108.json')))!=='2f93be012b6e19cf009e7da91d9abb7889852713e83d692d8f9614276a421aa6')throw Error('Refund v5 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-callback-economic-source-continuity-20261108.json')))!=='5f228fadf2d1c41e5e0fae415562829364414ea5d8a063bd38a148e8557168c4')throw Error('Refund v6 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-mixed-recovery-source-continuity-20261108.json')))!=='9e36eee479443be268d30a261741f0cf36a10f7493df3f6fc7de4a724545dfaf')throw Error('Refund v7 physical proof differs');
if(sha(readNativeFileSync(resolve(root,'workers-ts/test/fixtures/recharge-refund-counted-first-source-continuity-20261109.json')))!=='f786143d31046a6820b2a99f9f44839e3c23b801dc6fdd12c717f5e0b72391e4')throw Error('Refund v8 physical proof differs');
if(sha(readNativeFileSync(resolve(root,priorProofFile)))!==priorProofSha)throw Error('Refund prior proof physical bytes differ');
const raw=readNativeFileSync(resolve(root,RECHARGE_REFUND_SOURCE_PROOF_FILE));
if(sha(raw)!==RECHARGE_REFUND_SOURCE_PROOF_SHA)throw Error('Refund continuity immutable proof differs');
export const rechargeRefundSourceContinuity=freeze(verify(JSON.parse(decode(raw))as RechargeRefundHistoryProof));

/** Strict current-image entry: listed full physical targets only. An exact old
 * complete image and an unlisted key cannot authorize this outer projection. */
export function projectRechargeRefundPredecessor(file:string,source:string,proof=rechargeRefundSourceContinuity):string{
 const captured=verify(proof),row=captured.sources.find(value=>value.file===file);
 if(!row)throw Error('Refund continuity selected source absent');
 if(!whole(source,row.current))throw Error('Refund continuity complete current source differs');
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)??[];let boundary=0,priorStart=-1;
 for(const edit of row.inverseEdits){
  if(!Number.isSafeInteger(edit.start)||edit.start<0||edit.start<boundary||edit.start===priorStart
   ||!Array.isArray(edit.after)||!Array.isArray(edit.before)||!edit.after.every(line=>typeof line==='string')
   ||!edit.before.every(line=>typeof line==='string')||!edit.after.length&&!edit.before.length||edit.start+edit.after.length>lines.length
   ||!Number.isSafeInteger(edit.anchorStart)||edit.anchorStart<0||edit.anchorStart>edit.start
   ||!Array.isArray(edit.anchor)||!edit.anchor.length||!edit.anchor.every(line=>typeof line==='string')
   ||edit.anchorStart+edit.anchor.length<edit.start+edit.after.length||edit.anchorStart+edit.anchor.length>lines.length
   ||JSON.stringify(lines.slice(edit.start,edit.start+edit.after.length))!==JSON.stringify(edit.after)
   ||JSON.stringify(lines.slice(edit.anchorStart,edit.anchorStart+edit.anchor.length))!==JSON.stringify(edit.anchor)
   ||source.split(edit.anchor.join('')).length!==2)throw Error('Refund continuity exact literal/range/unique anchor differs');
  boundary=edit.start+edit.after.length;priorStart=edit.start;
 }
 for(const edit of[...row.inverseEdits].reverse())lines.splice(edit.start,edit.after.length,...edit.before);
 const previous=lines.join('');if(!whole(previous,row.predecessor))throw Error('Refund continuity complete predecessor differs');return previous;
}
/** Older adapters may already own a derived historical image. Only exact new
 * full bytes peel here; unchanged old leaves perform their own exact checks. */
export function peelMembershipHistoricalSourceIfPresent(file:string,source:string):string{
 const row=rechargeRefundSourceContinuity.sources.find(value=>value.file===file);
 const previous=row&&whole(source,row.current)?projectRechargeRefundPredecessor(file,source):source;
 return old.peelMembershipHistoricalSourceIfPresent(file,previous);
}

type NativePath=Parameters<typeof readNativeFileSync>[0];
type NativeOptions=Parameters<typeof readNativeFileSync>[1];
type View='refund'|'recharge'|'membership';
const refundFiles=new Set(files);
const rechargeFiles=new Set([...files,...old.rechargeNoticeSourceContinuity.sources.map(row=>row.file)]);
const membershipFiles=new Set([...rechargeFiles,...old.membershipContractSourceContinuity.sources.map(row=>row.file),
 ...old.membershipContractSourceContinuity.wiring.map(row=>row.file)]);
function read(file:NativePath,options:NativeOptions,view:View):ReturnType<typeof readNativeFileSync>{
 const value=readNativeFileSync(file,options);if(typeof file==='number')return value;
 // Native fs has already validated the path. An unrelated arbitrary-byte
 // pathname keeps its native result even when it has no UTF8 spelling.
 let absolute:string;
 if(typeof file==='string')absolute=resolve(file);
 else if(file instanceof URL)absolute=resolve(fileURLToPath(file));
 else{try{absolute=resolve(decode(file));}catch{return value;}}
 const name=relative(root,absolute).replace(/\\/g,'/');
 // Only the finite reviewed provider/test images map to fixed353 before the
 // unchanged older leaves. Production and current tests use native source.
 const transportType=isProviderTransportSource(name);
 const selected=transportType||(view==='refund'?refundFiles:view==='recharge'?rechargeFiles:membershipFiles).has(name);
 if(!selected)return value;
 const encoding=typeof options==='string'?options:options?.encoding;
 if(encoding&&encoding!=='utf8'&&encoding!=='utf-8')throw Error('Refund historical reader requires exact UTF8 or bytes');
 const physical=typeof value==='string'?value:decode(value);
 const source=transportType?projectProviderTransportPredecessor(name,physical):physical;
 const previous=refundFiles.has(name)?projectRechargeRefundPredecessor(name,source):source;
 const output=view==='refund'?previous:view==='recharge'?old.projectRechargeNoticePredecessor(name,previous)
  :old.projectMembershipHistoricalSource(name,previous);
 return typeof value==='string'?output:Buffer.from(output,'utf8');
}
export const readRechargeRefundPredecessorFile=((file:NativePath,options?:NativeOptions)=>read(file,options,'refund'))as typeof readNativeFileSync;
export const readRechargeNoticePredecessorFile=((file:NativePath,options?:NativeOptions)=>read(file,options,'recharge'))as typeof readNativeFileSync;
export const readMembershipContinuityHistoricalFile=((file:NativePath,options?:NativeOptions)=>read(file,options,'membership'))as typeof readNativeFileSync;
