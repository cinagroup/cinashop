import { readRoutineShippingRefundGenerationTx, parseRoutineShippingRefundGeneration, type RoutineShippingRefundGeneration } from './RoutineShippingRefundGeneration';
import { readRoutineVirtualPaidSourceTx, routineVirtualPaidKey, routineVirtualPaidPayload, ROUTINE_VIRTUAL_PAID_MARK, type RoutineVirtualShippingDomain } from '@/services/order/RoutineVirtualPaidShipping';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { and,asc,eq,inArray,or,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { orderNotificationDelivery,storeOrder,storeOrderCartInfo,storeOrderOutbox,type WechatShippingNotificationPayload } from '@/models/schema';
import { assertRoutineShippingReadyTx,assertRoutineShippingReadTx,inspectRoutineShippingCatalog } from '@/migrations/routineShipping';
import { FULFILLMENT_CITY_CONFLICT_GATE,inspectFulfillmentCityConflictReader } from '@/migrations/fulfillmentCityConflictReader';
import { assertOrderNotificationPayload,customerCityQueuedNoticeIsActive,ORDER_DELIVERY_NOTICE_EVENT } from '@/services/order/OrderNotificationOutboxService';
import { WechatProviderRejectedError } from '@/services/wechat/WechatNotificationProvider';
import { getRoutineShippingCarriers,uploadRoutineShipping,assertRoutineShippingHttpResult,type RoutineShippingHttpResult } from '@/services/wechat/RoutineShippingProvider';
import { routineShippingLogisticsType } from '@/services/wechat/RoutineShippingLogistics';
import { readRoutinePaidPickupSource, paidPickupEventIdentity, ROUTINE_PAID_PICKUP_MARK } from '@/services/order/RoutinePaidPickupShipping';
import { routineShippingItemTitle } from './RoutineShippingItems';
import { parseRoutineOriginalEvidence } from './RoutineOriginalPaymentEvidence';
import { readRoutineShippingOriginalTx,type RoutineShippingOriginal } from './RoutineShippingOriginal';
import { assertNativeAppExcludedForRoutineShippingTx } from './NativeAppRoutineShippingAuthority';
import { amountToCents } from './RefundGateway';
import { assertRoutineShippingHistoricalAccountTx,captureRoutineShippingEnv,freezeShipping,parseRoutineShippingAccountJournal,
 prepareRoutineShippingAccountTx,routineShippingClockTx,routineShippingScopeTx,routineShippingUnavailable,shippingEqual,shippingHex,
 shippingInteger,shippingMac,shippingObject,shippingSame,shippingUuid,type PreparedRoutineShippingAccount,
 type RoutineShippingAccountJournal,type RoutineShippingScope } from './RoutineShippingAccount';

type Signing=Pick<Env,'APP_KEY'>;
type Order=typeof storeOrder.$inferSelect;
type Delivery=typeof orderNotificationDelivery.$inferSelect;
export interface RoutineShippingClaim {id:number;eventKey:string;leaseToken:string}
export interface RoutineShippingRequest {
 order_key:{order_number_type:2;transaction_id:string};logistics_type:number;delivery_mode:1|2;is_all_delivered?:boolean;
 shipping_list:Array<{item_desc:string;tracking_no?:string;express_company?:string;contact?:{receiver_contact:string}}>;
 upload_time:string;payer:{openid:string};
}
interface Package {orderId:number;eventId:number;eventKey:string;logisticsType:number;description:string;tracking:string;carrier:string;contact:string;digest:string}
interface Identity {rootId:number;childId:number;buyerUid:number;orderNo:string;transactionId:string;totalAmount:number;appId:string;merchantId:string;payerId:string}
interface Snapshot {refundGeneration?:RoutineShippingRefundGeneration;identity:Identity;immutableDigest:string;stateDigest:string;packages:Package[];allDelivered:boolean;mode:1|2;logisticsType:number;original:RoutineShippingOriginal;delivery:Delivery}
interface DispatchPayload {
 format:1;purpose:'routine_shipping_upload';scope:RoutineShippingScope;identity:Identity;immutableDigest:string;
 packages:Package[];request:RoutineShippingRequest;account:RoutineShippingAccountJournal;
 original:{evidenceId:string;signature:string;relatedDigest:string;approvedUseDigest:string};
 actor:{role:string;roleOid:string};previousDispatchId:string;correction:boolean;
}
export interface RoutineShippingDispatch {dispatch_id:string;delivery_id:number;source_key:string;payload:DispatchPayload;created_at:number;signature:string}
interface VirtualIdentity extends Omit<Identity,'rootId'|'childId'> {domain:RoutineVirtualShippingDomain;subjectId:number}
interface VirtualPackage extends Omit<Package,'orderId'> {domain:RoutineVirtualShippingDomain;subjectId:number}
interface VirtualSnapshot extends Omit<Snapshot,'identity'|'packages'> {identity:VirtualIdentity;packages:VirtualPackage[]}
interface VirtualDispatchPayload extends Omit<DispatchPayload,'format'|'identity'|'packages'> {format:2;identity:VirtualIdentity;packages:VirtualPackage[]}
export interface RoutineVirtualShippingDispatch extends Omit<RoutineShippingDispatch,'payload'> {payload:VirtualDispatchPayload}
interface RefundDispatchPayload extends Omit<DispatchPayload,'format'> {format:3;refundGeneration:RoutineShippingRefundGeneration}
export interface RoutineRefundShippingDispatch extends Omit<RoutineShippingDispatch,'payload'> {payload:RefundDispatchPayload}
type AnyDispatch=RoutineShippingDispatch|RoutineVirtualShippingDispatch|RoutineRefundShippingDispatch;
type AnySnapshot=Snapshot|VirtualSnapshot;
type AnyIdentity=Identity|VirtualIdentity;
type AnyPackage=Package|VirtualPackage;
interface Evidence {evidence_id:string;dispatch_id:string;payload:{format:1;dispatchSignature:string;result:RoutineShippingHttpResult};created_at:number;signature:string}
const proofs=new WeakMap<RoutineShippingUploadProof,{dispatch:AnyDispatch;account:PreparedRoutineShippingAccount;claim:Readonly<RoutineShippingClaim>}>();
const preflights=new WeakMap<Preflight,{snapshot:AnySnapshot;claim:Readonly<RoutineShippingClaim>;account:PreparedRoutineShippingAccount;existing:AnyDispatch|null}>();
const uploadSlot=Symbol('routine.shipping.upload-proof.v1'),preflightSlot=Symbol('routine.shipping.preflight.v1');
export interface RoutineShippingUploadProof {readonly [uploadSlot]:true}
interface Preflight {readonly [preflightSlot]:true}
class Deferred extends Error {constructor(){super('wechat_shipping_previous_intent_pending');}}
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string'&&(empty||value.length>0)
 &&new TextEncoder().encode(value).byteLength<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
function root(container:Container){if(!Object.hasOwn(container.db,'$client')||!container.db.$client)return routineShippingUnavailable();}
function captureClaim(value:RoutineShippingClaim):Readonly<RoutineShippingClaim>{
 const r=shippingObject(value,['id','eventKey','leaseToken']);
 if(!shippingInteger(r.id)||typeof r.eventKey!=='string'||(!/^order\.(?:delivery\.notice:[1-9]\d*(?::city:[1-9]\d*)?|paid:[1-9]\d*)$/u.test(r.eventKey)&&!routineVirtualPaidKey(r.eventKey))||!shippingUuid(r.leaseToken))return routineShippingUnavailable();
 return Object.freeze({id:r.id,eventKey:r.eventKey,leaseToken:r.leaseToken});
}
export function captureRoutineShippingDeliveryEnv(env:Env):Env{
 const signing=captureRoutineShippingEnv(env),connectionString=env.HYPERDRIVE?.connectionString;
 return{...env,...signing,HYPERDRIVE:{...env.HYPERDRIVE,connectionString},UPSTASH_REDIS_URL:env.UPSTASH_REDIS_URL,UPSTASH_REDIS_TOKEN:env.UPSTASH_REDIS_TOKEN};
}
async function tables(tx:DbClient){
 const names=['order_notification_delivery','store_order_outbox','store_order','store_order_cart_info'];
 const [r]=await tx.execute<{ready:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) n(name)
  WHERE pg_catalog.to_regclass(pg_catalog.quote_ident(n.name)) IS DISTINCT FROM pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(n.name))) AS ready`);
 if(r?.ready!==true)return routineShippingUnavailable();
}
function deliveryIdentity(row:Delivery){return{id:row.id,outboxId:row.outboxId,eventKey:row.eventKey,orderId:row.orderId,withdrawalId:row.withdrawalId,
 userId:row.userId,noticeMark:row.noticeMark,channel:row.channel,target:row.target,templateCode:row.templateCode,payload:row.payload,addTime:row.addTime};}
async function claimed(tx:DbClient,c:Readonly<RoutineShippingClaim>,lock=true){
 const query=tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,c.id)).limit(2);
 const rows=lock?await query.for('update',{noWait:true}):await query,row=rows[0];
 if(rows.length!==1||row.channel!=='wechat_shipping'||row.eventKey!==c.eventKey||row.status!=='PROCESSING'||row.leaseToken!==c.leaseToken
  ||(routineVirtualPaidKey(c.eventKey)?row.orderId!==null:!shippingInteger(row.orderId))||row.withdrawalId!==null||row.templateCode!=='')return routineShippingUnavailable();
 const now=await routineShippingClockTx(tx);if(row.leaseUntil<=now)return routineShippingUnavailable();return row;
}
function masked(value:string){
 if(!value)return'';if(!/^[+0-9 ()-]{4,32}$/u.test(value)||!/[0-9]{4}$/u.test(value))return routineShippingUnavailable();
 return value.slice(0,-4).replace(/[0-9]/gu,'*')+value.slice(-4);
}
function physical(order:Order){return{id:order.id,pid:order.pid,uid:order.uid,orderId:order.orderId,payPrice:order.payPrice,paid:order.paid,payType:order.payType,
 tradeNo:order.tradeNo,isChannel:order.isChannel,shippingType:order.shippingType,supplierId:order.supplierId,storeId:order.storeId,
 supplierAllocationStatus:order.supplierAllocationStatus,deliveryType:order.deliveryType,deliveryId:order.deliveryId,deliveryName:order.deliveryName,
 deliveryCode:order.deliveryCode,userPhone:order.userPhone};}
/** Physical family locks are acquired in ID order, before the delivery/outbox,
 * carts, original-payment boundary or independent NativeApp verifier. */
async function snapshot(tx:DbClient,env:Env,c:Readonly<RoutineShippingClaim>):Promise<AnySnapshot>{
 if(routineVirtualPaidKey(c.eventKey))return virtualSnapshot(tx,env,c);
 await tables(tx);const initial=await claimed(tx,c,false);
 if(c.eventKey.startsWith('order.paid:'))return pickupSnapshot(tx,env,c,initial);
 const [hint]=await tx.select({id:storeOrder.id,pid:storeOrder.pid}).from(storeOrder).where(eq(storeOrder.id,initial.orderId!)).limit(1);
 if(!hint)return routineShippingUnavailable();const rootId=hint.pid>0?hint.pid:hint.id;
 const family=await tx.select().from(storeOrder).where(or(eq(storeOrder.id,rootId),eq(storeOrder.pid,rootId))).orderBy(asc(storeOrder.id)).limit(66).for('update',{noWait:true});
 if(!family.length||family.length>65)return routineShippingUnavailable();
 const parent=family.find(o=>o.id===rootId),child=family.find(o=>o.id===initial.orderId);
 if(!parent||!child||(child.pid>0?child.pid:child.id)!==rootId||![0,-1].includes(parent.pid)||parent.paid!==1||parent.payType!=='weixin'
  ||!shippingInteger(parent.uid)||!text(parent.tradeNo,100))return routineShippingUnavailable();
 const total=amountToCents(parent.payPrice);if(total===null||total<=0)return routineShippingUnavailable();
 const split=parent.pid===-1,leaves=split?family.filter(o=>o.pid===parent.id):[parent];
 if(split?(child.pid!==parent.id||leaves.length<2||leaves.length>64||family.length!==leaves.length+1):
  (child.id!==parent.id||family.length!==1))return routineShippingUnavailable();
 if(leaves.some(o=>o.uid!==parent.uid||o.paid!==1||o.payType!=='weixin'||o.isDel!==0||o.isSystemDel!==0
  ||split&&![1,3].includes(o.shippingType)))return routineShippingUnavailable();
 const amounts=leaves.map(o=>amountToCents(o.payPrice));
 if(amounts.some(n=>n===null||n<0)||amounts.reduce<number>((sum,n)=>sum+(n??0),0)!==total)return routineShippingUnavailable();
 const delivery=await claimed(tx,c);if(!shippingSame(deliveryIdentity(initial),deliveryIdentity(delivery)))return routineShippingUnavailable();
 const events=await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.eventType,ORDER_DELIVERY_NOTICE_EVENT),
  inArray(storeOrderOutbox.aggregateId,leaves.map(o=>o.id)))).orderBy(asc(storeOrderOutbox.id)).limit(65).for('share',{noWait:true});
 if(events.length>64||Buffer.byteLength(JSON.stringify(events),'utf8')>1048576)return routineShippingUnavailable();
 const own=events.find(e=>e.id===delivery.outboxId);
 if(!own||own.eventKey!==c.eventKey||own.aggregateType!=='order'||own.aggregateId!==child.id)return routineShippingUnavailable();
 assertOrderNotificationPayload(own.payload,own.eventType,own.aggregateId);
 if(!await customerCityQueuedNoticeIsActive(tx,own.eventKey))return routineShippingUnavailable();
 const ownPayload=own.payload as {orderId:number;orderNo:string;userId:number;deliveryType:string;deliveryName:string;deliveryId:string};
 if(ownPayload.orderNo!==child.orderId||ownPayload.userId!==parent.uid||ownPayload.deliveryType!==child.deliveryType
  ||ownPayload.deliveryId!==child.deliveryId||ownPayload.deliveryName!==child.deliveryName||child.status<1)return routineShippingUnavailable();
 const old=delivery.payload as WechatShippingNotificationPayload;
 if(old.kind!=='wechat_shipping'||old.transactionId!==parent.tradeNo||typeof old.itemDescription!=='string'||typeof old.isAllDelivered!=='boolean')return routineShippingUnavailable();
 const carts=await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid,leaves.map(o=>o.id))).orderBy(asc(storeOrderCartInfo.id)).limit(201).for('share',{noWait:true});
 if(!carts.length||carts.length>200||Buffer.byteLength(JSON.stringify(carts),'utf8')>1048576)return routineShippingUnavailable();
 const refundGeneration=await readRoutineShippingRefundGenerationTx(tx,env,{root:parent,family,carts});
 if(!refundGeneration&&(split&&(parent.supplierAllocationStatus!==2||leaves.length>15)
  ||[parent,...leaves].some(o=>o.refundStatus===2||o.refundStatus===3||o.refundType===6)))return routineShippingUnavailable();
 if(refundGeneration&&(!split||!refundGeneration.activeOrderIds.includes(child.id)))return routineShippingUnavailable();
 const activeLeaves=refundGeneration?leaves.filter(o=>refundGeneration.activeOrderIds.includes(o.id)):leaves;
 const packages:Package[]=[];
 for(const leaf of activeLeaves){
  if(leaf.status<1)continue;
  const candidates=events.filter(e=>e.aggregateId===leaf.id);let event:typeof own|undefined;
  for(const candidate of candidates){if(await customerCityQueuedNoticeIsActive(tx,candidate.eventKey)){if(event)return routineShippingUnavailable();event=candidate;}}
  if(!event)throw new Deferred();assertOrderNotificationPayload(event.payload,event.eventType,event.aggregateId);
  const p=event.payload as typeof ownPayload;
  if(p.orderId!==leaf.id||p.userId!==parent.uid||p.orderNo!==leaf.orderId||p.deliveryType!==leaf.deliveryType||p.deliveryId!==leaf.deliveryId||p.deliveryName!==leaf.deliveryName)return routineShippingUnavailable();
  const lines=carts.filter(row=>row.oid===leaf.id);
  if(!lines.length||lines.some(row=>row.uid!==parent.uid||!shippingInteger(row.cartNum)))return routineShippingUnavailable();
  const description=Array.from(lines.map(line=>routineShippingItemTitle(line.cartInfo,line.cartNum)).join('；')).slice(0,120).join('');
  if(!description)return routineShippingUnavailable();
  const logisticsType=routineShippingLogisticsType(leaf.shippingType,leaf.deliveryType);
  if(!logisticsType)return routineShippingUnavailable();
  const tracking=logisticsType===1?leaf.deliveryId:'',carrier=logisticsType===1?leaf.deliveryName:'',contact=logisticsType===1?masked(leaf.userPhone):'';
  if(logisticsType===1&&(!text(tracking,128)||!text(carrier,512)))return routineShippingUnavailable();
  const part={orderId:leaf.id,eventId:event.id,eventKey:event.eventKey,logisticsType,description,tracking,carrier,contact,
   digest:shippingMac(env,'physical-package',[physical(leaf),event.payload,lines.map(r=>[r.id,r.cartId,r.cartNum,r.cartInfo])])};
  packages.push(part);
 }
 if(!packages.length||packages.length>15||new Set(packages.map(p=>p.logisticsType)).size!==1)return routineShippingUnavailable();
 const allDelivered=leaves.every(o=>o.status>=1),logisticsType=packages[0].logisticsType,mode=split?2 as const:1 as const;
 if(split&&logisticsType!==1)return routineShippingUnavailable();
 const original=await readRoutineShippingOriginalTx(tx,env,{domain:'store_order',rootId:parent.id,buyerUid:parent.uid,orderNo:parent.orderId,transactionId:parent.tradeNo,totalAmount:total});
 await assertNativeAppExcludedForRoutineShippingTx(tx,env,original);
 const facts=original.evidence.payload.observation.facts,identity={rootId:parent.id,childId:child.id,buyerUid:parent.uid,orderNo:parent.orderId,
  transactionId:parent.tradeNo,totalAmount:total,appId:facts.appId,merchantId:facts.merchantId,payerId:facts.payerId};
 const ownPackage=packages.find(p=>p.orderId===child.id);if(!ownPackage)return routineShippingUnavailable();
 const immutableFacts=[deliveryIdentity(delivery),{id:own.id,key:own.eventKey,type:own.eventType,aggregateId:own.aggregateId,aggregateType:own.aggregateType,payload:own.payload,addTime:own.addTime},ownPackage.digest,identity];
 const immutableDigest=refundGeneration?shippingMac(env,'delivery-identity-refund-v1',[immutableFacts,refundGeneration]):shippingMac(env,'delivery-identity',immutableFacts);
 const stateFacts=[identity,immutableDigest,packages,allDelivered,mode,logisticsType];
 return{identity,immutableDigest,stateDigest:refundGeneration?shippingMac(env,'source-state-refund-v1',[stateFacts,refundGeneration]):shippingMac(env,'source-state',stateFacts),
  packages,allDelivered,mode,logisticsType,original,delivery,...(refundGeneration?{refundGeneration}:{})};
}

/** A real completed paid outbox is the pickup source; status0 is intentional.
 * Supplier leaves are aggregated once for this payment, never mode2 parcels. */
async function pickupSnapshot(tx:DbClient,env:Env,c:Readonly<RoutineShippingClaim>,initial:Delivery):Promise<Snapshot>{
 const rootId=Number(c.eventKey.slice('order.paid:'.length));
 if(initial.orderId!==rootId||initial.noticeMark!==ROUTINE_PAID_PICKUP_MARK||initial.target!=='')return routineShippingUnavailable();
 const source=await readRoutinePaidPickupSource(tx,rootId,'COMPLETED'),parent=source.parent;
 const delivery=await claimed(tx,c);
 if(!shippingSame(deliveryIdentity(initial),deliveryIdentity(delivery))||delivery.outboxId!==source.event.id||delivery.userId!==parent.uid)return routineShippingUnavailable();
 const expected:WechatShippingNotificationPayload={kind:'wechat_shipping',transactionId:parent.tradeNo.trim(),logisticsType:4,deliveryMode:1,isAllDelivered:true,
   itemDescription:source.description,trackingNumber:'',expressCompanyName:'',receiverContact:'',path:`pages/goods/order_details/index?order_id=${parent.orderId}`};
 if(!shippingSame(delivery.payload,expected))return routineShippingUnavailable();
 const original=await readRoutineShippingOriginalTx(tx,env,{domain:'store_order',rootId:parent.id,buyerUid:parent.uid,orderNo:parent.orderId,
   transactionId:parent.tradeNo,totalAmount:source.total});
 await assertNativeAppExcludedForRoutineShippingTx(tx,env,original);
 const facts=original.evidence.payload.observation.facts,identity:Identity={rootId:parent.id,childId:parent.id,buyerUid:parent.uid,orderNo:parent.orderId,
   transactionId:parent.tradeNo,totalAmount:source.total,appId:facts.appId,merchantId:facts.merchantId,payerId:facts.payerId};
 const part:Package={orderId:parent.id,eventId:source.event.id,eventKey:source.event.eventKey,logisticsType:4,description:source.description,
   tracking:'',carrier:'',contact:'',digest:shippingMac(env,'paid-pickup-physical',source.facts)},packages=[part];
 const immutableDigest=shippingMac(env,'delivery-identity',[deliveryIdentity(delivery),paidPickupEventIdentity(source.event),part.digest,identity]);
 return{identity,immutableDigest,stateDigest:shippingMac(env,'source-state',[identity,immutableDigest,packages,true,1,4]),packages,
   allDelivered:true,mode:1,logisticsType:4,original,delivery};
}

function sourceKey(env:Signing,i:AnyIdentity){
 if('domain'in i)return shippingMac(env,'payment-source-v2',[i.domain,i.subjectId,i.buyerUid,i.orderNo,i.transactionId,i.totalAmount,i.appId,i.merchantId,i.payerId]);
 return shippingMac(env,'payment-source',[i.rootId,i.buyerUid,i.orderNo,i.transactionId,i.totalAmount,i.appId,i.merchantId,i.payerId]);
}
async function virtualSnapshot(tx:DbClient,env:Env,c:Readonly<RoutineShippingClaim>):Promise<VirtualSnapshot>{
 const {source,event}=await readRoutineVirtualPaidSourceTx(tx,env,c.eventKey);
 const delivery=await claimed(tx,c);
 const subjects=await tx.execute<{domain:string;id:number}>(sql`SELECT subject_domain AS domain,subject_id AS id
  FROM public.order_notification_delivery WHERE id=${c.id} LIMIT 2`);
 if(subjects.length!==1||subjects[0].domain!==source.domain||subjects[0].id!==source.subjectId||delivery.orderId!==null||delivery.withdrawalId!==null
  ||delivery.outboxId!==event.id||delivery.userId!==source.buyerUid||delivery.noticeMark!==ROUTINE_VIRTUAL_PAID_MARK||delivery.target!==''
  ||!shippingSame(delivery.payload,routineVirtualPaidPayload(source)))return routineShippingUnavailable();
 const original=await readRoutineShippingOriginalTx(tx,env,{domain:source.domain,rootId:source.subjectId,buyerUid:source.buyerUid,
  orderNo:source.orderNo,transactionId:source.transactionId,totalAmount:source.totalAmount});
 await assertNativeAppExcludedForRoutineShippingTx(tx,env,original);
 const facts=original.evidence.payload.observation.facts;
 const identity:VirtualIdentity={domain:source.domain,subjectId:source.subjectId,buyerUid:source.buyerUid,orderNo:source.orderNo,
  transactionId:source.transactionId,totalAmount:source.totalAmount,appId:facts.appId,merchantId:facts.merchantId,payerId:facts.payerId};
 const part:VirtualPackage={domain:source.domain,subjectId:source.subjectId,eventId:event.id,eventKey:event.eventKey,logisticsType:3,
  description:source.description,tracking:'',carrier:'',contact:'',digest:shippingMac(env,'virtual-paid-physical',[source,paidPickupEventIdentity(event)])};
 const packages=[part],immutableDigest=shippingMac(env,'virtual-delivery-identity',[deliveryIdentity(delivery),subjects[0],part.digest,identity]);
 return{identity,immutableDigest,stateDigest:shippingMac(env,'virtual-source-state',[identity,immutableDigest,packages]),packages,
  allDelivered:true,mode:1,logisticsType:3,original,delivery};
}
/** A split upload is commissioned separately from shipping storage. This is a
 * fresh-use check only; durable accepted receipts acquire no new reader gate. */
async function splitReader(tx:DbClient,s:AnySnapshot){
 if(s.mode!==2)return;
 const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${FULFILLMENT_CITY_CONFLICT_GATE[0]},${FULFILLMENT_CITY_CONFLICT_GATE[1]}) AS locked`);
 if(gate?.locked!==true)throw new Deferred();
 const reader=await inspectFulfillmentCityConflictReader(tx),b=reader.binding;
 if(!reader.ready||!b||!b.actors.app)return routineShippingUnavailable();
 const [actual]=await tx.execute<{ready:boolean}>(sql`SELECT current_user=${b.app} AND current_user=session_user
  AND pg_catalog.current_database()=${b.database}
  AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${b.databaseOid}
  AND (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user)=${b.appOid} AS ready`);
 if(actual?.ready!==true)return routineShippingUnavailable();
}
function parseRequest(raw:unknown):RoutineShippingRequest{
 const r=shippingObject(raw,Object.hasOwn(Object(raw),'is_all_delivered')?['order_key','logistics_type','delivery_mode','is_all_delivered','shipping_list','upload_time','payer']:['order_key','logistics_type','delivery_mode','shipping_list','upload_time','payer']);
 const order=shippingObject(r.order_key,['order_number_type','transaction_id']),payer=shippingObject(r.payer,['openid']);
 if(order.order_number_type!==2||!text(order.transaction_id,100)||!text(payer.openid,128)||![1,2,3,4].includes(Number(r.logistics_type))
  ||typeof r.logistics_type!=='number'||r.delivery_mode!==1&&r.delivery_mode!==2||r.delivery_mode===2&&(r.logistics_type!==1||typeof r.is_all_delivered!=='boolean')
  ||r.delivery_mode===1&&Object.hasOwn(r,'is_all_delivered')||!Array.isArray(r.shipping_list)||!r.shipping_list.length||r.shipping_list.length>15
  ||r.delivery_mode===1&&r.shipping_list.length!==1||typeof r.upload_time!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/u.test(r.upload_time)
  ||!Number.isFinite(Date.parse(r.upload_time))||new Date(r.upload_time).toISOString()!==r.upload_time)return routineShippingUnavailable();
 const list=r.shipping_list.map(value=>{
  const express=r.logistics_type===1,hasContact=Object.hasOwn(Object(value),'contact');
  const p=shippingObject(value,express?(hasContact?['item_desc','tracking_no','express_company','contact']:['item_desc','tracking_no','express_company']):['item_desc']);
  if(!text(p.item_desc,4096)||Array.from(p.item_desc).length>120||express&&(!text(p.tracking_no,128)||!text(p.express_company,128)))return routineShippingUnavailable();
  let contact:{receiver_contact:string}|undefined;
  if(hasContact){const c=shippingObject(p.contact,['receiver_contact']);if(!text(c.receiver_contact,64)||!/[0-9]{4}$/u.test(c.receiver_contact)||/[0-9]/u.test(c.receiver_contact.slice(0,-4)))return routineShippingUnavailable();contact={receiver_contact:c.receiver_contact};}
  if(express&&p.express_company==='SF'&&!contact)return routineShippingUnavailable();
  return{item_desc:p.item_desc,...(express?{tracking_no:p.tracking_no as string,express_company:p.express_company as string}:{}),...(contact?{contact}:{})};
 });
 return freezeShipping({order_key:{order_number_type:2 as const,transaction_id:order.transaction_id},logistics_type:r.logistics_type,delivery_mode:r.delivery_mode,
  ...(r.delivery_mode===2?{is_all_delivered:r.is_all_delivered as boolean}:{}),shipping_list:list,upload_time:r.upload_time,payer:{openid:payer.openid}});
}
function parseDispatch(env:Signing,raw:unknown,scope:RoutineShippingScope):AnyDispatch{
 const record=shippingObject(raw,['dispatch_id','delivery_id','source_key','payload','created_at','signature']);
 const payload=shippingObject(record.payload,Object.hasOwn(Object(record.payload),'refundGeneration')
  ?['format','purpose','scope','identity','immutableDigest','packages','request','account','original','actor','previousDispatchId','correction','refundGeneration']
  :['format','purpose','scope','identity','immutableDigest','packages','request','account','original','actor','previousDispatchId','correction']);
 return payload.format===3?parseRefundDispatch(env,raw,scope):payload.format===2?parseVirtualDispatch(env,raw,scope):parseStoreDispatch(env,raw,scope);
}
function parseVirtualDispatch(env:Signing,raw:unknown,scope:RoutineShippingScope):RoutineVirtualShippingDispatch{
 const r=shippingObject(raw,['dispatch_id','delivery_id','source_key','payload','created_at','signature']);
 const p=shippingObject(r.payload,['format','purpose','scope','identity','immutableDigest','packages','request','account','original','actor','previousDispatchId','correction']);
 const i=shippingObject(p.identity,['domain','subjectId','buyerUid','orderNo','transactionId','totalAmount','appId','merchantId','payerId']);
 const actor=shippingObject(p.actor,['role','roleOid']),o=shippingObject(p.original,['evidenceId','signature','relatedDigest','approvedUseDigest']);
 const created=typeof r.created_at==='string'&&/^\d+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!shippingUuid(r.dispatch_id)||!shippingInteger(r.delivery_id)||!shippingHex(r.source_key)||!shippingInteger(created)||!shippingHex(r.signature)
  ||p.format!==2||p.purpose!=='routine_shipping_upload'||!shippingSame(p.scope,scope)||!shippingHex(p.immutableDigest)
  ||i.domain!=='recharge'&&i.domain!=='membership'||!['subjectId','buyerUid','totalAmount'].every(k=>shippingInteger(i[k]))
  ||!text(i.orderNo,64)||!text(i.transactionId,100)||!text(i.appId,64)||!text(i.merchantId,64)||!text(i.payerId,128)
  ||!text(actor.role,128)||typeof actor.roleOid!=='string'||!/^\d+$/u.test(actor.roleOid)
  ||!shippingHex(o.evidenceId)||!shippingHex(o.signature)||!shippingHex(o.relatedDigest)||!shippingHex(o.approvedUseDigest)
  ||p.previousDispatchId!==''||p.correction!==false||!Array.isArray(p.packages)||p.packages.length!==1)return routineShippingUnavailable();
 const v=shippingObject(p.packages[0],['domain','subjectId','eventId','eventKey','logisticsType','description','tracking','carrier','contact','digest']);
 if(v.domain!==i.domain||v.subjectId!==i.subjectId||!shippingInteger(v.eventId)||v.eventKey!==`${i.domain}.paid.shipping:${i.subjectId}`
  ||v.logisticsType!==3||!text(v.description,4096)||Array.from(v.description).length>120
  ||v.tracking!==''||v.carrier!==''||v.contact!==''||!shippingHex(v.digest))return routineShippingUnavailable();
 const identity=i as unknown as VirtualIdentity,packages=[v as unknown as VirtualPackage],request=parseRequest(p.request);
 const account=parseRoutineShippingAccountJournal(env,p.account,scope);
 if(r.source_key!==sourceKey(env,identity)||request.order_key.transaction_id!==identity.transactionId||request.payer.openid!==identity.payerId
  ||account.payload.data.appId!==identity.appId||account.payload.data.merchantId!==identity.merchantId||Date.parse(request.upload_time)!==Number(created)*1000
  ||request.logistics_type!==3||request.delivery_mode!==1||request.shipping_list[0].item_desc!==v.description)return routineShippingUnavailable();
 const body={dispatch_id:r.dispatch_id,delivery_id:r.delivery_id,source_key:r.source_key,payload:{format:2 as const,purpose:'routine_shipping_upload' as const,scope,
  identity,immutableDigest:p.immutableDigest,packages,request,account,original:o as unknown as VirtualDispatchPayload['original'],
  actor:actor as unknown as VirtualDispatchPayload['actor'],previousDispatchId:'',correction:false as const},created_at:Number(created)};
 if(!shippingEqual(r.signature,shippingMac(env,'dispatch',body)))return routineShippingUnavailable();
 return freezeShipping({...body,signature:r.signature});
}
function parseStoreDispatch(env:Signing,raw:unknown,scope:RoutineShippingScope):RoutineShippingDispatch{
 const r=shippingObject(raw,['dispatch_id','delivery_id','source_key','payload','created_at','signature']);
 const p=shippingObject(r.payload,['format','purpose','scope','identity','immutableDigest','packages','request','account','original','actor','previousDispatchId','correction']);
 const i=shippingObject(p.identity,['rootId','childId','buyerUid','orderNo','transactionId','totalAmount','appId','merchantId','payerId']);
 const actor=shippingObject(p.actor,['role','roleOid']),o=shippingObject(p.original,['evidenceId','signature','relatedDigest','approvedUseDigest']);
 const created=typeof r.created_at==='string'&&/^\d+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!shippingUuid(r.dispatch_id)||!shippingInteger(r.delivery_id)||!shippingHex(r.source_key)||!shippingInteger(created)||!shippingHex(r.signature)
  ||p.format!==1||p.purpose!=='routine_shipping_upload'||!shippingSame(p.scope,scope)||!shippingHex(p.immutableDigest)
  ||!['rootId','childId','buyerUid','totalAmount'].every(k=>shippingInteger(i[k]))||!text(i.orderNo,64)||!text(i.transactionId,100)
  ||!text(i.appId,64)||!text(i.merchantId,64)||!text(i.payerId,128)||!text(actor.role,128)||typeof actor.roleOid!=='string'||!/^\d+$/u.test(actor.roleOid)
  ||!shippingHex(o.evidenceId)||!shippingHex(o.signature)||!shippingHex(o.relatedDigest)||!shippingHex(o.approvedUseDigest)
  ||p.previousDispatchId!==''&&!shippingUuid(p.previousDispatchId)||p.correction!==false||!Array.isArray(p.packages)||!p.packages.length||p.packages.length>15)return routineShippingUnavailable();
 const packages=p.packages.map(value=>{
  const v=shippingObject(value,['orderId','eventId','eventKey','logisticsType','description','tracking','carrier','contact','digest']);
  if(!shippingInteger(v.orderId)||!shippingInteger(v.eventId)||!text(v.eventKey,128)||![1,2,3,4].includes(Number(v.logisticsType))||typeof v.logisticsType!=='number'
   ||!text(v.description,4096)||Array.from(v.description).length>120||!text(v.tracking,128,true)||!text(v.carrier,512,true)||!text(v.contact,64,true)||!shippingHex(v.digest))return routineShippingUnavailable();
  return v as unknown as Package;
 });
 if(new Set(packages.map(v=>v.orderId)).size!==packages.length||!packages.some(v=>v.orderId===i.childId))return routineShippingUnavailable();
 const identity=i as unknown as Identity,request=parseRequest(p.request),account=parseRoutineShippingAccountJournal(env,p.account,scope);
 if(r.source_key!==sourceKey(env,identity)||request.order_key.transaction_id!==identity.transactionId||request.payer.openid!==identity.payerId
  ||account.payload.data.appId!==identity.appId||account.payload.data.merchantId!==identity.merchantId||Date.parse(request.upload_time)!==Number(created)*1000)return routineShippingUnavailable();
 if(packages.some((v,n)=>v.logisticsType!==request.logistics_type||n>0&&packages[n-1].orderId>=v.orderId)
  ||request.delivery_mode===1&&packages.length!==1||request.delivery_mode===2&&identity.childId===identity.rootId
  ||request.logistics_type===1&&(request.shipping_list.length!==packages.length||packages.some((v,n)=>{
   const item=request.shipping_list[n];return item.item_desc!==v.description||item.tracking_no!==v.tracking||(item.contact?.receiver_contact??'')!==v.contact;
  })))return routineShippingUnavailable();
 const body={dispatch_id:r.dispatch_id,delivery_id:r.delivery_id,source_key:r.source_key,payload:{format:1 as const,purpose:'routine_shipping_upload' as const,scope,
  identity,immutableDigest:p.immutableDigest,packages,request,account,original:o as unknown as DispatchPayload['original'],actor:actor as unknown as DispatchPayload['actor'],previousDispatchId:p.previousDispatchId as string,correction:false},created_at:Number(created)};
 if(!shippingEqual(r.signature,shippingMac(env,'dispatch',body)))return routineShippingUnavailable();return freezeShipping({...body,signature:r.signature});
}
function parseRefundDispatch(env:Signing,raw:unknown,scope:RoutineShippingScope):RoutineRefundShippingDispatch{
 const r=shippingObject(raw,['dispatch_id','delivery_id','source_key','payload','created_at','signature']);
 const p=shippingObject(r.payload,['format','purpose','scope','identity','immutableDigest','packages','request','account','original','actor','previousDispatchId','correction','refundGeneration']);
 const i=shippingObject(p.identity,['rootId','childId','buyerUid','orderNo','transactionId','totalAmount','appId','merchantId','payerId']);
 const actor=shippingObject(p.actor,['role','roleOid']),o=shippingObject(p.original,['evidenceId','signature','relatedDigest','approvedUseDigest']);
 const created=typeof r.created_at==='string'&&/^\d+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
 if(!shippingUuid(r.dispatch_id)||!shippingInteger(r.delivery_id)||!shippingHex(r.source_key)||!shippingInteger(created)||!shippingHex(r.signature)
  ||p.format!==3||p.purpose!=='routine_shipping_upload'||!shippingSame(p.scope,scope)||!shippingHex(p.immutableDigest)
  ||!['rootId','childId','buyerUid','totalAmount'].every(k=>shippingInteger(i[k]))||!text(i.orderNo,64)||!text(i.transactionId,100)
  ||!text(i.appId,64)||!text(i.merchantId,64)||!text(i.payerId,128)||!text(actor.role,128)||typeof actor.roleOid!=='string'||!/^\d+$/u.test(actor.roleOid)
  ||!shippingHex(o.evidenceId)||!shippingHex(o.signature)||!shippingHex(o.relatedDigest)||!shippingHex(o.approvedUseDigest)
  ||p.previousDispatchId!==''&&!shippingUuid(p.previousDispatchId)||p.correction!==false||!Array.isArray(p.packages)||!p.packages.length||p.packages.length>15)return routineShippingUnavailable();
 const packages=p.packages.map(value=>{
  const v=shippingObject(value,['orderId','eventId','eventKey','logisticsType','description','tracking','carrier','contact','digest']);
  if(!shippingInteger(v.orderId)||!shippingInteger(v.eventId)||!text(v.eventKey,128)||![1,2,3,4].includes(Number(v.logisticsType))||typeof v.logisticsType!=='number'
   ||!text(v.description,4096)||Array.from(v.description).length>120||!text(v.tracking,128,true)||!text(v.carrier,512,true)||!text(v.contact,64,true)||!shippingHex(v.digest))return routineShippingUnavailable();
  return v as unknown as Package;
 });
 if(new Set(packages.map(v=>v.orderId)).size!==packages.length||!packages.some(v=>v.orderId===i.childId))return routineShippingUnavailable();
 const refundGeneration=parseRoutineShippingRefundGeneration(env,p.refundGeneration);
 const identity=i as unknown as Identity,request=parseRequest(p.request),account=parseRoutineShippingAccountJournal(env,p.account,scope);
 if(!shippingSame(refundGeneration.payment,{rootId:identity.rootId,buyerUid:identity.buyerUid,orderNo:identity.orderNo,transactionId:identity.transactionId,totalAmount:identity.totalAmount})
  ||!refundGeneration.activeOrderIds.includes(identity.childId)||packages.some(v=>!refundGeneration.activeOrderIds.includes(v.orderId))
  ||request.delivery_mode!==2||request.logistics_type!==1)return routineShippingUnavailable();
 if(r.source_key!==sourceKey(env,identity)||request.order_key.transaction_id!==identity.transactionId||request.payer.openid!==identity.payerId
  ||account.payload.data.appId!==identity.appId||account.payload.data.merchantId!==identity.merchantId||Date.parse(request.upload_time)!==Number(created)*1000)return routineShippingUnavailable();
 if(packages.some((v,n)=>v.logisticsType!==request.logistics_type||n>0&&packages[n-1].orderId>=v.orderId)
  ||identity.childId===identity.rootId
  ||request.logistics_type===1&&(request.shipping_list.length!==packages.length||packages.some((v,n)=>{
   const item=request.shipping_list[n];return item.item_desc!==v.description||item.tracking_no!==v.tracking||(item.contact?.receiver_contact??'')!==v.contact;
  })))return routineShippingUnavailable();
 const body={dispatch_id:r.dispatch_id,delivery_id:r.delivery_id,source_key:r.source_key,payload:{format:3 as const,purpose:'routine_shipping_upload' as const,scope,
  identity,immutableDigest:p.immutableDigest,packages,request,account,refundGeneration,original:o as unknown as DispatchPayload['original'],actor:actor as unknown as DispatchPayload['actor'],previousDispatchId:p.previousDispatchId as string,correction:false},created_at:Number(created)};
 if(!shippingEqual(r.signature,shippingMac(env,'dispatch',body)))return routineShippingUnavailable();return freezeShipping({...body,signature:r.signature});
}
async function savedDispatch(tx:DbClient,env:Signing,deliveryId:number){
 const rows=await tx.execute(sql`SELECT * FROM public.routine_shipping_dispatch WHERE delivery_id=${deliveryId} LIMIT 2`);
 if(rows.length>1)return routineShippingUnavailable();return rows.length?parseDispatch(env,rows[0],await routineShippingScopeTx(tx)):null;
}
async function authenticateHistorical(tx:DbClient,env:Signing,d:AnyDispatch){
 await assertRoutineShippingHistoricalAccountTx(tx,env,d.payload.account,d.created_at);
 const rows=await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE evidence_id=${d.payload.original.evidenceId} LIMIT 2`);
 if(rows.length!==1)return routineShippingUnavailable();const original=parseRoutineOriginalEvidence(env,rows[0]),facts=original.payload.observation.facts,b=original.payload.binding,i=d.payload.identity;
 if(original.signature!==d.payload.original.signature||b.state!=='bound'||b.local.domain!==('domain'in i?i.domain:'store_order')||b.local.orderId!==('domain'in i?i.subjectId:i.rootId)||b.local.buyerUid!==i.buyerUid
  ||b.local.amountCents!==i.totalAmount||facts.orderNo!==i.orderNo||facts.transactionId!==i.transactionId||facts.appId!==i.appId||facts.merchantId!==i.merchantId
  ||facts.payerId!==i.payerId||facts.amountCents!==i.totalAmount||facts.tradeType!=='JSAPI'||facts.tradeState!=='SUCCESS')return routineShippingUnavailable();
}
async function evidence(tx:DbClient,env:Signing,d:AnyDispatch):Promise<Evidence[]>{
 await authenticateHistorical(tx,env,d);
 const rows=await tx.execute(sql`SELECT * FROM public.routine_shipping_provider_evidence WHERE dispatch_id=${d.dispatch_id}::uuid ORDER BY created_at,evidence_id LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return routineShippingUnavailable();
 const output:Evidence[]=[];
 for(const raw of rows){
  const r=shippingObject(raw,['evidence_id','dispatch_id','payload','created_at','signature']),p=shippingObject(r.payload,['format','dispatchSignature','result']);
  const v=shippingObject(p.result,['dispatchId','dispatchSignature','code','status','issuedAt','rawDigest','requestStartedAt','verifiedAt']);
  const created=typeof r.created_at==='string'&&/^\d+$/u.test(r.created_at)?Number(r.created_at):r.created_at;
  if(!shippingHex(r.evidence_id)||r.dispatch_id!==d.dispatch_id||!shippingInteger(created)||!shippingHex(r.signature)||p.format!==1||p.dispatchSignature!==d.signature
   ||v.dispatchId!==d.dispatch_id||v.dispatchSignature!==d.signature||!Number.isSafeInteger(v.code)||!Number.isSafeInteger(v.status)||Number(v.status)<100||Number(v.status)>599
   ||v.code===0&&(Number(v.status)<200||Number(v.status)>299)||!shippingHex(v.rawDigest)||!shippingInteger(v.issuedAt)||!shippingInteger(v.requestStartedAt)||!shippingInteger(v.verifiedAt)
   ||v.issuedAt<d.created_at||Number(created)<v.issuedAt||Number(created)-v.issuedAt>90
   ||Math.abs(v.requestStartedAt-v.issuedAt)>60||v.verifiedAt-v.issuedAt < -60||v.verifiedAt-v.issuedAt>70
   ||v.verifiedAt-v.requestStartedAt < -60||v.verifiedAt-v.requestStartedAt>70)return routineShippingUnavailable();
  await assertRoutineShippingHistoricalAccountTx(tx,env,d.payload.account,v.issuedAt);
  const payload={format:1 as const,dispatchSignature:d.signature,result:v as unknown as RoutineShippingHttpResult},body={evidence_id:r.evidence_id,dispatch_id:d.dispatch_id,payload,created_at:Number(created)};
  if(r.evidence_id!==shippingMac(env,'provider-result-id',payload)||!shippingEqual(r.signature,shippingMac(env,'provider-result',body)))return routineShippingUnavailable();
  output.push(freezeShipping({...body,signature:r.signature}));
 }
 return output;
}
async function sourceHistory(tx:DbClient,env:Signing,key:string){
 const rows=await tx.execute(sql`SELECT * FROM public.routine_shipping_dispatch WHERE source_key=${key} ORDER BY created_at,dispatch_id LIMIT 65`);
 if(rows.length>64||Buffer.byteLength(JSON.stringify(rows),'utf8')>1048576)return routineShippingUnavailable();
 const scope=await routineShippingScopeTx(tx),decoded=Array.from(rows,r=>parseDispatch(env,r,scope));
 for(let n=0;n<decoded.length;n++)if(decoded[n].source_key!==key||decoded[n].payload.previousDispatchId!==(n?decoded[n-1].dispatch_id:''))return routineShippingUnavailable();
 return decoded;
}
async function sourceBoundary(tx:DbClient,key:string){
 const [r]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${'routine-shipping-source:v1:'+key},0)) AS locked`);
 if(r?.locked!==true)throw new Deferred();
}
function containsPackages(previous:readonly AnyPackage[],current:readonly AnyPackage[]){
 return previous.every(p=>{if(!('orderId'in p))return false;const now=current.find(v=>('orderId'in v)&&v.orderId===p.orderId);return now!==undefined&&shippingSame(p,now);});
}
function matchingSnapshot(d:AnyDispatch,s:AnySnapshot){
 if(!shippingSame(d.payload.format===3?d.payload.refundGeneration:null,s.refundGeneration??null))return routineShippingUnavailable();
 if(!shippingSame(d.payload.identity,s.identity)||d.payload.immutableDigest!==s.immutableDigest
  ||d.payload.request.logistics_type!==s.logisticsType||d.payload.request.delivery_mode!==s.mode)return routineShippingUnavailable();
 if(shippingSame(d.payload.packages,s.packages)&& (s.mode===1||d.payload.request.is_all_delivered===s.allDelivered))return;
 // A known rejected partial request may be retried after another package was
 // physically shipped, but its old body/time remain pinned. Admission below
 // still requires a genuine non-success receipt and the latest source intent.
 if(s.mode!==2||d.payload.request.is_all_delivered!==false||d.payload.packages.length>=s.packages.length
  ||!containsPackages(d.payload.packages,s.packages))return routineShippingUnavailable();
}
function newRequest(s:AnySnapshot,carriers:ReadonlyArray<{id:string;name:string}>,created:number,previous?:AnyDispatch):RoutineShippingRequest{
 const list=s.logisticsType===1?(s.packages as Package[]).map(p=>{
  const old=previous?.payload.packages.findIndex(v=>'orderId'in v&&v.orderId===p.orderId)??-1;
  // Accepted entries keep their exact original carrier ID and contact even if
  // the current carrier list changed its spelling or removed that company.
  if(previous&&old>=0)return previous.payload.request.shipping_list[old];
  const matches=carriers.filter(v=>v.id===p.carrier||v.name===p.carrier);if(matches.length!==1)return routineShippingUnavailable();
  const carrier=matches[0];return{item_desc:p.description,tracking_no:p.tracking,express_company:carrier.id,...(p.contact?{contact:{receiver_contact:p.contact}}:{})};
 }):[{item_desc:Array.from(s.packages.map(p=>p.description).join('；')).slice(0,120).join('')}];
 return parseRequest({order_key:{order_number_type:2,transaction_id:s.identity.transactionId},logistics_type:s.logisticsType,delivery_mode:s.mode,
  ...(s.mode===2?{is_all_delivered:s.allDelivered}:{}),shipping_list:list,upload_time:new Date(created*1000).toISOString(),payer:{openid:s.identity.payerId}});
}
async function prepare(container:Container,env:Env,c:Readonly<RoutineShippingClaim>):Promise<Preflight>{
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadyTx(tx))return routineShippingUnavailable();
  const s=await snapshot(tx,env,c);await splitReader(tx,s);
  const account=await prepareRoutineShippingAccountTx(tx,env,s.identity.appId,s.identity.merchantId),existing=await savedDispatch(tx,env,c.id);
  if(existing){matchingSnapshot(existing,s);if(!shippingSame(existing.payload.account,account.account))return routineShippingUnavailable();}
  const p=Object.freeze({[preflightSlot]:true as const});preflights.set(p,{snapshot:s,claim:c,account,existing});return p;
 });
}
async function admit(container:Container,env:Env,p:Preflight,carriers:ReadonlyArray<{id:string;name:string}>):Promise<RoutineShippingUploadProof>{
 const initial=preflights.get(p);if(!initial)return routineShippingUnavailable();
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadyTx(tx))return routineShippingUnavailable();
  const s=await snapshot(tx,env,initial.claim);if(s.stateDigest!==initial.snapshot.stateDigest)return routineShippingUnavailable();
  await splitReader(tx,s);
  const account=await prepareRoutineShippingAccountTx(tx,env,s.identity.appId,s.identity.merchantId);
  if(!shippingSame(initial.account.account,account.account))return routineShippingUnavailable();
  const key=sourceKey(env,s.identity);await sourceBoundary(tx,key);
  const history=await sourceHistory(tx,env,key),last=history.at(-1);let d=await savedDispatch(tx,env,initial.claim.id);
  if(d){
   matchingSnapshot(d,s);if(!shippingSame(d.payload.account,account.account)||last?.dispatch_id!==d.dispatch_id)return routineShippingUnavailable();
   const results=await evidence(tx,env,d);if(!results.length)throw new Error('wechat_shipping_existing_intent_outcome_unknown');
   if(results.some(v=>v.payload.result.code===0)||results.length>=5)return routineShippingUnavailable();
  }else{
   if(last){
    const results=await evidence(tx,env,last);if(!results.some(v=>v.payload.result.code===0))throw new Deferred();
    if(!shippingSame(last.payload.format===3?last.payload.refundGeneration:null,s.refundGeneration??null)
     ||!('rootId'in last.payload.identity)||!('rootId'in s.identity))return routineShippingUnavailable();
    const {childId:_,...oldIdentity}=last.payload.identity,{childId:__,...currentIdentity}=s.identity;
    if(last.payload.request.delivery_mode!==2||s.mode!==2||last.payload.request.is_all_delivered!==false
     ||!shippingSame(oldIdentity,currentIdentity)||last.payload.identity.childId===s.identity.childId
     ||last.payload.packages.length>=s.packages.length||!containsPackages(last.payload.packages,s.packages))return routineShippingUnavailable();
   }
   const now=await routineShippingClockTx(tx);if(last&&now<=last.created_at)throw new Deferred();
   const binding=(await inspectRoutineShippingCatalog(tx)).binding;if(!binding?.app||!binding.appOid)return routineShippingUnavailable();
   const common={purpose:'routine_shipping_upload' as const,scope:await routineShippingScopeTx(tx),immutableDigest:s.immutableDigest,
    request:newRequest(s,carriers,now,last),account:account.account,
    original:{evidenceId:s.original.evidence.evidence_id,signature:s.original.evidence.signature,relatedDigest:s.original.relatedDigest,approvedUseDigest:s.original.approvedUseDigest},
    actor:{role:binding.app,roleOid:binding.appOid},previousDispatchId:last?.dispatch_id??'',correction:false as const};
   const payload:DispatchPayload|VirtualDispatchPayload|RefundDispatchPayload='domain'in s.identity
    ?{...common,format:2,identity:s.identity,packages:s.packages as VirtualPackage[]}
    :s.refundGeneration?{...common,format:3,identity:s.identity,packages:s.packages as Package[],refundGeneration:s.refundGeneration}
    :{...common,format:1,identity:s.identity,packages:s.packages as Package[]};
   const body={dispatch_id:randomUUID(),delivery_id:initial.claim.id,source_key:key,payload,created_at:now};
   const signed={...body,signature:shippingMac(env,'dispatch',body)};
   await tx.execute(sql`INSERT INTO public.routine_shipping_dispatch(dispatch_id,delivery_id,source_key,payload,created_at,signature)
    VALUES(${signed.dispatch_id}::uuid,${signed.delivery_id},${signed.source_key},${JSON.stringify(signed.payload)}::text::jsonb,${signed.created_at},${signed.signature})`);
   d=await savedDispatch(tx,env,initial.claim.id);if(!d||!shippingSame(d,signed))return routineShippingUnavailable();
  }
  const proof=Object.freeze({[uploadSlot]:true as const});proofs.set(proof,{dispatch:d,account,claim:initial.claim});return proof;
 });
}
export function assertRoutineShippingUploadProof(value:RoutineShippingUploadProof){return proofs.get(value)??routineShippingUnavailable();}
export async function recheckRoutineShippingUpload(container:Container,env:Env,value:RoutineShippingUploadProof){
 root(container);env=captureRoutineShippingDeliveryEnv(env);const p=assertRoutineShippingUploadProof(value);
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadyTx(tx))return routineShippingUnavailable();
  const s=await snapshot(tx,env,p.claim);matchingSnapshot(p.dispatch,s);await splitReader(tx,s);await sourceBoundary(tx,p.dispatch.source_key);
  const account=await prepareRoutineShippingAccountTx(tx,env,s.identity.appId,s.identity.merchantId);
  if(!shippingSame(p.account.account,account.account))return routineShippingUnavailable();
  const history=await sourceHistory(tx,env,p.dispatch.source_key),d=history.at(-1);
  if(!d||!shippingSame(d,p.dispatch))return routineShippingUnavailable();
  const results=await evidence(tx,env,d);if(results.some(r=>r.payload.result.code===0))return routineShippingUnavailable();
  const [tail]=await tx.execute<{valid:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds'
   AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${s.delivery.leaseUntil})
   AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS valid`);
  if(tail?.valid!==true)return routineShippingUnavailable();
  const issuedAt=await routineShippingClockTx(tx);
  if(issuedAt<d.created_at||issuedAt<account.account.created_at||issuedAt>=account.account.payload.data.validUntil||issuedAt>=s.delivery.leaseUntil)return routineShippingUnavailable();
  return issuedAt;
 });
}
async function finish(tx:DbClient,c:Readonly<RoutineShippingClaim>,status:'SENT'|'RETRYABLE'|'UNKNOWN'|'DEAD',now:number,code:string,error:string,reference='',available=0){
 const rows=await tx.update(orderNotificationDelivery).set({status,availableTime:available,leaseToken:'',leaseUntil:0,providerReference:reference,providerRequestId:'',
  responseCode:code,lastError:error,sentTime:status==='SENT'?now:0,updateTime:now}).where(and(eq(orderNotificationDelivery.id,c.id),eq(orderNotificationDelivery.status,'PROCESSING'),
  eq(orderNotificationDelivery.eventKey,c.eventKey),eq(orderNotificationDelivery.channel,'wechat_shipping'),eq(orderNotificationDelivery.leaseToken,c.leaseToken))).returning({id:orderNotificationDelivery.id});
 if(rows.length!==1)return routineShippingUnavailable();
}
async function finishKnown(container:Container,env:Env,c:Readonly<RoutineShippingClaim>,proof:RoutineShippingUploadProof,result:RoutineShippingHttpResult){
 const {dispatch:d}=assertRoutineShippingUploadProof(proof);assertRoutineShippingHttpResult(result,d.dispatch_id,d.signature);
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadTx(tx))return routineShippingUnavailable();
  const saved=await savedDispatch(tx,env,c.id);if(!saved||!shippingSame(saved,d))return routineShippingUnavailable();
  await authenticateHistorical(tx,env,d);await assertRoutineShippingHistoricalAccountTx(tx,env,d.payload.account,result.issuedAt);
  const now=await routineShippingClockTx(tx);if(now<result.issuedAt||now-result.issuedAt>90||result.issuedAt<d.created_at)return routineShippingUnavailable();
  const payload={format:1 as const,dispatchSignature:d.signature,result},id=shippingMac(env,'provider-result-id',payload),body={evidence_id:id,dispatch_id:d.dispatch_id,payload,created_at:now};
  await tx.execute(sql`INSERT INTO public.routine_shipping_provider_evidence(evidence_id,dispatch_id,payload,created_at,signature)
   VALUES(${id},${d.dispatch_id}::uuid,${JSON.stringify(payload)}::text::jsonb,${now},${shippingMac(env,'provider-result',body)})`);
  const accepted=await evidence(tx,env,d);if(!accepted.some(r=>r.evidence_id===id))return routineShippingUnavailable();
  const [row]=await tx.select({attempt:orderNotificationDelivery.attemptCount}).from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,c.id));
  const retry=result.code!==0&&([-1,45009,45011,10060012,10060019].includes(result.code)||result.status===429||result.status>=500)&&(row?.attempt??5)<5;
  const status=result.code===0?'SENT':retry?'RETRYABLE':'DEAD';
  await finish(tx,c,status,now,String(result.code),result.code===0?'':`wechat_shipping_rejected:${result.code}`,d.dispatch_id,retry?now+Math.min(60*2**Math.max((row?.attempt??1)-1,0),3600):0);
  return result.code===0?'sent' as const:retry?'retry-scheduled' as const:'dead' as const;
 });
}
async function recoverKnown(container:Container,env:Env,c:Readonly<RoutineShippingClaim>){
 return withTx(container,async tx=>{
  if(!await assertRoutineShippingReadTx(tx))return false;
  const d=await savedDispatch(tx,env,c.id);if(!d)return false;
  const success=(await evidence(tx,env,d)).find(r=>r.payload.result.code===0);if(!success)return false;
  const s=await snapshot(tx,env,c);
  if(!shippingSame(d.payload.format===3?d.payload.refundGeneration:null,s.refundGeneration??null)
   ||d.payload.immutableDigest!==s.immutableDigest||!shippingSame(d.payload.identity,s.identity))return routineShippingUnavailable();
  await finish(tx,c,'SENT',await routineShippingClockTx(tx),'0','',d.dispatch_id);return true;
 });
}
/** Called by the actual Queue consumer after its ordinary claim. Metadata/token
 * preparation failures cannot have uploaded. Once POST might have started,
 * ambiguity is terminal UNKNOWN and never becomes an automatic retry. */
export async function processRoutineShippingDelivery(container:Container,env:Env,input:RoutineShippingClaim,fetcher:typeof fetch=fetch):Promise<'sent'|'retry-scheduled'|'dead'|'unknown'>{
 root(container);env=captureRoutineShippingDeliveryEnv(env);const c=captureClaim(input);let started=false;
 try{
  if(await recoverKnown(container,env,c))return'sent';
  const p=await prepare(container,env,c),details=preflights.get(p)!;
  const carriers=!details.existing&&details.snapshot.logisticsType===1?await getRoutineShippingCarriers(container,env,details.account,fetcher):[];
  const proof=await admit(container,env,p,carriers);
  const result=await uploadRoutineShipping(container,env,proof,fetcher,()=>{started=true;});
  return await finishKnown(container,env,c,proof,result);
 }catch(error){
  const ambiguous=started||error instanceof Error&&error.message==='wechat_shipping_existing_intent_outcome_unknown';
  return withTx(container,async tx=>{
   await assertRoutineShippingReadTx(tx);
   const [row]=await tx.select({attempt:orderNotificationDelivery.attemptCount}).from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,c.id));
   const retry=!ambiguous&&(error instanceof Deferred||error instanceof WechatProviderRejectedError&&error.retryable)&&(row?.attempt??5)<5;
   const now=await routineShippingClockTx(tx),status=ambiguous?'UNKNOWN':retry?'RETRYABLE':'DEAD';
   await finish(tx,c,status,now,'',ambiguous?'wechat_shipping_outcome_unknown':retry?'wechat_shipping_preparation_deferred':'wechat_shipping_original_account_evidence_required','',retry?now+60:0);
   return ambiguous?'unknown' as const:retry?'retry-scheduled' as const:'dead' as const;
  });
 }
}
