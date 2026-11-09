/** Fresh actual-App source for the UUID refund notice. A signed local success
 * is necessary but is not current receiver/template/account/send authority. */
import {eq,sql}from 'drizzle-orm';
import type {Env}from '@/env';
import type {DbClient}from '@/lib/di';
import {orderNotificationDelivery}from '@/models/schema';
import {assertRoutineSubscriptionDeliveryReadyTx}from '@/migrations/routineSubscriptionDelivery';
import {prepareRechargeRefundNoticeTx}from '@/migrations/rechargeRefundNotice';
import {readRechargeRefundSuccessNoticeSourceTx,rechargeRefundSuccessNoticeKey}from '@/services/payment/RechargeRefundSuccessNoticeSource';
import {readRoutineIdentityOwnerForUidTx}from './RoutineIdentityOwnership';
import {prepareRoutineSubscriptionAccountTx,routineSubscriptionScopeTx,routineSubscriptionClockTx,freezeSubscription,subscriptionSame as same,routineSubscriptionUnavailable as fail}from './RoutineSubscriptionAccount';
import {parseRoutineSubscriptionRechargeRefundIntent,rechargeRefundSubscriptionMac as mac,renderRoutineRechargeRefundData,type RoutineSubscriptionRechargeRefundFacts}from './RoutineSubscriptionRechargeRefundEvidenceCodec';
export type RoutineSubscriptionRechargeRefundDelivery=typeof orderNotificationDelivery.$inferSelect&{subjectDomain:'recharge';subjectId:number};
export async function readRoutineSubscriptionRechargeRefundDeliveryTx(tx:DbClient,id:number){
 const rows=await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id,id)).limit(2),row=rows[0];
 const subjects=await tx.execute<{subjectDomain:string;subjectId:number}>(sql`SELECT subject_domain AS "subjectDomain",subject_id AS "subjectId" FROM public.order_notification_delivery WHERE id=${id} LIMIT 2`),s=subjects[0];
 if(rows.length!==1||subjects.length!==1||row.orderId!==null||row.withdrawalId!==null||s.subjectDomain!=='recharge'||!Number.isSafeInteger(s.subjectId)||s.subjectId<=0||!rechargeRefundSuccessNoticeKey(row.eventKey))return fail();
 return{...row,subjectDomain:'recharge' as const,subjectId:s.subjectId};
}
function immutable(row:RoutineSubscriptionRechargeRefundDelivery){return{id:row.id,outboxId:row.outboxId,eventKey:row.eventKey,orderId:row.orderId,withdrawalId:row.withdrawalId,
 subjectDomain:row.subjectDomain,subjectId:row.subjectId,userId:row.userId,noticeMark:row.noticeMark,channel:row.channel,target:row.target,templateCode:row.templateCode,payload:row.payload,addTime:row.addTime};}
export async function readRoutineSubscriptionRechargeRefundNoticeSourceTx(tx:DbClient,env:Env,expected:{outboxId:number;eventKey:string}|{deliveryId:number;eventKey:string}){
 if(!rechargeRefundSuccessNoticeKey(expected.eventKey)||!await prepareRechargeRefundNoticeTx(tx)||!await assertRoutineSubscriptionDeliveryReadyTx(tx))return fail();
 await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
 const delivery='deliveryId'in expected?await readRoutineSubscriptionRechargeRefundDeliveryTx(tx,expected.deliveryId):undefined;
 const source=await readRechargeRefundSuccessNoticeSourceTx(tx,env,{outboxId:delivery?.outboxId??('outboxId'in expected?expected.outboxId:0),eventKey:expected.eventKey});
 const f=source.facts,owner=await readRoutineIdentityOwnerForUidTx(tx,env,{uid:f.recharge.buyerUid,appId:f.recharge.appId});
 // PHP addresses the recharge UID. An authenticated third-party payer does
 // not replace that recipient; current ownership in the original App is the
 // independently proved receiver authority.
 if(!owner||owner.owner.appId!==f.recharge.appId||owner.owner.uid!==f.recharge.buyerUid)return fail();
 const ownershipDigest=mac(env,'owner',owner),account=await prepareRoutineSubscriptionAccountTx(tx,env,f.recharge.appId,'755');
 if(account.template.templateId.length>100)return fail();
 const renderedAt=delivery?.addTime??await routineSubscriptionClockTx(tx),data=renderRoutineRechargeRefundData({orderNo:f.recharge.orderNo,principalCents:f.recharge.principalCents,
  postBalanceCents:f.recharge.postReservationBalanceCents,occurredAt:f.capturedAt});
 if(renderedAt<f.capturedAt)return fail();
 const request=freezeSubscription({touser:owner.owner.openid,template_id:account.template.templateId,page:'/pages/users/user_bill/index?type=2',data:Object.fromEntries(Object.entries(data).map(([k,value])=>[k,{value}]))});
 const noticeSignature=(source.event.payload as unknown as {signature:string}).signature;
 if(delivery){
  if(delivery.channel!=='wechat_routine'||delivery.noticeMark!=='recharge_order_refund_status'||delivery.outboxId!==source.event.id||delivery.eventKey!==source.event.eventKey
   ||delivery.subjectId!==f.recharge.id||delivery.userId!==f.recharge.buyerUid||delivery.target!==request.touser||delivery.templateCode!==request.template_id
   ||!['PENDING','ENQUEUED','PROCESSING','RETRYABLE'].includes(delivery.status)||delivery.payload.kind!=='wechat_routine'
   ||delivery.payload.routineAppId!==f.recharge.appId||!same(delivery.payload.data,data)||delivery.payload.url!==request.page)return fail();
  const intent=parseRoutineSubscriptionRechargeRefundIntent(env,delivery.payload.routineSubscriptionIntent,await routineSubscriptionScopeTx(tx));
  if(intent.deliveryId!==delivery.id||intent.outboxId!==source.event.id||intent.createdAt!==delivery.addTime||intent.requestSignature!==noticeSignature
   ||intent.source.physicalDigest!==source.sourceDigest||intent.source.ownershipDigest!==ownershipDigest||intent.source.localSignature!==source.local.signature
   ||intent.source.causeSignature!==source.cause.signature||intent.source.family!==source.family||intent.source.totalAttempts!==source.state.attempt_count
   ||!same(intent.request,request))return fail();
 }
 const facts:RoutineSubscriptionRechargeRefundFacts={deliveryId:delivery?.id??0,outboxId:source.event.id,eventKey:source.event.eventKey,orderId:f.recharge.id,rootId:f.recharge.id,buyerUid:f.recharge.buyerUid,subjectDomain:'recharge',
  appId:f.recharge.appId,ownershipId:owner.owner.ownershipId,bindingId:owner.owner.bindingId,observationId:owner.owner.observationId,templateMark:'755',operationId:String(source.operation.operation_id),
  family:source.family,totalAttempts:source.state.attempt_count,localResultId:String(source.local.result_id),localSignature:String(source.local.signature),causeResultId:String(source.cause.result_id),causeSignature:String(source.cause.signature),
  noticeSignature,physicalDigest:source.sourceDigest,ownershipDigest,sourceDigest:''};
 facts.sourceDigest=mac(env,delivery?'delivery-source':'author-source',[facts,account.account,request,delivery?immutable(delivery):null]);
 return{facts:freezeSubscription(facts),account,request,renderedAt,requestSignature:noticeSignature};
}
